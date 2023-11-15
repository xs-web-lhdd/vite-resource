import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import colors from 'picocolors'
import type { Alias, AliasOptions } from 'dep-types/alias'
import aliasPlugin from '@rollup/plugin-alias'
import { build } from 'esbuild'
import type { RollupOptions } from 'rollup'
import type { HookHandler, Plugin } from './plugin'
import type {
  BuildOptions,
  RenderBuiltAssetUrl,
  ResolvedBuildOptions,
} from './build'
import { resolveBuildOptions } from './build'
import type { ResolvedServerOptions, ServerOptions } from './server'
import { resolveServerOptions } from './server'
import type { PreviewOptions, ResolvedPreviewOptions } from './preview'
import { resolvePreviewOptions } from './preview'
import {
  type CSSOptions,
  type ResolvedCSSOptions,
  resolveCSSOptions,
} from './plugins/css'
import {
  asyncFlatten,
  createDebugger,
  createFilter,
  dynamicImport,
  isBuiltin,
  isExternalUrl,
  isNodeBuiltin,
  isObject,
  lookupFile,
  mergeAlias,
  mergeConfig,
  normalizeAlias,
  normalizePath,
  withTrailingSlash,
} from './utils'
import {
  createPluginHookUtils,
  getSortedPluginsByHook,
  resolvePlugins,
} from './plugins'
import type { ESBuildOptions } from './plugins/esbuild'
import {
  CLIENT_ENTRY,
  DEFAULT_ASSETS_RE,
  DEFAULT_CONFIG_FILES,
  DEFAULT_EXTENSIONS,
  DEFAULT_MAIN_FIELDS,
  ENV_ENTRY,
  FS_PREFIX,
} from './constants'
import type { InternalResolveOptions, ResolveOptions } from './plugins/resolve'
import { resolvePlugin, tryNodeResolve } from './plugins/resolve'
import type { LogLevel, Logger } from './logger'
import { createLogger } from './logger'
import type { DepOptimizationConfig, DepOptimizationOptions } from './optimizer'
import type { JsonOptions } from './plugins/json'
import type { PluginContainer } from './server/pluginContainer'
import { createPluginContainer } from './server/pluginContainer'
import type { PackageCache } from './packages'
import { findNearestPackageData } from './packages'
import { loadEnv, resolveEnvPrefix } from './env'
import type { ResolvedSSROptions, SSROptions } from './ssr'
import { resolveSSROptions } from './ssr'

const debug = createDebugger('vite:config')
const promisifiedRealpath = promisify(fs.realpath)

export type {
  RenderBuiltAssetUrl,
  ModulePreloadOptions,
  ResolvedModulePreloadOptions,
  ResolveModulePreloadDependenciesFn,
} from './build'

// NOTE: every export in this file is re-exported from ./index.ts so it will
// be part of the public API.

export interface ConfigEnv {
  command: 'build' | 'serve'
  mode: string
  /**
   * @experimental
   */
  ssrBuild?: boolean
}

/**
 * spa: include SPA fallback middleware and configure sirv with `single: true` in preview
 *
 * mpa: only include non-SPA HTML middlewares
 *
 * custom: don't include HTML middlewares
 */
export type AppType = 'spa' | 'mpa' | 'custom'

export type UserConfigFnObject = (env: ConfigEnv) => UserConfig
export type UserConfigFnPromise = (env: ConfigEnv) => Promise<UserConfig>
export type UserConfigFn = (env: ConfigEnv) => UserConfig | Promise<UserConfig>

export type UserConfigExport =
  | UserConfig
  | Promise<UserConfig>
  | UserConfigFnObject
  | UserConfigFnPromise
  | UserConfigFn

/**
 * Type helper to make it easier to use vite.config.ts
 * accepts a direct {@link UserConfig} object, or a function that returns it.
 * The function receives a {@link ConfigEnv} object that exposes two properties:
 * `command` (either `'build'` or `'serve'`), and `mode`.
 */
export function defineConfig(config: UserConfig): UserConfig
export function defineConfig(config: Promise<UserConfig>): Promise<UserConfig>
export function defineConfig(config: UserConfigFnObject): UserConfigFnObject
export function defineConfig(config: UserConfigExport): UserConfigExport
export function defineConfig(config: UserConfigExport): UserConfigExport {
  return config
}

export type PluginOption =
  | Plugin
  | false
  | null
  | undefined
  | PluginOption[]
  | Promise<Plugin | false | null | undefined | PluginOption[]>

