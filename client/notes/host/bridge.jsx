import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import App from '../App.jsx'
import { resolveFileReference } from '../imports.js'
import { isMarkdownResource } from '../note-types.js'
import { createNotesPersistenceSession } from '../persistence-session.js'
import { registerNotesLocale } from '../locale.js'

// 资料库属于当前宿主档位；同一网页里的新 main 重用保存队列，课程工作区只隔离视图。
const persistenceSession = createNotesPersistenceSession({ label: 'notes-main' })

export const CHAT_SLOT = 'studymate.notes.session'
export const REFERENCE_SOURCE = 'studymate-notes-resource'

const EMPTY = Object.freeze({})
const resourceCache = { current: EMPTY }
let hostServices = null

export function updateResourceCache(resources) {
  resourceCache.current = Object.fromEntries(Object.entries(asResourceMap(resources)).filter(([, resource]) => !resource.trashed))
}

function asResourceMap(resources) {
  if (typeof resources?.getResources === 'function') {
    const value = resources.getResources()
    if (Array.isArray(value)) return Object.fromEntries(value.map(item => [String(item.id ?? item.key), item]))
    return value && typeof value === 'object' ? value : EMPTY
  }
  if (Array.isArray(resources)) return Object.fromEntries(resources.map(item => [String(item.id ?? item.key), item]))
  return resources && typeof resources === 'object' ? resources : EMPTY
}

export function resourceText(resource) {
  if (!resource || typeof resource !== 'object') return undefined
  const type = String(resource.type ?? 'resource')
  const title = String(resource.title ?? resource.name ?? '未命名资源')
  if (type === 'note') return isMarkdownResource(resource) && typeof resource.markdown === 'string' ? resource.markdown : undefined
  if (type === 'course') return typeof resource.summary === 'string' && resource.summary.trim() ? resource.summary : undefined
  if (type === 'link') {
    if (typeof resource.url !== 'string' || !/^https?:\/\//i.test(resource.url)
      || typeof resource.summary !== 'string' || !resource.summary.trim()) return undefined
    return `URL: ${resource.url}\n摘要: ${resource.summary}`
  }
  // Imported images/SVG/HTML contribute safe metadata only; never serialize pixels or untrusted markup.
  const metadata = [
    `名称: ${title}`,
    `类型: ${type}`,
    typeof resource.mime === 'string' ? `MIME: ${resource.mime}` : '',
    Number.isFinite(resource.bytes) ? `大小: ${resource.bytes} bytes` : '',
    Number.isFinite(resource.width) ? `宽度: ${resource.width}` : '',
    Number.isFinite(resource.height) ? `高度: ${resource.height}` : '',
  ].filter(Boolean)
  return metadata.join('\n')
}

function resourceLabel(resource, id) {
  return String(resource?.title ?? resource?.name ?? resource?.label ?? id)
}

export function resourceReferenceSource() {
  return {
    trigger: '@',
    name: REFERENCE_SOURCE,
    showGroupTitle: false,
    order: 80,
    candidates: async (_session, request) => Object.entries(resourceCache.current)
      .filter(([id, item]) => resourceText(item) !== undefined
        && `${id} ${resourceLabel(item, id)}`.toLocaleLowerCase().includes(String(request?.query ?? '').toLocaleLowerCase()))
      .map(([id, item]) => ({
        name: resourceLabel(item, id),
        label: resourceLabel(item, id),
        description: '仅作为显式引用加入当前草稿',
        icon: 'file',
        value: id,
      })),
    onPick: ({ candidate }) => {
      const id = String(candidate.value ?? '')
      const item = resourceCache.current[id]
      if (!id || !item || resourceText(item) === undefined) return undefined
      return { insert: {
        source: REFERENCE_SOURCE,
        ref: id,
        label: resourceLabel(item, id),
        appearance: 'file',
        clipboardText: `@${resourceLabel(item, id)}`,
      } }
    },
    codec: {
      clipboardText: ref => {
        const item = resourceCache.current[String(ref)]
        return item ? `@${resourceLabel(item, String(ref))}` : `@${String(ref)}`
      },
      serialize: async (ref, signal) => {
        if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
        const id = String(ref)
        const item = resourceCache.current[id]
        const resolved = await resolveFileReference(item)
        if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
        if (resourceCache.current[id] !== item) throw new Error(`StudyMate reference changed while reading: ${id}`)
        const body = resourceText(resolved)
        if (body === undefined) throw new Error(`StudyMate reference is unavailable: ${id}`)
        return `\n--- BEGIN STUDYMATE RESOURCE ---\nID: ${id}\nTitle: ${resourceLabel(item, id)}\n\n${body}\n--- END STUDYMATE RESOURCE ---\n`
      },
    },
  }
}

