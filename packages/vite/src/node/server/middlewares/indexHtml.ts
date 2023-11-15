import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import MagicString from 'magic-string'
import type { SourceMapInput } from 'rollup'
import type { Connect } from 'dep-types/connect'
import type { DefaultTreeAdapterMap, Token } from 'parse5'
import type { IndexHtmlTransformHook } from '../../plugins/html'
import {
  addToHTMLProxyCache,
  applyHtmlTransforms,
  assetAttrsConfig,
  getAttrKey,
  getScriptInfo,
  htmlEnvHook,
  nodeIsElement,
  overwriteAttrValue,
  postImportMapHook,
  preImportMapHook,
  resolveHtmlTransforms,
  traverseHtml,
} from '../../plugins/html'
import type { ResolvedConfig, ViteDevServer } from '../..'
import { send } from '../send'
import { CLIENT_PUBLIC_PATH, FS_PREFIX } from '../../constants'
import {
  cleanUrl,
  ensureWatchedFile,
  fsPathFromId,
  injectQuery,
  isJSRequest,
  joinUrlSegments,
  normalizePath,
  processSrcSetSync,
  stripBase,
  unwrapId,
  wrapId,
} from '../../utils'
import { ERR_CLOSED_SERVER } from '../pluginContainer'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../../plugins/optimizedDeps'
import { isCSSRequest } from '../../plugins/css'
import { checkPublicFile } from '../../plugins/asset'
import { getCodeWithSourcemap, injectSourcesContent } from '../sourcemap'

interface AssetNode {
  start: number
  end: number
  code: string
}

// createDevHtmlTransformFn函数遍历所有插件，获取插件中定义的transformIndexHtml，并根据规则划分为postHooks和preHooks，并返回一个匿名函数。
export function createDevHtmlTransformFn(
  server: ViteDevServer,
): (url: string, html: string, originalUrl: string) => Promise<string> {
  // 遍历所有 plugin，获取 plugin.transformIndexHtml
  // 如果 plugin.transformIndexHtml 是一个函数，添加到 postHooks中
  // 如果 plugin.transformIndexHtml 是一个对象并且 transformIndexHtml.enforce === 'pre'，添加到 preHooks 中
  // 如果 plugin.transformIndexHtml 是一个对象并且 transformIndexHtml.enforce !== 'pre'，添加到 postHooks 中
  const [preHooks, normalHooks, postHooks] = resolveHtmlTransforms(
    server.config.plugins,
  )
  return (url: string, html: string, originalUrl: string): Promise<string> => {
    /**
     * applyHtmlTransforms就是按顺序调用传入的函数，如果传入的函数返回值中有tags属性，是一个数组；遍历这个数组，根据injectTo属性分类，将这些tag分别加入bodyTags、bodyPrependTags、headTags和headPrependTags中。所有函数执行完后，再调用injectToHead、injectToBody插入html中，最后返回转换后的html
     */
    return applyHtmlTransforms(
      html,
      [
        preImportMapHook(server.config),
        ...preHooks,
        htmlEnvHook(server.config),
        devHtmlHook,
        ...normalHooks,
        ...postHooks,
        postImportMapHook(),
      ],
      {
        path: url,
        filename: getHtmlFilename(url, server),
        server,
        originalUrl,
      },
    )
  }
}

function getHtmlFilename(url: string, server: ViteDevServer) {
  if (url.startsWith(FS_PREFIX)) {
    return decodeURIComponent(fsPathFromId(url))
  } else {
    return decodeURIComponent(
      normalizePath(path.join(server.config.root, url.slice(1))),
    )
  }
}

function shouldPreTransform(url: string, config: ResolvedConfig) {
  return (
    !checkPublicFile(url, config) && (isJSRequest(url) || isCSSRequest(url))
  )
}