export interface UserConfig {
  /**
   * Project root directory. Can be an absolute path, or a path relative from
   * the location of the config file itself.
   * @default process.cwd()
   */
  root?: string
  /**
   * Base public path when served in development or production.
   * @default '/'
   */
  base?: string
  /**
   * Directory to serve as plain static assets. Files in this directory are
   * served and copied to build dist dir as-is without transform. The value
   * can be either an absolute file system path or a path relative to project root.
   *
   * Set to `false` or an empty string to disable copied static assets to build dist dir.
   * @default 'public'
   */
  publicDir?: string | false
  /**
   * Directory to save cache files. Files in this directory are pre-bundled
   * deps or some other cache files that generated by vite, which can improve
   * the performance. You can use `--force` flag or manually delete the directory
   * to regenerate the cache files. The value can be either an absolute file
   * system path or a path relative to project root.
   * Default to `.vite` when no `package.json` is detected.
   * @default 'node_modules/.vite'
   */
  cacheDir?: string
  /**
   * Explicitly set a mode to run in. This will override the default mode for
   * each command, and can be overridden by the command line --mode option.
   */
  mode?: string
  /**
   * Define global variable replacements.
   * Entries will be defined on `window` during dev and replaced during build.
   */
  define?: Record<string, any>
  /**
   * Array of vite plugins to use.
   */
  plugins?: PluginOption[]
  /**
   * Configure resolver
   */
  resolve?: ResolveOptions & { alias?: AliasOptions }
  /**
   * CSS related options (preprocessors and CSS modules)
   */
  css?: CSSOptions
  /**
   * JSON loading options
   */
  json?: JsonOptions
  /**
   * Transform options to pass to esbuild.
   * Or set to `false` to disable esbuild.
   */
  esbuild?: ESBuildOptions | false
  /**
   * Specify additional picomatch patterns to be treated as static assets.
   */
  assetsInclude?: string | RegExp | (string | RegExp)[]
  /**
   * Server specific options, e.g. host, port, https...
   */
  server?: ServerOptions
  /**
   * Build specific options
   */
  build?: BuildOptions
  /**
   * Preview specific options, e.g. host, port, https...
   */
  preview?: PreviewOptions
  /**
   * Dep optimization options
   */
  optimizeDeps?: DepOptimizationOptions
  /**
   * SSR specific options
   */
  ssr?: SSROptions
  /**
   * Experimental features
   *
   * Features under this field could change in the future and might NOT follow semver.
   * Please be careful and always pin Vite's version when using them.
   * @experimental
   */
  experimental?: ExperimentalOptions
  /**
   * Legacy options
   *
   * Features under this field only follow semver for patches, they could be removed in a
   * future minor version. Please always pin Vite's version to a minor when using them.
   */
  legacy?: LegacyOptions
  /**
   * Log level.
   * @default 'info'
   */
  logLevel?: LogLevel
  /**
   * Custom logger.
   */
  customLogger?: Logger
  /**
   * @default true
   */
  clearScreen?: boolean
  /**
   * Environment files directory. Can be an absolute path, or a path relative from
   * root.
   * @default root
   */
  envDir?: string
  /**
   * Env variables starts with `envPrefix` will be exposed to your client source code via import.meta.env.
   * @default 'VITE_'
   */
  envPrefix?: string | string[]
  /**
   * Worker bundle options
   */
  worker?: {
    /**
     * Output format for worker bundle
     * @default 'iife'
     */
    format?: 'es' | 'iife'
    /**
     * Vite plugins that apply to worker bundle
     */
    plugins?: PluginOption[]
    /**
     * Rollup options to build worker bundle
     */
    rollupOptions?: Omit<
      RollupOptions,
      'plugins' | 'input' | 'onwarn' | 'preserveEntrySignatures'
    >
  }
  /**
   * Whether your application is a Single Page Application (SPA),
   * a Multi-Page Application (MPA), or Custom Application (SSR
   * and frameworks with custom HTML handling)
   * @default 'spa'
   */
  appType?: AppType
}

export interface ExperimentalOptions {
  /**
   * Append fake `&lang.(ext)` when queries are specified, to preserve the file extension for following plugins to process.
   *
   * @experimental
   * @default false
   */
  importGlobRestoreExtension?: boolean
  /**
   * Allow finegrain control over assets and public files paths
   *
   * @experimental
   */
  renderBuiltUrl?: RenderBuiltAssetUrl
  /**
   * Enables support of HMR partial accept via `import.meta.hot.acceptExports`.
   *
   * @experimental
   * @default false
   */
  hmrPartialAccept?: boolean
  /**
   * Skips SSR transform to make it easier to use Vite with Node ESM loaders.
   * @warning Enabling this will break normal operation of Vite's SSR in development mode.
   *
   * @experimental
   * @default false
   */
  skipSsrTransform?: boolean
}

export interface LegacyOptions {
  /**
   * Revert vite build --ssr to the v2.9 strategy. Use CJS SSR build and v2.9 externalization heuristics
   *
   * @experimental
   * @deprecated
   * @default false
   */
  buildSsrCjsExternalHeuristics?: boolean
}

export interface ResolveWorkerOptions extends PluginHookUtils {
  format: 'es' | 'iife'
  plugins: Plugin[]
  rollupOptions: RollupOptions
}

export interface InlineConfig extends UserConfig {
  configFile?: string | false
  envFile?: false
}

export type ResolvedConfig = Readonly<
  Omit<
    UserConfig,
    'plugins' | 'css' | 'assetsInclude' | 'optimizeDeps' | 'worker' | 'build'
  > & {
    configFile: string | undefined
    configFileDependencies: string[]
    inlineConfig: InlineConfig
    root: string
    base: string
    /** @internal */
    rawBase: string
    publicDir: string
    cacheDir: string
    command: 'build' | 'serve'
    mode: string
    isWorker: boolean
    // in nested worker bundle to find the main config
    /** @internal */
    mainConfig: ResolvedConfig | null
    isProduction: boolean
    envDir: string
    env: Record<string, any>
    resolve: Required<ResolveOptions> & {
      alias: Alias[]
    }
    plugins: readonly Plugin[]
    css: ResolvedCSSOptions | undefined
    esbuild: ESBuildOptions | false
    server: ResolvedServerOptions
    build: ResolvedBuildOptions
    preview: ResolvedPreviewOptions
    ssr: ResolvedSSROptions
    assetsInclude: (file: string) => boolean
    logger: Logger
    createResolver: (options?: Partial<InternalResolveOptions>) => ResolveFn
    optimizeDeps: DepOptimizationOptions
    /** @internal */
    packageCache: PackageCache
    worker: ResolveWorkerOptions
    appType: AppType
    experimental: ExperimentalOptions
  } & PluginHookUtils
>

export interface PluginHookUtils {
  getSortedPlugins: (hookName: keyof Plugin) => Plugin[]
  getSortedPluginHooks: <K extends keyof Plugin>(
    hookName: K,
  ) => NonNullable<HookHandler<Plugin[K]>>[]
}

export type ResolveFn = (
  id: string,
  importer?: string,
  aliasOnly?: boolean,
  ssr?: boolean,
) => Promise<string | undefined>