function useSessionList(sessions) {
  const list = sessions.list
  const snapshot = useSyncExternalStore(
    listener => list.subscribe(listener),
    () => list.getSnapshot(),
    () => list.getSnapshot(),
  )
  return snapshot?.byId ?? EMPTY
}

function listLabel(record, id) {
  // Deliberately use catalog metadata only: never inspect message previews/content.
  return String(record?.title ?? record?.label ?? record?.name ?? id)
}

export function detectLengthOf(state) {
  const clipboardText = String(state?.clipboardText || state?.draft || '')
  const collapsedChipLength = (state?.occurrences ?? []).reduce(
    (total, occurrence) => total + Math.max(0, Number(occurrence.length) - 1), 0,
  )
  return Math.max(0, clipboardText.length - collapsedChipLength)
}

export function appendSpan(state) {
  const detectLength = detectLengthOf(state)
  const requested = state?.selection?.end ?? state?.caret ?? detectLength
  const start = Math.max(0, Math.min(detectLength, Number(requested) || 0))
  return { start, end: start, draftRev: state.draftRev }
}

export function insertResourceReference({ hostKit, reference, id, resource }) {
  if (!reference?.binding?.ctx || !id || !resource || resourceText(resource) === undefined) return false
  const input = hostKit.conversation.input.for(reference.binding.ctx)
  const label = resourceLabel(resource, id)
  const insert = {
    source: REFERENCE_SOURCE,
    ref: String(id),
    label,
    appearance: 'file',
    clipboardText: `@${label}`,
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = input.state.getSnapshot()
    if ((state.occurrences ?? []).some(occurrence => occurrence.source === REFERENCE_SOURCE && String(occurrence.ref) === String(id))) return true
    if (input.insertReference(insert, appendSpan(state))) { input.focus?.(); return true }
  }
  return false
}

