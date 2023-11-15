import type { ErrorPayload, HMRPayload, Update } from 'types/hmrPayload'
import type { ModuleNamespace, ViteHotContext } from 'types/hot'
import type { InferCustomEventPayload } from 'types/customEvent'
import { ErrorOverlay, overlayId } from './overlay'
import '@vite/env'

// injected by the hmr plugin when served
declare const __BASE__: string
declare const __SERVER_HOST__: string
declare const __HMR_PROTOCOL__: string | null
declare const __HMR_HOSTNAME__: string | null
declare const __HMR_PORT__: number | null
declare const __HMR_DIRECT_TARGET__: string
declare const __HMR_BASE__: string
declare const __HMR_TIMEOUT__: number
declare const __HMR_ENABLE_OVERLAY__: boolean

console.debug('[vite] connecting...')

const importMetaUrl = new URL(import.meta.url)

// use server configuration, then fallback to inference
const serverHost = __SERVER_HOST__
const socketProtocol =
  __HMR_PROTOCOL__ || (importMetaUrl.protocol === 'https:' ? 'wss' : 'ws')
const hmrPort = __HMR_PORT__
const socketHost = `${__HMR_HOSTNAME__ || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port
  }${__HMR_BASE__}`
const directSocketHost = __HMR_DIRECT_TARGET__
const base = __BASE__ || '/'
const messageBuffer: string[] = []

let socket: WebSocket
try {
  let fallback: (() => void) | undefined
  // only use fallback when port is inferred to prevent confusion
  if (!hmrPort) {
    fallback = () => {
      // fallback to connecting directly to the hmr server
      // for servers which does not support proxying websocket
      socket = setupWebSocket(socketProtocol, directSocketHost, () => {
        const currentScriptHostURL = new URL(import.meta.url)
        const currentScriptHost =
          currentScriptHostURL.host +
          currentScriptHostURL.pathname.replace(/@vite\/client$/, '')
        console.error(
          '[vite] failed to connect to websocket.\n' +
          'your current setup:\n' +
          `  (browser) ${currentScriptHost} <--[HTTP]--> ${serverHost} (server)\n` +
          `  (browser) ${socketHost} <--[WebSocket (failing)]--> ${directSocketHost} (server)\n` +
          'Check out your Vite / network configuration and https://vitejs.dev/config/server-options.html#server-hmr .',
        )
      })
      socket.addEventListener(
        'open',
        () => {
          console.info(
            '[vite] Direct websocket connection fallback. Check out https://vitejs.dev/config/server-options.html#server-hmr to remove the previous connection error.',
          )
        },
        { once: true },
      )
    }
  }

  socket = setupWebSocket(socketProtocol, socketHost, fallback)
} catch (error) {
  console.error(`[vite] failed to connect to websocket (${error}). `)
}

function setupWebSocket(
  protocol: string,
  hostAndPath: string,
  onCloseWithoutOpen?: () => void,
) {
  // 创建 WebSocket 对象
  const socket = new WebSocket(`${protocol}://${hostAndPath}`, 'vite-hmr')
  let isOpened = false

  socket.addEventListener(
    'open',
    () => {
      isOpened = true
      notifyListeners('vite:ws:connect', { webSocket: socket })
    },
    { once: true },
  )

  // 当客户端接收到服务器发过来的消息后，调用handleMessage函数
  // Listen for messages
  socket.addEventListener('message', async ({ data }) => {
    handleMessage(JSON.parse(data))
  })

  // ping server
  socket.addEventListener('close', async ({ wasClean }) => {
    if (wasClean) return

    if (!isOpened && onCloseWithoutOpen) {
      onCloseWithoutOpen()
      return
    }

    notifyListeners('vite:ws:disconnect', { webSocket: socket })

    console.log(`[vite] server connection lost. polling for restart...`)
    await waitForSuccessfulPing(protocol, hostAndPath)
    location.reload()
  })

  return socket
}