export async function resolveConfig(
  inlineConfig: InlineConfig,
  command: 'build' | 'serve', // 命令
  defaultMode = 'development', // 环境
  defaultNodeEnv = 'development',
): Promise<ResolvedConfig> {
  // 命令行中的配置项
  let config = inlineConfig
  let configFileDependencies: string[] = []
  // mode首选命令行中的配置的mode选项，默认是 development
  let mode = inlineConfig.mode || defaultMode
  const isNodeEnvSet = !!process.env.NODE_ENV
  const packageCache: PackageCache = new Map()

  // some dependencies e.g. @vue/compiler-* relies on NODE_ENV for getting
  // production-specific behavior, so set it early on
  if (!isNodeEnvSet) {
    process.env.NODE_ENV = defaultNodeEnv
  }

  const configEnv = {
    mode, // 环境，开发环境下是 development
    command, // 命令，开发环境下是 serve
    ssrBuild: !!config.build?.ssr,
  }

  // 配置文件（vite.config.js）路径（命令行中配置的）
  let { configFile } = config
  if (configFile !== false) {
    // 查找配置文件并获取配置文件中的 config 配置
    const loadResult = await loadConfigFromFile(
      configEnv,
      configFile, // 命令行传入的配置文件路径
      config.root,
      config.logLevel,
    )
    if (loadResult) {
      // 合并配置 调用mergeConfig函数合并命令行配置和vite.config.js的配置
      config = mergeConfig(loadResult.config, config)
      // 获取配置文件绝对路径
      configFile = loadResult.path
      // 获取 vite.config.js 中导入的非第三方文件列表（比如自定义插件、方法文件等）
      // 非第三方导入的文件(比如自定义插件)
      // dependencies说白了也就是vite.config自身和它依赖的非node_modules的文件
      // vite是认为非node_modules下的文件不是稳定的文件，那么当这些非稳定的文件修改了之后，vite就要重启服务
      configFileDependencies = loadResult.dependencies
    }
  }

  // 获取打包环境 development、production
  // user config may provide an alternative mode. But --mode has a higher priority
  mode = inlineConfig.mode || config.mode || mode
  configEnv.mode = mode

  /**
   *
自定义插件的apply属性表示在什么环境下执行。这段代码的意思是

如果没有apply，表示在开发、生产环境下都会添加到rawUserPlugins等待执行
如果apply是一个函数，函数返回值是true，添加到rawUserPlugins等待执行
如果apply的属性值等于当前环境字符串（serve、build），则添加到rawUserPlugins等待执行
   */
  const filterPlugin = (p: Plugin) => {
    if (!p) {
      return false
    } else if (!p.apply) {
      return true
    } else if (typeof p.apply === 'function') {
      return p.apply({ ...config, mode }, configEnv)
    } else {
      return p.apply === command
    }
  }
  /**
   * 有些插件并不打算在 workers 的捆绑过程中使用（例如在构建时进行后处理）。
   * 并且，插件可能也有缓存，这些缓存可能会因为在这些额外的 rollup 调用中使用而被破坏。
   * 因此，我们需要将 worker 插件与 vite 需要运行的插件分开。
   */
  // 把 worker下在当前环境下不支持的 plugins 过滤掉
  const rawWorkerUserPlugins = (
    (await asyncFlatten(config.worker?.plugins || [])) as Plugin[]
  ).filter(filterPlugin)

  // resolve plugins
  // 根据 apply 属性将当前环境不支持的 plugins 过滤掉
  const rawUserPlugins = (
    (await asyncFlatten(config.plugins || [])) as Plugin[]
  ).filter(filterPlugin)

  // 过滤完之后，对rawUserPlugins中所有插件分类，根据enforce的属性值分类，代码如下
  /**
    * 属性值为 pre：表示提前执行的插件，放到 prePlugins 中
    * 属性值为 post：表示最后执行的插件，放到 postPlugins 中
    * 没有设置或者设置的是其他属性值：表示正常执行的插件，放到 normalPlugins 中
  */
  const [prePlugins, normalPlugins, postPlugins] =
    sortUserPlugins(rawUserPlugins)

  // 接下来就是执行所有自定义插件的config钩子函数(这个config钩子函数可以改变我们原来的config,最终会把config钩子函数的返回值与原来的config进行合并返回)
  // run config hooks
  const userPlugins = [...prePlugins, ...normalPlugins, ...postPlugins]
  config = await runConfigHook(config, userPlugins, configEnv)

  // If there are custom commonjsOptions, don't force optimized deps for this test
  // even if the env var is set as it would interfere with the playground specs.
  if (
    !config.build?.commonjsOptions &&
    process.env.VITE_TEST_WITHOUT_PLUGIN_COMMONJS
  ) {
    config = mergeConfig(config, {
      optimizeDeps: { disabled: false },
      ssr: { optimizeDeps: { disabled: false } },
    })
    config.build ??= {}
    config.build.commonjsOptions = { include: [] }
  }

  // Define logger
  const logger = createLogger(config.logLevel, {
    allowClearScreen: config.clearScreen,
    customLogger: config.customLogger,
  })

  // 获取config.root配置项的绝对路径或当前node命令执行时所在的文件夹目录
  // resolve root
  const resolvedRoot = normalizePath(
    config.root ? path.resolve(config.root) : process.cwd(),
  )

  // 创建新的alias
  // /^[\/]?@vite\/env/ 替换成 'vite/dist/client/env.mjs'
  // /^[\/]?@vite\/client/ 替换成 'vite/dist/client/client.mjs'
  const clientAlias = [
    {
      find: /^\/?@vite\/env/,
      replacement: path.posix.join(FS_PREFIX, normalizePath(ENV_ENTRY)),
    },
    {
      find: /^\/?@vite\/client/,
      replacement: path.posix.join(FS_PREFIX, normalizePath(CLIENT_ENTRY)),
    },
  ]

  // 将 clientAlias 和 配置项中的 alias 合并并返回
  // resolve alias with internal client alias
  const resolvedAlias = normalizeAlias(
    mergeAlias(clientAlias, config.resolve?.alias || []),
  )

  // 获取 resolve 所有配置项 拼接 resolve 配置
  // 官网的 resolve 用法在这里: https://cn.vitejs.dev/config/shared-options.html#resolve-alias
  const resolveOptions: ResolvedConfig['resolve'] = {
    mainFields: config.resolve?.mainFields ?? DEFAULT_MAIN_FIELDS,
    browserField: config.resolve?.browserField ?? true,
    conditions: config.resolve?.conditions ?? [],
    extensions: config.resolve?.extensions ?? DEFAULT_EXTENSIONS,
    dedupe: config.resolve?.dedupe ?? [],
    preserveSymlinks: config.resolve?.preserveSymlinks ?? false,
    alias: resolvedAlias,
  }

  // 如果没有设置 config.envDir 则获取项目根路径
  // load .env files
  const envDir = config.envDir
    ? normalizePath(path.resolve(resolvedRoot, config.envDir))
    : resolvedRoot
  // 获取所有 .env 文件中的属性
  /**
   * loadEnv函数根据envDir依次查找下面4个文件:
    .env.development.local
    .env.development
    .env.local
    .env
    如果找到了调用dotenv解析该.env文件。
    如果设置了config.envPrefix则只获取config.envPrefix前缀的变量。如果没设置config.envPrefix则获取VITE_开头的变量。
   */
  const userEnv =
    inlineConfig.envFile !== false &&
    loadEnv(mode, envDir, resolveEnvPrefix(config))

  // Note it is possible for user to have a custom mode, e.g. `staging` where
  // development-like behavior is expected. This is indicated by NODE_ENV=development
  // loaded from `.staging.env` and set by us as VITE_USER_NODE_ENV
  const userNodeEnv = process.env.VITE_USER_NODE_ENV
  if (!isNodeEnvSet && userNodeEnv) {
    if (userNodeEnv === 'development') {
      process.env.NODE_ENV = 'development'
    } else {
      // NODE_ENV=production is not supported as it could break HMR in dev for frameworks like Vue
      logger.warn(
        `NODE_ENV=${userNodeEnv} is not supported in the .env file. ` +
        `Only NODE_ENV=development is supported to create a development build of your project. ` +
        `If you need to set process.env.NODE_ENV, you can set it in the Vite config instead.`,
      )
    }
  }

  const isProduction = process.env.NODE_ENV === 'production'

  // resolve public base url
  const isBuild = command === 'build'
  const relativeBaseShortcut = config.base === '' || config.base === './'

  // During dev, we ignore relative base and fallback to '/'
  // For the SSR build, relative base isn't possible by means
  // of import.meta.url.
  const resolvedBase = relativeBaseShortcut
    ? !isBuild || config.build?.ssr
      ? '/'
      : './'
    : resolveBaseUrl(config.base, isBuild, logger) ?? '/'

  // 生产环境相关
  const resolvedBuildOptions = resolveBuildOptions(
    config.build,
    logger,
    resolvedRoot,
  )

  // 获取 package.json 路径
  // resolve cache directory
  const pkgDir = findNearestPackageData(resolvedRoot, packageCache)?.dir
  // 获取/设置缓存目录，默认是 node_modules/.vite
  const cacheDir = normalizePath(
    config.cacheDir
      ? path.resolve(resolvedRoot, config.cacheDir)
      : pkgDir
        ? path.join(pkgDir, `node_modules/.vite`)
        : path.join(resolvedRoot, `.vite`),
  )

  // 指定其他文件类型作为静态资源处理（这样导入它们就会返回解析后的 URL）
  const assetsFilter =
    config.assetsInclude &&
      (!Array.isArray(config.assetsInclude) || config.assetsInclude.length)
      ? createFilter(config.assetsInclude) // 构造一个过滤函数，该函数可用于确定是否应该对某些模块进行操作
      : () => false

  // 创建 resolveId 的函数
  // 创建在特殊场景中使用的内部解析器
  // 比如，预构建时，用于解析路径
  // 创建一个内部解析器，用于特殊场景，例如优化器和处理 CSS @import。
  const createResolver: ResolvedConfig['createResolver'] = (options) => {
    let aliasContainer: PluginContainer | undefined
    let resolverContainer: PluginContainer | undefined
    return async (id, importer, aliasOnly, ssr) => {
      let container: PluginContainer
      if (aliasOnly) {
        container =
          aliasContainer ||
          (aliasContainer = await createPluginContainer({
            ...resolved,
            plugins: [aliasPlugin({ entries: resolved.resolve.alias })],
          }))
      } else {
        container =
          resolverContainer ||
          (resolverContainer = await createPluginContainer({
            ...resolved,
            plugins: [
              aliasPlugin({ entries: resolved.resolve.alias }),
              resolvePlugin({
                ...resolved.resolve,
                root: resolvedRoot,
                isProduction,
                isBuild: command === 'build',
                ssrConfig: resolved.ssr,
                asSrc: true,
                preferRelative: false,
                tryIndex: true,
                ...options,
                idOnly: true,
              }),
            ],
          }))
      }
      return (
        await container.resolveId(id, importer, {
          ssr,
          scan: options?.scan,
        })
      )?.id
    }
  }

  const { publicDir } = config
  // 获取静态资源地址 默认是根目录下的 public
  const resolvedPublicDir =
    publicDir !== false && publicDir !== ''
      ? path.resolve(
        resolvedRoot,
        typeof publicDir === 'string' ? publicDir : 'public',
      )
      : ''

  // 开发时服务器选项
  // vite 服务器选项看这里: https://cn.vitejs.dev/config/server-options.html#server-fs-allow
  // 在这个函数里面会对用户传入的 config.server 与vite默认的server的值进行和并返回
  const server = resolveServerOptions(resolvedRoot, config.server, logger)
  // ssr选项
  const ssr = resolveSSROptions(
    config.ssr,
    resolveOptions.preserveSymlinks,
    config.legacy?.buildSsrCjsExternalHeuristics,
  )

  const middlewareMode = config?.server?.middlewareMode

  const optimizeDeps = config.optimizeDeps || {}

  const BASE_URL = resolvedBase

  // resolve worker
  let workerConfig = mergeConfig({}, config)
  const [workerPrePlugins, workerNormalPlugins, workerPostPlugins] =
    sortUserPlugins(rawWorkerUserPlugins)

  // run config hooks
  const workerUserPlugins = [
    ...workerPrePlugins,
    ...workerNormalPlugins,
    ...workerPostPlugins,
  ]
  workerConfig = await runConfigHook(workerConfig, workerUserPlugins, configEnv)
  const resolvedWorkerOptions: ResolveWorkerOptions = {
    format: workerConfig.worker?.format || 'iife', // worker 打包时的输出类型  'es' | 'iife'
    plugins: [],
    rollupOptions: workerConfig.worker?.rollupOptions || {}, // 用于打包 worker 的 Rollup 配置项
    getSortedPlugins: undefined!,
    getSortedPluginHooks: undefined!,
  }

  const resolvedConfig: ResolvedConfig = {
    // 配置文件路径
    configFile: configFile ? normalizePath(configFile) : undefined,
    // vite.config.js 中非第三方包的导入，比如自定义插件
    configFileDependencies: configFileDependencies.map((name) =>
      normalizePath(path.resolve(name)),
    ),
    // 命令行中输入的配置 options
    inlineConfig,
    // 项目根目录
    root: resolvedRoot,
    // 公共基础路径， /my-app/index.html
    base: withTrailingSlash(resolvedBase),
    rawBase: resolvedBase,
    // 文件解析时的相关配置
    resolve: resolveOptions,
    // 静态资源服务的文件夹 默认是public
    publicDir: resolvedPublicDir,
    // 缓存目录，默认 node_modules/.vite
    cacheDir,
    // serve | build
    command,
    // development | production
    mode,
    ssr,
    isWorker: false,
    mainConfig: null,
    // 是否是生产环境
    isProduction,
    // 自定义 plugins
    plugins: userPlugins,
    // css相关的
    css: resolveCSSOptions(config.css),
    esbuild:
      config.esbuild === false
        ? false
        : {
          jsxDev: !isProduction,
          ...config.esbuild,
        },
    server,
    build: resolvedBuildOptions,
    preview: resolvePreviewOptions(config.preview, server),
    envDir,
    env: {
      ...userEnv, // .env 文件
      BASE_URL,
      MODE: mode,
      DEV: !isProduction,
      PROD: isProduction,
    },
    // 一个函数，用于获取传入的 file 是否能作为静态资源处理，如果能，导入它们就会返回解析后的 URL
    assetsInclude(file: string) {
      return DEFAULT_ASSETS_RE.test(file) || assetsFilter(file)
    },
    logger,
    packageCache,
    createResolver, // 特殊场景中使用的内部解析器，预构建文件中会说
    // 依赖优化选项
    optimizeDeps: {
      disabled: 'build',
      ...optimizeDeps,
      // esbuild 配置
      esbuildOptions: {
        preserveSymlinks: resolveOptions.preserveSymlinks,
        ...optimizeDeps.esbuildOptions,
      },
    },
    worker: resolvedWorkerOptions,
    /**
     * 类型： 'spa' | 'mpa' | 'custom' 默认： 'spa'
无论你的应用是一个单页应用（SPA）还是一个 多页应用（MPA），亦或是一个定制化应用（SSR 和自定义 HTML 处理的框架）：
'spa'：包含 HTML 中间件以及使用 SPA 回退。在预览中将 sirv 配置为 single: true
'mpa'：包含 HTML 中间件
'custom'：不包含 HTML 中间件
     */
    appType: config.appType ?? (middlewareMode === 'ssr' ? 'custom' : 'spa'),
    experimental: {
      importGlobRestoreExtension: false,
      hmrPartialAccept: false,
      ...config.experimental,
    },
    getSortedPlugins: undefined!,
    getSortedPluginHooks: undefined!,
  }
  // 创建 resolved 对象，并拼接配置
  // 这个resolved对象就是最后处理完的所有配置。最后resolveConfig函数也会返回这个resolved对象
  const resolved: ResolvedConfig = {
    ...config,
    ...resolvedConfig,
  }

    // TODO: !!! 整合Vite自带的插件，代码如下:
    // 将vite自带插件和用户定义插件按顺序组合，并返回，更新到 resolved.plugins 这个数组里面
    ; (resolved.plugins as Plugin[]) = await resolvePlugins(
      resolved,
      prePlugins,
      normalPlugins,
      postPlugins,
    )
  // 将 createPluginHookUtils 函数返回的两个函数 getSortedPlugins, getSortedPluginHooks, 合并到 resolved 这个对象上面
  Object.assign(resolved, createPluginHookUtils(resolved.plugins))

  const workerResolved: ResolvedConfig = {
    ...workerConfig,
    ...resolvedConfig,
    isWorker: true,
    mainConfig: resolved,
  }
  resolvedConfig.worker.plugins = await resolvePlugins(
    workerResolved,
    workerPrePlugins,
    workerNormalPlugins,
    workerPostPlugins,
  )
  // 将 createPluginHookUtils 函数返回的两个函数 getSortedPlugins, getSortedPluginHooks, 合并到 resolvedConfig.worker 这个对象上面
  Object.assign(
    resolvedConfig.worker,
    createPluginHookUtils(resolvedConfig.worker.plugins),
  )

  // 所有插件拼接好之后，调用所有插件的configResolved钩子函数
  // call configResolved hooks
  await Promise.all([
    ...resolved
      .getSortedPluginHooks('configResolved')
      .map((hook) => hook(resolved)),
    ...resolvedConfig.worker
      .getSortedPluginHooks('configResolved')
      .map((hook) => hook(workerResolved)),
  ])

  // validate config

  if (middlewareMode === 'ssr') {
    logger.warn(
      colors.yellow(
        `Setting server.middlewareMode to 'ssr' is deprecated, set server.middlewareMode to \`true\`${config.appType === 'custom' ? '' : ` and appType to 'custom'`
        } instead`,
      ),
    )
  }
  if (middlewareMode === 'html') {
    logger.warn(
      colors.yellow(
        `Setting server.middlewareMode to 'html' is deprecated, set server.middlewareMode to \`true\` instead`,
      ),
    )
  }

  // server.force 已被弃用，应使用 optimizeDeps.force 代替。
  // 提醒去 optimizeDeps 中操作 force
  if (
    config.server?.force &&
    !isBuild &&
    config.optimizeDeps?.force === undefined
  ) {
    resolved.optimizeDeps.force = true
    logger.warn(
      colors.yellow(
        `server.force is deprecated, use optimizeDeps.force instead`,
      ),
    )
  }

  debug?.(`using resolved config: %O`, {
    ...resolved,
    plugins: resolved.plugins.map((p) => p.name),
    worker: {
      ...resolved.worker,
      plugins: resolved.worker.plugins.map((p) => p.name),
    },
  })

  // 下面就是一些提示信息了，不重要了
  if (config.build?.terserOptions && config.build.minify !== 'terser') {
    logger.warn(
      colors.yellow(
        `build.terserOptions is specified but build.minify is not set to use Terser. ` +
        `Note Vite now defaults to use esbuild for minification. If you still ` +
        `prefer Terser, set build.minify to "terser".`,
      ),
    )
  }

  // Check if all assetFileNames have the same reference.
  // If not, display a warn for user.
  const outputOption = config.build?.rollupOptions?.output ?? []
  // Use isArray to narrow its type to array
  if (Array.isArray(outputOption)) {
    const assetFileNamesList = outputOption.map(
      (output) => output.assetFileNames,
    )
    if (assetFileNamesList.length > 1) {
      const firstAssetFileNames = assetFileNamesList[0]
      const hasDifferentReference = assetFileNamesList.some(
        (assetFileNames) => assetFileNames !== firstAssetFileNames,
      )
      if (hasDifferentReference) {
        resolved.logger.warn(
          colors.yellow(`
assetFileNames isn't equal for every build.rollupOptions.output. A single pattern across all outputs is supported by Vite.
`),
        )
      }
    }
  }

  // Warn about removal of experimental features
  if (
    config.legacy?.buildSsrCjsExternalHeuristics ||
    config.ssr?.format === 'cjs'
  ) {
    resolved.logger.warn(
      colors.yellow(`
(!) Experimental legacy.buildSsrCjsExternalHeuristics and ssr.format: 'cjs' are going to be removed in Vite 5.
    Find more information and give feedback at https://github.com/vitejs/vite/discussions/13816.
`),
    )
  }

  return resolved
}

