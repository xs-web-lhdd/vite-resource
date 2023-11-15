/**
 * This file is refactored into TypeScript based on
 * https://github.com/preactjs/wmr/blob/main/packages/wmr/src/lib/rollup-plugin-container.js
 */

/**
https://github.com/preactjs/wmr/blob/master/LICENSE

MIT License

Copyright (c) 2020 The Preact Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import fs from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { VERSION as rollupVersion } from 'rollup'
// 从 rollup 中导出 PluginContext 接口
import type {
  AsyncPluginHooks,
  CustomPluginOptions,
  EmittedFile,
  FunctionPluginHooks,
  InputOptions,
  LoadResult,
  MinimalPluginContext,
  ModuleInfo,
  ModuleOptions,
  NormalizedInputOptions,
  OutputOptions,
  ParallelPluginHooks,
  PartialNull,
  PartialResolvedId,
  ResolvedId,
  RollupError,
  RollupLog,
  PluginContext as RollupPluginContext,
  SourceDescription,
  SourceMap,
  TransformResult,
} from 'rollup'
import * as acorn from 'acorn'
import type { RawSourceMap } from '@ampproject/remapping'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import MagicString from 'magic-string'
import type { FSWatcher } from 'chokidar'
import colors from 'picocolors'
import type * as postcss from 'postcss'
import type { Plugin } from '../plugin'
import {
  arraify,
  cleanUrl,
  combineSourcemaps,
  createDebugger,
  ensureWatchedFile,
  generateCodeFrame,
  isExternalUrl,
  isObject,
  normalizePath,
  numberToPos,
  prettifyUrl,
  timeFrom,
  unwrapId,
} from '../utils'
import { FS_PREFIX } from '../constants'
import type { ResolvedConfig } from '../config'
import { createPluginHookUtils } from '../plugins'
import { buildErrorMessage } from './middlewares/error'
import type { ModuleGraph } from './moduleGraph'

const noop = () => { }

export const ERR_CLOSED_SERVER = 'ERR_CLOSED_SERVER'

export function throwClosedServerError(): never {
  const err: any = new Error(
    'The server is being restarted or closed. Request is outdated',
  )
  err.code = ERR_CLOSED_SERVER
  // This error will be caught by the transform middleware that will
  // send a 504 status code request timeout
  throw err
}

export interface PluginContainerOptions {
  cwd?: string
  output?: OutputOptions
  modules?: Map<string, { info: ModuleInfo }>
  writeFile?: (name: string, source: string | Uint8Array) => void
}

export interface PluginContainer {
  options: InputOptions
  getModuleInfo(id: string): ModuleInfo | null
  buildStart(options: InputOptions): Promise<void>
  resolveId(
    id: string,
    importer?: string,
    options?: {
      assertions?: Record<string, string>
      custom?: CustomPluginOptions
      skip?: Set<Plugin>
      ssr?: boolean
      /**
       * @internal
       */
      scan?: boolean
      isEntry?: boolean
    },
  ): Promise<PartialResolvedId | null>
  transform(
    code: string,
    id: string,
    options?: {
      inMap?: SourceDescription['map']
      ssr?: boolean
    },
  ): Promise<{ code: string; map: SourceMap | null }>
  load(
    id: string,
    options?: {
      ssr?: boolean
    },
  ): Promise<LoadResult | null>
  close(): Promise<void>
}
// 定义新的 PluginContext 接口
type PluginContext = Omit<
  RollupPluginContext,
  // not documented
  | 'cache'
  // deprecated
  | 'moduleIds'
>

