import glob from 'fast-glob'
import type { WatchOptions } from 'dep-types/chokidar'
import type { ResolvedConfig } from '.'

// ignored：忽略监听的文件；watchOptions：对应 server.watch 配置，传递给 chokidar 的文件系统监视器选项
export function resolveChokidarOptions(
  config: ResolvedConfig,
  options: WatchOptions | undefined,
): WatchOptions {
  const { ignored = [], ...otherOptions } = options ?? {}

  const resolvedWatchOptions: WatchOptions = {
    // 默认的不监听的文件：
    ignored: [
      '**/.git/**',
      '**/node_modules/**',
      '**/test-results/**', // Playwright
      glob.escapePath(config.cacheDir) + '/**',
      ...(Array.isArray(ignored) ? ignored : [ignored]),
    ],
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ...otherOptions,
  }

  return resolvedWatchOptions
}
