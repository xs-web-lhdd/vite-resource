import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server } from 'node:http'
import colors from 'picocolors'
import type { Update } from 'types/hmrPayload'
import type { RollupError } from 'rollup'
import { CLIENT_DIR } from '../constants'
import {
  createDebugger,
  normalizePath,
  unique,
  withTrailingSlash,
  wrapId,
} from '../utils'
import type { ViteDevServer } from '..'
import { isCSSRequest } from '../plugins/css'
import { getAffectedGlobModules } from '../plugins/importMetaGlob'
import { isExplicitImportRequired } from '../plugins/importAnalysis'
import type { ModuleNode } from './moduleGraph'

export const debugHmr = createDebugger('vite:hmr')

const whitespaceRE = /\s/

const normalizedClientDir = normalizePath(CLIENT_DIR)

export interface HmrOptions {
  protocol?: string
  host?: string
  port?: number
  clientPort?: number
  path?: string
  timeout?: number
  overlay?: boolean
  server?: Server
}

export interface HmrContext {
  file: string
  timestamp: number
  modules: Array<ModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

export function getShortName(file: string, root: string): string {
  return file.startsWith(withTrailingSlash(root))
    ? path.posix.relative(root, file)
    : file
}
// 对热更新处理的函数,整体流程如下:
/**
配置文件更新、.env更新、自定义插件或引入配置文件的自定义文件更新都会重起服务器
客户端使用的热更新文件更新、index.html更新，重新加载页面
调用所有插件定义的handleHotUpdate钩子函数，具体功能可参考文档
    过滤和缩小受影响的模块列表，使 HMR 更准确。
    返回一个空数组，并通过向客户端发送自定义事件来执行完整的自定义 HMR 处理
如果是其他文件更新，调用updateModules函数
 */
export async function handleHMRUpdate(
  file: string,
  server: ViteDevServer,
  configOnly: boolean,
): Promise<void> {
  const { ws, config, moduleGraph } = server
  // 获取 file 相对于根路径的相对路径
  const shortFile = getShortName(file, config.root)
  // 拿到文件名称
  const fileName = path.basename(file)

  // 如果当前文件是配置文件则为 true
  const isConfig = file === config.configFile
  // 如果当前文件名是自定义的插件则为 true
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name,
  )
  //如果是环境变量文件，则为 true
  const isEnv =
    config.inlineConfig.envFile !== false &&
    (fileName === '.env' || fileName.startsWith('.env.'))
  // 环境变量文件、自定义插件、配置文件修改会重启服务
  if (isConfig || isConfigDependency || isEnv) {
    // auto restart server
    debugHmr?.(`[config change] ${colors.dim(shortFile)}`)
    config.logger.info(
      colors.green(
        `${path.relative(process.cwd(), file)} changed, restarting server...`,
      ),
      { clear: true, timestamp: true },
    )
    try {
      // 重启服务!!!
      await server.restart()
    } catch (e) {
      config.logger.error(colors.red(e))
    }
    return
  }

  if (configOnly) {
    return
  }

  // 打印出那个文件发生了改变的日志。。。
  debugHmr?.(`[file change] ${colors.dim(shortFile)}`)

  // /xxx/node_modules/vite/dist/client
  // 如果是客户端使用的热更新文件发生改变则重新加载页面(client.mjs 对应 src/client/client.ts文件)
  // （仅开发人员）客户端本身不能进行热更新。修改了就要重新加载。。。
  if (file.startsWith(withTrailingSlash(normalizedClientDir))) {
    ws.send({
      type: 'full-reload',
      path: '*',
    })
    return
  }

  // 根据文件绝对路径获取 ModuleNode 对象（Set）
  // 是一个数组，因为会出现单个文件可能映射到多个服务模块，比如 Vue单文件组件
  const mods = moduleGraph.getModulesByFile(file)

  // check if any plugin wants to perform custom HMR handling
  // 为插件中的 handleHotUpdate 服务的
  const timestamp = Date.now()
  const hmrContext: HmrContext = {
    file,
    timestamp,
    modules: mods ? [...mods] : [], // 是受更改文件影响的模块数组。它是一个数组，因为单个文件可能映射到多个服务模块（例如 Vue 单文件组件）
    read: () => readModifiedFile(file), // 这是一个异步读函数，它返回文件的内容。之所以这样做，是因为在某些系统上，文件更改的回调函数可能会在编辑器完成文件更新之前过快地触发，并 fs.readFile 直接会返回空内容。传入的 read 函数规范了这种行为。
    server,
  }

