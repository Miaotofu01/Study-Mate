// 无界笔记的懒加载控制器（#302 方案A，ADR-0019）。
// 入口包只装这里：三个懒包装组件 + 真实侧栏图标 + 纯 workspace store + 常量。
// 笔记组件/编辑器/限域样式/字体全部住在 client.notes.js 分块里，第一次真的
// 需要笔记 UI（打开笔记面 / 学习节点笔记 / 课程笔记面板）时才由宿主
// require.async('./client.notes.js') 拉一次并物化。
//
// 生命周期约束（proposal-302 验收①②③）：
// - 入口 apply 阶段绝不触发加载——attach 只登记宿主上下文，分块请求只由
//   包装组件挂载（用户动作）触发；
// - 加载中给 role=status 占位，失败给 role=alert + 明确重试按钮，绝不静默回退；
// - phase='ready' 必须等「分块物化且 notes.apply(ctx) 已在入口清理链上」同时成立
//   （settle 先于 emit，避免真组件先渲染、宿主服务还没就绪的竞态）；
// - 分块物化后按 fileName 缓存，往返保活不重拉。
import React from 'react'
import { PanelIcon } from './panel-icon.jsx'
import { createNotesWorkspace } from '../curriculum.js'
import { createLocaleScope } from './locale.js'

// 与 client/notes/host/bridge.jsx 的 CHAT_SLOT 必须逐字一致；分块物化时做运行时
// 相等校验（漂移即失败），scripts/tests/test_client_bundle.mjs 再静态钉住两处字面量。
const CHUNK_CHAT_SLOT = 'studymate.notes.session'
export const NOTES_CHUNK_FILE = 'client.notes.js'
// 与 client/notes/host/bridge.jsx createClientModule 的 inputTriggers 名单一致：
// 这些服务由宿主注入，分块与入口共用同一组。
const NOTES_SERVICES = ['slots', 'sessions', 'inputTriggers', 'conversation']

const PHASE_IDLE = 'idle'
const PHASE_LOADING = 'loading'
const PHASE_READY = 'ready'
const PHASE_FAILED = 'failed'

// 占位与错误态都用内联样式：入口侧没有笔记限域 CSS，也绝不为此加载分块。
const GATE_STYLE = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap', padding: '36px 16px', color: '#5b6472', font: "13px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif" }
const GATE_TEXT_STYLE = { margin: 0 }
const GATE_BUTTON_STYLE = { font: 'inherit', padding: '4px 14px', borderRadius: 8, border: '1px solid #b9c0cb', background: '#fff', color: '#1c7164', cursor: 'pointer' }

function errorText(cause) {
  if (!cause) return ''
  const message = typeof cause === 'string' ? cause : cause?.message
  return message ? String(message) : String(cause)
}

function createNotesChunkLoader({ require }) {
  const listeners = new Set()
  let phase = PHASE_IDLE
  let chunkExports = null
  let chunkError = null
  let pendingPromise = null
  let attachedContext = null
  let notesApplied = false
  let notesCleanup = null
  let disposed = false

  function emit() {
    for (const listener of [...listeners]) listener()
  }
  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  function getSnapshot() {
    return phase
  }
  function getError() {
    return chunkError ? errorText(chunkError) : ''
  }
  function getExports() {
    return chunkExports
  }

  // ready 的唯一入口：分块已物化、宿主上下文已 attach 时，执行分块 apply 并登记清理。
  function settle() {
    if (disposed || notesApplied || !chunkExports || !attachedContext) return
    const cleanups = []
    const result = chunkExports.apply(attachedContext)
    if (typeof result === 'function') cleanups.push(result)
    notesApplied = true
    notesCleanup = () => {
      for (const cleanup of [...cleanups].reverse()) cleanup()
    }
    phase = PHASE_READY
  }

  function start() {
    if (disposed || phase === PHASE_READY || pendingPromise) return
    if (!require || typeof require.async !== 'function') {
      // 旧宿主没有 require.async：明确失败态（错误 UI + 重试按钮），学习面完全不受影响，
      // 也绝不静默回退成入口同步注入。
      chunkError = new Error('当前宿主不支持分块加载（require.async 缺失）')
      phase = PHASE_FAILED
      emit()
      return
    }
    phase = PHASE_LOADING
    chunkError = null
    emit()
    pendingPromise = Promise.resolve()
      .then(() => require.async(`./${NOTES_CHUNK_FILE}`))
      .then(module => {
        if (disposed) return
        if (!module || typeof module.apply !== 'function') throw new Error('StudyMate notes chunk shape invalid')
        for (const key of ['NativeMainPanel', 'LearningNotesTree', 'LearningNotesPanel']) {
          if (typeof module[key] !== 'function') throw new Error(`StudyMate notes chunk missing ${key}`)
        }
        if (module.CHAT_SLOT !== CHUNK_CHAT_SLOT) throw new Error(`StudyMate notes chunk CHAT_SLOT drift: ${String(module.CHAT_SLOT)}`)
        chunkExports = module
        settle()
        emit()
      })
      .catch(cause => {
        if (disposed) return
        chunkError = cause
        phase = PHASE_FAILED
        emit()
      })
      .then(() => {
        pendingPromise = null
      })
  }

  function load() {
    start()
    return pendingPromise || Promise.resolve()
  }

  function retry() {
    if (disposed || phase === PHASE_READY || phase === PHASE_LOADING) return
    chunkExports = null
    chunkError = null
    start()
  }

  // 入口 apply 阶段调用：只登记上下文，绝不触发加载（验收①）。
  // 「分块先到、上下文后到」与「上下文先到、分块后到」两个方向都在这里汇合。
  function attach(context) {
    if (disposed) return () => {}
    attachedContext = context
    try {
      settle()
    } catch (cause) {
      chunkError = cause
      phase = PHASE_FAILED
    }
    emit()
    return () => {
      disposed = true
      listeners.clear()
      if (notesCleanup) {
        notesCleanup()
        notesCleanup = null
      }
      notesApplied = false
      attachedContext = null
    }
  }

  return { subscribe, getSnapshot, getError, getExports, load, retry, attach }
}