const processNodeUrl = (
  attr: Token.Attribute,
  sourceCodeLocation: Token.Location,
  s: MagicString,
  config: ResolvedConfig,
  htmlPath: string,
  originalUrl?: string,
  server?: ViteDevServer,
) => {
  let url = attr.value || ''

  if (server?.moduleGraph) {
    const mod = server.moduleGraph.urlToModuleMap.get(url)
    if (mod && mod.lastHMRTimestamp > 0) {
      url = injectQuery(url, `t=${mod.lastHMRTimestamp}`)
    }
  }
  const devBase = config.base
  if (url[0] === '/' && url[1] !== '/') {
    // prefix with base (dev only, base is never relative)
    const fullUrl = path.posix.join(devBase, url)
    overwriteAttrValue(s, sourceCodeLocation, fullUrl)
    if (server && shouldPreTransform(url, config)) {
      preTransformRequest(server, fullUrl, devBase)
    }
  } else if (
    url[0] === '.' &&
    originalUrl &&
    originalUrl !== '/' &&
    htmlPath === '/index.html'
  ) {
    // prefix with base (dev only, base is never relative)
    const replacer = (url: string) => {
      const fullUrl = path.posix.join(devBase, url)
      if (server && shouldPreTransform(url, config)) {
        preTransformRequest(server, fullUrl, devBase)
      }
      return fullUrl
    }

    // #3230 if some request url (localhost:3000/a/b) return to fallback html, the relative assets
    // path will add `/a/` prefix, it will caused 404.
    // rewrite before `./index.js` -> `localhost:5173/a/index.js`.
    // rewrite after `../index.js` -> `localhost:5173/index.js`.

    const processedUrl =
      attr.name === 'srcset' && attr.prefix === undefined
        ? processSrcSetSync(url, ({ url }) => replacer(url))
        : replacer(url)
    overwriteAttrValue(s, sourceCodeLocation, processedUrl)
  }
}
// devHtmlHook会将HTML转换成AST；处理引入的文件路径和行内js；还会将客户端接受热更新的代码注入。
const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server, originalUrl },
) => {
  const { config, moduleGraph, watcher } = server!
  const base = config.base || '/'
  htmlPath = decodeURI(htmlPath)

  let proxyModulePath: string
  let proxyModuleUrl: string

  const trailingSlash = htmlPath.endsWith('/')
  if (!trailingSlash && fs.existsSync(filename)) {
    proxyModulePath = htmlPath
    proxyModuleUrl = joinUrlSegments(base, htmlPath)
  } else {
    // There are users of vite.transformIndexHtml calling it with url '/'
    // for SSR integrations #7993, filename is root for this case
    // A user may also use a valid name for a virtual html file
    // Mark the path as virtual in both cases so sourcemaps aren't processed
    // and ids are properly handled
    const validPath = `${htmlPath}${trailingSlash ? 'index.html' : ''}`
    proxyModulePath = `\0${validPath}`
    proxyModuleUrl = wrapId(proxyModulePath)
  }

  const s = new MagicString(html)
  let inlineModuleIndex = -1
  const proxyCacheUrl = cleanUrl(proxyModulePath).replace(
    normalizePath(config.root),
    '',
  )
  const styleUrl: AssetNode[] = []

  const addInlineModule = (
    node: DefaultTreeAdapterMap['element'],
    ext: 'js',
  ) => {
    inlineModuleIndex++

    const contentNode = node.childNodes[0] as DefaultTreeAdapterMap['textNode']

    const code = contentNode.value

    let map: SourceMapInput | undefined
    if (proxyModulePath[0] !== '\0') {
      map = new MagicString(html)
        .snip(
          contentNode.sourceCodeLocation!.startOffset,
          contentNode.sourceCodeLocation!.endOffset,
        )
        .generateMap({ hires: 'boundary' })
      map.sources = [filename]
      map.file = filename
    }

    // add HTML Proxy to Map
    addToHTMLProxyCache(config, proxyCacheUrl, inlineModuleIndex, { code, map })

    // inline js module. convert to src="proxy" (dev only, base is never relative)
    const modulePath = `${proxyModuleUrl}?html-proxy&index=${inlineModuleIndex}.${ext}`

    // invalidate the module so the newly cached contents will be served
    const module = server?.moduleGraph.getModuleById(modulePath)
    if (module) {
      server?.moduleGraph.invalidateModule(module)
    }
    s.update(
      node.sourceCodeLocation!.startOffset,
      node.sourceCodeLocation!.endOffset,
      `<script type="module" src="${modulePath}"></script>`,
    )
    preTransformRequest(server!, modulePath, base)
  }

  // 将传入的html交给traverseHtml处理()
  await traverseHtml(html, filename, (node) => {
    if (!nodeIsElement(node)) {
      return
    }

    // script tags
    if (node.nodeName === 'script') {
      const { src, sourceCodeLocation, isModule } = getScriptInfo(node)

      if (src) {
        processNodeUrl(
          src,
          sourceCodeLocation!,
          s,
          config,
          htmlPath,
          originalUrl,
          server,
        )
      } else if (isModule && node.childNodes.length) {
        addInlineModule(node, 'js')
      }
    }

    if (node.nodeName === 'style' && node.childNodes.length) {
      const children = node.childNodes[0] as DefaultTreeAdapterMap['textNode']
      styleUrl.push({
        start: children.sourceCodeLocation!.startOffset,
        end: children.sourceCodeLocation!.endOffset,
        code: children.value,
      })
    }

    // elements with [href/src] attrs
    const assetAttrs = assetAttrsConfig[node.nodeName]
    if (assetAttrs) {
      for (const p of node.attrs) {
        const attrKey = getAttrKey(p)
        if (p.value && assetAttrs.includes(attrKey)) {
          processNodeUrl(
            p,
            node.sourceCodeLocation!.attrs![attrKey],
            s,
            config,
            htmlPath,
            originalUrl,
          )
        }
      }
    }
  })

  await Promise.all(
    styleUrl.map(async ({ start, end, code }, index) => {
      const url = `${proxyModulePath}?html-proxy&direct&index=${index}.css`

      // ensure module in graph after successful load
      const mod = await moduleGraph.ensureEntryFromUrl(url, false)
      ensureWatchedFile(watcher, mod.file, config.root)

      const result = await server!.pluginContainer.transform(code, mod.id!)
      let content = ''
      if (result) {
        if (result.map) {
          if (result.map.mappings) {
            await injectSourcesContent(
              result.map,
              proxyModulePath,
              config.logger,
            )
          }
          content = getCodeWithSourcemap('css', result.code, result.map)
        } else {
          content = result.code
        }
      }
      s.overwrite(start, end, content)
    }),
  )

  html = s.toString()

  return {
    html,
    tags: [
      {
        tag: 'script',
        attrs: {
          type: 'module',
          src: path.posix.join(base, CLIENT_PUBLIC_PATH),
        },
        injectTo: 'head-prepend',
      },
    ],
  }
}