  // 调用所有插件定义的 handleHotUpdate 钩子函数
  for (const hook of config.getSortedPluginHooks('handleHotUpdate')) {
    const filteredModules = await hook(hmrContext)
    if (filteredModules) {
      hmrContext.modules = filteredModules
    }
  }

  if (!hmrContext.modules.length) {
    // 如果是 html 文件 重新加载页面
    if (file.endsWith('.html')) {
      config.logger.info(colors.green(`page reload `) + colors.dim(shortFile), {
        clear: true,
        timestamp: true,
      })
      ws.send({
        type: 'full-reload',
        path: config.server.middlewareMode
          ? '*'
          : '/' + normalizePath(path.relative(config.root, file)),
      })
    } else {
      // 已加载但不在module graph中，可能不是 JavaScript 文件。
      debugHmr?.(`[no modules matched] ${colors.dim(shortFile)}`)
    }
    return
  }

  // 如果是其他文件更新，调用updateModules函数
  updateModules(shortFile, hmrContext.modules, timestamp, server)
}

export function updateModules(
  file: string,
  modules: ModuleNode[],
  timestamp: number,
  { config, ws, moduleGraph }: ViteDevServer,
  afterInvalidation?: boolean,
): void {
  // 用于存储要更新的模块
  const updates: Update[] = []
  const invalidatedModules = new Set<ModuleNode>()
  const traversedModules = new Set<ModuleNode>()
  // 是否需要全部更新（重新加载）
  let needFullReload = false

  // 遍历该文件编译后的所有文件
  for (const mod of modules) {
    const boundaries: { boundary: ModuleNode; acceptedVia: ModuleNode }[] = []
    // TODO: !!! 查找引用模块，判断是否需要重载页面
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries)

    // 沿着引用路线向上查找，设置时间戳、清空 transformResult
    moduleGraph.invalidateModule(
      mod,
      invalidatedModules,
      timestamp,
      true,
      boundaries.map((b) => b.boundary),
    )

    // 根据needFullReload的值判断是重新加载整个页面还是更新某些模块updates
    // 如果需要重新加载，不需要再遍历其他的了，因为已经知道要重新刷新页面了，那么既然要重新刷新页面了，就不需要再处理HMR了
    if (needFullReload) {
      continue
    }

    if (hasDeadEnd) {
      // 如果 hasDeadEnd 为 true，则全部更新。
      needFullReload = true
      continue
    }

    updates.push(
      ...boundaries.map(({ boundary, acceptedVia }) => ({
        type: `${boundary.type}-update` as const,  // 更新类型
        timestamp, // 时间戳
        path: normalizeHmrUrl(boundary.url), // 导入该模块的模块
        explicitImportRequired:
          boundary.type === 'js'
            ? isExplicitImportRequired(acceptedVia.url)
            : undefined,
        acceptedPath: normalizeHmrUrl(acceptedVia.url),  // 当前模块
      })),
    )
  }

  // 循环完成之后，将消息发送给客户端。根据needFullReload判断更新方式；如果propagateUpdate返回true，说明需要重新加载页面。反之就是更新模块。
  if (needFullReload) {
    config.logger.info(colors.green(`page reload `) + colors.dim(file), {
      clear: !afterInvalidation,
      timestamp: true,
    })
    ws.send({
      type: 'full-reload',
    })
    return
  }

  // 没有模块需要更新...
  if (updates.length === 0) {
    debugHmr?.(colors.yellow(`no update happened `) + colors.dim(file))
    return
  }

  config.logger.info(
    colors.green(`hmr update `) +
    colors.dim([...new Set(updates.map((u) => u.path))].join(', ')),
    { clear: !afterInvalidation, timestamp: true },
  )
  // 把要更新的模块发送给客户端...
  ws.send({
    type: 'update',
    updates,
  })
}