function warnFailedFetch(err: Error, path: string | string[]) {
  if (!err.message.match('fetch')) {
    console.error(err)
  }
  console.error(
    `[hmr] Failed to reload ${path}. ` +
    `This could be due to syntax errors or importing non-existent ` +
    `modules. (see errors above)`,
  )
}

function cleanUrl(pathname: string): string {
  const url = new URL(pathname, location.toString())
  url.searchParams.delete('direct')
  return url.pathname + url.search
}

let isFirstUpdate = true
const outdatedLinkTags = new WeakSet<HTMLLinkElement>()

const debounceReload = (time: number) => {
  let timer: ReturnType<typeof setTimeout> | null
  return () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    timer = setTimeout(() => {
      // 重新加载页面
      location.reload()
    }, time)
  }
}
const pageReload = debounceReload(50)

async function handleMessage(payload: HMRPayload) {
  // 当服务器返回不同消息类型时，会调用不同的钩子函数
  switch (payload.type) {
    case 'connected':
      console.debug(`[vite] connected.`)
      sendMessageBuffer()
      // proxy(nginx, docker) hmr ws maybe caused timeout,
      // so send ping package let ws keep alive.
      setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          socket.send('{"type":"ping"}')
        }
      }, __HMR_TIMEOUT__)
      break
    case 'update':
      // 调用 vite:beforeUpdate 事件的回调
      notifyListeners('vite:beforeUpdate', payload)
      // if this is the first update and there's already an error overlay, it
      // means the page opened with existing server compile error and the whole
      // module script failed to load (since one of the nested imports is 500).
      // in this case a normal update won't work and a full reload is needed.
      // 如果这是第一次更新并且已经存在错误覆盖，这意味着页面打开时存在现有的服务器编译错误，并且整个模块脚本未能加载（因为其中一个嵌套导入是 500）。在这种情况下，普通的更新将不起作用，需要进行完全重新加载。
      if (isFirstUpdate && hasErrorOverlay()) {
        window.location.reload()
        return
      } else {
        clearErrorOverlay()
        isFirstUpdate = false
      }
      await Promise.all(
        payload.updates.map(async (update): Promise<void> => {
          if (update.type === 'js-update') {
            return queueUpdate(fetchUpdate(update))
          }

          // css-update
          // this is only sent when a css file referenced with <link> is updated
          const { path, timestamp } = update
          const searchUrl = cleanUrl(path)
          // can't use querySelector with `[href*=]` here since the link may be
          // using relative paths so we need to use link.href to grab the full
          // URL for the include check.
          const el = Array.from(
            document.querySelectorAll<HTMLLinkElement>('link'),
          ).find(
            (e) =>
              !outdatedLinkTags.has(e) && cleanUrl(e.href).includes(searchUrl),
          )

          if (!el) {
            return
          }

          const newPath = `${base}${searchUrl.slice(1)}${searchUrl.includes('?') ? '&' : '?'
            }t=${timestamp}`

          // rather than swapping the href on the existing tag, we will
          // create a new link tag. Once the new stylesheet has loaded we
          // will remove the existing link tag. This removes a Flash Of
          // Unstyled Content that can occur when swapping out the tag href
          // directly, as the new stylesheet has not yet been loaded.
          return new Promise((resolve) => {
            const newLinkTag = el.cloneNode() as HTMLLinkElement
            newLinkTag.href = new URL(newPath, el.href).href
            const removeOldEl = () => {
              el.remove()
              console.debug(`[vite] css hot updated: ${searchUrl}`)
              resolve()
            }
            newLinkTag.addEventListener('load', removeOldEl)
            newLinkTag.addEventListener('error', removeOldEl)
            outdatedLinkTags.add(el)
            el.after(newLinkTag)
          })
        }),
      )
      notifyListeners('vite:afterUpdate', payload)
      break
    case 'custom': {
      notifyListeners(payload.event, payload.data)
      break
    }
    case 'full-reload':
      // 调用 vite:beforeFullReload 事件的回调
      notifyListeners('vite:beforeFullReload', payload)
      if (payload.path && payload.path.endsWith('.html')) {
        // if html file is edited, only reload the page if the browser is
        // currently on that page.
        const pagePath = decodeURI(location.pathname)
        const payloadPath = base + payload.path.slice(1)
        if (
          pagePath === payloadPath ||
          payload.path === '/index.html' ||
          (pagePath.endsWith('/') && pagePath + 'index.html' === payloadPath)
        ) {
          pageReload()
        }
        return
      } else {
        pageReload()
      }
      break
    case 'prune':
      // 当不再需要的模块即将被剔除时
      notifyListeners('vite:beforePrune', payload)
      // After an HMR update, some modules are no longer imported on the page
      // but they may have left behind side effects that need to be cleaned up
      // (.e.g style injections)
      // TODO Trigger their dispose callbacks.
      payload.paths.forEach((path) => {
        const fn = pruneMap.get(path)
        if (fn) {
          fn(dataMap.get(path))
        }
      })
      break
    case 'error': {
      // 当发生错误时（例如，语法错误）
      notifyListeners('vite:error', payload)
      const err = payload.err
      if (enableOverlay) {
        createErrorOverlay(err)
      } else {
        console.error(
          `[vite] Internal Server Error\n${err.message}\n${err.stack}`,
        )
      }
      break
    }
    default: {
      const check: never = payload
      return check
    }
  }
}

