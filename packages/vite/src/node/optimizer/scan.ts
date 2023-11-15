import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import glob from 'fast-glob'
import type {
  BuildContext,
  BuildOptions,
  Loader,
  OnLoadResult,
  Plugin,
} from 'esbuild'
import esbuild, { formatMessages, transform } from 'esbuild'
import colors from 'picocolors'
import type { ResolvedConfig } from '..'
import {
  CSS_LANGS_RE,
  JS_TYPES_RE,
  KNOWN_ASSET_TYPES,
  SPECIAL_QUERY_RE,
} from '../constants'
import {
  cleanUrl,
  createDebugger,
  dataUrlRE,
  externalRE,
  isInNodeModules,
  isObject,
  isOptimizable,
  moduleListContains,
  multilineCommentsRE,
  normalizePath,
  singlelineCommentsRE,
  virtualModulePrefix,
  virtualModuleRE,
} from '../utils'
import type { PluginContainer } from '../server/pluginContainer'
import { createPluginContainer } from '../server/pluginContainer'
import { transformGlobImport } from '../plugins/importMetaGlob'

type ResolveIdOptions = Parameters<PluginContainer['resolveId']>[2]

const debug = createDebugger('vite:deps')

const htmlTypesRE = /\.(html|vue|svelte|astro|imba)$/

// A simple regex to detect import sources. This is only used on
// <script lang="ts"> blocks in vue (setup only) or svelte files, since
// seemingly unused imports are dropped by esbuild when transpiling TS which
// prevents it from crawling further.
// We can't use es-module-lexer because it can't handle TS, and don't want to
// use Acorn because it's slow. Luckily this doesn't have to be bullet proof
// since even missed imports can be caught at runtime, and false positives will
// simply be ignored.
export const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm

export function scanImports(config: ResolvedConfig): {
  cancel: () => Promise<void>
  result: Promise<{
    deps: Record<string, string>
    missing: Record<string, string>
  }>
} {
  // Only used to scan non-ssr code

  const start = performance.now()
  const deps: Record<string, string> = {}
  const missing: Record<string, string> = {}
  let entries: string[]

  const scanContext = { cancelled: false }

  // 计算入口
  const esbuildContext: Promise<BuildContext | undefined> = computeEntries(
    config,
  ).then((computedEntries) => {
    entries = computedEntries

    // 没有入口就直接返回了
    if (!entries.length) {
      if (!config.optimizeDeps.entries && !config.optimizeDeps.include) {
        config.logger.warn(
          colors.yellow(
            '(!) Could not auto-determine entry point from rollupOptions or html files ' +
            'and there are no explicit optimizeDeps.include patterns. ' +
            'Skipping dependency pre-bundling.',
          ),
        )
      }
      return
    }
    if (scanContext.cancelled) return

    debug?.(
      `Crawling dependencies using entries: ${entries
        .map((entry) => `\n  ${colors.dim(entry)}`)
        .join('')}`,
    )
    return prepareEsbuildScanner(config, entries, deps, missing, scanContext)
  })

  const result = esbuildContext
    .then((context) => {
      function disposeContext() {
        return context?.dispose().catch((e) => {
          config.logger.error('Failed to dispose esbuild context', { error: e })
        })
      }
      if (!context || scanContext?.cancelled) {
        disposeContext()
        return { deps: {}, missing: {} }
      }
      return context
        .rebuild()
        .then(() => {
          return {
            // Ensure a fixed order so hashes are stable and improve logs
            deps: orderedDependencies(deps),
            missing,
          }
        })
        .finally(() => {
          return disposeContext()
        })
    })
    .catch(async (e) => {
      if (e.errors && e.message.includes('The build was canceled')) {
        // esbuild logs an error when cancelling, but this is expected so
        // return an empty result instead
        return { deps: {}, missing: {} }
      }

      const prependMessage = colors.red(`\
  Failed to scan for dependencies from entries:
  ${entries.join('\n')}

  `)
      if (e.errors) {
        const msgs = await formatMessages(e.errors, {
          kind: 'error',
          color: true,
        })
        e.message = prependMessage + msgs.join('\n')
      } else {
        e.message = prependMessage + e.message
      }
      throw e
    })
    .finally(() => {
      if (debug) {
        const duration = (performance.now() - start).toFixed(2)
        const depsStr =
          Object.keys(orderedDependencies(deps))
            .sort()
            .map((id) => `\n  ${colors.cyan(id)} -> ${colors.dim(deps[id])}`)
            .join('') || colors.dim('no dependencies found')
        debug(`Scan completed in ${duration}ms: ${depsStr}`)
      }
    })

  return {
    cancel: async () => {
      scanContext.cancelled = true
      return esbuildContext.then((context) => context?.cancel())
    },
    result,
  }
}

