/**
importAnalysis是 Vite 中内置的很重要的一个插件，它的作用如下：

  1、解析请求文件中的导入，确保它们存在；并重写导入路径为绝对路径
  2、如果导入的模块需要更新，会在导入URL上挂载一个参数，从而强制浏览器请求新的文件
  3、对于引入 CommonJS 转成 ESM 的模块，会注入一段代码，以支持获取模块内容
  4、如果代码中有import.meta.hot.accept，注入import.meta.hot定义
  5、更新 Module Graph，以及收集请求文件接收的热更新模块
  6、如果代码中环境变量import.meta.env，注入import.meta.env定义
 */

import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import colors from 'picocolors'
// magic-string是一个用于转换、编辑和操作字符串的库。
import MagicString from 'magic-string'
import type { ExportSpecifier, ImportSpecifier } from 'es-module-lexer'
// 很棒的一个库,可以获取 import 和 exports 代码 的位置
import { init, parse as parseImports } from 'es-module-lexer'
import { parse as parseJS } from 'acorn'
import type { Node } from 'estree'
import { findStaticImports, parseStaticImport } from 'mlly'
import { makeLegalIdentifier } from '@rollup/pluginutils'
import type { ViteDevServer } from '..'
import {
  CLIENT_DIR,
  CLIENT_PUBLIC_PATH,
  DEP_VERSION_RE,
  FS_PREFIX,
} from '../constants'
import {
  debugHmr,
  handlePrunedModules,
  lexAcceptedHmrDeps,
  lexAcceptedHmrExports,
  normalizeHmrUrl,
} from '../server/hmr'
import {
  cleanUrl,
  createDebugger,
  fsPathFromUrl,
  generateCodeFrame,
  injectQuery, // 该函数将 queryToInject 注入到 url 中，并返回修改后的 URL。
  isBuiltin,
  isDataUrl,
  isExternalUrl,
  isInNodeModules,
  isJSRequest,
  joinUrlSegments,
  moduleListContains,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  stripBase,
  stripBomTag,
  timeFrom,
  transformStableResult,
  unwrapId,
  withTrailingSlash,
  wrapId,
} from '../utils'
import { getDepOptimizationConfig } from '../config'
import type { ResolvedConfig } from '../config'
import type { Plugin } from '../plugin'
import {
  cjsShouldExternalizeForSSR,
  shouldExternalizeForSSR,
} from '../ssr/ssrExternal'
import { getDepsOptimizer, optimizedDepNeedsInterop } from '../optimizer'
import { ERR_CLOSED_SERVER } from '../server/pluginContainer'
import { checkPublicFile, urlRE } from './asset'
import {
  ERR_OUTDATED_OPTIMIZED_DEP,
  throwOutdatedRequest,
} from './optimizedDeps'
import { isCSSRequest, isDirectCSSRequest, isModuleCSSRequest } from './css'
import { browserExternalId } from './resolve'

const debug = createDebugger('vite:import-analysis')

const clientDir = normalizePath(CLIENT_DIR)

const skipRE = /\.(?:map|json)(?:$|\?)/
// id就是文件路径: 'C:/Users/LiuHao/Desktop/temp/test-vite/index.js'
export const canSkipImportAnalysis = (id: string): boolean =>
  skipRE.test(id) || isDirectCSSRequest(id)

const optimizedDepChunkRE = /\/chunk-[A-Z\d]{8}\.js/
const optimizedDepDynamicRE = /-[A-Z\d]{8}\.js/

const hasImportInQueryParamsRE = /[?&]import=?\b/

export const hasViteIgnoreRE = /\/\*\s*@vite-ignore\s*\*\//

const cleanUpRawUrlRE = /\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm
const urlIsStringRE = /^(?:'.*'|".*"|`.*`)$/

// 匹配以 ' 或 " 开头，以 ' 或 " 结尾的字符串。
const templateLiteralRE = /^\s*`(.*)`\s*$/

interface UrlPosition {
  url: string
  start: number
  end: number
}

export function isExplicitImportRequired(url: string): boolean {
  // CSS_LANGS_RE = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/
  // 不是以上面结尾的都不是css请求
  return !isJSRequest(cleanUrl(url)) && !isCSSRequest(url)
}

function markExplicitImport(url: string) {
  // 不是 js 和 css 的请求
  if (isExplicitImportRequired(url)) {
    // 该函数将 import 注入到 url 中，并返回修改后的 URL。
    return injectQuery(url, 'import')
  }
  return url
}

function extractImportedBindings(
  id: string,
  source: string,
  importSpec: ImportSpecifier,
  importedBindings: Map<string, Set<string>>,
) {
  let bindings = importedBindings.get(id)
  if (!bindings) {
    bindings = new Set<string>()
    importedBindings.set(id, bindings)
  }

  const isDynamic = importSpec.d > -1
  const isMeta = importSpec.d === -2
  if (isDynamic || isMeta) {
    // this basically means the module will be impacted by any change in its dep
    bindings.add('*')
    return
  }

  const exp = source.slice(importSpec.ss, importSpec.se)
  const [match0] = findStaticImports(exp)
  if (!match0) {
    return
  }
  const parsed = parseStaticImport(match0)
  if (!parsed) {
    return
  }
  if (parsed.namespacedImport) {
    bindings.add('*')
  }
  if (parsed.defaultImport) {
    bindings.add('default')
  }
  if (parsed.namedImports) {
    for (const name of Object.keys(parsed.namedImports)) {
      bindings.add(name)
    }
  }
}

