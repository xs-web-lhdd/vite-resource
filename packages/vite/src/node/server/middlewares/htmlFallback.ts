import fs from 'node:fs'
import path from 'node:path'
// 当出现符合条件的请求时，它将把请求定位到指定的索引文件。这里就是/index.html，一般用于解决单页面应用程序 (SPA)刷新或直接通过输入地址的方式访问页面时返回404的问题。
import history from 'connect-history-api-fallback'
import type { Connect } from 'dep-types/connect'
import { createDebugger } from '../../utils'

// 但是这个中间件只匹配/，也就是说如果访问的是localhost:3000/，会被匹配成/index.html
export function htmlFallbackMiddleware(
  root: string,
  spaFallback: boolean,
): Connect.NextHandleFunction {
  const historyHtmlFallbackMiddleware = history({
    logger: createDebugger('vite:html-fallback'),
    // support /dir/ without explicit index.html
    rewrites: [
      {
        from: /\/$/,
        to({ parsedUrl, request }: any) {
          // 如果匹配，则重写路由
          const rewritten =
            decodeURIComponent(parsedUrl.pathname) + 'index.html'

          if (fs.existsSync(path.join(root, rewritten))) {
            return rewritten
          }

          return spaFallback ? `/index.html` : request.url
        },
      },
    ],
  })

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteHtmlFallbackMiddleware(req, res, next) {
    return historyHtmlFallbackMiddleware(req, res, next)
  }
}
