// 无界笔记 · 同一浏览器标签页的持久化会话（纯逻辑：无 React、无 DOM、无 fetch、无浏览器 storage）
//
// 为什么需要它：宿主 main 关闭/重挂会卸载 App，useNotesPersistence 的 cleanup 若直接
// dispose 控制器，已接受但未落盘的编辑（pending/inflight/error/conflict，含 layout）会
// 随控制器一起消失；快速重进又会新建第二个控制器，在途回包与草稿分属两代。
//
// 边界：会话只持有「本标签页、这个笔记数据域」唯一的一个保存控制器、最近一次载入基线
// （loaded）、最近一次已接受的 runtime 快照、以及进行中的载入操作。挂载 = 取租约；
// 卸载 = 交还租约（不 dispose、不清链、不取消定时器）；只有显式 dispose 才释放。
// 它不碰传输协议：transport 由调用方（bridge 的持久化适配器）注入，换成新适配器也由
// 同一个控制器通过 dispatcher 接住。
//
// 不在这里做的事：媒体重入、GET 组装、React 状态。那些留在 hook 里，会话只记结果。

import {
  createSaveController, serializeResource, serializeLayout,
  fingerprintOf as defaultFingerprintOf,
} from './persistence.js'
import { createResourceSerializer } from './resource-serialization-cache.js'

const DEFAULT_CAMERA = Object.freeze({ x: 0, y: 0, zoom: 1 })

// 句柄 → 会话状态。WeakMap 保证句柄被丢弃时状态不会成为永久根。
const sessionStores = new WeakMap()
// 可选的 storeKey → 会话状态：同一标签页里即使句柄对象换了（HMR、上层重建），
// 同一个库也仍只有一个控制器。
const keyedStores = new Map()

function isSessionObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function createStore({ persistence, session = null, debounceMs, fingerprintOf }) {
  const store = {
    session,
    controller: null,
    // controller 通过 dispatcher 写；重挂换了适配器时只换 transport，不重建控制器。
    transport: persistence,
    serializer: createResourceSerializer({ serialize: serializeResource, fingerprint: fingerprintOf }),
    loaded: null,
    loadState: 'idle',
    loadError: null,
    validationErrors: {},
    editRevision: 0,
    renderPending: false,
    lastViewport: DEFAULT_CAMERA,
    restoredViewport: false,
    loadOp: null,
    loadSeq: 0,
    loadGeneration: 0,
    lease: null,
    leaseEpoch: 0,
    disposed: false,
    unloadGuard: null,
    runtime: { resources: null, scene: null, folders: null, flow: null, initialFolders: [], active: true },
  }

  store.controller = createSaveController({
    transport: {
      saveResource: (dto, expectedVersion) => store.transport.saveResource(dto, expectedVersion),
      saveLayout: (dto, expectedVersion) => store.transport.saveLayout(dto, expectedVersion),
    },
    ...(Number.isFinite(debounceMs) ? { debounceMs } : {}),
    fingerprintOf,
  })

  // 已接受编辑：推进修订号（外部核对据此放弃迟到快照），并标一次「渲染待捕获」。
  store.markEdit = ({ render = true } = {}) => {
    store.editRevision += 1
    if (render) store.renderPending = true
  }
  store.settleRender = () => { store.renderPending = false }
  store.setValidationErrors = next => { store.validationErrors = next && typeof next === 'object' ? next : {} }
  store.setStatuses = () => {}
  // 脏 = 控制器链上有草稿/在途/失败/冲突，或序列化失败的草稿，或已接受但还没被捕获的渲染。
  store.isDirty = () => Boolean(store.controller?.isDirty())
    || Object.keys(store.validationErrors).length > 0
    || store.renderPending
  // 状态表 = 控制器各 key 的状态 + 本地序列化错误（后者也带草稿）。
  store.statuses = () => ({ ...(store.controller?.getStatuses() || {}), ...store.validationErrors })
  return store
}

// 关页守卫挂在会话上而不是某个组件实例上：面板关掉之后草稿还活着时，关标签页仍要拦。
function ensureUnloadGuard(store) {
  if (store.unloadGuard) return
  const win = typeof window !== 'undefined' ? window : null
  if (!win || typeof win.addEventListener !== 'function') return
  const handler = event => {
    if (!store.isDirty()) return
    event.preventDefault()
    event.returnValue = ''
  }
  win.addEventListener('beforeunload', handler)
  store.unloadGuard = handler
}