/**
 * Resolve base url. Note that some users use Vite to build for non-web targets like
 * electron or expects to deploy
 */
export function resolveBaseUrl(
  base: UserConfig['base'] = '/',
  isBuild: boolean,
  logger: Logger,
): string {
  if (base[0] === '.') {
    logger.warn(
      colors.yellow(
        colors.bold(
          `(!) invalid "base" option: ${base}. The value can only be an absolute ` +
          `URL, ./, or an empty string.`,
        ),
      ),
    )
    return '/'
  }

  // external URL flag
  const isExternal = isExternalUrl(base)
  // no leading slash warn
  if (!isExternal && base[0] !== '/') {
    logger.warn(
      colors.yellow(
        colors.bold(`(!) "base" option should start with a slash.`),
      ),
    )
  }

  // parse base when command is serve or base is not External URL
  if (!isBuild || !isExternal) {
    base = new URL(base, 'http://vitejs.dev').pathname
    // ensure leading slash
    if (base[0] !== '/') {
      base = '/' + base
    }
  }

  return base
}

/**
 * 属性值为 pre：表示提前执行的插件，放到 prePlugins 中
 * 属性值为 post：表示最后执行的插件，放到 postPlugins 中
 * 没有设置或者设置的是其他属性值：表示正常执行的插件，放到 normalPlugins 中
 */