// indexHtmlMiddleware这个中间件的作用就是处理html文件，首先获取html文件的绝对路径，根据绝对路径获取html字符串。
export function indexHtmlMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (res.writableEnded) {
      return next()
    }
    // 获取url，/ 被 htmlFallbackMiddleware 处理成了 /index.html
    // 所以这里的 url 就是 /index.html
    const url = req.url && cleanUrl(req.url)
    // htmlFallbackMiddleware appends '.html' to URLs
    if (url?.endsWith('.html') && req.headers['sec-fetch-dest'] !== 'script') {
      // 根据 config.root 获取 html 文件的绝对路径
      const filename = getHtmlFilename(url, server)
      if (fs.existsSync(filename)) {
        try {
          // 获取 html 文件内容
          let html = await fsp.readFile(filename, 'utf-8')
          // 接下来调用server.transformIndexHtml函数转换 HTML(其实就是上面的createDevHtmlTransformFn这个函数 )，最后返回给客户端
          html = await server.transformIndexHtml(url, html, req.originalUrl)
          return send(req, res, html, 'html', {
            headers: server.config.server.headers,
          })
        } catch (e) {
          return next(e)
        }
      }
    }
    next()
  }
}

function preTransformRequest(server: ViteDevServer, url: string, base: string) {
  if (!server.config.server.preTransformRequests) return

  url = unwrapId(stripBase(url, base))

  // transform all url as non-ssr as html includes client-side assets only
  server.transformRequest(url).catch((e) => {
    if (
      e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
      e?.code === ERR_CLOSED_SERVER
    ) {
      // these are expected errors
      return
    }
    // Unexpected error, log the issue but avoid an unhandled exception
    server.config.logger.error(e.message)
  })
}