function removeUnloadGuard(store) {
  if (!store.unloadGuard) return
  const win = typeof window !== 'undefined' ? window : null
  if (win && typeof win.removeEventListener === 'function') win.removeEventListener('beforeunload', store.unloadGuard)
  store.unloadGuard = null
}

function disposeStore(store) {
  if (!store || store.disposed) return
  store.disposed = true
  removeUnloadGuard(store)
  store.loadOp = null
  try { store.controller?.dispose() } catch { /* 控制器自清理失败不该拦住卸载 */ }
  store.serializer.invalidate()
  store.lease = null
  store.runtime = { resources: null, scene: null, folders: null, flow: null, initialFolders: [], active: true }
  store.validationErrors = {}
  store.loaded = null
  store.renderPending = false
}

function attachLease(store) {
  // 同一库同时只有一个有效租约：新挂载接管，旧实例失去载入/应用权（它的编辑仍会并入同一控制器）。
  if (store.lease && !store.lease.detached) store.lease.revoked = true
  store.leaseEpoch += 1
  const lease = {
    store, session: store.session, id: store.leaseEpoch,
    revoked: false, detached: false, reused: false,
    // 重挂实例要等会话快照搬回 React 树之后才允许再镜像 props，否则会拿 App 的初始
    // fixtures 盖掉会话里的 runtime。首次挂载没有可恢复的东西，直接算完成。
    restored: false,
  }
  store.lease = lease
  ensureUnloadGuard(store)
  return lease
}

/**
 * 建一个「每浏览器标签页一个」的会话句柄。**在模块级建一次**并稳定地传给 hook；
 * 每次 render 新建句柄等于每次挂载都换会话，保护就失效了。
 *
 * options.label     诊断用标签
 * options.storeKey  可选：同标签页里同 key 的不同句柄也复用同一个控制器
 */
export function createNotesPersistenceSession(options = {}) {
  return Object.freeze({
    label: typeof options.label === 'string' ? options.label : '',
    storeKey: typeof options.storeKey === 'string' ? options.storeKey : '',
  })
}

/** 任何非数组对象都算会话句柄（允许调用方传自己的稳定对象）。 */
export function isNotesPersistenceSession(value) {
  return isSessionObject(value)
}

/** 诊断/测试用：拿到会话内部状态（没有就是 null）。 */
export function getNotesPersistenceSessionStore(session) {
  if (!isSessionObject(session)) return null
  return sessionStores.get(session) || null
}

/**
 * 硬释放：只在标签页/插件真的结束、确定不再回来时调用。会丢弃内存里的草稿。
 * 空闲后再挂载会建一份新的会话状态，不会拿到已经 dispose 的控制器。
 */
export function disposeNotesPersistenceSession(session) {
  if (!isSessionObject(session)) return
  const store = sessionStores.get(session) || (session.storeKey ? keyedStores.get(session.storeKey) : null)
  if (store) disposeStore(store)
  sessionStores.delete(session)
  if (session.storeKey && keyedStores.get(session.storeKey) === store) keyedStores.delete(session.storeKey)
}

/**
 * hook 挂载时调用：取会话里那一份（或新建）状态，并取一个租约。
 * 返回 null 表示没有原生适配器（调用方退回预览/内存路径）。
 */
export function acquireNotesPersistenceStore({ persistence, persistenceSession, debounceMs, fingerprintOf } = {}) {
  if (!persistence) return null
  const fp = typeof fingerprintOf === 'function' ? fingerprintOf : defaultFingerprintOf
  const session = isSessionObject(persistenceSession) ? persistenceSession : null
  if (!session) {
    // 没有会话 = 原来的「每挂载一份」语义：卸载即 dispose。
    const store = createStore({ persistence, debounceMs, fingerprintOf: fp, session: null })
    return { store, lease: attachLease(store) }
  }
  const key = session.storeKey || ''
  let store = sessionStores.get(session) || (key ? keyedStores.get(key) : null) || null
  const reused = Boolean(store) && !store.disposed
  if (!reused) {
    store = createStore({ persistence, debounceMs, fingerprintOf: fp, session })
    if (key) keyedStores.set(key, store)
  }
  sessionStores.set(session, store)
  // 重挂可能带着新的适配器对象（bridge 每次挂载 useMemo 一份）：只换写入口，不换控制器。
  store.transport = persistence
  const lease = attachLease(store)
  lease.reused = reused
  return { store, lease }
}