export function sortUserPlugins(
  plugins: (Plugin | Plugin[])[] | undefined,
): [Plugin[], Plugin[], Plugin[]] {
  const prePlugins: Plugin[] = []
  const postPlugins: Plugin[] = []
  const normalPlugins: Plugin[] = []

  if (plugins) {
    plugins.flat().forEach((p) => {
      if (p.enforce === 'pre') prePlugins.push(p)
      else if (p.enforce === 'post') postPlugins.push(p)
      else normalPlugins.push(p)
    })
  }

  return [prePlugins, normalPlugins, postPlugins]
}

// 1、查找、校验配置文件的路径，并判断文件类型（是不是ts、是不是遵循ESM规范）
// 2、根据路径和类型获取文件内容
export async function loadConfigFromFile(
  configEnv: ConfigEnv,
  configFile?: string,
  configRoot: string = process.cwd(),
  logLevel?: LogLevel,
): Promise<{
  path: string
  config: UserConfig
  dependencies: string[]
} | null> {
  const start = performance.now()
  const getTime = () => `${(performance.now() - start).toFixed(2)}ms`

  // 配置文件vie.config.js的路径
  let resolvedPath: string | undefined

  if (configFile) {
    // explicit config path is always resolved from cwd
    resolvedPath = path.resolve(configFile)
  } else {
    // implicit config file loaded from inline root (if present)
    // otherwise from cwd
    /**
     *    'vite.config.js',
          'vite.config.mjs',
          'vite.config.ts',
          'vite.config.cjs',
          'vite.config.mts',
          'vite.config.cts',
     */
    for (const filename of DEFAULT_CONFIG_FILES) {
      const filePath = path.resolve(configRoot, filename)
      if (!fs.existsSync(filePath)) continue

      resolvedPath = filePath
      break
    }
  }

  // 如果没有找到vite的配置文件 ，抛出异常
  if (!resolvedPath) {
    debug?.('no config file found.')
    return null
  }

  // 标注是不是 ESM 规范的文件
  let isESM = false
  if (/\.m[jt]s$/.test(resolvedPath)) {
    isESM = true
  } else if (/\.c[jt]s$/.test(resolvedPath)) {
    isESM = false
  } else {
    // check package.json for type: "module" and set `isESM` to true
    try {
      // 如果 package.json 中的 type 属性是 module，则说明配置文件遵循 ESM 规范
      // 拿到 package.json 的文件路径
      const pkg = lookupFile(configRoot, ['package.json'])
      isESM =
        !!pkg && JSON.parse(fs.readFileSync(pkg, 'utf-8')).type === 'module'
    } catch (e) { }
  }

  try {
    // 通过 ESbuild 打包文件，第二个参数表示打包后的文件类型，true是遵循ESM规范
    // bundled有编译后的代码和配置文件对应的依赖
    const bundled = await bundleConfigFile(resolvedPath, isESM)
    // 这里用这个函数的主要作用是即可以获取遵循ESM规范的导出，又可以获取遵循CommonJS规范的导出
    // 导出的就是 vite.config.js 中的内容
    const userConfig = await loadConfigFromBundledFile(
      resolvedPath,
      bundled.code,
      isESM,
    )
    debug?.(`bundled config file loaded in ${getTime()}`)

    // 如果 配置文件导出的是一个函数，则执行该函数
    // 函数的参数是 configEnv { command, mode, ssrBuild }, 这也是为什么 vite.config.js 中写函数时的参数可以解构出 command mode ssrBuild 的原因
    const config = await (typeof userConfig === 'function'
      ? userConfig(configEnv)
      : userConfig)
    // 如果不是对象就抛出错误!
    if (!isObject(config)) {
      throw new Error(`config must export or return an object.`)
    }
    return {
      path: normalizePath(resolvedPath),
      config,
      dependencies: bundled.dependencies,
    }
  } catch (e) {
    createLogger(logLevel).error(
      colors.red(`failed to load config from ${resolvedPath}`),
      { error: e },
    )
    throw e
  }
}