// 懒包装组件：挂载即触发一次加载（用户动作），ready 才渲染真组件。
// props 原样透传给分块里的真组件；占位与失败态内联自绘，不依赖任何笔记 CSS。
function makeNotesGate(loader, label, locale) {
  const Gate = props => {
    React.useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot)
    const t = locale.t
    const phase = React.useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot)
    React.useEffect(() => {
      loader.load()
    }, [loader])
    if (phase === PHASE_READY) {
      const Loaded = loader.getExports()[label]
      return React.createElement(Loaded, props)
    }
    if (phase === PHASE_FAILED) {
      const detail = loader.getError()
      return React.createElement('div', { className: 'studymate-notes-chunk-gate', style: GATE_STYLE, role: 'alert' },
        React.createElement('p', { style: GATE_TEXT_STYLE }, detail ? t('failed_detail', { detail }) : t('failed')),
        React.createElement('button', { type: 'button', 'data-proto': 'notes-chunk-retry', style: GATE_BUTTON_STYLE, onClick: () => loader.retry() }, t('retry')))
    }
    return React.createElement('div', { className: 'studymate-notes-chunk-gate', style: GATE_STYLE, role: 'status' },
      React.createElement('p', { style: GATE_TEXT_STYLE }, t('loading')))
  }
  Gate.displayName = `StudyMateNotesLazy:${label}`
  return Gate
}

// 入口工厂：构建产物在 factory(require) 里调它。返回 reader 期望的 notes 形状
// （NativeMainPanel/PanelIcon/CHAT_SLOT/createNotesWorkspace/LearningNotesTree/LearningNotesPanel）
// 加 injectServices 与 attach(ctx)。
export function createNotesEntry({ require }) {
  const loader = createNotesChunkLoader({ require })
  const locale = createLocaleScope('@yunmiao/studymate/notes-loading', {
    zh: { loading: '无界笔记正在加载…', failed: '无界笔记加载失败', failed_detail: '无界笔记加载失败：{detail}', retry: '重试' },
    en: { loading: 'Loading unbounded notes…', failed: 'Unbounded notes could not be loaded', failed_detail: 'Unbounded notes could not be loaded: {detail}', retry: 'Retry' },
  })
  return {
    options: {
      NativeMainPanel: makeNotesGate(loader, 'NativeMainPanel', locale),
      PanelIcon,
      CHAT_SLOT: CHUNK_CHAT_SLOT,
      createNotesWorkspace,
      LearningNotesTree: makeNotesGate(loader, 'LearningNotesTree', locale),
      LearningNotesPanel: makeNotesGate(loader, 'LearningNotesPanel', locale),
    },
    injectServices: [...NOTES_SERVICES],
    attach(ctx) { locale.attach(ctx); return loader.attach(ctx) },
  }
}

export default createNotesEntry