function notifyListeners<T extends string>(
  event: T,
  data: InferCustomEventPayload<T>,
): void
// 从customListenersMap中根据事件名获取所有回调，然后执行这些回调
function notifyListeners(event: string, data: any): void {
  const cbs = customListenersMap.get(event)
  if (cbs) {
    cbs.forEach((cb) => cb(data))
  }
}

const enableOverlay = __HMR_ENABLE_OVERLAY__

function createErrorOverlay(err: ErrorPayload['err']) {
  if (!enableOverlay) return
  clearErrorOverlay()
  document.body.appendChild(new ErrorOverlay(err))
}

function clearErrorOverlay() {
  document
    .querySelectorAll(overlayId)
    .forEach((n) => (n as ErrorOverlay).close())
}

function hasErrorOverlay() {
  return document.querySelectorAll(overlayId).length
}

let pending = false
let queued: Promise<(() => void) | undefined>[] = []

/**
 * buffer multiple hot updates triggered by the same src change
 * so that they are invoked in the same order they were sent.
 * (otherwise the order may be inconsistent because of the http request round trip)
 */
// fetchUpdate 函数返回的函数，函数内调用 import.meta.hot.accept 内定义的回调函数，并将请求文件的导出内容当作参数传入
// queueUpdate函数内会收集fetchUpdate函数返回的函数；并在下一个任务队列中触发所有回调。
async function queueUpdate(p: Promise<(() => void) | undefined>) {
  queued.push(p)
  if (!pending) {
    pending = true
    await Promise.resolve()
    pending = false
    const loading = [...queued]
    queued = []
      ; (await Promise.all(loading)).forEach((fn) => fn && fn())
  }
}