// bundleConfigFile内调用的esbuild 的配置中设置了 metafile: true 用于生成依赖关系
// 并且手写了一个 esbuild 的 plugin，不会将第三方库打包在 bundle 中，即生成的依赖也不会包含第三方库
// 所以里面的 dependencies 内容，只包含用户自己写的文件
async function bundleConfigFile(
  fileName: string,
  isESM: boolean,
): Promise<{ code: string; dependencies: string[] }> {
  const dirnameVarName = '__vite_injected_original_dirname'
  const filenameVarName = '__vite_injected_original_filename'
  const importMetaUrlVarName = '__vite_injected_original_import_meta_url'
  // 调用esbuild执行打包
  const result = await build({
    absWorkingDir: process.cwd(), // 工作文件夹的绝对路径
    entryPoints: [fileName], // 入口文件，通过对象方式可以指定输出后文件名，和 webpack 类似
    outfile: 'out.js', // 输出的文件名，，不能和 outdir 同时使用；单入口文件使用 outfile
    write: false, // 默认 false，对于cli和js API，默认是写入文件系统中，设置为 true 后，写入内存缓冲区
    target: ['node14.18', 'node16'], // 设置目标环境，默认是 esnext（使用最新 es 特性）
    platform: 'node', // 指定输出环境，默认为 browser 还有一个值是 node，
    bundle: true, // 将所有源码打包到一起
    format: isESM ? 'esm' : 'cjs', // js 输出规范（iife/cjs/esm），如果 platform 为 browser，默认为 iife；如果 platform 为 node，默认为 cjs
    mainFields: ['main'],
    sourcemap: 'inline',
    metafile: true, // 生成依赖图
    define: { // define = {K: V}  在解析代码的时候用V替换K
      __dirname: dirnameVarName,
      __filename: filenameVarName,
      'import.meta.url': importMetaUrlVarName,
    },
    plugins: [ // 插件
      {
        name: 'externalize-deps',
        setup(build) {
          const packageCache = new Map()
          const resolveByViteResolver = (
            id: string,
            importer: string,
            isRequire: boolean,
          ) => {
            return tryNodeResolve(
              id,
              importer,
              {
                root: path.dirname(fileName),
                isBuild: true,
                isProduction: true,
                preferRelative: false,
                tryIndex: true,
                mainFields: [],
                browserField: false,
                conditions: [],
                overrideConditions: ['node'],
                dedupe: [],
                extensions: DEFAULT_EXTENSIONS,
                preserveSymlinks: false,
                packageCache,
                isRequire,
              },
              false,
            )?.id
          }
          const isESMFile = (id: string): boolean => {
            if (id.endsWith('.mjs')) return true
            if (id.endsWith('.cjs')) return false

            const nearestPackageJson = findNearestPackageData(
              path.dirname(id),
              packageCache,
            )
            return (
              !!nearestPackageJson && nearestPackageJson.data.type === 'module'
            )
          }

          // externalize bare imports
          build.onResolve(
            { filter: /^[^.].*/ },
            async ({ path: id, importer, kind }) => {
              if (
                kind === 'entry-point' ||
                path.isAbsolute(id) ||
                isNodeBuiltin(id)
              ) {
                return
              }

              // With the `isNodeBuiltin` check above, this check captures if the builtin is a
              // non-node built-in, which esbuild doesn't know how to handle. In that case, we
              // externalize it so the non-node runtime handles it instead.
              if (isBuiltin(id)) {
                return { external: true }
              }

              const isImport = isESM || kind === 'dynamic-import'
              let idFsPath: string | undefined
              try {
                idFsPath = resolveByViteResolver(id, importer, !isImport)
              } catch (e) {
                if (!isImport) {
                  let canResolveWithImport = false
                  try {
                    canResolveWithImport = !!resolveByViteResolver(
                      id,
                      importer,
                      false,
                    )
                  } catch { }
                  if (canResolveWithImport) {
                    throw new Error(
                      `Failed to resolve ${JSON.stringify(
                        id,
                      )}. This package is ESM only but it was tried to load by \`require\`. See http://vitejs.dev/guide/troubleshooting.html#this-package-is-esm-only for more details.`,
                    )
                  }
                }
                throw e
              }
              if (idFsPath && isImport) {
                idFsPath = pathToFileURL(idFsPath).href
              }
              if (idFsPath && !isImport && isESMFile(idFsPath)) {
                throw new Error(
                  `${JSON.stringify(
                    id,
                  )} resolved to an ESM file. ESM file cannot be loaded by \`require\`. See http://vitejs.dev/guide/troubleshooting.html#this-package-is-esm-only for more details.`,
                )
              }
              return {
                path: idFsPath,
                external: true,
              }
            },
          )
        },
      },
      {
        name: 'inject-file-scope-variables',
        setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
            const contents = await fsp.readFile(args.path, 'utf8')
            const injectValues =
              `const ${dirnameVarName} = ${JSON.stringify(
                path.dirname(args.path),
              )};` +
              `const ${filenameVarName} = ${JSON.stringify(args.path)};` +
              `const ${importMetaUrlVarName} = ${JSON.stringify(
                pathToFileURL(args.path).href,
              )};`

            return {
              loader: args.path.endsWith('ts') ? 'ts' : 'js',
              contents: injectValues + contents,
            }
          })
        },
      },
    ],
  })
  // outputFiles 只有在 write 为 false 时，才会输出，它是一个 Uint8Array
  const { text } = result.outputFiles[0]
  return {
    code: text,
    dependencies: result.metafile ? Object.keys(result.metafile.inputs) : [],
  }
}

