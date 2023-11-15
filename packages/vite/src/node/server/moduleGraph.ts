// Vite 为每个模块创建一个ModuleNode对象，对象内包含模块间的引用关系以及模块信息。模块信息包含绝对路径、转换后的代码、接收的热更新模块等。
import { extname } from 'node:path'
import type { ModuleInfo, PartialResolvedId } from 'rollup'
import { isDirectCSSRequest } from '../plugins/css'
import {
  cleanUrl,
  normalizePath,
  removeImportQuery,
  removeTimestampQuery,
} from '../utils'
import { FS_PREFIX } from '../constants'
import type { TransformResult } from './transformRequest'

export class ModuleNode {
  /**
   * Public served url path, starts with /
   */
  url: string
  /**
   * Resolved file system path + query
   */
  id: string | null = null
  file: string | null = null
  type: 'js' | 'css'
  info?: ModuleInfo
  meta?: Record<string, any>
  importers = new Set<ModuleNode>()
  clientImportedModules = new Set<ModuleNode>()
  ssrImportedModules = new Set<ModuleNode>()
  acceptedHmrDeps = new Set<ModuleNode>()
  acceptedHmrExports: Set<string> | null = null
  importedBindings: Map<string, Set<string>> | null = null
  isSelfAccepting?: boolean
  transformResult: TransformResult | null = null
  ssrTransformResult: TransformResult | null = null
  ssrModule: Record<string, any> | null = null
  ssrError: Error | null = null
  lastHMRTimestamp = 0
  lastInvalidationTimestamp = 0

  /**
   * @param setIsSelfAccepting - set `false` to set `isSelfAccepting` later. e.g. #7870
   */
  constructor(url: string, setIsSelfAccepting = true) {
    this.url = url
    this.type = isDirectCSSRequest(url) ? 'css' : 'js'
    if (setIsSelfAccepting) {
      this.isSelfAccepting = false
    }
  }

  get importedModules(): Set<ModuleNode> {
    const importedModules = new Set(this.clientImportedModules)
    for (const module of this.ssrImportedModules) {
      importedModules.add(module)
    }
    return importedModules
  }
}

export type ResolvedUrl = [
  url: string,
  resolvedId: string,
  meta: object | null | undefined,
]

// 把模块之间的依赖关系通过个对象进行维护,这个ModuleGraph就是模块间依赖的管理的工具
export class ModuleGraph {
  // 初始化过程就是将传入的插件容器container挂载到this上，并初始化 4 个属性urlToModuleMap、idToModuleMap、fileToModulesMap、safeModulesPath
  urlToModuleMap = new Map<string, ModuleNode>() // 客户端的url与模块之间的关系
  idToModuleMap = new Map<string, ModuleNode>() // resolvedId接收到的id与模块之间的关系
  // 单个文件可能对应于多个具有不同查询的模块。
  fileToModulesMap = new Map<string, Set<ModuleNode>>() // 文件名与模块之间的关系
  safeModulesPath = new Set<string>()

  /**
   * @internal
   */
  _unresolvedUrlToModuleMap = new Map<
    string,
    Promise<ModuleNode> | ModuleNode
  >()
  /**
   * @internal
   */
  _ssrUnresolvedUrlToModuleMap = new Map<
    string,
    Promise<ModuleNode> | ModuleNode
  >()

  constructor(
    private resolveId: (
      url: string,
      ssr: boolean,
    ) => Promise<PartialResolvedId | null>,
  ) { }

