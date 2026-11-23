/* 无界笔记 · 同一标签页的持久化会话（client/notes/persistence-session.js）· 纯 Node 测试
   跑法：`node --test scripts/tests/test_notes_persistence_session.mjs`
   覆盖：无会话时保持「每挂载一份、卸载即 dispose」的原语义；有会话时卸载交还租约而不丢
   控制器草稿（pending/saving/error 基线与 runtime 快照）；重挂复用同一控制器与同一在途载入
   （strict effects / 在途快速重进只发一次 GET）；失败过的载入不复用；同一库两个租约竞争时
   旧租约认领失败（写权限 fail closed）；关页守卫挂在会话上而不是组件实例上。
   真实 React 的前端路径在 scripts/tests/browser/ 那套里覆盖。 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createNotesPersistenceSession,
  acquireNotesPersistenceStore,
  releaseNotesPersistenceStore,
  startPersistenceLoad,
  claimPersistenceLoad,
  commitPersistenceBase,
  disposeNotesPersistenceSession,
  getNotesPersistenceSessionStore,
} from '../../client/notes/persistence-session.js'
import { SaveState, serializeLayout } from '../../client/notes/persistence.js'

const LAYOUT = { folders: [], nodes: [], edges: [], viewport: { x: 1, y: 2, zoom: 0.5 } }
const NOTE = { id: 'r1', type: 'note', title: '一', parent: 'notes', owner: 'me', markdown: 'a' }
const NOTE2 = { id: 'r2', type: 'note', title: '二', parent: 'notes', owner: 'me', markdown: 'b' }

const snapshot = (overrides = {}) => ({
  storeId: 's1',
  resources: { r1: NOTE, r2: NOTE2 },
  resourceVersions: { r1: 'v1', r2: 'v1' },
  layout: LAYOUT,
  layoutVersion: 'l1',
  requiresUpgrade: false,
  missingLayout: false,
  ...overrides,
})

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

// 一个可控制回包时机的假 transport：写请求停在 gate 上，读请求记次数。
function createFakeTransport() {
  const writes = []
  const loads = []
  const transport = {
    loadStore: () => {
      const entry = {}
      const promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject })
      entry.promise = promise
      loads.push(entry)
      return promise
    },
    saveResource: (dto, expectedVersion) => {
      const entry = { dto, expectedVersion }
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject })
      writes.push(entry)
      return entry.promise
    },
    saveLayout: (dto, expectedVersion) => transport.saveResource(dto, expectedVersion),
  }
  return { transport, writes, loads }
}

test('无会话时保持原语义：卸载即 dispose，下次挂载是新控制器', async () => {
  const { transport } = createFakeTransport()
  const first = acquireNotesPersistenceStore({ persistence: transport })
  commitPersistenceBase(first.store, snapshot(), { initial: true })
  first.store.controller.saveResource({ id: 'r1', markdown: 'draft' })
  assert.equal(first.lease.reused, false)
  assert.ok(first.store.controller.getStatuses().r1)

  releaseNotesPersistenceStore(first.lease)
  assert.equal(first.lease.detached, true)
  assert.equal(first.store.disposed, true)
  assert.deepEqual(first.store.controller.getStatuses(), {})

  const second = acquireNotesPersistenceStore({ persistence: transport })
  assert.notEqual(second.store, first.store)
  assert.notEqual(second.store.controller, first.store.controller)
  assert.equal(second.lease.reused, false)
  releaseNotesPersistenceStore(second.lease)
})

test('有会话时卸载只交还租约：控制器、在途保存与草稿都留着', async () => {
  const { transport, writes } = createFakeTransport()
  const session = createNotesPersistenceSession({ label: 'tab-1' })
  const first = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session, debounceMs: 5 })
  assert.ok(getNotesPersistenceSessionStore(session))
  commitPersistenceBase(first.store, snapshot(), { initial: true })

  // 已接受但还没落盘：draft 在 debounce 窗口里，随后进入在途。
  first.store.controller.saveResource({ id: 'r1', markdown: '未落盘' })
  await tick(20)
  assert.equal(writes.length, 1, 'debounce 后发出写请求')
  assert.equal(first.store.controller.getStatus('r1').state, SaveState.SAVING)

  // 宿主 main 关掉：卸载交还租约，不 dispose、不取消在途。
  releaseNotesPersistenceStore(first.lease)
  assert.equal(first.store.disposed, false)
  assert.equal(first.store.lease, null)
  assert.equal(first.store.controller.getStatus('r1').draft.markdown, '未落盘')

  // 快速重进：同一控制器、同一在途请求、草稿仍在。
  const second = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session, debounceMs: 5 })
  assert.equal(second.store, first.store)
  assert.equal(second.store.controller, first.store.controller)
  assert.equal(second.lease.reused, true)
  assert.equal(second.store.controller.getStatus('r1').state, SaveState.SAVING)

  // 在途回包落地：卸载期间发出、重挂之后才回来的保存也要把基线推到 v2。
  writes[0].resolve({ version: 'v2' })
  await tick()
  const status = second.store.controller.getStatus('r1')
  assert.equal(status.state, SaveState.SAVED)
  assert.equal(status.draft, null)
  assert.equal(status.baseVersion, 'v2')
  releaseNotesPersistenceStore(second.lease)
  disposeNotesPersistenceSession(session)
})

test('重挂保留失败草稿与错误基线（error 不会被新挂载洗掉）', async () => {
  const { transport, writes } = createFakeTransport()
  const session = createNotesPersistenceSession()
  const first = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session, debounceMs: 5 })
  commitPersistenceBase(first.store, snapshot(), { initial: true })
  first.store.controller.saveResource({ id: 'r1', markdown: '会失败' })
  await tick(20)
  writes[0].resolve(Promise.reject(Object.assign(new Error('boom'), { code: 'network' })))
  await tick()
  assert.equal(first.store.controller.getStatus('r1').state, SaveState.ERROR)

  releaseNotesPersistenceStore(first.lease)
  const second = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session, debounceMs: 5 })
  const status = second.store.controller.getStatus('r1')
  assert.equal(status.state, SaveState.ERROR)
  assert.equal(status.draft.markdown, '会失败')
  assert.equal(status.baseVersion, 'v1')
  assert.equal(second.store.isDirty(), true)
  releaseNotesPersistenceStore(second.lease)
  disposeNotesPersistenceSession(session)
})

test('会话里的 runtime 快照与「已恢复相机」跨卸载保留', async () => {
  const { transport } = createFakeTransport()
  const session = createNotesPersistenceSession()
  const first = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  first.store.runtime = {
    resources: { r1: { ...NOTE, markdown: '草稿正文' } }, scene: { nodes: [], edges: [] },
    folders: [], flow: { marker: 'old-flow' }, initialFolders: [], active: true,
  }
  first.store.lastViewport = { x: 9, y: 8, zoom: 0.25 }
  first.store.restoredViewport = true
  releaseNotesPersistenceStore(first.lease)

  const second = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  assert.equal(second.store.runtime.resources.r1.markdown, '草稿正文')
  assert.deepEqual(second.store.lastViewport, { x: 9, y: 8, zoom: 0.25 })
  assert.equal(second.store.restoredViewport, true)
  assert.equal(second.store.runtime.flow.marker, 'old-flow', '重挂换新 flow 之前先留着旧快照')
  releaseNotesPersistenceStore(second.lease)
  disposeNotesPersistenceSession(session)
})

test('strict effects / 在途快速重进：同一会话只发一次 GET，回包只应用一次', async () => {
  const { transport, loads } = createFakeTransport()
  const session = createNotesPersistenceSession()
  let runs = 0
  const run = () => { runs += 1; return transport.loadStore() }

  const first = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  const opA = startPersistenceLoad(first.store, { run })
  await tick()
  assert.equal(loads.length, 1)

  // 第一跳被卸载（strict effects 的 cleanup），第二跳取到同一会话与同一在途操作。
  releaseNotesPersistenceStore(first.lease)
  const second = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  const opB = startPersistenceLoad(second.store, { run })
  await tick()
  assert.equal(opB.id, opA.id, '在途操作复用，不发第二次读')
  assert.equal(loads.length, 1)
  assert.equal(runs, 1)

  loads[0].resolve(snapshot())
  await opB.promise
  assert.equal(claimPersistenceLoad(second.store, first.lease, opA.id), false, '已交还的旧租约不能认领')
  assert.equal(claimPersistenceLoad(second.store, second.lease, opA.id), true)
  assert.equal(claimPersistenceLoad(second.store, second.lease, opA.id), false, '同一回包只应用一次')
  commitPersistenceBase(second.store, opB.snapshot, { initial: true })
  assert.equal(second.store.controller.getStatus('r1').baseVersion, 'v1')
  releaseNotesPersistenceStore(second.lease)
  disposeNotesPersistenceSession(session)
})

test('载入成功后卸载、重挂：已 resolve 未应用的回包直接领，不重发 GET', async () => {
  const { transport, loads } = createFakeTransport()
  const session = createNotesPersistenceSession()
  let runs = 0
  const run = () => { runs += 1; return transport.loadStore() }
  const first = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  const op = startPersistenceLoad(first.store, { run })
  await tick()
  loads[0].resolve(snapshot())
  await op.promise
  // 回包落在「没人挂载」的窗口里：这一跳卸载了，没来得及认领。
  releaseNotesPersistenceStore(first.lease)
  assert.equal(op.applied, false)

  const second = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  const again = startPersistenceLoad(second.store, { run })
  assert.equal(again.id, op.id)
  assert.equal(runs, 1, '重挂不重发 GET')
  assert.equal(claimPersistenceLoad(second.store, second.lease, again.id), true)
  assert.equal(again.snapshot.storeId, 's1')
  releaseNotesPersistenceStore(second.lease)
  disposeNotesPersistenceSession(session)
})

test('失败过的载入不复用：重挂会重新试一次 GET', async () => {
  const { transport, loads } = createFakeTransport()
  const session = createNotesPersistenceSession()
  const first = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  const failed = startPersistenceLoad(first.store, { run: () => transport.loadStore() })
  await tick()
  loads[0].reject(new Error('offline'))
  await assert.rejects(failed.promise, /offline/)
  assert.equal(first.store.loadState, 'error')
  releaseNotesPersistenceStore(first.lease)

  const second = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  const retried = startPersistenceLoad(second.store, { run: () => transport.loadStore() })
  assert.notEqual(retried.id, failed.id)
  await tick()
  assert.equal(loads.length, 2)
  loads[1].resolve(snapshot())
  await retried.promise
  assert.equal(claimPersistenceLoad(second.store, second.lease, retried.id), true)
  releaseNotesPersistenceStore(second.lease)
  disposeNotesPersistenceSession(session)
})

test('同一库两个租约竞争：旧租约被撤销、认领失败（写权限 fail closed）', async () => {
  const { transport } = createFakeTransport()
  const session = createNotesPersistenceSession()
  const first = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  const op = startPersistenceLoad(first.store, { run: () => transport.loadStore() })

  const second = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  assert.equal(first.lease.revoked, true, '新挂载接管旧租约')
  assert.equal(second.lease.revoked, false)

  op.promise.catch(() => {})
  // 旧租约即使还持有引用，也不能再认领/应用结果。
  assert.equal(claimPersistenceLoad(first.store, first.lease, op.id), false)
  releaseNotesPersistenceStore(first.lease)
  assert.equal(claimPersistenceLoad(second.store, second.lease, op.id), true)
  releaseNotesPersistenceStore(second.lease)
  disposeNotesPersistenceSession(session)
})

test('commitPersistenceBase 不碰忙链的草稿，干净链前移基线', () => {
  const { transport } = createFakeTransport()
  const session = createNotesPersistenceSession()
  const { store, lease } = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  commitPersistenceBase(store, snapshot(), { initial: true })

  store.controller.saveResource({ id: 'r1', markdown: '还在队列里' })
  const next = snapshot({
    resourceVersions: { r1: 'v9', r2: 'v9' },
    layout: { ...LAYOUT, viewport: { x: 3, y: 4, zoom: 1 } },
    layoutVersion: 'l9',
  })
  const result = commitPersistenceBase(store, next, { initial: true })
  assert.equal(result.layoutChanged, true)
  assert.deepEqual(result.viewport, { x: 3, y: 4, zoom: 1 })
  const r1 = store.controller.getStatus('r1')
  assert.equal(r1.draft.markdown, '还在队列里', '忙链的草稿不能被换基线丢掉')
  assert.equal(r1.baseVersion, 'v1', '忙链的基线不能前移')
  assert.equal(store.controller.getStatus('r2').baseVersion, 'v9', '干净链换到新基线')
  assert.equal(store.controller.getStatus('__layout__').baseVersion, 'l9')
  assert.equal(store.loaded.layoutVersion, 'l9')
  releaseNotesPersistenceStore(lease)
  disposeNotesPersistenceSession(session)
})

test('释放后再次 acquire 拿到新控制器（dispose 之后不复活）', () => {
  const { transport } = createFakeTransport()
  const session = createNotesPersistenceSession({ storeKey: 'library:main' })
  const first = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  const controller = first.store.controller
  releaseNotesPersistenceStore(first.lease)
  disposeNotesPersistenceSession(session)
  assert.equal(first.store.disposed, true)

  const second = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  assert.notEqual(second.store.controller, controller)
  assert.equal(second.lease.reused, false)
  releaseNotesPersistenceStore(second.lease)
  disposeNotesPersistenceSession(session)
})

test('关页守卫挂在会话上：卸载后草稿还在时仍拦关页', () => {
  const listeners = []
  const previousWindow = globalThis.window
  globalThis.window = {
    addEventListener: (type, handler) => { if (type === 'beforeunload') listeners.push(handler) },
    removeEventListener: (type, handler) => {
      if (type !== 'beforeunload') return
      const index = listeners.indexOf(handler)
      if (index >= 0) listeners.splice(index, 1)
    },
  }
  try {
    const { transport } = createFakeTransport()
    const session = createNotesPersistenceSession()
    const first = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
    commitPersistenceBase(first.store, snapshot(), { initial: true })
    assert.equal(listeners.length, 1)
    const event = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true } }
    listeners[0](event)
    assert.equal(event.prevented, false, '干净时放行')

    first.store.controller.saveResource({ id: 'r1', markdown: '草稿' })
    releaseNotesPersistenceStore(first.lease)
    assert.equal(listeners.length, 1, '组件卸载不摘守卫')
    const dirtyEvent = { prevented: false, preventDefault() { this.prevented = true } }
    listeners[0](dirtyEvent)
    assert.equal(dirtyEvent.prevented, true, '会话里还有草稿，关页要拦')

    disposeNotesPersistenceSession(session)
    assert.equal(listeners.length, 0, '真正释放时才摘守卫')
  } finally {
    globalThis.window = previousWindow
  }
})

test('确认丢弃的载入跨卸载不复用错代：pending/resolved 都复用且保留丢弃意图', async () => {
  const { transport, loads } = createFakeTransport()
  const session = createNotesPersistenceSession({ label: 'discard' })
  const first = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  const op = startPersistenceLoad(first.store, { run: () => transport.loadStore(), fresh: true, discardDrafts: true })
  await tick()
  assert.equal(loads.length, 1, '显式 reload 发一次 GET')

  // GET 还在途，宿主 main 被关掉；回包落在没人挂载的窗口里。
  releaseNotesPersistenceStore(first.lease)
  loads[0].resolve(snapshot())
  await tick()
  assert.equal(op.status, 'resolved')

  const second = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  const again = startPersistenceLoad(second.store, { run: () => transport.loadStore() })
  assert.equal(again, op, '重挂必须复用同一次载入，而不是重发 GET')
  assert.equal(again.discardDrafts, true, '用户确认过的丢弃意图要跟着这次载入走')
  assert.equal(loads.length, 1, '不重发 GET')
  assert.equal(claimPersistenceLoad(second.store, second.lease, again.id), true, '新租约认领这次回包')
  assert.equal(claimPersistenceLoad(second.store, second.lease, again.id), false, '同一回包只应用一次')
})

test('失败的丢弃载入不复用：重挂重新试 GET，且失败不会顺手清掉草稿', async () => {
  const { transport, loads } = createFakeTransport()
  const session = createNotesPersistenceSession({ label: 'discard-fail' })
  const first = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  commitPersistenceBase(first.store, snapshot(), { initial: true })
  // 用户确认丢弃时，草稿还在控制器里（本地保存链上）。丢弃只在成功拿到新基线之后生效。
  first.store.controller.saveResource({ id: 'r1', markdown: '要丢弃的失败稿' })
  assert.equal(first.store.isDirty(), true)

  const op = startPersistenceLoad(first.store, { run: () => transport.loadStore(), fresh: true, discardDrafts: true })
  await tick()
  loads[0].reject(Object.assign(new Error('断网'), { code: 'network' }))
  await tick()
  assert.equal(op.status, 'rejected')
  assert.equal(first.store.isDirty(), true, '读失败不能把草稿清掉')

  releaseNotesPersistenceStore(first.lease)
  const second = acquireNotesPersistenceStore({ persistence: transport, persistenceSession: session })
  const again = startPersistenceLoad(second.store, { run: () => transport.loadStore() })
  assert.notEqual(again, op, '失败过的载入不复用')
  assert.equal(again.discardDrafts, false, '失败后重试默认保留草稿，不继承丢弃意图')
  await tick()
  assert.equal(loads.length, 2, '重挂要重新试一次 GET')
})