export function NativeChatPanel({
  hostKit,
  resources,
  currentId,
  quoteIds = [],
  onQuote,
  onRemoveQuote,
  draft,
  onDraftChange,
}) {
  const [selectedId, setSelectedId] = useState('')
  const [reference, setReference] = useState(null)
  const [ready, setReady] = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const selectedReference = reference?.sessionId === selectedId ? reference : null
  const sessionsById = useSessionList(hostKit.sessions)
  const resourceMap = useMemo(() => asResourceMap(resources), [resources])

  useEffect(() => {
    updateResourceCache(resourceMap)
  }, [resourceMap])

  useEffect(() => {
    if (!selectedId) {
      setReference(null)
      setReady(false)
      return undefined
    }
    let active = true
    const retained = hostKit.sessions.retain(selectedId, { source: 'studyMateNativeBridge' })
    setReference(retained)
    setReady(false)
    retained.ready.then(() => {
      if (active) setReady(true)
    }).catch(error => {
      if (active) {
        setReady(false)
        console.error('[StudyMate native host] session open failed', error)
      }
    })
    return () => {
      active = false
      retained.release()
    }
  }, [hostKit.sessions, selectedId])

  const insertQuote = useCallback((id) => {
    const key = String(id ?? '')
    const item = resourceMap[key]
    if (!key || !selectedReference || selectedReference.sessionId !== selectedId || !ready) return false
    const inserted = insertResourceReference({ hostKit, reference: selectedReference, id: key, resource: item })
    setQuoteError(inserted ? '' : `无法将“${resourceLabel(item, key)}”加入原生草稿，请重试。`)
    return inserted
  }, [hostKit, ready, resourceMap, selectedId, selectedReference])

  const quoteKey = Array.isArray(quoteIds) ? quoteIds.map(String).join('\u0000') : ''
  const previousQuotes = React.useRef(new Set())
  const quoteSession = React.useRef(selectedId)
  useEffect(() => {
    const next = new Set(Array.isArray(quoteIds) ? quoteIds.map(String) : [])
    const sessionChanged = quoteSession.current !== selectedId
    quoteSession.current = selectedId
    if (!sessionChanged && selectedReference && ready) {
      for (const id of next) if (!previousQuotes.current.has(id)) insertQuote(id)
    }
    previousQuotes.current = next
  }, [insertQuote, quoteKey, ready, selectedId, selectedReference])

  const input = useMemo(() => {
    if (!ready || !selectedReference || selectedReference.sessionId !== selectedId || !selectedReference.binding?.ctx) return null
    return hostKit.conversation.input.for(selectedReference.binding.ctx)
  }, [hostKit, ready, selectedId, selectedReference])
  const inputState = useSyncExternalStore(
    input ? listener => input.state.subscribe(listener) : () => () => {},
    input ? () => input.state.getSnapshot() : () => EMPTY,
    input ? () => input.state.getSnapshot() : () => EMPTY,
  )
  useEffect(() => {
    if (typeof inputState?.draft === 'string') onDraftChange?.(inputState.draft)
  }, [inputState?.draft, onDraftChange])
  const currentResource = currentId == null ? undefined : resourceMap[String(currentId)]
  const currentTextResource = resourceText(currentResource) === undefined ? undefined : currentResource

  const lastInput = React.useRef(input)
  const lastDraftRev = React.useRef(inputState?.draftRev)
  const lastInputReferences = React.useRef(new Set())
  const reconcileInputReferences = useCallback((state) => {
    const present = new Set((state?.occurrences ?? [])
      .filter(item => item.source === REFERENCE_SOURCE)
      .map(item => String(item.ref)))
    for (const id of lastInputReferences.current) {
      if (!present.has(id)) onRemoveQuote?.(id)
    }
    lastInputReferences.current = present
  }, [onRemoveQuote])
  useEffect(() => {
    if (lastInput.current !== input) {
      lastInput.current = input
      lastDraftRev.current = inputState?.draftRev
      lastInputReferences.current = new Set((inputState?.occurrences ?? [])
        .filter(item => item.source === REFERENCE_SOURCE)
        .map(item => String(item.ref)))
      return
    }
    if (lastDraftRev.current === inputState?.draftRev) return
    lastDraftRev.current = inputState?.draftRev
    reconcileInputReferences(inputState)
  }, [input, inputState?.draftRev, inputState?.occurrences, reconcileInputReferences])

  const onDragOver = event => {
    if (!event.dataTransfer.types.includes('application/studymate-resource')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = selectedReference && ready ? 'copy' : 'none'
  }
  const onDrop = event => {
    if (!event.dataTransfer.types.includes('application/studymate-resource')) return
    event.preventDefault()
    event.stopPropagation()
    const id = event.dataTransfer.getData('application/studymate-resource')
    if (id && insertQuote(id)) onQuote?.(id)
  }

  return <section className="studymate-native-chat" aria-label="DSH 原生对话" onDragOverCapture={onDragOver} onDropCapture={onDrop} style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    <div className="studymate-native-chat__session" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: 8 }}>
      <label htmlFor="studymate-native-session">选择现有学习答疑会话</label>
      <select id="studymate-native-session" value={selectedId} onChange={event => {
        setReference(null)
        setReady(false)
        setQuoteError('')
        setSelectedId(event.target.value)
      }}>
        <option value="">请选择会话（不会自动新建）</option>
        {Object.entries(sessionsById).map(([id, record]) => <option key={id} value={id}>{listLabel(record, id)}</option>)}
      </select>
      {currentTextResource && <button type="button" disabled={!selectedReference || !ready} onClick={() => {
        const id = String(currentId)
        if (insertQuote(id)) onQuote?.(id)
      }}>引用当前文档</button>}
      <span className="studymate-native-chat__privacy">图片、HTML 与 SVG 仅引用安全元信息，不上传像素或源码。</span>
    </div>
    {quoteError && <p role="alert" className="studymate-native-chat__error">{quoteError}</p>}
    {selectedReference && selectedReference.sessionId === selectedId && <div className="studymate-native-chat__body" key={selectedId} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {!ready && <p role="status">正在打开所选会话…</p>}
      {ready && <hostKit.SessionProvider session={reference}>
        {hostKit.renderSlot(hostKit.chatSlot ?? CHAT_SLOT, {})}
      </hostKit.SessionProvider>}
    </div>}
    {!selectedId && <p className="studymate-native-chat__empty">请选择已有会话后开始对话。引用只会进入草稿；是否发送由你在原生输入框中确认。</p>}
    {selectedId && !selectedReference && <p role="status">正在保留所选会话…</p>}
  </section>
}

export function EmbeddedConversation({ renderFactorySlot }) {
  return renderFactorySlot('conversation.content', {
    variant: 'embedded',
    phase: 'active',
    hero: false,
  })
}