interface NodeModuleWithCompile extends NodeModule {
  _compile(code: string, filename: string): any
}

const _require = createRequire(import.meta.url)
async function loadConfigFromBundledFile(
  fileName: string,
  bundledCode: string,
  isESM: boolean,
): Promise<UserConfigExport> {
  // 对于 ESM（ECMAScript Modules），在不需要用户自己运行带有 --experimental-loader 参数的 node 之前，我们必须在此进行一些黑客操作：将其写入磁盘，使用原生 Node ESM 加载它，然后删除文件。
  if (isESM) {
    // 新建 js 文件，并将打包后的代码写入文件中
    const fileBase = `${fileName}.timestamp-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`
    const fileNameTmp = `${fileBase}.mjs`
    const fileUrl = `${pathToFileURL(fileBase)}.mjs`
    // 写入文件中
    await fsp.writeFile(fileNameTmp, bundledCode)
    try {
      // 通过 import() 动态加载刚创建的 js 文件，并获取导出内容，将其返回
      return (await dynamicImport(fileUrl)).default
    } finally {
      // 删除刚创建的文件
      fs.unlink(fileNameTmp, () => { }) // Ignore errors
    }
  }
  // 对于 CJS（CommonJS），我们可以通过 _require.extensions 注册一个自定义加载器
  else {
    // 不需要写一个新的文件而require这个文件代码的功能
    // 拿到文件扩展名
    const extension = path.extname(fileName)
    // 我们在这里不使用 fsp.realpath()，因为它的行为与 fs.realpath.native 相同。在某些 Windows 系统上，它返回大写的卷字母（例如 "C:"），而 Node.js 加载器使用小写的卷字母。
    const realFileName = await promisifiedRealpath(fileName)
    const loaderExt = extension in _require.extensions ? extension : '.js'
    const defaultLoader = _require.extensions[loaderExt]!
    // 对requireLoader的默认行为进行扩展
    _require.extensions[loaderExt] = (module: NodeModule, filename: string) => {
      if (filename === realFileName) {
        ; (module as NodeModuleWithCompile)._compile(bundledCode, filename)
      } else {
        defaultLoader(module, filename)
      }
    }
    // 服务重启的时候清除缓存
    delete _require.cache[_require.resolve(fileName)]
    const raw = _require(fileName)
    _require.extensions[loaderExt] = defaultLoader
    return raw.__esModule ? raw.default : raw
  }
}