/**
 * Server-only plugin that lexes, resolves, rewrites and analyzes url imports.
 *
 * - Imports are resolved to ensure they exist on disk
 *
 * - Lexes HMR accept calls and updates import relationships in the module graph
 *
 * - Bare module imports are resolved (by @rollup-plugin/node-resolve) to
 * absolute file paths, e.g.
 *
 *     ```js
 *     import 'foo'
 *     ```
 *     is rewritten to
 *     ```js
 *     import '/@fs//project/node_modules/foo/dist/foo.js'
 *     ```
 *
 * - CSS imports are appended with `.js` since both the js module and the actual
 * css (referenced via `<link>`) may go through the transform pipeline:
 *
 *     ```js
 *     import './style.css'
 *     ```
 *     is rewritten to
 *     ```js
 *     import './style.css.js'
 *     ```
 */
export function importAnalysisPlugin(config: ResolvedConfig): Plugin {
  const { root, base } = config
  // CLIENT_PUBLIC_PATH = `/@vite/client`
  // 拼接 /@vite/client
  const clientPublicPath = path.posix.join(base, CLIENT_PUBLIC_PATH)
  const enablePartialAccept = config.experimental?.hmrPartialAccept
  let server: ViteDevServer

  let _env: string | undefined
  function getEnv(ssr: boolean) {
    if (!_env) {
      _env = `import.meta.env = ${JSON.stringify({
        ...config.env,
        SSR: '__vite__ssr__',
      })};`
      // account for user env defines
      for (const key in config.define) {
        if (key.startsWith(`import.meta.env.`)) {
          const val = config.define[key]
          _env += `${key} = ${typeof val === 'string' ? val : JSON.stringify(val)
            };`
        }
      }
    }
    return _env.replace('"__vite__ssr__"', ssr + '')
  }

  // 有 configureServer 和 transform 这两个钩子函数
  return {
    name: 'vite:import-analysis',

    configureServer(_server) {
      server = _server
    },

    /**
     *
     * @param source 经ESbuild编译后的源码
     * @param importer 文件绝对路径 'C:/Users/LiuHao/Desktop/temp/test-vite/index.js'
     * @param options 选项options
     * @returns
     */
    async transform(source, importer, options) {
      // In a real app `server` is always defined, but it is undefined when
      // running src/node/server/__tests__/pluginContainer.spec.ts
      if (!server) {
        return null
      }

      const ssr = options?.ssr === true
      const prettyImporter = prettifyUrl(importer, root)

      if (canSkipImportAnalysis(importer)) {
        debug?.(colors.dim(`[skipped] ${prettyImporter}`))
        return null
      }

      const start = performance.now()
      // es-module-lexer 的初始化
      await init
      let imports!: readonly ImportSpecifier[]
      let exports!: readonly ExportSpecifier[]
      // 这个函数 stripBomTag 的作用是去除字符串中的 bom 标签。
      // bom 标签是指在一些文件中（如 UTF - 8 文件）开头的三个不可见字符（\uFEFF），它用来标识文件的编码方式。在某些情况下，我们可能不希望 bom 标签出现在我们的字符串中，因此需要将其去除。
      source = stripBomTag(source)
      try {
        // 通过 es-module-lexer 获取文件中 import 语句的代码位置
        ;[imports, exports] = parseImports(source)
      } catch (e: any) {
        const isVue = importer.endsWith('.vue')
        const isJsx = importer.endsWith('.jsx') || importer.endsWith('.tsx')
        const maybeJSX = !isVue && isJSRequest(importer)

        const msg = isVue
          ? `Install @vitejs/plugin-vue to handle .vue files.`
          : maybeJSX
            ? isJsx
              ? `If you use tsconfig.json, make sure to not set jsx to preserve.`
              : `If you are using JSX, make sure to name the file with the .jsx or .tsx extension.`
            : `You may need to install appropriate plugins to handle the ${path.extname(
              importer,
            )} file format, or if it's an asset, add "**/*${path.extname(
              importer,
            )}" to \`assetsInclude\` in your configuration.`

        this.error(
          `Failed to parse source for import analysis because the content ` +
          `contains invalid JS syntax. ` +
          msg,
          e.idx,
        )
      }

      const depsOptimizer = getDepsOptimizer(config, ssr)

      const { moduleGraph } = server
      // since we are already in the transform phase of the importer, it must
      // have been loaded so its entry is guaranteed in the module graph.
      // importer 文件绝对路径
      // 根据文件绝对路径获取文件的 ModuleNode 对象
      const importerModule = moduleGraph.getModuleById(importer)!
      if (!importerModule) {
        // This request is no longer valid. It could happen for optimized deps
        // requests. A full reload is going to request this id again.
        // Throwing an outdated error so we properly finish the request with a
        // 504 sent to the browser.
        throwOutdatedRequest(importer)
      }

      if (!imports.length && !(this as any)._addedImports) {
        importerModule.isSelfAccepting = false
        debug?.(
          `${timeFrom(start)} ${colors.dim(`[no imports] ${prettyImporter}`)}`,
        )
        return source
      }

      let hasHMR = false
      let isSelfAccepting = false
      let hasEnv = false
      let needQueryInjectHelper = false
      let s: MagicString | undefined
      const str = () => s || (s = new MagicString(source))
      let isPartiallySelfAccepting = false
      const importedBindings = enablePartialAccept
        ? new Map<string, Set<string>>()
        : null
      const toAbsoluteUrl = (url: string) =>
        path.posix.resolve(path.posix.dirname(importerModule.url), url)

      // 参数: 模块名 | 绝对/相对路径 和 模块名的开始位置，即上面的start
      // importer 当前正在被请求文件的绝对路径
      /**
# 假设 base = /
[url, url 对应的绝对路径]

url:
    - 从根路径推断出来的绝对路径。比如 /node_modules/react/index.js
    - 如果不是jsx、tsx、js、ts、vue、css等文件，会有一个 import 参数。比如 /src/logo.png?import
    - 如果是外部url，保持不变。比如 https/www.xxx.com/a.js
    - 如果是相对路径引入的jsx、tsx、js、ts、vue、css等文件，并且请求文件的绝对路径上有参数v
        则给这个文件也添加相同的参数v。比如 /src/App.vue?v=xxx
    - 如果路径对应的 ModuleNode 对象的 lastHMRTimestamp 大于 0，添加 t 参数，这里的目的是修改引入的路径参数，从而防止走浏览器缓存
       */
      const normalizeUrl = async (
        url: string, // 比如 react、./App.vue
        pos: number,
        forceSkipImportAnalysis: boolean = false,
      ): Promise<[string, string]> => {
        url = stripBase(url, base)

        let importerFile = importer

        const optimizeDeps = getDepOptimizationConfig(config, ssr)
        if (moduleListContains(optimizeDeps?.exclude, url)) {
          if (depsOptimizer) {
            await depsOptimizer.scanProcessing

            // if the dependency encountered in the optimized file was excluded from the optimization
            // the dependency needs to be resolved starting from the original source location of the optimized file
            // because starting from node_modules/.vite will not find the dependency if it was not hoisted
            // (that is, if it is under node_modules directory in the package source of the optimized file)
            for (const optimizedModule of depsOptimizer.metadata.depInfoList) {
              if (!optimizedModule.src) continue // Ignore chunks
              if (optimizedModule.file === importerModule.file) {
                importerFile = optimizedModule.src
              }
            }
          }
        }

        // 获取 url（模块）绝对路径 resolved: { id: 'xxx/yyy/zzz/node_modules/react/index.js' }
        const resolved = await this.resolve(url, importerFile)

        if (!resolved) {
          // in ssr, we should let node handle the missing modules
          if (ssr) {
            return [url, url]
          }
          // fix#9534, prevent the importerModuleNode being stopped from propagating updates
          importerModule.isSelfAccepting = false
          return this.error(
            `Failed to resolve import "${url}" from "${path.relative(
              process.cwd(),
              importerFile,
            )}". Does the file exist?`,
            pos,
          )
        }

        // 如果 url 是相对路径则为 true
        const isRelative = url[0] === '.'
        // 如果是自己引用自己则为 true
        const isSelfImport = !isRelative && cleanUrl(url) === cleanUrl(importer)

        // normalize all imports into resolved URLs
        // e.g. `import 'foo'` -> `import '/@fs/.../node_modules/foo/index.js'`
        if (resolved.id.startsWith(withTrailingSlash(root))) {
          // in root: infer short absolute path from root
          // 如果当前文件在项目根目录内，将 url 修改成 从根路径推断出来的绝对路径
          // 比如：root = /xxx/yyy/zzz
          // /xxx/yyy/zzz/src/main.ts -> /src/main.ts
          url = resolved.id.slice(root.length)
        } else if (
          depsOptimizer?.isOptimizedDepFile(resolved.id) ||
          fs.existsSync(cleanUrl(resolved.id))
        ) {
          // an optimized deps may not yet exists in the filesystem, or
          // a regular file exists but is out of root: rewrite to absolute /@fs/ paths
          // 文件存在，但不在根目录下，重写成 /@fs/ + 绝对路径
          url = path.posix.join(FS_PREFIX, resolved.id)
        } else {
          url = resolved.id
        }
        // 如果是外部 url /http(s)/ 则返回
        if (isExternalUrl(url)) {
          return [url, url]
        }

        // if the resolved id is not a valid browser import specifier,
        // prefix it to make it valid. We will strip this before feeding it
        // back into the transform pipeline
        if (url[0] !== '.' && url[0] !== '/') {
          url = wrapId(resolved.id)
        }

        // make the URL browser-valid if not SSR
        if (!ssr) {
          // mark non-js/css imports with `?import`
          // 下面的 js 文件包含 jsx、tsx、js、ts、vue 等
          // 给非 js、css文件添加query ?import。比如 json 文件、图片文件等
          url = markExplicitImport(url)

          // If the url isn't a request for a pre-bundled common chunk,
          // for relative js/css imports, or self-module virtual imports
          // (e.g. vue blocks), inherit importer's version query
          // do not do this for unknown type imports, otherwise the appended
          // query can break 3rd party plugin's extension checks.
          // 对相对路径引入的 js、css 的 url 挂载 v=xxx 参数
          if (
            (isRelative || isSelfImport) &&
            !hasImportInQueryParamsRE.test(url) &&
            !url.match(DEP_VERSION_RE)
          ) {
            // const DEP_VERSION_RE = /[\?&](v=[\w\.-]+)\b/
            // 这里要注意，是将 当前被解析文件的 v=xxx 参数，挂载到 url 上
            const versionMatch = importer.match(DEP_VERSION_RE)
            if (versionMatch) {
              url = injectQuery(url, versionMatch[1])
            }
          }

          // check if the dep has been hmr updated. If yes, we need to attach
          // its last updated timestamp to force the browser to fetch the most
          // up-to-date version of this module.
          // 热更新相关：检查 dep 是否已更新 HMR。如果是，需要附加它最近更新的时间戳，以强制浏览器获取该模块的最新版本。
          try {
            // delay setting `isSelfAccepting` until the file is actually used (#7870)
            // We use an internal function to avoid resolving the url again
            // 获取/创建 url 对应的 ModuleNode 对象
            const depModule = await moduleGraph._ensureEntryFromUrl(
              unwrapId(url),
              ssr,
              canSkipImportAnalysis(url) || forceSkipImportAnalysis,
              resolved,
            )
            if (depModule.lastHMRTimestamp > 0) {
              // 更新 url 上的 t 参数
              url = injectQuery(url, `t=${depModule.lastHMRTimestamp}`)
            }
          } catch (e: any) {
            // it's possible that the dep fails to resolve (non-existent import)
            // attach location to the missing import
            e.pos = pos
            throw e
          }

          // prepend base
          // 将 url 重新和 base 拼接到一起
          url = joinUrlSegments(base, url)
        }

        // 返回 url 和 文件绝对路径
        return [url, resolved.id]
      }

      // 设置一个数组保存源代码中导入的顺序
      const orderedImportedUrls = new Array<string | undefined>(imports.length)
      const orderedAcceptedUrls = new Array<Set<UrlPosition> | undefined>(
        imports.length,
      )
      const orderedAcceptedExports = new Array<Set<string> | undefined>(
        imports.length,
      )

      await Promise.all(
        imports.map(async (importSpecifier, index) => {
          const {
            s: start,  // 模块名称在导入语句中的开始位置
            e: end, // 模块名称在导入语句中的结束位置
            ss: expStart, // 导入语句在代码中的开始位置
            se: expEnd, // 导入语句在代码中的结束位置
            d: dynamicIndex, // 导入语句是否为动态导入，如果是则为对应的开始位置，否则默认为 -1
            a: assertIndex,
          } = importSpecifier

          // #2083 User may use escape path,
          // so use imports[index].n to get the unescaped string
          // 模块的名称
          let specifier = importSpecifier.n

          // 获取导入的模块名称，比如第一个的是 react、热更新的是 import.meta
          const rawUrl = source.slice(start, end)

          // check import.meta usage
          if (rawUrl === 'import.meta') {
            // 拿到 import.meta 后面的东西，像 .hot  等等
            const prop = source.slice(end, end + 4)
            if (prop === '.hot') { // 热更新相关
              hasHMR = true
              const endHot = end + 4 + (source[end + 4] === '?' ? 1 : 0)
              // import.meta.hot.accept 对应的逻辑
              if (source.slice(endHot, endHot + 7) === '.accept') {
                // further analyze accepted modules
                // import.meta.hot.acceptExports 对应的逻辑
                if (source.slice(endHot, endHot + 14) === '.acceptExports') {
                  const importAcceptedExports = (orderedAcceptedExports[index] =
                    new Set<string>())
                  lexAcceptedHmrExports(
                    source,
                    source.indexOf('(', endHot + 14) + 1,
                    importAcceptedExports,
                  )
                  isPartiallySelfAccepting = true
                } else {
                  const importAcceptedUrls = (orderedAcceptedUrls[index] =
                    new Set<UrlPosition>())
                  // lexAcceptedHmrDeps方法，就是遍历源码，根据import.meta.hot.accept方法的参数，判断。如果是接收直接依赖项的更新，则将路径添加到importAcceptedUrls中，并返回false。如果是接收自身更新，返回true
                  if (
                    lexAcceptedHmrDeps(
                      source,
                      source.indexOf('(', endHot + 7) + 1,
                      importAcceptedUrls,
                    )
                  ) {
                    // 接收模块自身热更新
                    isSelfAccepting = true
                  }
                }
              }
            } else if (prop === '.env') { // import.meta.env 相关
              // 环境变量
              hasEnv = true
            }
            return
          } else if (templateLiteralRE.test(rawUrl)) { // 匹配以 ' 或 " 开头，以 ' 或 " 结尾的字符串。
            // If the import has backticks but isn't transformed as a glob import
            // (as there's nothing to glob), check if it's simply a plain string.
            // If so, we can replace the specifier as a plain string to prevent
            // an incorrect "cannot be analyzed" warning.
            if (!(rawUrl.includes('${') && rawUrl.includes('}'))) {
              specifier = rawUrl.replace(templateLiteralRE, '$1')
            }
          }

          // 如果是动态导入，则为 true
          const isDynamicImport = dynamicIndex > -1

          // strip import assertions as we can process them ourselves
          if (!isDynamicImport && assertIndex > -1) {
            str().remove(end + 1, expEnd)
          }

          // static import or valid string in dynamic import
          // If resolvable, let's resolve it
          // 如果有模块名，就是普通的 import
          if (specifier) {
            // skip external / data uri
            // 跳过 http(s)或data:开头的路径
            if (isExternalUrl(specifier) || isDataUrl(specifier)) {
              return
            }
            // skip ssr external
            if (ssr) {
              if (config.legacy?.buildSsrCjsExternalHeuristics) {
                if (
                  cjsShouldExternalizeForSSR(specifier, server._ssrExternals)
                ) {
                  return
                }
              } else if (shouldExternalizeForSSR(specifier, importer, config)) {
                return
              }
              if (isBuiltin(specifier)) {
                return
              }
            }
            // skip client
            // 跳过 /@vite/client
            if (specifier === clientPublicPath) {
              return
            }

            // warn imports to non-asset /public files
            if (
              specifier[0] === '/' &&
              !(
                config.assetsInclude(cleanUrl(specifier)) ||
                urlRE.test(specifier)
              ) &&
              checkPublicFile(specifier, config)
            ) {
              throw new Error(
                `Cannot import non-asset file ${specifier} which is inside /public. ` +
                `JS/CSS files inside /public are copied as-is on build and ` +
                `can only be referenced via <script src> or <link href> in html. ` +
                `If you want to get the URL of that file, use ${injectQuery(
                  specifier,
                  'url',
                )} instead.`,
              )
            }

            // normalize
            // 调用 normalizeUrl 函数，并传入模块名和模块名字符串的开始位置
            const [url, resolvedId] = await normalizeUrl(specifier, start)

            if (
              !isDynamicImport &&
              specifier &&
              !specifier.includes('?') && // ignore custom queries
              isCSSRequest(resolvedId) &&
              !isModuleCSSRequest(resolvedId)
            ) {
              const sourceExp = source.slice(expStart, start)
              if (
                sourceExp.includes('from') && // check default and named imports
                !sourceExp.includes('__vite_glob_') // glob handles deprecation message itself
              ) {
                const newImport =
                  sourceExp + specifier + `?inline` + source.slice(end, expEnd)
                this.warn(
                  `\n` +
                  colors.cyan(importerModule.file) +
                  `\n` +
                  colors.reset(generateCodeFrame(source, start)) +
                  `\n` +
                  colors.yellow(
                    `Default and named imports from CSS files are deprecated. ` +
                    `Use the ?inline query instead. ` +
                    `For example: ${newImport}`,
                  ),
                )
              }
            }

            // record as safe modules
            // safeModulesPath should not include the base prefix.
            // See https://github.com/vitejs/vite/issues/9438#issuecomment-1465270409
            // 记录到 moduleGraph.safeModulesPath 中
            server?.moduleGraph.safeModulesPath.add(
              fsPathFromUrl(stripBase(url, base)),
            )
            // rewrite
            if (url !== specifier) {
              let rewriteDone = false
              if (
                depsOptimizer?.isOptimizedDepFile(resolvedId) &&
                !resolvedId.match(optimizedDepChunkRE)
              ) {
                // for optimized cjs deps, support named imports by rewriting named imports to const assignments.
                // internal optimized chunks don't need es interop and are excluded

                // The browserHash in resolvedId could be stale in which case there will be a full
                // page reload. We could return a 404 in that case but it is safe to return the request
                // 把 v=xxx 给删了
                const file = cleanUrl(resolvedId) // Remove ?v={hash}

                const needsInterop = await optimizedDepNeedsInterop(
                  depsOptimizer.metadata,
                  file,
                  config,
                  ssr,
                )

                if (needsInterop === undefined) {
                  // Non-entry dynamic imports from dependencies will reach here as there isn't
                  // optimize info for them, but they don't need es interop. If the request isn't
                  // a dynamic import, then it is an internal Vite error
                  if (!file.match(optimizedDepDynamicRE)) {
                    config.logger.error(
                      colors.red(
                        `Vite Error, ${url} optimized info should be defined`,
                      ),
                    )
                  }
                } else if (needsInterop) {
                  debug?.(`${url} needs interop`)
                  interopNamedImports(
                    str(),
                    importSpecifier,
                    url,
                    index,
                    importer,
                    config,
                  )
                  rewriteDone = true
                }
              }
              // If source code imports builtin modules via named imports, the stub proxy export
              // would fail as it's `export default` only. Apply interop for builtin modules to
              // correctly throw the error message.
              else if (
                url.includes(browserExternalId) &&
                source.slice(expStart, start).includes('{')
              ) {
                interopNamedImports(
                  str(),
                  importSpecifier,
                  url,
                  index,
                  importer,
                  config,
                )
                rewriteDone = true
              }
              if (!rewriteDone) {
                // 将 import 的模块名替换成 url
                // 比如， import vue from 'Vue' -> import vue from '/node_modules/vue/dist/vue.runtime.esm-bundler.js'
                const rewrittenUrl = JSON.stringify(url)
                const s = isDynamicImport ? start : start - 1
                const e = isDynamicImport ? end : end + 1
                str().overwrite(s, e, rewrittenUrl, {
                  contentOnly: true,
                })
              }
            }

            // record for HMR import chain analysis
            // make sure to unwrap and normalize away base
            const hmrUrl = unwrapId(stripBase(url, base))
            // 判断是不是导入本地的路径
            const isLocalImport = !isExternalUrl(hmrUrl) && !isDataUrl(hmrUrl)
            if (isLocalImport) {
              orderedImportedUrls[index] = hmrUrl
            }

            if (enablePartialAccept && importedBindings) {
              extractImportedBindings(
                resolvedId,
                source,
                importSpecifier,
                importedBindings,
              )
            }

            if (
              !isDynamicImport &&
              isLocalImport &&
              config.server.preTransformRequests
            ) {
              // pre-transform known direct imports
              // These requests will also be registered in transformRequest to be awaited
              // by the deps optimizer
              // 预处理已知的直接导入。这些请求也将在 transformRequest 中注册，以供依赖项优化器等待。
              const url = removeImportQuery(hmrUrl)
              server.transformRequest(url, { ssr }).catch((e) => {
                if (
                  e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
                  e?.code === ERR_CLOSED_SERVER
                ) {
                  // these are expected errors
                  return
                }
                // Unexpected error, log the issue but avoid an unhandled exception
                config.logger.error(e.message, { error: e })
              })
            }
          } else if (!importer.startsWith(withTrailingSlash(clientDir))) { // es-module-lexer 没有解析到，并且文件绝对路径不是以 /@vite/client 开头
            if (!isInNodeModules(importer)) {
              // check @vite-ignore which suppresses dynamic import warning
              const hasViteIgnore = hasViteIgnoreRE.test(
                // complete expression inside parens
                source.slice(dynamicIndex + 1, end),
              )
              if (!hasViteIgnore) {
                this.warn(
                  `\n` +
                  colors.cyan(importerModule.file) +
                  `\n` +
                  colors.reset(generateCodeFrame(source, start)) +
                  colors.yellow(
                    `\nThe above dynamic import cannot be analyzed by Vite.\n` +
                    `See ${colors.blue(
                      `https://github.com/rollup/plugins/tree/master/packages/dynamic-import-vars#limitations`,
                    )} ` +
                    `for supported dynamic import formats. ` +
                    `If this is intended to be left as-is, you can use the ` +
                    `/* @vite-ignore */ comment inside the import() call to suppress this warning.\n`,
                  ),
                )
              }
            }

            if (!ssr) {
              const url = rawUrl.replace(cleanUpRawUrlRE, '').trim()
              if (
                !urlIsStringRE.test(url) ||
                isExplicitImportRequired(url.slice(1, -1))
              ) {
                needQueryInjectHelper = true
                str().overwrite(
                  start,
                  end,
                  `__vite__injectQuery(${url}, 'import')`,
                  { contentOnly: true },
                )
              }
            }
          }
        }),
      )

      const importedUrls = new Set(
        orderedImportedUrls.filter(Boolean) as string[],
      )
      const acceptedUrls = mergeAcceptedUrls(orderedAcceptedUrls)
      const acceptedExports = mergeAcceptedUrls(orderedAcceptedExports)

      // 下面这块就是关于热更新和环境变量相关的了
      if (hasEnv) {
        // inject import.meta.env
        str().prepend(getEnv(ssr))
      }

      if (hasHMR && !ssr) {
        debugHmr?.(
          `${isSelfAccepting
            ? `[self-accepts]`
            : isPartiallySelfAccepting
              ? `[accepts-exports]`
              : acceptedUrls.size
                ? `[accepts-deps]`
                : `[detected api usage]`
          } ${prettyImporter} `,
        )
        // 将下面这段代码注入源码中
        // clientPublicPath 就是客户端接收热更新的代码
        // inject hot context
        str().prepend(
          `import { createHotContext as __vite__createHotContext } from "${clientPublicPath}"; ` +
          `import.meta.hot = __vite__createHotContext(${JSON.stringify(
            normalizeHmrUrl(importerModule.url),
          )
          }); `,
        )
        // 上述代码的作用是，从客户端接收热更新的js文件中导出createHotContext方法，createHotContext方法的返回值就是import.meta.hot的值。传入的是当前文件的路径以 / 开头的 url
      }

      if (needQueryInjectHelper) {
        str().prepend(
          `import { injectQuery as __vite__injectQuery } from "${clientPublicPath}"; `,
        )
      }

      // normalize and rewrite accepted urls
      // acceptedUrls的内容是当前文件接受热更新的直接依赖项；获取这些依赖项的绝对路径，并将源码中的路径改成绝对路径。然后将其添加到normalizedAcceptedUrls中，用于更新 Module Graph。
      const normalizedAcceptedUrls = new Set<string>()
      for (const { url, start, end } of acceptedUrls) {
        const [normalized] = await moduleGraph.resolveUrl(
          toAbsoluteUrl(url),
          ssr,
        )
        normalizedAcceptedUrls.add(normalized)
        str().overwrite(start, end, JSON.stringify(normalized), {
          contentOnly: true,
        })
      }

      // update the module graph for HMR analysis.
      // node CSS imports does its own graph update in the css plugin so we
      // only handle js graph updates here.
      if (!isCSSRequest(importer)) {
        // attached by pluginContainer.addWatchFile
        const pluginImports = (this as any)._addedImports as
          | Set<string>
          | undefined
        if (pluginImports) {
          ; (
            await Promise.all(
              [...pluginImports].map((id) => normalizeUrl(id, 0, true)),
            )
          ).forEach(([url]) => importedUrls.add(url))
        }
        // HMR transforms are no-ops in SSR, so an `accept` call will
        // never be injected. Avoid updating the `isSelfAccepting`
        // property for our module node in that case.
        if (ssr && importerModule.isSelfAccepting) {
          isSelfAccepting = true
        }
        // a partially accepted module that accepts all its exports
        // behaves like a self-accepted module in practice
        if (
          !isSelfAccepting &&
          isPartiallySelfAccepting &&
          acceptedExports.size >= exports.length &&
          exports.every((e) => acceptedExports.has(e.n))
        ) {
          isSelfAccepting = true
        }
        // 更新 Module Graph，前面讲过这个方法
        const prunedImports = await moduleGraph.updateModuleInfo(
          importerModule, // 当前文件的 Module 实例
          importedUrls,  // 当前文件中的导入
          importedBindings,
          normalizedAcceptedUrls, // 接受直接依赖项的更新，而无需重新加载自身
          isPartiallySelfAccepting ? acceptedExports : null,
          isSelfAccepting,  // 接收模块自身热更新
          ssr,
        )
        // 热更新相关
        if (hasHMR && prunedImports) {
          handlePrunedModules(prunedImports, server)
        }
      }

      debug?.(
        `${timeFrom(start)} ${colors.dim(
          `[${importedUrls.size} imports rewritten] ${prettyImporter}`,
        )
        } `,
      )

      if (s) {
        return transformStableResult(s, importer, config)
      } else {
        return source
      }
    },
  }
}

function mergeAcceptedUrls<T>(orderedUrls: Array<Set<T> | undefined>) {
  const acceptedUrls = new Set<T>()
  for (const urls of orderedUrls) {
    if (!urls) continue
    for (const url of urls) acceptedUrls.add(url)
  }
  return acceptedUrls
}

// 如果是 CommonJS 转成 ESM 的文件，在解析路径的时候会在路径上挂一个 es-interop 参数
// 比如：/xxx/yyy/zzz/node_modules/.vite/react.js?v=af73c26f&es-interop
export function interopNamedImports(
  str: MagicString,
  importSpecifier: ImportSpecifier,
  rewrittenUrl: string,
  importIndex: number,
  importer: string,
  config: ResolvedConfig,
): void {
  const source = str.original
  const {
    s: start,
    e: end,
    ss: expStart,
    se: expEnd,
    d: dynamicIndex,
  } = importSpecifier
  // 去除 url 上面的 &es-interop
  //'import React, { useState, createContext } from "react"'
  const exp = source.slice(expStart, expEnd)
  // 如果是动态引入的，重写方式如下
  if (dynamicIndex > -1) {
    // rewrite `import('package')` to expose the default directly
    str.overwrite(
      expStart,
      expEnd,
      `import('${rewrittenUrl}').then(m => m.default && m.default.__esModule ? m.default : ({ ...m.default, default: m.default }))` +
      getLineBreaks(exp),
      { contentOnly: true },
    )
  } else {
    // 获取原来的url如: 'react'
    const rawUrl = source.slice(start, end)
    // 调用 transformCjsImport 重写
    const rewritten = transformCjsImport(
      exp,
      rewrittenUrl,
      rawUrl,
      importIndex,
      importer,
      config,
    )
    if (rewritten) {
      str.overwrite(expStart, expEnd, rewritten + getLineBreaks(exp), {
        contentOnly: true,
      })
    } else {
      // #1439 export * from '...'
      str.overwrite(
        start,
        end,
        rewrittenUrl + getLineBreaks(source.slice(start, end)),
        {
          contentOnly: true,
        },
      )
    }
  }
}

// get line breaks to preserve line count for not breaking source maps
/**
这段代码定义了一个名为 getLineBreaks 的函数，它接受一个字符串参数 str。
该函数使用 includes 方法检查 str 是否包含换行符 '\n'。如果 str 包含换行符，函数使用 '\n'.repeat(str.split('\n').length - 1) 来创建一个新的字符串，其中包含 '\n' 字符重复 str.split('\n').length - 1 次。这将在 str 中每个换行符之前添加一个换行符，以便在输出结果中保留行分隔符。
如果 str 不包含换行符，函数返回一个空字符串 ''。
该函数的主要用途可能是在处理文本数据时，为了在输出结果中保留行分隔符，以便更好地显示文本的格式和结构。例如，在将文本输出到控制台或文件时，使用该函数可以确保行分隔符被正确地保留。
 */
function getLineBreaks(str: string) {
  return str.includes('\n') ? '\n'.repeat(str.split('\n').length - 1) : ''
}

type ImportNameSpecifier = { importedName: string; localName: string }

/**
 * Detect import statements to a known optimized CJS dependency and provide
 * ES named imports interop. We do this by rewriting named imports to a variable
 * assignment to the corresponding property on the `module.exports` of the cjs
 * module. Note this doesn't support dynamic re-assignments from within the cjs
 * module.
 *
 * Note that es-module-lexer treats `export * from '...'` as an import as well,
 * so, we may encounter ExportAllDeclaration here, in which case `undefined`
 * will be returned.
 *
 * Credits \@csr632 via #837
 */
// 返回一段新代码，这段新代码就可以实现导入；然后将之前的导入语句替换成这段新代码。
/**
import __vite__cjsImport0_react from '/node_modules/.vite/react.js?v=af73c26f'
const React = __vite__cjsImport0_react.__esModule ? __vite__cjsImport0_react.default : __vite__cjsImport0_react
const useState = __vite__cjsImport0_react['useState']
const createContext = __vite__cjsImport0_react['createContext']

将 main.js 里面的 `import React, { useState, createContext } from 'react'` 替换成上面这段代码

'import __vite__cjsImport0_react from "/node_modules/.vite/deps/react.js?v=158ff378";
const React = __vite__cjsImport0_react.__esModule ? __vite__cjsImport0_react.default : __vite__cjsImport0_react;
const useState = __vite__cjsImport0_react["useState"];
const createContext = __vite__cjsImport0_react["createContext"]'
 */
export function transformCjsImport(
  importExp: string, // import React, { useState, createContext } from 'react'
  url: string, // /node_modules/.vite/react.js?v=af73c26f
  rawUrl: string, //  react
  importIndex: number, // 0
  importer: string,
  config: ResolvedConfig,
): string | undefined {
  const node = (
    parseJS(importExp, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    }) as any
  ).body[0] as Node

  // `export * from '...'` may cause unexpected problem, so give it a warning
  if (
    config.command === 'serve' &&
    node.type === 'ExportAllDeclaration' &&
    !node.exported
  ) {
    config.logger.warn(
      colors.yellow(
        `\nUnable to interop \`${importExp}\` in ${importer}, this may lose module exports. Please export "${rawUrl}" as ESM or use named exports instead, e.g. \`export { A, B } from "${rawUrl}"\``,
      ),
    )
  } else if (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportNamedDeclaration'
  ) {
    if (!node.specifiers.length) {
      return `import "${url}"`
    }

    const importNames: ImportNameSpecifier[] = []
    const exportNames: string[] = []
    let defaultExports: string = ''
    for (const spec of node.specifiers) {
      if (
        spec.type === 'ImportSpecifier' &&
        spec.imported.type === 'Identifier'
      ) {
        const importedName = spec.imported.name
        const localName = spec.local.name
        importNames.push({ importedName, localName })
      } else if (spec.type === 'ImportDefaultSpecifier') {
        importNames.push({
          importedName: 'default',
          localName: spec.local.name,
        })
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        importNames.push({ importedName: '*', localName: spec.local.name })
      } else if (
        spec.type === 'ExportSpecifier' &&
        spec.exported.type === 'Identifier'
      ) {
        // for ExportSpecifier, local name is same as imported name
        // prefix the variable name to avoid clashing with other local variables
        const importedName = spec.local.name
        // we want to specify exported name as variable and re-export it
        const exportedName = spec.exported.name
        if (exportedName === 'default') {
          defaultExports = makeLegalIdentifier(
            `__vite__cjsExportDefault_${importIndex}`,
          )
          importNames.push({ importedName, localName: defaultExports })
        } else {
          const localName = makeLegalIdentifier(
            `__vite__cjsExport_${exportedName}`,
          )
          importNames.push({ importedName, localName })
          exportNames.push(`${localName} as ${exportedName}`)
        }
      }
    }

    // If there is multiple import for same id in one file,
    // importIndex will prevent the cjsModuleName to be duplicate
    const cjsModuleName = makeLegalIdentifier(
      `__vite__cjsImport${importIndex}_${rawUrl}`,
    )
    const lines: string[] = [`import ${cjsModuleName} from "${url}"`]
    importNames.forEach(({ importedName, localName }) => {
      if (importedName === '*') {
        lines.push(`const ${localName} = ${cjsModuleName}`)
      } else if (importedName === 'default') {
        lines.push(
          `const ${localName} = ${cjsModuleName}.__esModule ? ${cjsModuleName}.default : ${cjsModuleName}`,
        )
      } else {
        lines.push(`const ${localName} = ${cjsModuleName}["${importedName}"]`)
      }
    })
    if (defaultExports) {
      lines.push(`export default ${defaultExports}`)
    }
    if (exportNames.length) {
      lines.push(`export { ${exportNames.join(', ')} }`)
    }

    return lines.join('; ')
  }
}
