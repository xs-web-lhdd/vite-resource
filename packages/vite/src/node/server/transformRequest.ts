import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import getEtag from 'etag'
import convertSourceMap from 'convert-source-map'
import type { PartialResolvedId, SourceDescription, SourceMap } from 'rollup'
import colors from 'picocolors'
import type { ModuleNode, ViteDevServer } from '..'
import {
  blankReplacer,
  cleanUrl,
  createDebugger,
  ensureWatchedFile,
  isObject,
  prettifyUrl,
  removeTimestampQuery,
  timeFrom,
} from '../utils'
import { checkPublicFile } from '../plugins/asset'
import { getDepsOptimizer } from '../optimizer'
import { applySourcemapIgnoreList, injectSourcesContent } from './sourcemap'
import { isFileServingAllowed } from './middlewares/static'
import { throwClosedServerError } from './pluginContainer'

export const ERR_LOAD_URL = 'ERR_LOAD_URL'
export const ERR_LOAD_PUBLIC_URL = 'ERR_LOAD_PUBLIC_URL'

const debugLoad = createDebugger('vite:load')
const debugTransform = createDebugger('vite:transform')
const debugCache = createDebugger('vite:cache')

export interface TransformResult {
  code: string
  map: SourceMap | null
  etag?: string
  deps?: string[]
  dynamicDeps?: string[]
}

export interface TransformOptions {
  ssr?: boolean
  html?: boolean
}

export function transformRequest(
  url: string,
  server: ViteDevServer,
  options: TransformOptions = {},
): Promise<TransformResult | null> {
  if (server._restartPromise && !options.ssr) throwClosedServerError()

  const cacheKey = (options.ssr ? 'ssr:' : options.html ? 'html:' : '') + url

  // This module may get invalidated while we are processing it. For example
  // when a full page reload is needed after the re-processing of pre-bundled
  // dependencies when a missing dep is discovered. We save the current time
  // to compare it to the last invalidation performed to know if we should
  // cache the result of the transformation or we should discard it as stale.
  //
  // A module can be invalidated due to:
  // 1. A full reload because of pre-bundling newly discovered deps
  // 2. A full reload after a config change
  // 3. The file that generated the module changed
  // 4. Invalidation for a virtual module
  //
  // For 1 and 2, a new request for this module will be issued after
  // the invalidation as part of the browser reloading the page. For 3 and 4
  // there may not be a new request right away because of HMR handling.
  // In all cases, the next time this module is requested, it should be
  // re-processed.
  //
  // We save the timestamp when we start processing and compare it with the
  // last time this module is invalidated
  const timestamp = Date.now()

  // 是否正在请求
  const pending = server._pendingRequests.get(cacheKey)
  if (pending) {
    return server.moduleGraph
      .getModuleByUrl(removeTimestampQuery(url), options.ssr)
      .then((module) => {
        if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
          // The pending request is still valid, we can safely reuse its result
          return pending.request
        } else {
          // Request 1 for module A     (pending.timestamp)
          // Invalidate module A        (module.lastInvalidationTimestamp)
          // Request 2 for module A     (timestamp)

          // First request has been invalidated, abort it to clear the cache,
          // then perform a new doTransform.
          pending.abort()
          return transformRequest(url, server, options)
        }
      })
  }

  // doTransform 返回一个 Promise 对象
  const request = doTransform(url, server, options, timestamp)

  // 如果请求被放弃，避免清除未来请求的缓存。
  let cleared = false
  const clearCache = () => {
    if (!cleared) {
      server._pendingRequests.delete(cacheKey)
      cleared = true
    }
  }

  // 缓存请求并在处理完成后清除它。
  server._pendingRequests.set(cacheKey, {
    request,
    timestamp,
    abort: clearCache,
  })

  return request.finally(clearCache)
}

/**
doTransform函数会调用所有插件的resolveId钩子函数获取文件的绝对路径，
然后创建/获取该文件的ModuleNode对象，并调用所有插件的load钩子函数，如果某个钩子函数有返回值，则这个返回值就是该文件的源码；
如果没有返回值就根据绝对路径读取文件内容，最后调用所有插件的transform钩子函数转换源码。
这个过程中会调用一个很重要的插件importAnalysis这个插件的作用主要作用是为该文件创建模块对象、设置模块之间的引用关系、解析代码中的导入路径；还会处理热更新相关逻辑。
最后，doTransform 函数返回转换后的代码、map信息和 etag值
 */