export let parser = acorn.Parser
// 主函数
// 大体逻辑就是，当 Vite 构建到某一时机的时候，会调用container中的函数，函数内遍历并执行所有插件的对应钩子函数；传入的参数就是Context实例或TransformContext实例，不同钩子函数传入的实例不同
export async function createPluginContainer(
  config: ResolvedConfig,
  moduleGraph?: ModuleGraph,
  watcher?: FSWatcher,
): Promise<PluginContainer> {
  const {
    plugins,
    logger,
    root,
    build: { rollupOptions },
  } = config
  const { getSortedPluginHooks, getSortedPlugins } =
    createPluginHookUtils(plugins)

  const seenResolves: Record<string, true | undefined> = {}
  const debugResolve = createDebugger('vite:resolve')
  const debugPluginResolve = createDebugger('vite:plugin-resolve', {
    onlyWhenFocused: 'vite:plugin',
  })
  const debugPluginTransform = createDebugger('vite:plugin-transform', {
    onlyWhenFocused: 'vite:plugin',
  })
  const debugSourcemapCombineFilter =
    process.env.DEBUG_VITE_SOURCEMAP_COMBINE_FILTER
  const debugSourcemapCombine = createDebugger('vite:sourcemap-combine', {
    onlyWhenFocused: true,
  })

  // ---------------------------------------------------------------------------

  const watchFiles = new Set<string>()

  const minimalContext: MinimalPluginContext = {
    meta: {
      rollupVersion,
      watchMode: true,
    },
    debug: noop,
    info: noop,
    warn: noop,
    // @ts-expect-error noop
    error: noop,
  }

  function warnIncompatibleMethod(method: string, plugin: string) {
    logger.warn(
      colors.cyan(`[plugin:${plugin}] `) +
      colors.yellow(
        `context method ${colors.bold(
          `${method}()`,
        )} is not supported in serve mode. This plugin is likely not vite-compatible.`,
      ),
    )
  }

  // parallel, ignores returns
  async function hookParallel<H extends AsyncPluginHooks & ParallelPluginHooks>(
    hookName: H,
    context: (plugin: Plugin) => ThisType<FunctionPluginHooks[H]>,
    args: (plugin: Plugin) => Parameters<FunctionPluginHooks[H]>,
  ): Promise<void> {
    const parallelPromises: Promise<unknown>[] = []
    for (const plugin of getSortedPlugins(hookName)) {
      // Don't throw here if closed, so buildEnd and closeBundle hooks can finish running
      const hook = plugin[hookName]
      if (!hook) continue
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore hook is not a primitive
      const handler: Function = 'handler' in hook ? hook.handler : hook
      if ((hook as { sequential?: boolean }).sequential) {
        await Promise.all(parallelPromises)
        parallelPromises.length = 0
        await handler.apply(context(plugin), args(plugin))
      } else {
        parallelPromises.push(handler.apply(context(plugin), args(plugin)))
      }
    }
    await Promise.all(parallelPromises)
  }

  // throw when an unsupported ModuleInfo property is accessed,
  // so that incompatible plugins fail in a non-cryptic way.
  const ModuleInfoProxy: ProxyHandler<ModuleInfo> = {
    get(info: any, key: string) {
      if (key in info) {
        return info[key]
      }
      // Don't throw an error when returning from an async function
      if (key === 'then') {
        return undefined
      }
      throw Error(
        `[vite] The "${key}" property of ModuleInfo is not supported.`,
      )
    },
  }

  // same default value of "moduleInfo.meta" as in Rollup
  const EMPTY_OBJECT = Object.freeze({})

  function getModuleInfo(id: string) {
    const module = moduleGraph?.getModuleById(id)
    if (!module) {
      return null
    }
    if (!module.info) {
      module.info = new Proxy(
        { id, meta: module.meta || EMPTY_OBJECT } as ModuleInfo,
        ModuleInfoProxy,
      )
    }
    return module.info
  }

  function updateModuleInfo(id: string, { meta }: { meta?: object | null }) {
    if (meta) {
      const moduleInfo = getModuleInfo(id)
      if (moduleInfo) {
        moduleInfo.meta = { ...moduleInfo.meta, ...meta }
      }
    }
  }

  // 我们应该为每个异步钩子管道创建一个新的上下文，以便在并发安全的方式下跟踪该管道中的活动插件。使用类来提高创建新上下文的效率。
  // 定义一个 Context 类，是rollup Context 的 vite 的实现
  // 如果直接用rollup的Context那么有些钩子vite的支持不到的，所以vite要自己实现一个Context
  // 这个Context中，如果能实现的方法vite会自己去实现，而不能实现的方法它会告诉我们，没有实现这个方法我们不能用
  class Context implements PluginContext {
    meta = minimalContext.meta
    ssr = false
    _scan = false
    _activePlugin: Plugin | null
    _activeId: string | null = null
    _activeCode: string | null = null
    _resolveSkips?: Set<Plugin>
    _addedImports: Set<string> | null = null

    constructor(initialPlugin?: Plugin) {
      this._activePlugin = initialPlugin || null
    }

    // 自己实现的 rollup 方法
    parse(code: string, opts: any = {}) {
      return parser.parse(code, {
        sourceType: 'module',
        ecmaVersion: 'latest',
        locations: true,
        ...opts,
      })
    }

    async resolve(
      id: string,
      importer?: string,
      options?: {
        assertions?: Record<string, string>
        custom?: CustomPluginOptions
        isEntry?: boolean
        skipSelf?: boolean
      },
    ) {
      let skip: Set<Plugin> | undefined
      if (options?.skipSelf && this._activePlugin) {
        skip = new Set(this._resolveSkips)
        skip.add(this._activePlugin)
      }
      let out = await container.resolveId(id, importer, {
        assertions: options?.assertions,
        custom: options?.custom,
        isEntry: !!options?.isEntry,
        skip,
        ssr: this.ssr,
        scan: this._scan,
      })
      if (typeof out === 'string') out = { id: out }
      return out as ResolvedId | null
    }

    async load(
      options: {
        id: string
        resolveDependencies?: boolean
      } & Partial<PartialNull<ModuleOptions>>,
    ): Promise<ModuleInfo> {
      // We may not have added this to our module graph yet, so ensure it exists
      await moduleGraph?.ensureEntryFromUrl(unwrapId(options.id), this.ssr)
      // Not all options passed to this function make sense in the context of loading individual files,
      // but we can at least update the module info properties we support
      updateModuleInfo(options.id, options)

      await container.load(options.id, { ssr: this.ssr })
      const moduleInfo = this.getModuleInfo(options.id)
      // This shouldn't happen due to calling ensureEntryFromUrl, but 1) our types can't ensure that
      // and 2) moduleGraph may not have been provided (though in the situations where that happens,
      // we should never have plugins calling this.load)
      if (!moduleInfo)
        throw Error(`Failed to load module with id ${options.id}`)
      return moduleInfo
    }

    getModuleInfo(id: string) {
      return getModuleInfo(id)
    }

    getModuleIds() {
      return moduleGraph
        ? moduleGraph.idToModuleMap.keys()
        : Array.prototype[Symbol.iterator]()
    }

    addWatchFile(id: string) {
      watchFiles.add(id)
        ; (this._addedImports || (this._addedImports = new Set())).add(id)
      if (watcher) ensureWatchedFile(watcher, id, root)
    }

    getWatchFiles() {
      return [...watchFiles]
    }

    // 暂未实现
    emitFile(assetOrFile: EmittedFile) {
      warnIncompatibleMethod(`emitFile`, this._activePlugin!.name)
      return ''
    }
    // 暂未实现
    setAssetSource() {
      warnIncompatibleMethod(`setAssetSource`, this._activePlugin!.name)
    }
    // 暂未实现
    getFileName() {
      warnIncompatibleMethod(`getFileName`, this._activePlugin!.name)
      return ''
    }

    warn(
      e: string | RollupLog | (() => string | RollupLog),
      position?: number | { column: number; line: number },
    ) {
      const err = formatError(typeof e === 'function' ? e() : e, position, this)
      const msg = buildErrorMessage(
        err,
        [colors.yellow(`warning: ${err.message}`)],
        false,
      )
      logger.warn(msg, {
        clear: true,
        timestamp: true,
      })
    }

    error(
      e: string | RollupError,
      position?: number | { column: number; line: number },
    ): never {
      // error thrown here is caught by the transform middleware and passed on
      // the the error middleware.
      throw formatError(e, position, this)
    }

    debug = noop
    info = noop
  }

  function formatError(
    e: string | RollupError,
    position: number | { column: number; line: number } | undefined,
    ctx: Context,
  ) {
    const err = (
      typeof e === 'string' ? new Error(e) : e
    ) as postcss.CssSyntaxError & RollupError
    if (err.pluginCode) {
      return err // The plugin likely called `this.error`
    }
    if (err.file && err.name === 'CssSyntaxError') {
      err.id = normalizePath(err.file)
    }
    if (ctx._activePlugin) err.plugin = ctx._activePlugin.name
    if (ctx._activeId && !err.id) err.id = ctx._activeId
    if (ctx._activeCode) {
      err.pluginCode = ctx._activeCode

      // some rollup plugins, e.g. json, sets err.position instead of err.pos
      const pos = position ?? err.pos ?? (err as any).position

      if (pos != null) {
        let errLocation
        try {
          errLocation = numberToPos(ctx._activeCode, pos)
        } catch (err2) {
          logger.error(
            colors.red(
              `Error in error handler:\n${err2.stack || err2.message}\n`,
            ),
            // print extra newline to separate the two errors
            { error: err2 },
          )
          throw err
        }
        err.loc = err.loc || {
          file: err.id,
          ...errLocation,
        }
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, pos)
      } else if (err.loc) {
        // css preprocessors may report errors in an included file
        if (!err.frame) {
          let code = ctx._activeCode
          if (err.loc.file) {
            err.id = normalizePath(err.loc.file)
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch { }
          }
          err.frame = generateCodeFrame(code, err.loc)
        }
      } else if ((err as any).line && (err as any).column) {
        err.loc = {
          file: err.id,
          line: (err as any).line,
          column: (err as any).column,
        }
        err.frame = err.frame || generateCodeFrame(err.id!, err.loc)
      }

      if (
        ctx instanceof TransformContext &&
        typeof err.loc?.line === 'number' &&
        typeof err.loc?.column === 'number'
      ) {
        const rawSourceMap = ctx._getCombinedSourcemap()
        if (rawSourceMap) {
          const traced = new TraceMap(rawSourceMap as any)
          const { source, line, column } = originalPositionFor(traced, {
            line: Number(err.loc.line),
            column: Number(err.loc.column),
          })
          if (source && line != null && column != null) {
            err.loc = { file: source, line, column }
          }
        }
      }
    } else if (err.loc) {
      if (!err.frame) {
        let code = err.pluginCode
        if (err.loc.file) {
          err.id = normalizePath(err.loc.file)
          if (!code) {
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch { }
          }
        }
        if (code) {
          err.frame = generateCodeFrame(`${code}`, err.loc)
        }
      }
    }

    if (
      typeof err.loc?.column !== 'number' &&
      typeof err.loc?.line !== 'number' &&
      !err.loc?.file
    ) {
      delete err.loc
    }

    return err
  }

  // 定义一个 TransformContext 类
  // 在 transform 这个钩子函数中可能会用到 TransformContext 这个类
  class TransformContext extends Context {
    filename: string
    originalCode: string
    originalSourcemap: SourceMap | null = null
    sourcemapChain: NonNullable<SourceDescription['map']>[] = []
    combinedMap: SourceMap | null = null

    constructor(filename: string, code: string, inMap?: SourceMap | string) {
      super()
      this.filename = filename
      this.originalCode = code
      if (inMap) {
        if (debugSourcemapCombine) {
          // @ts-expect-error inject name for debug purpose
          inMap.name = '$inMap'
        }
        this.sourcemapChain.push(inMap)
      }
    }

    _getCombinedSourcemap(createIfNull = false) {
      if (
        debugSourcemapCombine &&
        debugSourcemapCombineFilter &&
        this.filename.includes(debugSourcemapCombineFilter)
      ) {
        debugSourcemapCombine('----------', this.filename)
        debugSourcemapCombine(this.combinedMap)
        debugSourcemapCombine(this.sourcemapChain)
        debugSourcemapCombine('----------')
      }

      let combinedMap = this.combinedMap
      for (let m of this.sourcemapChain) {
        if (typeof m === 'string') m = JSON.parse(m)
        if (!('version' in (m as SourceMap))) {
          // empty, nullified source map
          combinedMap = this.combinedMap = null
          this.sourcemapChain.length = 0
          break
        }
        if (!combinedMap) {
          combinedMap = m as SourceMap
        } else {
          combinedMap = combineSourcemaps(cleanUrl(this.filename), [
            m as RawSourceMap,
            combinedMap as RawSourceMap,
          ]) as SourceMap
        }
      }
      if (!combinedMap) {
        return createIfNull
          ? new MagicString(this.originalCode).generateMap({
            includeContent: true,
            hires: 'boundary',
            source: cleanUrl(this.filename),
          })
          : null
      }
      if (combinedMap !== this.combinedMap) {
        this.combinedMap = combinedMap
        this.sourcemapChain.length = 0
      }
      return this.combinedMap
    }

    getCombinedSourcemap() {
      return this._getCombinedSourcemap(true) as SourceMap
    }
  }

  let closed = false
  const processesing = new Set<Promise<any>>()
  // keeps track of hook promises so that we can wait for them all to finish upon closing the server
  function handleHookPromise<T>(maybePromise: undefined | T | Promise<T>) {
    if (!(maybePromise as any)?.then) {
      return maybePromise
    }
    const promise = maybePromise as Promise<T>
    processesing.add(promise)
    return promise.finally(() => processesing.delete(promise))
  }

  // 创建容器对象，对象内属性就是 Vite 支持的 Rollup 钩子函数
  const container: PluginContainer = {
    // 服务器启动时被调用: options buildStart
    // 注意这里是一个立即执行函数
    // options 是构建阶段的第一个钩子
    // 这个钩子函数的调用发生在创建容器的时候，也就是在createPluginContainer内，container.options 是一个立即执行函数
    // 这个钩子函数比较简单，就是扩展acorn解析器、替换或修改options配置，最后传入buildStart钩子函数中
    options: await (async () => {
      // 传入 createPluginContainer 的参数 config.build.rollupOptions
      let options = rollupOptions
      for (const optionsHook of getSortedPluginHooks('options')) {
        if (closed) throwClosedServerError()
        // 调用所有 vite 插件中定义的 options 钩子函数并传入配置中的 config.build.rollupOptions
        options =
          (await handleHookPromise(
            optionsHook.call(minimalContext, options),
          )) || options
      }
      // 扩展 acorn 解析器
      if (options.acornInjectPlugins) {
        parser = acorn.Parser.extend(
          ...(arraify(options.acornInjectPlugins) as any),
        )
      }
      return {
        acorn,
        acornInjectPlugins: [],
        ...options,
      }
    })(),

    getModuleInfo,

    // 开始构建之前调用
    // 在调用httpServer.listen方法时触发这个钩子函数
    // container.buildStart就是执行所有插件的buildStart钩子函数并传入options钩子函数的返回值，this指向Context实例。这个函数的作用就是在开始构建之前获取配置项，用于其他钩子函数使用；或初始化一些变量。
    async buildStart() {
      await handleHookPromise(
        hookParallel(
          'buildStart',
          (plugin) => new Context(plugin),
          () => [container.options as NormalizedInputOptions],
        ),
      )
    },

    // TODO: 在每个传入模块请求时被调用：resolveId load transform
    // Vite通过transformMiddleware中间件拦截并处理模块请求，其中就包含调用resolveId钩子函数，用于解析文件路径。也就是说每个文件请求都会调用resolveId钩子函数，去解析文件路径。
    // 作用: 遍历所有插件，如果当前插件有resolveId钩子函数并且没在skips中，则执行resolveId钩子函数。如果其中一个插件的resolveId钩子函数有返回值，就不会继续执行剩余插件的resolveId钩子函数。
    /**
     * @param rawId 代码中使用的路径，比如 @/main.ts
     * @param importer 导入模块的位置
     * @param options optins选项
     * @returns { external?: boolean | 'absolute' | 'relative', id: string } | null
     */
    async resolveId(rawId, importer = join(root, 'index.html'), options) {
      const skip = options?.skip
      const ssr = options?.ssr
      const scan = !!options?.scan
      const ctx = new Context()
      ctx.ssr = !!ssr
      ctx._scan = scan
      // 需要跳过的插件
      ctx._resolveSkips = skip
      const resolveStart = debugResolve ? performance.now() : 0
      let id: string | null = null
      const partial: Partial<PartialResolvedId> = {}
      // 遍历所有插件
      for (const plugin of getSortedPlugins('resolveId')) {
        if (closed && !ssr) throwClosedServerError()
        // 插件中没有 resolveId 跳过
        if (!plugin.resolveId) continue
        // 如果这个插件在 skips 中，跳过
        if (skip?.has(plugin)) continue

        // ctx._activePlugin 表示当前正在执行 resolveId 钩子函数的插件
        ctx._activePlugin = plugin

        const pluginResolveStart = debugPluginResolve ? performance.now() : 0
        const handler =
          'handler' in plugin.resolveId
            ? plugin.resolveId.handler
            : plugin.resolveId
        // 调用 plugin 的 resolveId 钩子函数
        const result = await handleHookPromise(
          handler.call(ctx as any, rawId, importer, { // 配置项
            assertions: options?.assertions ?? {},
            custom: options?.custom,
            isEntry: !!options?.isEntry,
            ssr,
            scan,
          }),
        )
        // 如果没有返回值继续调用剩余插件的 resolveId 钩子函数，如果有返回值退出循环
        // result没值.说明这个resolveId没有找到对应的文件,就需要其他的resolveId去继续找文件
        if (!result) continue

        if (typeof result === 'string') {
          id = result
        } else {
          id = result.id
          Object.assign(partial, result)
        }

        debugPluginResolve?.(
          timeFrom(pluginResolveStart),
          plugin.name,
          prettifyUrl(id, root),
        )

        // resolveId() is hookFirst - first non-null result is returned.
        break
      }

      // rawId: 原始id
      // id: 处理过后的id
      if (debugResolve && rawId !== id && !rawId.startsWith(FS_PREFIX)) {
        const key = rawId + id
        // avoid spamming
        // 在 seenResolves 标识一下
        if (!seenResolves[key]) {
          seenResolves[key] = true
          debugResolve(
            `${timeFrom(resolveStart)} ${colors.cyan(rawId)} -> ${colors.dim(
              id,
            )}`,
          )
        }
      }

      // 最后返回一个对象；对象内有一个属性 id，值是解析后的绝对路径
      if (id) {
        partial.id = isExternalUrl(id) ? id : normalizePath(id)
        return partial as PartialResolvedId
      } else {
        return null
      }
    },

    // load钩子函数是resolveId钩子函数的下一个钩子函数，可用于读取文件代码、拦截文件读取。
    // 调用所有插件的load钩子函数，如果有插件返回，直接返回结果；剩余插件停止执行。
    async load(id, options) {
      const ssr = options?.ssr
      const ctx = new Context()
      ctx.ssr = !!ssr
      for (const plugin of getSortedPlugins('load')) {
        if (closed && !ssr) throwClosedServerError()
        if (!plugin.load) continue
        ctx._activePlugin = plugin
        const handler =
          'handler' in plugin.load ? plugin.load.handler : plugin.load
        const result = await handleHookPromise(
          handler.call(ctx as any, id, { ssr }),
        )
        if (result != null) {
          if (isObject(result)) {
            updateModuleInfo(id, result)
          }
          return result
        }
      }
      return null
    },

    // 这个钩子的作用是转换代码
    // 和上面两个钩子一样，都是在transformMiddleware中间件中调用，在load钩子函数之后
    // 声明一个TransformContext实例，遍历所有插件，如果插件定义了transform，则调用这个函数，并传入文件源码、文件路径。最后返回一个对象，对象内容是转换后的代码和sourcemap。
    // Ps: 如果其中一个插件的transform函数有返回，并不会阻断其他插件的transform函数执行，而是更新code变量，当下一个插件使用时，获取的就是最新的code
    /**
     * @param code 文件源码
     * @param id 文件路径
     * @param inMap sourcemap 相关
     * @returns {object} { code: 经插件转换后的代码, map: sourcemap 相关 }
     */
    async transform(code, id, options) {
      const inMap = options?.inMap
      const ssr = options?.ssr
      const ctx = new TransformContext(id, code, inMap as SourceMap)
      ctx.ssr = !!ssr
      for (const plugin of getSortedPlugins('transform')) {
        if (closed && !ssr) throwClosedServerError()
        if (!plugin.transform) continue
        ctx._activePlugin = plugin
        ctx._activeId = id
        ctx._activeCode = code
        const start = debugPluginTransform ? performance.now() : 0
        let result: TransformResult | string | undefined
        const handler =
          'handler' in plugin.transform
            ? plugin.transform.handler
            : plugin.transform
        try {
          // 调用插件的 transform 钩子函数，并传入 源码、文件路径
          result = await handleHookPromise(
            handler.call(ctx as any, code, id, { ssr }),
          )
        } catch (e) {
          ctx.error(e)
        }
        if (!result) continue
        debugPluginTransform?.(
          timeFrom(start),
          plugin.name,
          prettifyUrl(id, root),
        )
        if (isObject(result)) {
          if (result.code !== undefined) {
            code = result.code
            if (result.map) {
              if (debugSourcemapCombine) {
                // @ts-expect-error inject plugin name for debug purpose
                result.map.name = plugin.name
              }
              ctx.sourcemapChain.push(result.map)
            }
          }
          updateModuleInfo(id, result)
        } else {
          code = result
        }
      }
      return {
        code,
        map: ctx._getCombinedSourcemap(), // sourcemap
      }
    },

    // 在服务器关闭时被调用：buildEnd closeBundle
    async close() {
      if (closed) return
      closed = true
      await Promise.allSettled(Array.from(processesing))
      const ctx = new Context()
      await hookParallel(
        'buildEnd',
        () => ctx,
        () => [],
      )
      await hookParallel(
        'closeBundle',
        () => ctx,
        () => [],
      )
    },
  }

  return container
}