/**
 * 执行插件的config钩子
 * @param config
 * @param plugins
 * @param configEnv
 * @returns config 钩子函数可以修改配置项，并返回新的配置项 拿到新的配置项之后，让新的配置项和老的配置项合并
 */
async function runConfigHook(
  config: InlineConfig,
  plugins: Plugin[],
  configEnv: ConfigEnv,
): Promise<InlineConfig> {
  let conf = config

  // 执行所有自定义插件的 config 钩子函数
  // 并传入vite的配置项和 configEnv
  // configEnv（对象内部： mode: 'development'|'production', command: 'serve'|'build' ）
  for (const p of getSortedPluginsByHook('config', plugins)) {
    const hook = p.config
    const handler = hook && 'handler' in hook ? hook.handler : hook
    if (handler) {
      const res = await handler(conf, configEnv)
      // 也就是说 config 钩子函数可以修改配置项，并返回新的配置项
      // 拿到新的配置项之后，让新的配置项和老的配置项合并
      if (res) {
        conf = mergeConfig(conf, res)
      }
    }
  }

  return conf
}

// 返回依赖预构建的配置
export function getDepOptimizationConfig(
  config: ResolvedConfig,
  ssr: boolean,
): DepOptimizationConfig {
  return ssr ? config.ssr.optimizeDeps : config.optimizeDeps
}
export function isDepsOptimizerEnabled(
  config: ResolvedConfig,
  ssr: boolean,
): boolean {
  const { command } = config
  // disabled: 禁用依赖优化，值为 true 将在构建和开发期间均禁用优化器。传 'build' 或 'dev' 将仅在其中一种模式下禁用优化器。默认情况下，仅在开发阶段启用依赖优化。
  const { disabled } = getDepOptimizationConfig(config, ssr)
  return !(
    disabled === true ||
    (command === 'build' && disabled === 'build') ||
    (command === 'serve' && disabled === 'dev')
  )
}