export async function handleFileAddUnlink(
  file: string,
  server: ViteDevServer,
): Promise<void> {
  const modules = [...(server.moduleGraph.getModulesByFile(file) || [])]

  modules.push(...getAffectedGlobModules(file, server))

  if (modules.length > 0) {
    updateModules(
      getShortName(file, server.config.root),
      unique(modules),
      Date.now(),
      server,
    )
  }
}

function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>,
) {
  for (const binding of importedBindings) {
    if (!acceptedExports.has(binding)) {
      return false
    }
  }
  return true
}

// 这个函数的作用就是获取要更新的所有模块，并判断是否要重新加载整个页面。沿着导入链向上查找，直到找到接收自更新或者接收子模块更新的模块，将这个模块添加到boundaries中；并返回true，反之返回false
// 同时判读了有没有循环引用
function propagateUpdate(
  node: ModuleNode,
  traversedModules: Set<ModuleNode>,
  boundaries: { boundary: ModuleNode; acceptedVia: ModuleNode }[],
  currentChain: ModuleNode[] = [node], // 维护一个数组判断有没有进行模块间的循环引用
): boolean /* hasDeadEnd */ {
  if (traversedModules.has(node)) {
    return false
  }
  traversedModules.add(node)

  // #7561
  // if the imports of `node` have not been analyzed, then `node` has not
  // been loaded in the browser and we should stop propagation.
  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr?.(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id,
      )}`,
    )
    return false
  }

  // 如果是自身监听，则添加到 boundaries 中，并返回 false
  if (node.isSelfAccepting) {
    boundaries.push({ boundary: node, acceptedVia: node })

    // 此外，还要检查 CSS 导入器，因为像 Tailwind JIT 这样的 PostCSS 插件可能会将任何文件注册为 CSS 文件的依赖项。
    // 通过node.importers拿到所有引入当前node的模块
    for (const importer of node.importers) {
      if (isCSSRequest(importer.url) && !currentChain.includes(importer)) {
        propagateUpdate(
          importer,
          traversedModules,
          boundaries,
          currentChain.concat(importer),
        )
      }
    }

    return false
  }

  // A partially accepted module with no importers is considered self accepting,
  // because the deal is "there are parts of myself I can't self accept if they
  // are used outside of me".
  // Also, the imported module (this one) must be updated before the importers,
  // so that they do get the fresh imported module when/if they are reloaded.
  if (node.acceptedHmrExports) {
    boundaries.push({ boundary: node, acceptedVia: node })
  } else {
    if (!node.importers.size) {
      return true
    }

    // #3716, #3913
    // For a non-CSS file, if all of its importers are CSS files (registered via
    // PostCSS plugins) it should be considered a dead end and force full reload.
    // 这个文件不是css，但是引入这个文件的模块是css也要特殊处理
    if (
      !isCSSRequest(node.url) &&
      [...node.importers].every((i) => isCSSRequest(i.url))
    ) {
      return true
    }
  }
  // 遍历导入此模块的所有模块对象，向上查找
  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer)
    // 如果当前模块的上层模块接收当前模块的更新，则添加到 boundaries 中
    if (importer.acceptedHmrDeps.has(node)) {
      // boundary: importer, 导入当前模块的模块对象 acceptedVia: node, // 当前模块
      boundaries.push({ boundary: importer, acceptedVia: node })
      continue
    }

    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      const importedBindingsFromNode = importer.importedBindings.get(node.id)
      if (
        importedBindingsFromNode &&
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue
      }
    }

    // 循环引用，如果不 return 出去，则会造成死循环
    if (currentChain.includes(importer)) {
      // circular deps is considered dead end
      return true
    }

    // 完整的模块向上遍历，直到APP为止，是一个递归的过程
    // 递归调用 propagateUpdate，收集 boundaries，向上查找
    if (propagateUpdate(importer, traversedModules, boundaries, subChain)) {
      return true
    }
  }
  return false
}
// 更新这些模块的时间戳，并向客户端发送类型为prune的消息
export function handlePrunedModules(
  mods: Set<ModuleNode>,
  { ws }: ViteDevServer,
): void {
  // update the disposed modules' hmr timestamp
  // since if it's re-imported, it should re-apply side effects
  // and without the timestamp the browser will not re-import it!
  const t = Date.now()
  mods.forEach((mod) => {
    mod.lastHMRTimestamp = t
    debugHmr?.(`[dispose] ${colors.dim(mod.file)}`)
  })
  ws.send({
    type: 'prune',
    paths: [...mods].map((m) => m.url),
  })
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray,
}

/**
 * Lex import.meta.hot.accept() for accepted deps.
 * Since hot.accept() can only accept string literals or array of string
 * literals, we don't really need a heavy @babel/parse call on the entire source.
 *
 * @returns selfAccepts
 */
// 遍历源码，根据，判断。如果是接收直接依赖项的更新，则将路径添加到urls中，并返回false。如果是接收自身更新，返回true
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<{ url: string; start: number; end: number }>,
): boolean {
  let state: LexerState = LexerState.inCall
  // the state can only be 2 levels deep so no need for a stack
  let prevState: LexerState = LexerState.inCall
  let currentDep: string = ''

  function addDep(index: number) {
    urls.add({
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1,
    })
    currentDep = ''
  }

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i)
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        if (char === `'`) {
          prevState = state
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          prevState = state
          state = LexerState.inDoubleQuoteString
        } else if (char === '`') {
          prevState = state
          state = LexerState.inTemplateString
        } else if (whitespaceRE.test(char)) {
          continue
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray
            } else {
              // reaching here means the first arg is neither a string literal
              // nor an Array literal (direct callback) or there is no arg
              // in both case this indicates a self-accepting module
              return true // done
            }
          } else if (state === LexerState.inArray) {
            if (char === `]`) {
              return false // done
            } else if (char === ',') {
              continue
            } else {
              error(i)
            }
          }
        }
        break
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inTemplateString:
        if (char === '`') {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else if (char === '$' && code.charAt(i + 1) === '{') {
          error(i)
        } else {
          currentDep += char
        }
        break
      default:
        throw new Error('unknown import.meta.hot lexer state')
    }
  }
  return false
}