/** hook 卸载时调用：交还租约。会话状态（控制器/基线/runtime/载入操作）原样保留。 */
export function releaseNotesPersistenceStore(lease) {
  if (!lease || lease.detached) return
  lease.detached = true
  const store = lease.store
  if (!store || store.disposed) return
  if (store.lease === lease) store.lease = null
  // 没有会话的临时路径仍然按原语义回收。
  if (!store.session) disposeStore(store)
}

/**
 * 开始（或复用）一次载入。`run()` 负责 GET + prepare（由 hook 注入）。
 * - 同一会话里 pending 的操作直接复用，strict effects/快速重进不会发第二次 GET；
 * - 已 resolve 但还没被应用的操作也复用（回包落在无人挂载的窗口里时，下次挂载直接领）；
 * - fresh:true 用于用户显式 reload/升级：作废旧的，开始新一代。
 */
export function startPersistenceLoad(store, { run, fresh = false, discardDrafts = false } = {}) {
  if (!store || store.disposed) throw new Error('持久化会话已释放，不能载入。')
  if (typeof run !== 'function') throw new Error('startPersistenceLoad 需要 run()。')
  const existing = store.loadOp
  if (!fresh && existing) {
    if (existing.status === 'pending') return existing
    if (existing.status === 'resolved' && !existing.applied) return existing
    // 失败过的不复用：重挂（或 strict effects 的第二跳）应当重新试一次 GET，
    // 否则面板一关就再也等不到自动恢复。显式 reload 走 fresh 分支。
  }
  store.loadSeq += 1
  const op = { id: store.loadSeq, status: 'pending', promise: null, snapshot: null, error: null, applied: false, discardDrafts }
  store.loadOp = op
  store.loadState = 'loading'
  store.loadError = null
  op.promise = Promise.resolve()
    .then(run)
    .then(snapshot => {
      if (store.loadOp === op) {
        op.status = 'resolved'
        op.snapshot = snapshot
      }
      return snapshot
    }, error => {
      if (store.loadOp === op) {
        op.status = 'rejected'
        op.error = error
        store.loadState = 'error'
        store.loadError = error
      }
      throw error
    })
  // 回包可能落在「没人 await」的窗口里（载入中卸载）：不留下未处理的拒绝。
  op.promise.catch(() => {})
  return op
}

/**
 * 认领一次载入的结果：同一操作只允许一个仍有效的租约应用，且只应用一次。
 * 被接管/已卸载/已被别的挂载应用过 → false。
 */
export function claimPersistenceLoad(store, lease, loadId) {
  if (!store || !store.loadOp || store.loadOp.id !== loadId) return false
  if (store.loadOp.applied) return false
  if (!lease || lease.detached || lease.revoked || lease.store !== store || store.lease !== lease) return false
  store.loadOp.applied = true
  store.loadGeneration += 1
  return true
}

/**
 * 把一次载入结果落成新基线：整表换序列化缓存、逐 key loadBase、记 loaded。
 * 返回 layoutChanged / viewport，React 状态与相机由 hook 负责。
 */
export function commitPersistenceBase(store, snapshot, { initial = false } = {}) {
  const controller = store.controller
  const previous = store.loaded
  // 基线指纹必须与本次实际资源字节一致：整表作废缓存，旧引用即使还在 React state 里也不命中陈旧 DTO。
  store.serializer.invalidate()
  for (const [id, resource] of Object.entries(snapshot.resources)) {
    const entry = store.serializer.entryOf(resource)
    controller.loadBase(id, snapshot.resourceVersions[id], entry.dto)
  }
  controller.loadBase('__layout__', snapshot.layoutVersion, serializeLayout(snapshot.layout))
  store.loaded = {
    storeId: snapshot.storeId,
    resources: snapshot.resources,
    versions: snapshot.resourceVersions,
    layout: snapshot.layout,
    layoutVersion: snapshot.layoutVersion,
  }
  const layoutChanged = initial || previous?.layoutVersion !== snapshot.layoutVersion
  const viewport = snapshot.layout?.viewport || DEFAULT_CAMERA
  store.runtime = {
    ...store.runtime,
    resources: snapshot.resources,
    ...(layoutChanged
      ? { folders: snapshot.layout.folders, scene: { nodes: snapshot.layout.nodes, edges: snapshot.layout.edges } }
      : {}),
  }
  if (layoutChanged) store.lastViewport = viewport
  return { layoutChanged, viewport }
}