async function doTransform(
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number,
) {
  url = removeTimestampQuery(url)

  const { config, pluginContainer } = server
  const prettyUrl = debugCache ? prettifyUrl(url, config.root) : ''
  const ssr = !!options.ssr
  // 获取当前文件对应的 ModuleNode 对象
  const module = await server.moduleGraph.getModuleByUrl(url, ssr)

  // 判断有无缓存，如果有则返回，获取当前文件转换后的代码，
  // check if we have a fresh cache
  const cached =
    module && (ssr ? module.ssrTransformResult : module.transformResult)
  if (cached) {
    // TODO: check if the module is "partially invalidated" - i.e. an import
    // down the chain has been fully invalidated, but this current module's
    // content has not changed.
    // in this case, we can reuse its previous cached result and only update
    // its import timestamps.

    debugCache?.(`[memory] ${prettyUrl}`)
    return cached
  }

  // 调用所有插件的 resolveId 钩子函数，获取请求文件在项目中的绝对路径
  // /xxx/yyy/zzz/src/main.ts
  const resolved = module
    ? undefined
    : (await pluginContainer.resolveId(url, undefined, { ssr })) ?? undefined

  // 去掉 id 中的 query 和 hash
  // resolve
  const id = module?.id ?? resolved?.id ?? url

  // 执行load 和 transform 钩子函数
  const result = loadAndTransform(
    id,
    url,
    server,
    options,
    timestamp,
    module,
    resolved,
  )

  getDepsOptimizer(config, ssr)?.delayDepsOptimizerUntil(id, () => result)

  return result
}
// load钩子和transform钩子的执行
async function loadAndTransform(
  id: string,
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number,
  mod?: ModuleNode,
  resolved?: PartialResolvedId,
) {
  const { config, pluginContainer, moduleGraph, watcher } = server
  const { root, logger } = config
  const prettyUrl =
    debugLoad || debugTransform ? prettifyUrl(url, config.root) : ''
  const ssr = !!options.ssr

  const file = cleanUrl(id)

  let code: string | null = null
  let map: SourceDescription['map'] = null

  // 调用所有插件的load钩子函数，如果有插件返回，直接返回结果；剩余插件停止执行。
  // 调用所有插件的 load 钩子函数，如果所有插件的 load 钩子函数都没有处理过该文件，则返回 null
  // load
  const loadStart = debugLoad ? performance.now() : 0
  const loadResult = await pluginContainer.load(id, { ssr })
  if (loadResult == null) {
    // 如果这是一个 HTML 请求并且没有加载结果，跳过并直接进入 SPA 回退
    if (options.html && !id.endsWith('.html')) {
      return null
    }
    /**
如果文件是二进制文件，并且已经有插件将其作为字符串加载，则尝试从文件系统中回退加载它。只有在允许访问的情况下才尝试回退，对于根 URL 之外的路径（如/service-worker.js 或/api/users）则跳过回退。
这段文字描述了一种处理文件加载的策略。如果文件是二进制文件，并且已经有插件将其作为字符串加载，则可以尝试从文件系统中回退加载它。但是，只有在允许访问的情况下才尝试回退，对于根 URL 之外的路径则跳过回退。
这种策略可能用于处理一些特定的文件加载情况，例如在浏览器中加载 Service Worker 文件或 API 接口文件等。在这种情况下，如果文件加载失败，可以尝试从文件系统中加载回退版本的文件，以确保应用程序的正常运行。但是，为了保证安全性，对于根 URL 之外的路径，可能不允许回退加载，以避免恶意文件的加载和执行。
     */
    if (options.ssr || isFileServingAllowed(file, server)) {
      try {
        // 读取文件中的代码
        code = await fsp.readFile(file, 'utf-8')
        debugLoad?.(`${timeFrom(loadStart)} [fs] ${prettyUrl}`)
      } catch (e) {
        if (e.code !== 'ENOENT') {
          if (e.code === 'EISDIR') {
            e.message = `${e.message} ${file}`
          }
          throw e
        }
      }
    }
    if (code) {
      try {
        map = (
          convertSourceMap.fromSource(code) ||
          (await convertSourceMap.fromMapFileSource(
            code,
            createConvertSourceMapReadMap(file),
          ))
        )?.toObject()

        code = code.replace(convertSourceMap.mapFileCommentRegex, blankReplacer)
      } catch (e) {
        logger.warn(`Failed to load source map for ${url}.`, {
          timestamp: true,
        })
      }
    }
  } else {
    debugLoad?.(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`)
    // 获取 code 和 map
    if (isObject(loadResult)) {
      code = loadResult.code
      map = loadResult.map
    } else {
      code = loadResult
    }
  }
  // code为空,进行报错
  if (code == null) {
    const isPublicFile = checkPublicFile(url, config)
    const msg = isPublicFile
      ? `This file is in /public and will be copied as-is during build without ` +
      `going through the plugin transforms, and therefore should not be ` +
      `imported from source code. It can only be referenced via HTML tags.`
      : `Does the file exist?`
    const importerMod: ModuleNode | undefined = server.moduleGraph.idToModuleMap
      .get(id)
      ?.importers.values()
      .next().value
    const importer = importerMod?.file || importerMod?.url
    const err: any = new Error(
      `Failed to load url ${url} (resolved id: ${id})${importer ? ` in ${importer}` : ''
      }. ${msg}`,
    )
    err.code = isPublicFile ? ERR_LOAD_PUBLIC_URL : ERR_LOAD_URL
    throw err
  }

  if (server._restartPromise && !ssr) throwClosedServerError()

  // 创建/获取当前文件的 ModuleNode 对象,并进行一系列存储
  mod ??= await moduleGraph._ensureEntryFromUrl(url, ssr, undefined, resolved)
  // 如果该文件的位置不在项目根路径以内，则添加监听
  ensureWatchedFile(watcher, mod.file, root)

  // transform
  const transformStart = debugTransform ? performance.now() : 0
  const transformResult = await pluginContainer.transform(code, id, {
    inMap: map,
    ssr,
  })
  const originalCode = code
  if (
    transformResult == null ||
    (isObject(transformResult) && transformResult.code == null)
  ) {
    // no transform applied, keep code as-is
    debugTransform?.(
      timeFrom(transformStart) + colors.dim(` [skipped] ${prettyUrl}`),
    )
  } else {
    debugTransform?.(`${timeFrom(transformStart)} ${prettyUrl}`)
    // 拿到转换后的code和map
    code = transformResult.code!
    map = transformResult.map
  }

  if (map && mod.file) {
    map = (typeof map === 'string' ? JSON.parse(map) : map) as SourceMap
    if (map.mappings) {
      // 把sourcemap注入到代码中
      await injectSourcesContent(map, mod.file, logger)
    }

    const sourcemapPath = `${mod.file}.map`
    applySourcemapIgnoreList(
      map,
      sourcemapPath,
      config.server.sourcemapIgnoreList,
      logger,
    )

    if (path.isAbsolute(mod.file)) {
      for (
        let sourcesIndex = 0;
        sourcesIndex < map.sources.length;
        ++sourcesIndex
      ) {
        const sourcePath = map.sources[sourcesIndex]
        if (sourcePath) {
          // Rewrite sources to relative paths to give debuggers the chance
          // to resolve and display them in a meaningful way (rather than
          // with absolute paths).
          if (path.isAbsolute(sourcePath)) {
            map.sources[sourcesIndex] = path.relative(
              path.dirname(mod.file),
              sourcePath,
            )
          }
        }
      }
    }
  }

  if (server._restartPromise && !ssr) throwClosedServerError()

  // 最终返回的结果
  const result =
    ssr && !server.config.experimental.skipSsrTransform
      ? await server.ssrTransform(code, map as SourceMap, url, originalCode)
      : ({
        code,
        map,
        etag: getEtag(code, { weak: true }),
      } as TransformResult)

  // 仅在模块处理过程中未被失效的情况下才缓存结果，以便在下次失效时重新处理。
  if (timestamp > mod.lastInvalidationTimestamp) {
    if (ssr) mod.ssrTransformResult = result
    else mod.transformResult = result
  }

  return result
}

function createConvertSourceMapReadMap(originalFileName: string) {
  return (filename: string) => {
    return fsp.readFile(
      path.resolve(path.dirname(originalFileName), filename),
      'utf-8',
    )
  }
}