// 持久化适配器：走宿主已认证的 /api/studymate/notes 路由。
// loadStore → GET；saveResource/saveLayout → POST {operation, ...}。
// 409 冲突时抛 {code:'version-conflict', current, version}，供控制器停在 CONFLICT。
function createNotesPersistenceAdapter() {
  const BASE = '/api/studymate/notes'
  async function request(body, options = {}) {
    const url = options.skipCorrupt ? `${BASE}?onCorrupt=skip` : BASE
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      credentials: 'same-origin', cache: 'no-store',
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || !json?.ok) {
      const code = json?.error?.code || 'request-failed'
      const message = json?.error?.message || `请求失败（${res.status}）`
      const err = new Error(message)
      err.code = code
      if (res.status === 409 || code === 'version-conflict') {
        err.code = 'version-conflict'
        err.current = json?.resource ?? json?.layout ?? null
        err.version = json?.version ?? null
      }
      throw err
    }
    return json
  }
  return {
    async loadStore(options = {}) { return request(null, options) },
    async upgradeStore() { return request({ operation: 'upgrade' }) },
    async saveResource(resource, expectedVersion) {
      const result = await request({ operation: 'resource', resource, expectedVersion: expectedVersion ?? null })
      return { resource: result.resource, version: result.version }
    },
    async saveLayout(layout, expectedVersion) {
      const result = await request({ operation: 'layout', layout, expectedVersion: expectedVersion ?? null })
      return { layout: result.layout, version: result.version }
    },
  }
}

export function NativeMainPanel(props) {
  const { renderSlot, SessionProvider, renderFactorySlot, chatSlot = CHAT_SLOT, active = true } = props
  const services = hostServices ?? EMPTY
  const [hostTheme, setHostTheme] = useState(() => document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light')
  useEffect(() => {
    const body = document.body
    const update = () => setHostTheme(body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light')
    const observer = new MutationObserver(update)
    observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    update()
    return () => observer.disconnect()
  }, [])

  // 持久化适配器：显式 useMemo 稳定引用传 App.persistence。独立 preview 完全不传（没有 API/localStorage/IndexedDB）。
  // 绝不按 theme 判断是否持久化。
  const persistence = useMemo(() => createNotesPersistenceAdapter(), [])

  const hostKit = useMemo(() => ({
    ...services,
    SessionProvider,
    renderSlot,
    renderFactorySlot,
    chatSlot,
  }), [services, SessionProvider, renderSlot, renderFactorySlot, chatSlot])
  const BoundChatPanel = useCallback(chatProps => <NativeChatPanel {...chatProps} hostKit={hostKit} />, [hostKit])

  return <div className="studymate-notes">
    <App ChatComponent={BoundChatPanel} hostTheme={hostTheme} onResourcesChange={updateResourceCache} active={active} persistenceSession={persistenceSession} viewMemory={props.viewMemory} scopedShortcuts={props.scopedShortcuts} getMotionScale={props.getMotionScale} persistence={persistence} workspaceBridge={props.workspaceBridge} courseLibrary={props.courseLibrary} onNavigateCourse={props.onNavigateCourse} renderCourse={props.renderCourse} />
  </div>
}

export function ConversationSessionSlot({ renderFactorySlot }) {
  return <EmbeddedConversation renderFactorySlot={renderFactorySlot} />
}

export { PanelIcon } from './panel-icon.jsx'

export function createClientModule() {
  const inputTriggers = ['slots', 'sessions', 'inputTriggers', 'conversation']
  function apply(ctx) {
    registerNotesLocale(ctx)
    const slots = ctx.get('slots')
    const sessions = ctx.get('sessions')
    const inputTriggers = ctx.get('inputTriggers')
    const conversation = ctx.get('conversation')
    const priorServices = hostServices
    hostServices = { slots, sessions, inputTriggers, conversation }
    ctx.effect(() => () => {
      if (hostServices?.slots === slots) hostServices = priorServices
    }, 'StudyMate: native host services')

    const source = resourceReferenceSource()
    ctx.effect(() => inputTriggers.registerSource(source), 'StudyMate: resource reference trigger')
    // 只填学习入口声明的子槽，不登记独立的主面板或侧栏项。
    for (const name of [CHAT_SLOT, `${CHAT_SLOT}.rightbar`]) {
      ctx.effect(() => slots.inject(name, () => slots.register({ name }, ConversationSessionSlot)), `StudyMate: embedded native conversation (${name})`)
    }
  }
  return { inject: inputTriggers, apply }
}

export default createClientModule

// Session references are owned and released by NativeChatPanel; no session is created or submitted here.
// The trigger codec resolves bodies only for selected reference occurrences during a user-initiated submit.
export { resourceText as getSelectedResourceText }

// Kept as a standalone source module; client-entry.jsx exposes the loader factory.