export function lexAcceptedHmrExports(
  code: string,
  start: number,
  exportNames: Set<string>,
): boolean {
  const urls = new Set<{ url: string; start: number; end: number }>()
  lexAcceptedHmrDeps(code, start, urls)
  for (const { url } of urls) {
    exportNames.add(url)
  }
  return urls.size > 0
}

export function normalizeHmrUrl(url: string): string {
  if (url[0] !== '.' && url[0] !== '/') {
    url = wrapId(url)
  }
  return url
}

function error(pos: number) {
  const err = new Error(
    `import.meta.hot.accept() can only accept string literals or an ` +
    `Array of string literals.`,
  ) as RollupError
  err.pos = pos
  throw err
}

/**
在 Vite.js 的#610 问题中，当热重载 Vue 文件时，我们会立即在文件更改事件上进行读取，有时这可能会过早，导致获取到空的缓冲区。因此，我们可以在再次读取之前进行轮询，直到文件的修改时间发生变化。
这是指 Vite.js 中的一个问题，即在热重载 Vue 文件时，由于文件更改事件的触发可能过早，导致读取到的内容为空。为了解决这个问题，可以采用一种轮询的方式，等待文件的修改时间发生变化后再进行读取。
这种方式可以确保文件内容已经完全写入到磁盘上，避免读取到空的缓冲区。通过轮询文件的修改时间，可以等待文件内容的更新，然后再进行读取，从而确保获取到正确的文件内容。这可以提高热重载的可靠性和稳定性，避免由于过早读取文件而导致的错误或不完整的内容加载。

比如一些编译器，在内容修改后保存会文件的change事件的，但是这个时候并不一定编辑器就已经把文件内容给写进去了，也有可能还没写进去，所以vite这样做是为了确保能读到真真正正更新后的文件内容
 */
async function readModifiedFile(file: string): Promise<string> {
  const content = await fsp.readFile(file, 'utf-8')
  if (!content) {
    // mtimeMS 文件最近的一次更新时间
    const mtime = (await fsp.stat(file)).mtimeMs
    await new Promise((r) => {
      let n = 0
      const poll = async () => {
        n++
        const newMtime = (await fsp.stat(file)).mtimeMs
        if (newMtime !== mtime || n > 10) {
          r(0) // resolved
        } else {
          setTimeout(poll, 10)
        }
      }
      setTimeout(poll, 10)
    })
    return await fsp.readFile(file, 'utf-8')
  } else {
    return content
  }
}