  // 根据 url 获取模块对应的 ModuleGraph 对象
  async getModuleByUrl(
    rawUrl: string,
    ssr?: boolean,
  ): Promise<ModuleNode | undefined> {
    // Quick path, if we already have a module for this rawUrl (even without extension)
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl))
    const mod = this._getUnresolvedUrlToModule(rawUrl, ssr)
    if (mod) {
      return mod
    }

    const [url] = await this._resolveUrl(rawUrl, ssr)
    return this.urlToModuleMap.get(url)
  }

  // 根据 可能有参数的绝对路径 获取模块对应的 ModuleGraph 对象
  getModuleById(id: string): ModuleNode | undefined {
    return this.idToModuleMap.get(removeTimestampQuery(id))
  }

  // 根据 没有参数的绝对路径 获取模块对应的 ModuleGraph 对象集合 Set
  getModulesByFile(file: string): Set<ModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }

  // 根据传入的file获取并清空对应ModuleNode对象的transformResult属性值
  onFileChange(file: string): void {
    const mods = this.getModulesByFile(file)
    if (mods) {
      const seen = new Set<ModuleNode>()
      mods.forEach((mod) => {
        this.invalidateModule(mod, seen)
      })
    }
  }

  // 清空 ModuleGraph 对象的 transformResult
  invalidateModule(
    mod: ModuleNode,
    seen: Set<ModuleNode> = new Set(),
    timestamp: number = Date.now(),
    isHmr: boolean = false,
    hmrBoundaries: ModuleNode[] = [],
  ): void {
    // 防止死循环
    if (seen.has(mod)) {
      return
    }
    seen.add(mod)
    if (isHmr) {
      // 设置修改时间
      mod.lastHMRTimestamp = timestamp
    } else {
      // Save the timestamp for this invalidation, so we can avoid caching the result of possible already started
      // processing being done for this module
      mod.lastInvalidationTimestamp = timestamp
    }
    // Don't invalidate mod.info and mod.meta, as they are part of the processing pipeline
    // Invalidating the transform result is enough to ensure this module is re-processed next time it is requested
    mod.transformResult = null
    mod.ssrTransformResult = null
    mod.ssrModule = null
    mod.ssrError = null

    // Fix #3033
    if (hmrBoundaries.includes(mod)) {
      return
    }
    mod.importers.forEach((importer) => {
      // 如果上层文件的 acceptedHmrDeps 上不包含当前文件，说明上层文件没有定义接受当前文件更新的回调
      // 则再次对上层文件调用 invalidate 方法
      if (!importer.acceptedHmrDeps.has(mod)) {
        this.invalidateModule(importer, seen, timestamp, isHmr)
      }
    })
  }

  // 清空所有 ModuleGraph 对象的 transformResult
  invalidateAll(): void {
    const timestamp = Date.now()
    const seen = new Set<ModuleNode>()
    this.idToModuleMap.forEach((mod) => {
      this.invalidateModule(mod, seen, timestamp)
    })
  }

  /**
   * Update the module graph based on a module's updated imports information
   * If there are dependencies that no longer have any importers, they are
   * returned as a Set.
   */
  // TODO: 最重要的一个方法，用于构建和更新模块之间的引用关系
  async updateModuleInfo(
    mod: ModuleNode, // 当前模块对应的 ModuleNode 对象
    importedModules: Set<string | ModuleNode>, // 当前模块导入的模块
    importedBindings: Map<string, Set<string>> | null,
    acceptedModules: Set<string | ModuleNode>, // 哪些模块被HMR接收
    acceptedExports: Set<string> | null,
    isSelfAccepting: boolean, // 如果是自身更新则为 true
    ssr?: boolean,
  ): Promise<Set<ModuleNode> | undefined> {
    // 如果为 true，表示接收模块自身的热更新
    mod.isSelfAccepting = isSelfAccepting
    // 获取该模块之前导入集合
    const prevImports = ssr ? mod.ssrImportedModules : mod.clientImportedModules
    // 这个模块不再引入哪些模块
    let noLongerImported: Set<ModuleNode> | undefined

    let resolvePromises = []
    let resolveResults = new Array(importedModules.size)
    let index = 0
    // update import graph
    // 遍历 importedModules
    for (const imported of importedModules) {
      // 如果 imported 是字符串则为依赖模块创建/查找 ModuleNode 实例
      const nextIndex = index++
      if (typeof imported === 'string') {
        resolvePromises.push(
          this.ensureEntryFromUrl(imported, ssr).then((dep) => {
            dep.importers.add(mod)
            resolveResults[nextIndex] = dep
          }),
        )
      } else {
        // 将当前模块的 ModuleNode 实例添加到依赖模块对应的 ModuleNode 实例的 importers 上
        imported.importers.add(mod)
        // 将这个依赖模块对应的 ModuleNode 实例添加到 nextImports 中
        resolveResults[nextIndex] = imported
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises)
    }

    // 创建新的 Set
    const nextImports = new Set(resolveResults)
    if (ssr) {
      mod.ssrImportedModules = nextImports
    } else {
      mod.clientImportedModules = nextImports
    }

    // remove the importer from deps that were imported but no longer are.
    prevImports.forEach((dep) => {
      // 如果 nextImports 中没有这个 dep
      // 说明这个 dep 对应的模块没在当前模块中导入
      // 所以将 mod 从 dep 的 dep.importers 中删除
      if (
        !mod.clientImportedModules.has(dep) &&
        !mod.ssrImportedModules.has(dep)
      ) {
        dep.importers.delete(mod)
        if (!dep.importers.size) {
          // dependency no longer imported
          // 如果没有模块导入 dep 对应的模块，则收集到 noLongerImported 中
          ; (noLongerImported || (noLongerImported = new Set())).add(dep)
        }
      }
    })

    // update accepted hmr deps
    // 将 import.meta.hot.accept() 中设置的模块添加到 mod.acceptedModules 里面，不包含自身
    resolvePromises = []
    resolveResults = new Array(acceptedModules.size)
    index = 0
    for (const accepted of acceptedModules) {
      const nextIndex = index++
      if (typeof accepted === 'string') {
        resolvePromises.push(
          this.ensureEntryFromUrl(accepted, ssr).then((dep) => {
            resolveResults[nextIndex] = dep
          }),
        )
      } else {
        resolveResults[nextIndex] = accepted
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises)
    }

    mod.acceptedHmrDeps = new Set(resolveResults)

    // update accepted hmr exports
    mod.acceptedHmrExports = acceptedExports
    mod.importedBindings = importedBindings
    // 将当前模块导入过，现在没有任何模块导入的文件集合返回
    return noLongerImported
  }

  async ensureEntryFromUrl(
    rawUrl: string,
    ssr?: boolean,
    setIsSelfAccepting = true,
  ): Promise<ModuleNode> {
    return this._ensureEntryFromUrl(rawUrl, ssr, setIsSelfAccepting)
  }

  /**
根据模块路径创建ModuleNode对象，将对象收集到ModuleGraph的属性中；最后返回这个对象

添加到urlToModuleMap中，键是文件url；值是模块对应的ModuleNode对象
添加到idToModuleMap中，键是文件绝对路径；值是模块对应的ModuleNode对象
添加到fileToModulesMap中，键是去掉query和hash的文件绝对路径；值是Set实例，里面添加的是模块对应的ModuleNode对象

对象内就是关于这个模块的一些信息和模块之间的关系
   */
  async _ensureEntryFromUrl(
    rawUrl: string,
    ssr?: boolean,
    setIsSelfAccepting = true,
    // Optimization, avoid resolving the same url twice if the caller already did it
    resolved?: PartialResolvedId,
  ): Promise<ModuleNode> {
    // Quick path, if we already have a module for this rawUrl (even without extension)
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl))
    let mod = this._getUnresolvedUrlToModule(rawUrl, ssr)
    if (mod) {
      return mod
    }
    const modPromise = (async () => {
      // 获取文件 url 和 绝对路径
      const [url, resolvedId, meta] = await this._resolveUrl(
        rawUrl,
        ssr,
        resolved,
      )
      // 根据 url 获取该url对应的 ModuleNode 实例
      mod = this.idToModuleMap.get(resolvedId)
      if (!mod) {
        // 初始化 ModuleNode 实例
        mod = new ModuleNode(url, setIsSelfAccepting)
        if (meta) mod.meta = meta
        // 将 mod 添加到 urlToModuleMap 中
        this.urlToModuleMap.set(url, mod)
        // 设置 id 将 mod 添加到 idToModuleMap 中
        mod.id = resolvedId
        this.idToModuleMap.set(resolvedId, mod)
        // 一个文件可能对应多个模块，所以还要在Map里面维护一个Set列表
        // 比如一个 vue 组件，对应 script template style 三部分
        const file = (mod.file = cleanUrl(resolvedId))
        let fileMappedModules = this.fileToModulesMap.get(file)
        if (!fileMappedModules) {
          fileMappedModules = new Set()
          // 设置 fileToModulesMap
          this.fileToModulesMap.set(file, fileMappedModules)
        }
        fileMappedModules.add(mod)
      }
      // multiple urls can map to the same module and id, make sure we register
      // the url to the existing module in that case
      else if (!this.urlToModuleMap.has(url)) {
        this.urlToModuleMap.set(url, mod)
      }
      this._setUnresolvedUrlToModule(rawUrl, mod, ssr)
      return mod
    })()

    // Also register the clean url to the module, so that we can short-circuit
    // resolving the same url twice
    this._setUnresolvedUrlToModule(rawUrl, modPromise, ssr)
    return modPromise
  }

  // some deps, like a css file referenced via @import, don't have its own
  // url because they are inlined into the main css import. But they still
  // need to be represented in the module graph so that they can trigger
  // hmr in the importing css file.
  createFileOnlyEntry(file: string): ModuleNode {
    file = normalizePath(file)
    let fileMappedModules = this.fileToModulesMap.get(file)
    if (!fileMappedModules) {
      fileMappedModules = new Set()
      this.fileToModulesMap.set(file, fileMappedModules)
    }

    const url = `${FS_PREFIX}${file}`
    for (const m of fileMappedModules) {
      if (m.url === url || m.id === file) {
        return m
      }
    }

    const mod = new ModuleNode(url)
    mod.file = file
    fileMappedModules.add(mod)
    return mod
  }

  // for incoming urls, it is important to:
  // 1. remove the HMR timestamp query (?t=xxxx) and the ?import query
  // 2. resolve its extension so that urls with or without extension all map to
  // the same module
  // 这个方法的作用是调用所有插件的resolveId钩子函数，根据当前被请求模块的url，获取该文件的绝对路径，最后返回[url, 文件绝对路径]
  async resolveUrl(url: string, ssr?: boolean): Promise<ResolvedUrl> {
    // 去掉 ?import 和 t=xxx
    url = removeImportQuery(removeTimestampQuery(url))
    const mod = await this._getUnresolvedUrlToModule(url, ssr)
    if (mod?.id) {
      return [mod.url, mod.id, mod.meta]
    }
    return this._resolveUrl(url, ssr)
  }

  /**
   * @internal
   */
  _getUnresolvedUrlToModule(
    url: string,
    ssr?: boolean,
  ): Promise<ModuleNode> | ModuleNode | undefined {
    return (
      ssr ? this._ssrUnresolvedUrlToModuleMap : this._unresolvedUrlToModuleMap
    ).get(url)
  }
  /**
   * @internal
   */
  _setUnresolvedUrlToModule(
    url: string,
    mod: Promise<ModuleNode> | ModuleNode,
    ssr?: boolean,
  ): void {
    ; (ssr
      ? this._ssrUnresolvedUrlToModuleMap
      : this._unresolvedUrlToModuleMap
    ).set(url, mod)
  }

  /**
   * @internal
   */
  async _resolveUrl(
    url: string,
    ssr?: boolean,
    alreadyResolved?: PartialResolvedId,
  ): Promise<ResolvedUrl> {
    const resolved = alreadyResolved ?? (await this.resolveId(url, !!ssr))
    const resolvedId = resolved?.id || url
    if (
      url !== resolvedId &&
      !url.includes('\0') &&
      !url.startsWith(`virtual:`)
    ) {
      const ext = extname(cleanUrl(resolvedId))
      if (ext) {
        const pathname = cleanUrl(url)
        if (!pathname.endsWith(ext)) {
          url = pathname + ext + url.slice(pathname.length)
        }
      }
    }
    return [url, resolvedId, resolved?.meta]
  }
}