// 计算入口
/**
如果有config.optimizeDeps.entries配置项，则入口文件从这里查找
如果有config.build.rollupOptions.input配置项，则入口文件从这里查找
上述两种都没有，在项目跟目录下查找html文件
 */
async function computeEntries(config: ResolvedConfig) {
  let entries: string[] = []
  // 一般都是用默认的 index.html
  // 默认情况下，Vite 会抓取你的 index.html 来检测需要预构建的依赖项。如果指定了 build.rollupOptions.input，Vite 将转而去抓取这些入口点。
  // 如果这两者都不适合你的需要，则可以使用此选项指定自定义条目，或者是相对于 vite 项目根的模式数组。这将覆盖掉默认条目推断。
  const explicitEntryPatterns = config.optimizeDeps.entries
  const buildInput = config.build.rollupOptions?.input

  if (explicitEntryPatterns) {
    // 如果配置了 config.optimizeDeps.entries
    // 在 config.root 下查找 explicitEntryPatterns 中对应的文件，并返回绝对路径
    entries = await globEntries(explicitEntryPatterns, config)
  } else if (buildInput) {
    // 如果配置了 build.rollupOptions.input
    const resolvePath = (p: string) => path.resolve(config.root, p)
    // 下面的逻辑都是将 buildInput 的路径修改为相对于 config.root 的路径
    if (typeof buildInput === 'string') {
      entries = [resolvePath(buildInput)]
    } else if (Array.isArray(buildInput)) {
      entries = buildInput.map(resolvePath)
    } else if (isObject(buildInput)) {
      entries = Object.values(buildInput).map(resolvePath)
    } else {
      throw new Error('invalid rollupOptions.input value.')
    }
  } else {
    // 查找 html 文件
    entries = await globEntries('**/*.html', config)
  }

  // Non-supported entry file types and virtual files should not be scanned for
  // dependencies.
  // 不支持的入口文件类型和虚拟文件不应该扫描依赖项。
  // 过滤非 .jsx .tsx .mjs .html .vue .svelte .astro 文件，并且文件必须存在
  entries = entries.filter(
    (entry) => isScannable(entry) && fs.existsSync(entry),
  )

  return entries
}

/**
 */