async function waitForSuccessfulPing(
  socketProtocol: string,
  hostAndPath: string,
  ms = 1000,
) {
  const pingHostProtocol = socketProtocol === 'wss' ? 'https' : 'http'

  const ping = async () => {
    // A fetch on a websocket URL will return a successful promise with status 400,
    // but will reject a networking error.
    // When running on middleware mode, it returns status 426, and an cors error happens if mode is not no-cors
    try {
      await fetch(`${pingHostProtocol}://${hostAndPath}`, {
        mode: 'no-cors',
        headers: {
          // Custom headers won't be included in a request with no-cors so (ab)use one of the
          // safelisted headers to identify the ping request
          Accept: 'text/x-vite-ping',
        },
      })
      return true
    } catch { }
    return false
  }

  if (await ping()) {
    return
  }
  await wait(ms)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (document.visibilityState === 'visible') {
      if (await ping()) {
        break
      }
      await wait(ms)
    } else {
      await waitForWindowShow()
    }
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForWindowShow() {
  return new Promise<void>((resolve) => {
    const onChange = async () => {
      if (document.visibilityState === 'visible') {
        resolve()
        document.removeEventListener('visibilitychange', onChange)
      }
    }
    document.addEventListener('visibilitychange', onChange)
  })
}

const sheetsMap = new Map<string, HTMLStyleElement>()

// collect existing style elements that may have been inserted during SSR
// to avoid FOUC or duplicate styles
if ('document' in globalThis) {
  document.querySelectorAll('style[data-vite-dev-id]').forEach((el) => {
    sheetsMap.set(el.getAttribute('data-vite-dev-id')!, el as HTMLStyleElement)
  })
}

// all css imports should be inserted at the same position
// because after build it will be a single css file
let lastInsertedStyle: HTMLStyleElement | undefined

export function updateStyle(id: string, content: string): void {
  let style = sheetsMap.get(id)
  if (!style) {
    style = document.createElement('style')
    style.setAttribute('type', 'text/css')
    style.setAttribute('data-vite-dev-id', id)
    style.textContent = content

    if (!lastInsertedStyle) {
      document.head.appendChild(style)

      // reset lastInsertedStyle after async
      // because dynamically imported css will be splitted into a different file
      setTimeout(() => {
        lastInsertedStyle = undefined
      }, 0)
    } else {
      lastInsertedStyle.insertAdjacentElement('afterend', style)
    }
    lastInsertedStyle = style
  } else {
    style.textContent = content
  }
  sheetsMap.set(id, style)
}

export function removeStyle(id: string): void {
  const style = sheetsMap.get(id)
  if (style) {
    document.head.removeChild(style)
    sheetsMap.delete(id)
  }
}

/**
fetchUpdate函数的作用就是收集需要更新的模块路径和import.meta.hot.accept中的回调函数，调用import.meta.hot.disposer的回调函数清空副作用；拼接更新模块的路径，会挂上import和时间戳；通过import()加载拼接后的路径。最后返回一个函数，这个函数的作用就是import.meta.hot.accept中的回调函数，并打印更新信息。
返回的这个函数被queueUpdate函数接收；queueUpdate函数内会收集fetchUpdate函数返回的函数；并在下一个任务队列中触发所有回调。
 */
async function fetchUpdate({
  path,
  acceptedPath,
  timestamp,
  explicitImportRequired,
}: Update) {
  // path 接收热更新的模块
  // mod：{ id: 文件地址, callbacks: [{ deps: 被监听的文件路径数组, fn: 定义的回调函数 }] }
  const mod = hotModulesMap.get(path)
  if (!mod) {
    // In a code-splitting project,
    // it is common that the hot-updating module is not loaded yet.
    // https://github.com/vitejs/vite/issues/721
    return
  }

  let fetchedModule: ModuleNamespace | undefined
  // 如果是自身更新
  const isSelfUpdate = path === acceptedPath

  // 获取符合条件的回调
  // 过滤条件是如果 mod.callbacks.deps 中的元素在 modulesToUpdate 中存在，则返回 true
  // determine the qualified callbacks before we re-import the modules
  const qualifiedCallbacks = mod.callbacks.filter(({ deps }) =>
    deps.includes(acceptedPath),
  )

  if (isSelfUpdate || qualifiedCallbacks.length > 0) {
    // 获取模块设置的副作用中的回调 import.meta.hot.dispose
    const disposer = disposeMap.get(acceptedPath)
    // import.meta.hot.data 对象在同一个更新模块的不同实例之间持久化。它可以用于将信息从模块的前一个版本传递到下一个版本。
    // 调用 disposer
    if (disposer) await disposer(dataMap.get(acceptedPath))
    const [acceptedPathWithoutQuery, query] = acceptedPath.split(`?`)
    try {
      // 拼接路径，请求新的文件
      fetchedModule = await import(
        /* @vite-ignore */
        base +
        acceptedPathWithoutQuery.slice(1) +
        `?${explicitImportRequired ? 'import&' : ''}t=${timestamp}${query ? `&${query}` : ''
        }`
      )
    } catch (e) {
      warnFailedFetch(e, acceptedPath)
    }
  }

  return () => {
    for (const { deps, fn } of qualifiedCallbacks) {
      // 调用 import.meta.hot.accept 中定义的回调函数，并将文件的导出内容传入回调函数中
      fn(deps.map((dep) => (dep === acceptedPath ? fetchedModule : undefined)))
    }
    const loggedPath = isSelfUpdate ? path : `${acceptedPath} via ${path}`
    console.debug(`[vite] hot updated: ${loggedPath}`)
  }
}

function sendMessageBuffer() {
  if (socket.readyState === 1) {
    messageBuffer.forEach((msg) => socket.send(msg))
    messageBuffer.length = 0
  }
}

interface HotModule {
  id: string
  callbacks: HotCallback[]
}

interface HotCallback {
  // the dependencies must be fetchable paths
  deps: string[]
  fn: (modules: Array<ModuleNamespace | undefined>) => void
}

type CustomListenersMap = Map<string, ((data: any) => void)[]>
/**
 * 存储的是被请求文件的 import.meta.hot.accept
 * key: 当前文件地址
 * value: { id: 文件地址, callbacks: [{ deps: 被监听的文件路径数组, fn: 定义的回调函数 }] }
 */
const hotModulesMap = new Map<string, HotModule>()
/**
 * 存储的是所有被请求文件的 import.meta.hot.dispose
 * key: 当前文件地址
 * value: 定义的回调函数
 */
const disposeMap = new Map<string, (data: any) => void | Promise<void>>()
/**
 * 存储的是所有被请求文件的 import.meta.hot.prune
 * key: 当前文件地址
 * value: 定义的回调函数
 */
const pruneMap = new Map<string, (data: any) => void | Promise<void>>()
/**
 * 存储的是所有被请求文件的 import.meta.hot.data
 * 对象在同一个更新模块的不同实例之间持久化。它可以用于将信息从模块的前一个版本传递到下一个版本。
 * key: 当前文件地址
 * value: 是一个对象，持久化的信息
 */
const dataMap = new Map<string, any>()
/**
 * 存储的是被请求文件监听的 hmr 钩子
 * key: 事件名称
 * value： 事件对应回调函数的数组
 */
const customListenersMap: CustomListenersMap = new Map()
/**
 * 存储的是被请求文件监听的 hmr 钩子
 * key: 当前文件地址
 * value: 是一个 Map，Map 内的 key 是事件名，valye 是一个回调函数数组
 */
const ctxToListenersMap = new Map<string, CustomListenersMap>()

// 对于存在import.meta.hot.accept的模块会执行这个函数，并传入当前文件的绝对路径
// ownerPath 当前文件的路径
// 这个函数最主要的作用就是定义一个hot对象，并返回这个对象。返回的对象会赋值给模块的import.meta.hot
// createHotContext函数的作用：
//    创建持久化数据对象，并添加到dataMap中
//    清空hotModulesMap内当前路径绑定的依赖回调（accept函数的参数）
//    清除过时的自定义事件监听器
//    给当前路径创建自定义事件回调的容器，并放到ctxToListenersMap中
export function createHotContext(ownerPath: string): ViteHotContext {
  // 如果 dataMap 中没有当前路径，则添加到 dataMap 中
  if (!dataMap.has(ownerPath)) {
    dataMap.set(ownerPath, {})
  }

  // when a file is hot updated, a new context is created
  // clear its stale callbacks
  const mod = hotModulesMap.get(ownerPath)
  if (mod) {
    // 清空 cb
    mod.callbacks = []
  }

  // 清除过时的自定义事件监听器
  // 获取当前模块监听的所有事件
  // clear stale custom event listeners
  const staleListeners = ctxToListenersMap.get(ownerPath)
  if (staleListeners) {
    // 遍历当前模块监听的回调
    for (const [event, staleFns] of staleListeners) {
      // 将 staleFns 中所有回调从 customListenersMap 中清除
      const listeners = customListenersMap.get(event)
      if (listeners) {
        customListenersMap.set(
          event,
          listeners.filter((l) => !staleFns.includes(l)),
        )
      }
    }
  }

  const newListeners: CustomListenersMap = new Map()
  ctxToListenersMap.set(ownerPath, newListeners)

  // 参数为接收文件的数组、对应文件更新时的回调
  // acceptDeps方法的作用就是将文件更新时的回调函数添加到hotModulesMap中
  function acceptDeps(deps: string[], callback: HotCallback['fn'] = () => { }) {
    const mod: HotModule = hotModulesMap.get(ownerPath) || {
      id: ownerPath,
      callbacks: [],
    }
    mod.callbacks.push({
      deps,
      fn: callback,
    })
    // 设置 hotModulesMap
    hotModulesMap.set(ownerPath, mod)
  }

  const hot: ViteHotContext = {
    get data() {
      return dataMap.get(ownerPath)
    },

    accept(deps?: any, callback?: any) {
      if (typeof deps === 'function' || !deps) { // 接收自身
        // self-accept: hot.accept(() => {})
        acceptDeps([ownerPath], ([mod]) => deps?.(mod))
      } else if (typeof deps === 'string') { // 接受一个直接依赖项的更新
        // explicit deps
        acceptDeps([deps], ([mod]) => callback?.(mod))
      } else if (Array.isArray(deps)) { // 接受多个直接依赖项的更新
        acceptDeps(deps, callback)
      } else {
        throw new Error(`invalid hot.accept() usage.`)
      }
    },

    // export names (first arg) are irrelevant on the client side, they're
    // extracted in the server for propagation
    acceptExports(_, callback) {
      acceptDeps([ownerPath], ([mod]) => callback?.(mod))
    },

    dispose(cb) {
      disposeMap.set(ownerPath, cb)
    },

    prune(cb) {
      pruneMap.set(ownerPath, cb)
    },

    // Kept for backward compatibility (#11036)
    // @ts-expect-error untyped
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    decline() { },

    // tell the server to re-perform hmr propagation from this module as root
    invalidate(message) {
      notifyListeners('vite:invalidate', { path: ownerPath, message })
      this.send('vite:invalidate', { path: ownerPath, message })
      console.debug(
        `[vite] invalidate ${ownerPath}${message ? `: ${message}` : ''}`,
      )
    },

    // 当执行import.meta.hot.on时，调用了两次addToMap函数，第一次传入customListenersMap，第二次传入newListeners。并将传入的回调放到这两个变量里面。
    // custom events
    on(event, cb) {
      const addToMap = (map: Map<string, any[]>) => {
        const existing = map.get(event) || []
        existing.push(cb)
        map.set(event, existing)
      }
      addToMap(customListenersMap)
      addToMap(newListeners)
    },

    send(event, data) {
      messageBuffer.push(JSON.stringify({ type: 'custom', event, data }))
      sendMessageBuffer()
    },
  }

  return hot
}

/**
 * urls here are dynamic import() urls that couldn't be statically analyzed
 */
export function injectQuery(url: string, queryToInject: string): string {
  // skip urls that won't be handled by vite
  if (url[0] !== '.' && url[0] !== '/') {
    return url
  }

  // can't use pathname from URL since it may be relative like ../
  const pathname = url.replace(/#.*$/, '').replace(/\?.*$/, '')
  const { search, hash } = new URL(url, 'http://vitejs.dev')

  return `${pathname}?${queryToInject}${search ? `&` + search.slice(1) : ''}${hash || ''
    }`
}

export { ErrorOverlay }