async function prepareEsbuildScanner(
  config: ResolvedConfig,
  entries: string[],
  deps: Record<string, string>,
  missing: Record<string, string>,
  scanContext?: { cancelled: boolean },
): Promise<BuildContext | undefined> {
  // 下面定义查找预构建模块需要的变量，比如插件容器container、esbuildScanPlugin插件、config.optimizeDeps.esbuildOptions 中定义的plugins和其他 ESbuild 配置项
  // 创建插件容器
  const container = await createPluginContainer(config)

  if (scanContext?.cancelled) return

  // 创建 esbuildScanPlugin 插件
  const plugin = esbuildScanPlugin(config, container, deps, missing, entries)

  // 获取 预构建的 plugins 和 配置项
  const {
    plugins = [],
    tsconfig,
    tsconfigRaw,
    ...esbuildOptions
  } = config.optimizeDeps?.esbuildOptions ?? {}

  // 接着就是调用 ESbuild 从入口模块开始构建整个项目，获取需要预构建的模块，并将依赖列表返回。其中会执行esbuildScanPlugin插件，这个插件就是查找的核心，
  // 打包 deps 中的文件
  return await esbuild.context({
    absWorkingDir: process.cwd(),
    write: false,
    stdin: {
      contents: entries.map((e) => `import ${JSON.stringify(e)}`).join('\n'),
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    plugins: [...plugins, plugin],
    tsconfig,
    tsconfigRaw: resolveTsconfigRaw(tsconfig, tsconfigRaw),
    ...esbuildOptions,
  })
}

function orderedDependencies(deps: Record<string, string>) {
  const depsList = Object.entries(deps)
  // Ensure the same browserHash for the same set of dependencies
  depsList.sort((a, b) => a[0].localeCompare(b[0]))
  return Object.fromEntries(depsList)
}

function globEntries(pattern: string | string[], config: ResolvedConfig) {
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      '**/node_modules/**',
      `**/${config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`]),
    ],
    absolute: true,
    suppressErrors: true, // suppress EACCES errors
  })
}

export const scriptRE =
  /(<script(?:\s+[a-z_:][-\w:]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^"'<>=\s]+))?)*\s*>)(.*?)<\/script>/gis
export const commentRE = /<!--.*?-->/gs
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/i

/**
esbuildScanPlugin方法返回一个插件对象；
定义了一个查找路径的resolve函数，和获取配置项中需要预构建的列表和忽略列表
这个插件会针对不同类型的文件做不同处理

esbuildScanPlugin插件的作用就是收集要进行预构建的模块。Vite 将从入口文件开始（默认是index.html）通过 ESbuild 抓取源码，并自动寻找引入的依赖项（即 "bare import"，表示期望从 node_modules 解析）
 */
function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[],
): Plugin {
  const seen = new Map<string, string | undefined>()

  // 通过 container.resolveId 处理 id，最终返回该模块的绝对路径
  // 并将这个模块路径添加到 seen 中，key 是 id + importer的上级目录，value是模块绝对路径
  const resolve = async (
    id: string,
    importer?: string,
    options?: ResolveIdOptions,
  ) => {
    const key = id + (importer && path.dirname(importer))
    if (seen.has(key)) {
      return seen.get(key)
    }
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        ...options,
        scan: true,
      },
    )
    const res = resolved?.id
    seen.set(key, res)
    return res
  }

  const include = config.optimizeDeps?.include
  // 忽略的包，在 config.optimizeDeps.exclude中写入的内容不会被依赖于构建
  // @vite/client 和 @vite/env 也不会被依赖预构建
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    '@vite/client',
    '@vite/env',
  ]

  // 设置 build.onResolve 钩子函数的返回值
  const externalUnlessEntry = ({ path }: { path: string }) => ({
    path, // 模块路径
    // 如果 entries 包含当前id，返回false
    // 如果 external 为 true，不会将当前模块打包到 bundle 中
    // 这段代码的意思是，如果当前模块包含在 entries 中，将这个模块打包到 bundle 中
    external: !entries.includes(path),
  })

  const doTransformGlobImport = async (
    contents: string,
    id: string,
    loader: Loader,
  ) => {
    let transpiledContents
    // transpile because `transformGlobImport` only expects js
    if (loader !== 'js') {
      transpiledContents = (await transform(contents, { loader })).code
    } else {
      transpiledContents = contents
    }

    const result = await transformGlobImport(
      transpiledContents,
      id,
      config.root,
      resolve,
      config.isProduction,
    )

    return result?.s.toString() || transpiledContents
  }

  return {
    name: 'vite:dep-scan',
    setup(build) {
      const scripts: Record<string, OnLoadResult> = {}

      // external urls
      // 如果是 http(s) 的外部文件，不打包到 bundle 中
      build.onResolve({ filter: externalRE }, ({ path }) => ({
        path,
        external: true,
      }))

      // data urls
      // 如果是以 data: 开头，不打包到 bundle 中
      build.onResolve({ filter: dataUrlRE }, ({ path }) => ({
        path,
        external: true,
      }))

      // local scripts (`<script>` in Svelte and `<script setup>` in Vue)
      build.onResolve({ filter: virtualModuleRE }, ({ path }) => {
        return {
          // strip prefix to get valid filesystem path so esbuild can resolve imports in the file
          path: path.replace(virtualModulePrefix, ''),
          namespace: 'script',
        }
      })

      build.onLoad({ filter: /.*/, namespace: 'script' }, ({ path }) => {
        return scripts[path]
      })

      // html types: extract script contents -----------------------------------
      // htmlTypesRE = /\.(html|vue|svelte|astro)$/
      // importer：绝对路径，该文件在哪个文件里被导入的
      // 设置路径，并设置 namespace 为 html
      build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
        const resolved = await resolve(path, importer)
        if (!resolved) return
        // It is possible for the scanner to scan html types in node_modules.
        // If we can optimize this html type, skip it so it's handled by the
        // bare import resolve, and recorded as optimization dep.
        if (
          isInNodeModules(resolved) &&
          isOptimizable(resolved, config.optimizeDeps)
        )
          return
        return {
          path: resolved,
          namespace: 'html',
        }
      })

      // extract scripts inside HTML-like files and treat it as a js module
      /**
这个钩子函数的主要作用就是将所有导入拼成一个字符串，并设置loader属性值；然后交给 ESbuild 处理，这样做的目的就是 ESbuild 会加载这些导入内容，并收集符合条件的模块。
HTML文件：
获取 HTML 中所有script标签，对于有src属性的，通过import()的形式拼接成字符串；对于内联的script标签，将内联代码拼接到字符串中，因为这里面可能包含导入代码，最后返回loader和content
Vue文件：和 HTML 文件大致相同，都是获取导入内容并返回loader和content
       */
      build.onLoad(
        { filter: htmlTypesRE, namespace: 'html' },
        async ({ path }) => {
          // 读取html、Vue内容
          let raw = await fsp.readFile(path, 'utf-8')
          // Avoid matching the content of the comment
          // 将注释内容替换成 <!---->
          raw = raw.replace(commentRE, '<!---->')
          // 如果是 .html 结尾，则为true
          const isHtml = path.endsWith('.html')
          // 重置 regex.lastIndex
          scriptRE.lastIndex = 0
          let js = ''
          let scriptId = 0
          let match: RegExpExecArray | null
          while ((match = scriptRE.exec(raw))) {
            const [, openTag, content] = match
            // 获取开始标签上的 type 内容
            const typeMatch = openTag.match(typeRE)
            const type =
              typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3])
            // 获取开始标签上的 lang 内容
            const langMatch = openTag.match(langRE)
            const lang =
              langMatch && (langMatch[1] || langMatch[2] || langMatch[3])
            // skip non type module script
            if (isHtml && type !== 'module') {
              continue
            }
            // skip type="application/ld+json" and other non-JS types
            if (
              type &&
              !(
                type.includes('javascript') ||
                type.includes('ecmascript') ||
                type === 'module'
              )
            ) {
              continue
            }
            let loader: Loader = 'js'
            // 不同文件设置不同 loader
            if (lang === 'ts' || lang === 'tsx' || lang === 'jsx') {
              loader = lang
            } else if (path.endsWith('.astro')) {
              loader = 'ts'
            }
            // 获取开始标签上的 src 内容
            const srcMatch = openTag.match(srcRE)
            // 将 src 或者 script 代码块内容添加到 js 字符串中
            if (srcMatch) {
              const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
              js += `import ${JSON.stringify(src)}\n`
            } else if (content.trim()) {
              // The reason why virtual modules are needed:
              // 1. There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
              // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
              // 2. There can be multiple module scripts in html
              // We need to handle these separately in case variable names are reused between them

              // append imports in TS to prevent esbuild from removing them
              // since they may be used in the template
              const contents =
                content +
                (loader.startsWith('ts') ? extractImportPaths(content) : '')

              const key = `${path}?id=${scriptId++}`
              if (contents.includes('import.meta.glob')) {
                scripts[key] = {
                  loader: 'js', // since it is transpiled
                  contents: await doTransformGlobImport(contents, path, loader),
                  pluginData: {
                    htmlType: { loader },
                  },
                }
              } else {
                scripts[key] = {
                  loader,
                  contents,
                  pluginData: {
                    htmlType: { loader },
                  },
                }
              }

              const virtualModulePath = JSON.stringify(
                virtualModulePrefix + key,
              )

              const contextMatch = openTag.match(contextRE)
              const context =
                contextMatch &&
                (contextMatch[1] || contextMatch[2] || contextMatch[3])

              // Especially for Svelte files, exports in <script context="module"> means module exports,
              // exports in <script> means component props. To avoid having two same export name from the
              // star exports, we need to ignore exports in <script>
              if (path.endsWith('.svelte') && context !== 'module') {
                js += `import ${virtualModulePath}\n`
              } else {
                js += `export * from ${virtualModulePath}\n`
              }
            }
          }

          // This will trigger incorrectly if `export default` is contained
          // anywhere in a string. Svelte and Astro files can't have
          // `export default` as code so we know if it's encountered it's a
          // false positive (e.g. contained in a string)
          if (!path.endsWith('.vue') || !js.includes('export default')) {
            js += '\nexport default {}'
          }

          return {
            loader: 'js',
            contents: js,
          }
        },
      )

      // 对第三方库的操作:
      /**
        如果模块导入路径以字母、数字、下划线、汉字、@开头，会被这个钩子函数捕获；获取模块绝对路径；如果模块路径包含node_modules子字符串，或者该模块在include中存在，并且是mjs、js、ts文件，则将这个模块添加到depImports中
        如果根据传入的id没有解析到模块路径，添加到missing中
       */
      // bare imports: record and externalize ----------------------------------
      build.onResolve(
        {
          // avoid matching windows volume
          filter: /^[\w@][^:]/,
        },
        async ({ path: id, importer, pluginData }) => {
          // 判断引入的第三方模块是不是包含在 exclude 中
          if (moduleListContains(exclude, id)) {
            return externalUnlessEntry({ path: id })
          }
          // 如果当前模块已经被收集
          if (depImports[id]) {
            return externalUnlessEntry({ path: id })
          }
          // 获取 第三方模块的绝对路径
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          })
          if (resolved) {
            // 虚拟路径、非绝对路径、非 .jsx .tsx .mjs .html .vue .svelte .astro 文件返回 true
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id })
            }
            // TODO: 重点！！！！ 这里进行收集第三方依赖
            // 如果路径包含 node_modules 子字符串，或者该文件在 include 中存在
            if (isInNodeModules(resolved) || include?.includes(id)) {
              // dependency or forced included, externalize and stop crawling
              if (isOptimizable(resolved, config.optimizeDeps)) {
                // 添加到 depImports 中
                depImports[id] = resolved
              }
              // 如果当前id，比如 vue，没有包含在entries时不将此文件打包到 bundle 中，反之打包
              return externalUnlessEntry({ path: id })
            } else if (isScannable(resolved)) {
              const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined
              // linked package, keep crawling
              return {
                path: path.resolve(resolved),
                namespace,
              }
            } else {
              return externalUnlessEntry({ path: id })
            }
          } else {
            // 说明没找到 id 对应的模块
            missing[id] = normalizePath(importer)
          }
        },
      )

      // Externalized file types -----------------------------------------------
      // these are done on raw ids using esbuild's native regex filter so it
      // should be faster than doing it in the catch-all via js
      // they are done after the bare import resolve because a package name
      // may end with these extensions

      // css
      build.onResolve({ filter: CSS_LANGS_RE }, externalUnlessEntry)

      // json & wasm
      build.onResolve({ filter: /\.(json|json5|wasm)$/ }, externalUnlessEntry)

      // known asset types
      build.onResolve(
        {
          filter: new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})$`),
        },
        externalUnlessEntry,
      )

      // known vite query types: ?worker, ?raw
      build.onResolve({ filter: SPECIAL_QUERY_RE }, ({ path }) => ({
        path,
        external: true, // 不注入 boundle 中
      }))

      // catch all -------------------------------------------------------------

      build.onResolve(
        {
          filter: /.*/,
        },
        async ({ path: id, importer, pluginData }) => {
          // use vite resolver to support urls and omitted extensions
          const resolved = await resolve(id, importer, {
            custom: {
              depScan: { loader: pluginData?.htmlType?.loader },
            },
          })
          if (resolved) {
            if (shouldExternalizeDep(resolved, id) || !isScannable(resolved)) {
              return externalUnlessEntry({ path: id })
            }

            const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined

            return {
              path: path.resolve(cleanUrl(resolved)),
              namespace,
            }
          } else {
            // resolve failed... probably unsupported type
            return externalUnlessEntry({ path: id })
          }
        },
      )

      // for jsx/tsx, we need to access the content and check for
      // presence of import.meta.glob, since it results in import relationships
      // but isn't crawled by esbuild.
      // 通过onload钩子函数，判断有没有配置jsxInject选项，如果有将这个选项内容添加到代码中
      build.onLoad({ filter: JS_TYPES_RE }, async ({ path: id }) => {
        let ext = path.extname(id).slice(1)
        if (ext === 'mjs') ext = 'js'

        let contents = await fsp.readFile(id, 'utf-8')
        // 如果是 tsx、jsx并且配置了 jsxInject，则将 jsxInject 注入到代码中
        if (ext.endsWith('x') && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents
        }

        const loader =
          config.optimizeDeps?.esbuildOptions?.loader?.[`.${ext}`] ||
          (ext as Loader)

        if (contents.includes('import.meta.glob')) {
          return {
            loader: 'js', // since it is transpiled,
            contents: await doTransformGlobImport(contents, id, loader),
          }
        }

        return {
          loader,
          contents,
        }
      })
    },
  }
}

/**
 * when using TS + (Vue + `<script setup>`) or Svelte, imports may seem
 * unused to esbuild and dropped in the build output, which prevents
 * esbuild from crawling further.
 * the solution is to add `import 'x'` for every source to force
 * esbuild to keep crawling due to potential side effects.
 */
function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  code = code
    .replace(multilineCommentsRE, '/* */')
    .replace(singlelineCommentsRE, '')

  let js = ''
  let m
  importsRE.lastIndex = 0
  while ((m = importsRE.exec(code)) != null) {
    js += `\nimport ${m[1]}`
  }
  return js
}

function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  // not a valid file path
  if (!path.isAbsolute(resolvedId)) {
    return true
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes('\0')) {
    return true
  }
  return false
}

function isScannable(id: string): boolean {
  // From Vite 5, all optimizeDeps.extensions are scannable. We hardcode .marko for 4.5.0 to avoid
  // potential regressions. See https://github.com/vitejs/vite/pull/14543
  return (
    JS_TYPES_RE.test(id) ||
    htmlTypesRE.test(id) ||
    path.extname(id) === '.marko'
  )
}

// esbuild v0.18 only transforms decorators when `experimentalDecorators` is set to `true`.
// To preserve compat with the esbuild breaking change, we set `experimentalDecorators` to
// `true` by default if it's unset.
// TODO: Remove this in Vite 5 and check https://github.com/vitejs/vite/pull/13805#issuecomment-1633612320
export function resolveTsconfigRaw(
  tsconfig: string | undefined,
  tsconfigRaw: BuildOptions['tsconfigRaw'],
): BuildOptions['tsconfigRaw'] {
  return tsconfig || typeof tsconfigRaw === 'string'
    ? tsconfigRaw
    : {
      ...tsconfigRaw,
      compilerOptions: {
        experimentalDecorators: true,
        ...tsconfigRaw?.compilerOptions,
      },
    }
}
