// 无界笔记 · 持久化序列化与保存控制（纯函数 + 纯控制器，无浏览器依赖，Node 可测）
import { normalizeCourseRef, normalizeAssociations, subjectKey } from './curriculum.js';
// 契约：lib/notes/contracts.ts（校验口径的唯一出处）；宿主路由 GET/POST /api/studymate/notes
// API：GET {ok,schemaVersion:1|2,requiresUpgrade,storeId,resources,resourceVersions,layout,layoutVersion}
//      POST {operation:'resource'|'layout',...expectedVersion} → {ok:true,...,version} | 409 version-conflict
//      POST {operation:'upgrade'} → {ok:true,schemaVersion:2,requiresUpgrade:false,backup,backupId}
//
// 边界：这里只负责「内存形状 ↔ 存储 DTO」与保存队列/版本栅栏。不碰 DOM、不 fetch、不 hydrate 媒体。
//       媒体重入在 rehydrateMediaResource 里做，那一段允许用 DOM/File（只在浏览器里跑）。

// ---------------------------------------------------------------------------
// 上限（照 lib/notes/contracts.ts 的口径，不放宽）
// ---------------------------------------------------------------------------

export const LIMITS = Object.freeze({
  maxNoteChars: 128 * 1024,
  maxNoteBytes: 512 * 1024,
  maxResources: 250,
  maxFolders: 80,
  maxNodes: 120,
  maxEdges: 240,
  maxMetaChars: 2000,
  maxNodeTextChars: 20000,
  maxEdgeLabelChars: 500,
})

// ID 合法性：小写 ASCII [a-z0-9-]，1..96 个字符（与 contracts.ts 一致）。
const ID_RE = /^[a-z0-9-]{1,96}$/

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id)
}

const NODE_TYPES = Object.freeze(['knowledge', 'text'])
const FOLDER_KINDS = Object.freeze(['folder', 'notebook'])
const RESOURCE_TYPES = Object.freeze(['note', 'course', 'link', 'image', 'svg', 'html'])

const fail = (message) => { throw new Error(message) }

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertPlainObject(value, message) {
  if (!isPlainObject(value)) fail(message)
}

// ---------------------------------------------------------------------------
// 资源序列化白名单
// ---------------------------------------------------------------------------

const RESOURCE_SCALAR_FIELDS = [
  'id', 'type', 'title', 'parent', 'owner', 'summary', 'url', 'source',
  'origin', 'mime', 'bytes', 'width', 'height', 'courseRef', 'associations', 'trashed',
]

// 自有 note 的正文（markdown）与自有媒体（html / src）。
const RESOURCE_BODY_FIELDS = ['markdown', 'html', 'src']

// origin 白名单：只留 kind/mode/name/lastModified/sourceId。
// canReopen 是运行时句柄能力，**不入存储**（契约明文）。
export function serializeOrigin(origin) {
  if (!origin || typeof origin !== 'object') return undefined
  const out = {}
  if (typeof origin.kind === 'string') out.kind = origin.kind
  if (typeof origin.mode === 'string') out.mode = origin.mode
  if (typeof origin.name === 'string') out.name = origin.name
  if (Number.isFinite(origin.lastModified)) out.lastModified = origin.lastModified
  if (typeof origin.sourceId === 'string') out.sourceId = origin.sourceId
  return Object.keys(out).length ? out : undefined
}

/**
 * 是否**外部文件引用**：判据只看 origin（kind==='file' && mode==='reference'），
 * **不限 type**——引用一张图片、一个 SVG、一段 HTML 同样只存元信息。
 */
export function isFileReference(resource) {
  const origin = resource?.origin
  if (!isPlainObject(origin)) return false
  return origin.kind === 'file' && origin.mode === 'reference'
}

/**
 * 物理文件 kind：外部引用 → .json；自有 note → .md 单份权威 Markdown；其余 → .json。
 */
export function physicalKindOf(resource) {
  if (isFileReference(resource)) return 'json'
  return resource?.type === 'note' ? 'md' : 'json'
}

// 把内存资源转成可存储 DTO：剥运行时句柄（sourceFile/fileHandle/refBody）、
// 剥 unknown origin 字段（canReopen）、剥 quote/chatDraft/会话等。
// 外部文件引用（origin.kind==='file' && mode==='reference'）只留元信息，
// 不带 markdown/html/src/sourceFile/fileHandle——**与 type 无关**。
export function serializeResource(resource) {
  if (!resource || typeof resource !== 'object') return null
  const id = String(resource.id ?? '')
  if (!id) return null
  if (!isValidId(id)) fail(`资源 id 非法：${id}`)
  const type = resource.type
  if (typeof type !== 'string' || !RESOURCE_TYPES.includes(type)) {
    fail(`资源 type 不合法：只支持 ${RESOURCE_TYPES.join(' / ')}。`)
  }
  const fileReference = isFileReference(resource)

  const out = { id, type }
  for (const key of RESOURCE_SCALAR_FIELDS) {
    if (key === 'id' || key === 'type' || key === 'origin') continue
    const value = resource[key]
    if (value === undefined) continue
    if (key === 'courseRef') { if (type !== 'course') fail('只有课程卡能有 courseRef。'); out.courseRef = normalizeCourseRef(value); continue }
    if (key === 'associations') { if (type !== 'note' || fileReference) fail('只有自有笔记能有课程关联。'); out.associations = normalizeAssociations(value); continue }
    if (key === 'trashed') { if (typeof value !== 'boolean') fail('trashed 必须是布尔值。'); out.trashed = value; continue }
    if (key === 'bytes' || key === 'width' || key === 'height') {
      if (Number.isFinite(value)) out[key] = value
      continue
    }
    if (key === 'parent') {
      // parent 允许 null（根目录）：null 是合法值，不能被当成「没有」。
      if (value === null) out.parent = null
      else if (typeof value === 'string') out.parent = value
      continue
    }
    if (typeof value === 'string') {
      if (['title', 'owner', 'summary', 'source'].includes(key) && [...value].length > LIMITS.maxMetaChars) {
        fail(`资源「${key}」超过 ${LIMITS.maxMetaChars} 字符上限，请缩短后再保存。`)
      }
      out[key] = value
    }
  }
  const origin = serializeOrigin(resource.origin)
  if (origin) out.origin = origin

  // 正文：只有非外部引用才允许带 markdown/html/src。
  if (!fileReference) {
    for (const key of RESOURCE_BODY_FIELDS) {
      const value = resource[key]
      if (typeof value !== 'string') continue
      if (key === 'markdown') {
        if ([...value].length > LIMITS.maxNoteChars) fail(`笔记正文超过 ${LIMITS.maxNoteChars} 字符上限，请缩短后再保存。`)
        if (utf8Bytes(value) > LIMITS.maxNoteBytes) fail(`笔记正文 UTF-8 超过 ${LIMITS.maxNoteBytes} 字节上限，请缩短后再保存。`)
      }
      out[key] = value
    }
  }
  return out
}

// 从存储 DTO 构造内存资源：外部文件引用补 referenceError 提示 + canReopen=false 标记，
// 供 UI 显示「请重新选择原文件…」。不回填 sourceFile/fileHandle（那是会话内运行时）。
export function hydrateResource(dto) {
  if (!dto || typeof dto !== 'object') return null
  const id = String(dto.id ?? '')
  if (!id || !isValidId(id)) return null
  const out = {}
  for (const key of RESOURCE_SCALAR_FIELDS) {
    if (key === 'id' || key === 'origin') continue
    if (dto[key] !== undefined) out[key] = dto[key]
  }
  for (const key of RESOURCE_BODY_FIELDS) {
    if (typeof dto[key] === 'string') out[key] = dto[key]
  }
  out.id = id
  if (dto.courseRef !== undefined) {
    if (dto.type !== 'course') fail('只有课程卡能有 courseRef。')
    out.courseRef = normalizeCourseRef(dto.courseRef)
  }
  if (dto.associations !== undefined) {
    if (dto.type !== 'note' || isFileReference(dto)) fail('只有自有笔记能有课程关联。')
    out.associations = normalizeAssociations(dto.associations)
  }
  if (dto.trashed !== undefined && typeof dto.trashed !== 'boolean') fail('trashed 必须是布尔值。')
  if (dto.origin && typeof dto.origin === 'object') {
    const origin = serializeOrigin(dto.origin) ?? {}
    if (origin.kind === 'file' && origin.mode === 'reference') {
      // 重载后的引用没有 File/handle；canReopen 仅会话内由用户重新关联后才可能为 true。
      out.origin = { ...origin, canReopen: false }
      out.referenceError = '请重新选择原文件…'
      // 外部引用绝不缓存正文副本：剥 markdown/html/src
      delete out.markdown
      delete out.html
      delete out.src
    } else {
      out.origin = origin
    }
  }
  return out
}

function utf8Bytes(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length
  return Buffer.byteLength(text, 'utf8')
}

// ---------------------------------------------------------------------------
// 布局序列化（严格：非法就 throw，不静默归零/丢弃/截断）
// ---------------------------------------------------------------------------

const NODE_DATA_FIELDS = ['contentId', 'text', 'collapsed', 'expandedHeight', 'notebookId']

function normalizeFolder(raw) {
  assertPlainObject(raw, '目录必须是对象。')
  const id = raw.id
  if (!isValidId(id)) fail(`目录 id 非法：${String(id)}`)
  const name = raw.name
  if (typeof name !== 'string' || name.length > 200) fail(`目录「${id}」的 name 非法。`)
  // parent:null 是「根目录」的合法值——必须原样保留，不能改成 'library'（那会造出自环）。
  const parent = raw.parent === undefined ? null : raw.parent
  if (parent !== null && !isValidId(parent)) fail(`目录「${id}」的 parent 非法。`)
  const kind = raw.kind
  if (kind !== undefined && !FOLDER_KINDS.includes(kind)) fail(`目录「${id}」的 kind 非法。`)
  const folder = { id, name, parent }
  if (kind !== undefined) folder.kind = kind
  for (const key of ['bindings', 'defaultForSubjects']) if (raw[key] !== undefined) {
    if (kind !== 'notebook' || !Array.isArray(raw[key]) || raw[key].length > 32) fail('笔记本科目绑定非法。')
    folder[key] = raw[key].map(ref => normalizeCourseRef(ref, { subjectOnly: true }))
    if (new Set(folder[key].map(subjectKey)).size !== folder[key].length) fail('笔记本有重复科目绑定。')
  }
  if ((folder.defaultForSubjects || []).some(ref => !(folder.bindings || []).some(binding => subjectKey(binding) === subjectKey(ref)))) fail('默认科目必须先绑定到笔记本。')
  if (raw.viewport !== undefined) {
    if (kind !== 'notebook') fail('只有笔记本能保存画布视口。')
    assertPlainObject(raw.viewport, '笔记本 viewport 必须是对象。')
    if (Object.keys(raw.viewport).some(key => !['x', 'y', 'zoom'].includes(key))) fail('笔记本 viewport 不允许额外字段。')
    if (Math.abs(raw.viewport.x) > 1e6 || Math.abs(raw.viewport.y) > 1e6 || raw.viewport.zoom < 0.01) fail('笔记本 viewport 超过坐标或缩放范围。')
    folder.viewport = normalizeViewport(raw.viewport)
  }
  return folder
}

function normalizeNode(raw) {
  assertPlainObject(raw, '节点必须是对象。')
  const id = raw.id
  if (!isValidId(id)) fail(`节点 id 非法：${String(id)}`)
  const type = raw.type
  if (!NODE_TYPES.includes(type)) fail(`节点「${id}」的 type 只能是 ${NODE_TYPES.join(' / ')}。`)

  const position = raw.position
  assertPlainObject(position, `节点「${id}」的 position 非法。`)
  const x = position.x
  const y = position.y
  if (!Number.isFinite(x) || !Number.isFinite(y)) fail(`节点「${id}」的 position 非法：坐标必须是有限数。`)

  const styleRaw = raw.style ?? {}
  assertPlainObject(styleRaw, `节点「${id}」的 style 非法。`)
  const style = {}
  for (const key of ['width', 'height']) {
    const value = raw[key] !== undefined ? raw[key] : styleRaw[key]
    if (value === undefined) continue
    if (!Number.isFinite(value) || value < 1 || value > 100000) fail(`节点「${id}」的 style.${key} 非法。`)
    style[key] = value
  }

  const dataRaw = raw.data ?? {}
  assertPlainObject(dataRaw, `节点「${id}」的 data 非法。`)
  const data = {}
  if ('contentId' in dataRaw) {
    const contentId = dataRaw.contentId
    if (contentId === null) {
      if (type === 'knowledge') fail(`节点「${id}」是内容卡，必须有 data.contentId。`)
    } else {
      if (!isValidId(contentId)) fail(`节点「${id}」的 data.contentId 非法。`)
      data.contentId = contentId
    }
  } else if (type === 'knowledge') {
    fail(`节点「${id}」是内容卡，必须有 data.contentId。`)
  }
  if ('text' in dataRaw) {
    const text = dataRaw.text
    if (typeof text !== 'string') fail(`节点「${id}」的 data.text 非法。`)
    if ([...text].length > LIMITS.maxNodeTextChars) fail(`节点「${id}」的文字超过 ${LIMITS.maxNodeTextChars} 字符上限，请缩短后再保存。`)
    data.text = text
  }
  if ('collapsed' in dataRaw) {
    if (typeof dataRaw.collapsed !== 'boolean') fail(`节点「${id}」的 data.collapsed 非法。`)
    data.collapsed = dataRaw.collapsed
  }
  if ('expandedHeight' in dataRaw) {
    const height = dataRaw.expandedHeight
    if (!Number.isFinite(height) || height < 1 || height > 100000) fail(`节点「${id}」的 data.expandedHeight 非法。`)
    data.expandedHeight = height
  }

  if ('notebookId' in dataRaw) {
    if (!isValidId(dataRaw.notebookId)) fail(`节点「${id}」的 notebookId 非法。`)
    data.notebookId = dataRaw.notebookId
  }
  return { id, type, position: { x, y }, style, data }
}

// 复原 marker/styles 用原 fixture edge 默认值（edge() 工厂里的那组）。
const DEFAULT_EDGE_MARKER = { type: 'arrowclosed', width: 17, height: 17 }
const DEFAULT_EDGE_STYLE = { stroke: '#9caea7', strokeWidth: 1.6 }

function normalizeEdge(raw) {
  assertPlainObject(raw, '连线必须是对象。')
  const id = raw.id
  if (!isValidId(id)) fail(`连线 id 非法：${String(id)}`)
  const source = raw.source
  const target = raw.target
  if (!isValidId(source) || !isValidId(target)) fail(`连线「${id}」的 source/target 非法。`)
  if (source === target) fail(`连线「${id}」不能连接到自身。`)
  const type = raw.type === undefined ? 'relation' : raw.type
  if (type !== 'relation') fail(`连线「${id}」的 type 必须是 relation。`)
  const edge = { id, source, target, type }
  for (const key of ['sourceHandle', 'targetHandle']) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length > 96) fail(`连线「${id}」的 ${key} 非法。`)
    edge[key] = value
  }
  const dataRaw = raw.data ?? {}
  assertPlainObject(dataRaw, `连线「${id}」的 data 非法。`)
  const label = dataRaw.label === undefined ? '' : dataRaw.label
  if (typeof label !== 'string') fail(`连线「${id}」的 data.label 非法。`)
  if ([...label].length > LIMITS.maxEdgeLabelChars) fail(`连线「${id}」的标签超过 ${LIMITS.maxEdgeLabelChars} 字符上限，请缩短后再保存。`)
  edge.data = { label }
  return edge
}

function normalizeViewport(raw) {
  if (raw === null || raw === undefined) return null
  assertPlainObject(raw, 'viewport 必须是对象。')
  const x = raw.x
  const y = raw.y
  const zoom = raw.zoom
  if (!Number.isFinite(x) || !Number.isFinite(y)) fail('viewport 的 x/y 必须是有限数。')
  if (!Number.isFinite(zoom) || zoom <= 0 || zoom > 10) fail('viewport 的 zoom 非法。')
  return { x, y, zoom }
}

export function serializeLayout({ folders = [], nodes = [], edges = [], viewport = null } = {}) {
  if (!Array.isArray(folders)) fail('布局 folders 必须是数组。')
  if (!Array.isArray(nodes)) fail('布局 nodes 必须是数组。')
  if (!Array.isArray(edges)) fail('布局 edges 必须是数组。')
  if (folders.length > LIMITS.maxFolders) fail(`目录数量超过 ${LIMITS.maxFolders} 上限。`)
  if (nodes.length > LIMITS.maxNodes) fail(`节点数量超过 ${LIMITS.maxNodes} 上限。`)
  if (edges.length > LIMITS.maxEdges) fail(`连线数量超过 ${LIMITS.maxEdges} 上限。`)

  const outFolders = folders.map(normalizeFolder)
  const outNodes = nodes.map(normalizeNode).map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    style: node.style,
    data: pickNodeData(node.data),
  }))
  const outEdges = edges.map(normalizeEdge).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    sourceHandle: edge.sourceHandle ?? 'out',
    targetHandle: edge.targetHandle ?? 'in',
    data: edge.data,
  }))
  const notebookIds = new Set(outFolders.filter(folder => folder.kind === 'notebook').map(folder => folder.id))
  for (const node of outNodes) if (node.data.notebookId && !notebookIds.has(node.data.notebookId)) fail('节点的 notebookId 指向不存在的笔记本。')
  const defaults = outFolders.flatMap(folder => (folder.defaultForSubjects || []).map(subjectKey))
  if (new Set(defaults).size !== defaults.length) fail('同一科目只能有一个默认笔记本。')
  return { folders: outFolders, nodes: outNodes, edges: outEdges, viewport: normalizeViewport(viewport) }
}

function pickNodeData(data) {
  const out = {}
  for (const key of NODE_DATA_FIELDS) {
    if (data[key] !== undefined) out[key] = data[key]
  }
  return out
}

export function hydrateLayout(dto) {
  if (!dto || typeof dto !== 'object') fail('布局必须是对象。')
  const folders = dto.folders ?? []
  const nodes = dto.nodes ?? []
  const edges = dto.edges ?? []
  if (!Array.isArray(folders)) fail('布局 folders 必须是数组。')
  if (!Array.isArray(nodes)) fail('布局 nodes 必须是数组。')
  if (!Array.isArray(edges)) fail('布局 edges 必须是数组。')
  if (folders.length > LIMITS.maxFolders) fail(`目录数量超过 ${LIMITS.maxFolders} 上限。`)
  if (nodes.length > LIMITS.maxNodes) fail(`节点数量超过 ${LIMITS.maxNodes} 上限。`)
  if (edges.length > LIMITS.maxEdges) fail(`连线数量超过 ${LIMITS.maxEdges} 上限。`)

  const checked = serializeLayout({ folders, nodes, edges, viewport: dto.viewport ?? { x: 0, y: 0, zoom: 1 } })
  return {
    folders: checked.folders,
    nodes: checked.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      style: node.style,
      data: node.data,
    })),
    edges: edges.map(normalizeEdge).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      sourceHandle: edge.sourceHandle ?? 'out',
      targetHandle: edge.targetHandle ?? 'in',
      data: edge.data,
      markerEnd: DEFAULT_EDGE_MARKER,
      style: DEFAULT_EDGE_STYLE,
    })),
    viewport: normalizeViewport(dto.viewport ?? { x: 0, y: 0, zoom: 1 }),
  }
}

// ---------------------------------------------------------------------------
// 载入辅助：只认合法的 GET 响应，不回 demo、不空库伪成功
// ---------------------------------------------------------------------------

// 载入 GET 响应 → { resources: {id: memoryResource}, layout, resourceVersions, layoutVersion, storeId }
function hydrateCorruptEntries(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) fail('载入响应的 corrupt 必须是数组。')
  if (raw.length > LIMITS.maxResources) fail(`坏资源数量超过 ${LIMITS.maxResources} 上限。`)
  return raw.map((item) => {
    if (!isPlainObject(item)) fail('坏资源条目必须是对象。')
    if (!isValidId(item.id)) fail(`坏资源 id 非法：${String(item.id)}`)
    if (item.kind !== 'md' && item.kind !== 'json') fail(`坏资源「${item.id}」的 kind 非法。`)
    if (typeof item.message !== 'string' || !item.message || [...item.message].length > LIMITS.maxMetaChars) {
      fail(`坏资源「${item.id}」的 message 非法。`)
    }
    if (item.notebook !== null && typeof item.notebook !== 'string') fail(`坏资源「${item.id}」的 notebook 非法。`)
    const entry = { id: item.id, kind: item.kind, notebook: item.notebook, message: item.message }
    if (item.title !== undefined) {
      if (typeof item.title !== 'string' || !item.title || [...item.title].length > LIMITS.maxMetaChars) {
        fail(`坏资源「${item.id}」的 title 非法。`)
      }
      entry.title = item.title
    }
    if (item.associations !== undefined) {
      try { entry.associations = normalizeAssociations(item.associations) }
      catch (error) { fail(`坏资源「${item.id}」的课程关联非法：${error.message}`) }
    }
    return entry
  })
}

export function hydrateStore(payload) {
  if (!isPlainObject(payload)) fail('载入响应必须是 JSON 对象。')
  if (payload.ok !== undefined && payload.ok !== true) fail('载入失败：宿主返回了错误响应。')
  if (![1, 2].includes(payload.schemaVersion)) fail(`载入响应的 schemaVersion 非法：${String(payload.schemaVersion)}`)

  const rawResources = payload.resources
  if (!isPlainObject(rawResources)) fail('载入响应的 resources 非法。')
  const resourceIds = Object.keys(rawResources)
  if (resourceIds.length > LIMITS.maxResources) fail(`资源数量超过 ${LIMITS.maxResources} 上限。`)

  const resources = {}
  for (const [id, dto] of Object.entries(rawResources)) {
    if (!isPlainObject(dto)) fail(`资源「${id}」非法。`)
    if (!isValidId(dto.id ?? id)) fail(`资源 id 非法：${id}`)
    const hydrated = hydrateResource(dto)
    if (!hydrated) fail(`资源「${id}」非法。`)
    resources[id] = hydrated
  }

  const rawVersions = payload.resourceVersions ?? {}
  if (!isPlainObject(rawVersions)) fail('载入响应的 resourceVersions 非法。')
  const resourceVersions = {}
  for (const [id, version] of Object.entries(rawVersions)) {
    if (version !== null && typeof version !== 'string') fail(`资源「${id}」的版本号非法。`)
    resourceVersions[id] = version ?? null
  }

  const layout = payload.layout ? hydrateLayout(payload.layout) : null
  const layoutVersion = payload.layoutVersion ?? null
  if (layoutVersion !== null && typeof layoutVersion !== 'string') fail('载入响应的 layoutVersion 非法。')

  const corrupt = hydrateCorruptEntries(payload.corrupt)
  return { resources, layout, resourceVersions, layoutVersion, storeId: payload.storeId ?? null, schemaVersion: payload.schemaVersion, requiresUpgrade: payload.schemaVersion === 1 || payload.requiresUpgrade === true, corrupt }
}

// ---------------------------------------------------------------------------
// 媒体重入：从存储 DTO 重新经过 media.js 安全入口（浏览器里跑，允许 DOM/File）
// ---------------------------------------------------------------------------

// raster: 从受控 dataURL 重构 File 再 readMediaFile
// html:   从存储 html 重新过 safeDocument
// svg:    从已 safeDocument 过的 html 里用 inert template 抽出唯一 svg，再走 SVG 入口（2000 元素预算）
// 外部文件引用没有 payload，不尝试重建，原样返回。

const RASTER_MIME_EXT = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' })
const RASTER_BYTES_LIMIT = 4 * 1024 * 1024

export async function rehydrateMediaResource(resource, { readMediaFile } = {}) {
  if (!resource || typeof resource !== 'object') return resource
  if (typeof readMediaFile !== 'function') fail('缺少媒体读取入口 readMediaFile。')
  // 外部引用没有正文：绝不试着重建，也不缓存副本。
  if (isFileReference(resource)) return resource

  const type = resource.type
  if (type === 'image') {
    if (typeof resource.src !== 'string') fail('图片资源缺少 src，无法重新解析。')
    const { mime, bytes } = parseImageDataUrl(resource.src)
    const file = new File([bytes], `image.${RASTER_MIME_EXT[mime]}`, { type: mime })
    const result = await readMediaFile(file)
    return mergeMediaResult(resource, result)
  }
  if (type === 'html') {
    if (typeof resource.html !== 'string') fail('HTML 资源缺少 html，无法重新解析。')
    const file = new File([resource.html], 'media.html', { type: 'text/html' })
    const result = await readMediaFile(file)
    return mergeMediaResult(resource, result)
  }
  if (type === 'svg') {
    if (typeof resource.html !== 'string') fail('SVG 资源缺少 html，无法重新解析。')
    const markup = extractSvgMarkup(resource.html)
    const file = new File([markup], 'media.svg', { type: 'image/svg+xml' })
    const result = await readMediaFile(file)
    return mergeMediaResult(resource, result)
  }
  return resource
}

// 保留原资源元信息，只换掉正文/媒体体（重新清理后的 html/src 与真实 mime/bytes/dimensions）。
const MEDIA_META_FIELDS = ['id', 'title', 'parent', 'owner', 'summary', 'url', 'source', 'origin', 'type']

function mergeMediaResult(resource, result) {
  const merged = { ...result }
  for (const key of MEDIA_META_FIELDS) {
    if (resource[key] !== undefined) merged[key] = resource[key]
  }
  return merged
}

// 受控 dataURL → {mime, bytes}（仅 png/jpeg/webp，≤4 MiB；不 fetch 任意 URL）
function parseImageDataUrl(src) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(src)
  if (!match) fail('图片资源只接受 png/jpeg/webp 的 dataURL。')
  const mime = match[1].toLowerCase()
  const base64 = match[2]
  if (base64.length % 4 !== 0) fail('图片 base64 长度不合法。')
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const size = (base64.length / 4) * 3 - padding
  if (size > RASTER_BYTES_LIMIT) fail(`图片超过 ${RASTER_BYTES_LIMIT} 字节上限。`)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { mime, bytes }
}

// 从已 safeDocument 的 html 里抽唯一 svg。浏览器里走 inert template（不执行脚本）；
// 无 DOM 的纯 Node 环境退回到等价的字面抽取（只用于单测，不参与线上路径）。
function extractSvgMarkup(html) {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const template = document.createElement('template')
    template.innerHTML = html
    const found = template.content.querySelectorAll('svg')
    if (found.length !== 1) fail('SVG 内容里必须有且只有一个 svg 元素。')
    return found[0].outerHTML
  }
  const found = html.match(/<svg\b[\s\S]*?<\/svg>/gi)
  if (!found || found.length !== 1) fail('SVG 内容里必须有且只有一个 svg 元素。')
  return found[0]
}

// ---------------------------------------------------------------------------
// 稳态场景序列化（剥 selected/dragging/resizing/measured）
// ---------------------------------------------------------------------------

export function serializeStableScene(scene) {
  return {
    nodes: (scene?.nodes ?? []).map(n => {
      const { selected, dragging, resizing, measured, dragHandle, ...rest } = n
      return { ...rest, data: { ...n.data }, style: { ...n.style } }
    }),
    edges: (scene?.edges ?? []).map(e => {
      const { selected, ...rest } = e
      return { ...rest, data: { ...e.data } }
    }),
  }
}

// ---------------------------------------------------------------------------
// 保存控制器（纯逻辑，无 fetch；transport 注入）
// ---------------------------------------------------------------------------

export const SaveState = Object.freeze({
  IDLE: 'idle',
  PENDING: 'pending',   // 有草稿等待保存（debounce 中或排队）
  SAVING: 'saving',     // 请求已发出
  SAVED: 'saved',       // 最近一次提交成功且之后无新草稿
  ERROR: 'error',       // 保存失败（保留草稿，可重试）
  CONFLICT: 'conflict', // 409 版本冲突（必须停下，不自动覆盖）
})

const DEFAULT_DEBOUNCE_MS = 800
const LAYOUT_KEY = '__layout__'

// fingerprint：结构稳定的内容指纹（不依赖对象引用）。
export function fingerprintOf(value) {
  return stableStringify(value)
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

const defaultFingerprintOf = fingerprintOf

// 每个 key（资源 id 或 '__layout__'）一条串行保存链：
//   baseVersion    当前已知的服务器版本（null = 新建）
//   baseFingerprint 上次提交成功（或载入基线）时的 fingerprint
//   draft          最新草稿对象（未提交）
//   draftFingerprint 草稿的 fingerprint
//   state/error/conflict
//   inFlight       当前已发出的请求（{fingerprint, promise}）
export function createSaveController({ transport, debounceMs = DEFAULT_DEBOUNCE_MS, fingerprintOf: fingerprintOption, now = () => Date.now() }) {
  if (typeof transport?.saveResource !== 'function' || typeof transport?.saveLayout !== 'function') {
    throw new Error('transport must expose saveResource and saveLayout')
  }
  const fp = typeof fingerprintOption === 'function' ? fingerprintOption : defaultFingerprintOf
  const chains = new Map()          // key -> chain
  const listeners = new Set()
  const pendingRequests = new Set()  // 已发出的请求（suspendAndWait 等它们 settle）
  let generation = 0                // 代际：clear() 推进它，迟到回包不得污染新 base
  let suspended = false             // 挂起：禁止新的 outbound
  let disposed = false

  const emit = () => {
    for (const fn of [...listeners]) {
      try { fn() } catch { /* 监听器自己的错不该打断保存链 */ }
    }
  }

  const normalizeKey = (key) => (key === LAYOUT_KEY ? LAYOUT_KEY : String(key))

  const getChain = (key) => {
    if (!chains.has(key)) {
      chains.set(key, {
        key, baseVersion: null, baseFingerprint: null,
        draft: null, draftFingerprint: null,
        state: SaveState.IDLE, error: null, conflict: null,
        timer: null, saving: false, inFlight: null,
      })
    }
    return chains.get(key)
  }

  const statusOf = (chain) => ({
    state: chain.state,
    error: chain.error,
    conflict: chain.conflict,
    dirty: Boolean(chain.draft) || chain.state === SaveState.SAVING || chain.state === SaveState.PENDING,
    baseVersion: chain.baseVersion ?? null,
    baseFingerprint: chain.baseFingerprint ?? null,
    draft: chain.draft ?? null,
  })

  const idleStatus = () => ({
    state: SaveState.IDLE, error: null, conflict: null, dirty: false,
    baseVersion: null, baseFingerprint: null, draft: null,
  })

  function clearTimer(chain) {
    if (chain.timer) { clearTimeout(chain.timer); chain.timer = null }
  }

  function schedule(chain) {
    if (disposed || suspended || chain.state === SaveState.ERROR || chain.state === SaveState.CONFLICT) return
    clearTimer(chain)
    chain.timer = setTimeout(() => { chain.timer = null; void flushChain(chain) }, debounceMs)
    if (chain.state !== SaveState.ERROR && chain.state !== SaveState.CONFLICT) chain.state = SaveState.PENDING
    emit()
  }

  async function flushChain(chain) {
    if (disposed || suspended || chain.state === SaveState.ERROR || chain.state === SaveState.CONFLICT) return
    if (chain.saving || chain.inFlight) return
    if (!chain.draft) return
    // 与基线同值 → 没有东西可存。
    if (chain.baseFingerprint !== null && chain.baseFingerprint === chain.draftFingerprint) {
      chain.draft = null
      chain.draftFingerprint = null
      chain.state = SaveState.SAVED
      emit()
      return
    }
    const submitted = chain.draft
    const submittedFingerprint = chain.draftFingerprint
    const expectedVersion = chain.baseVersion ?? null
    const gen = generation
    chain.saving = true
    chain.state = SaveState.SAVING
    chain.error = null
    chain.conflict = null
    emit()

    let request
    try {
      request = chain.key === LAYOUT_KEY
        ? transport.saveLayout(submitted, expectedVersion)
        : transport.saveResource(submitted, expectedVersion)
    } catch (error) {
      request = Promise.reject(error)
    }
    const tracked = Promise.resolve(request)
    chain.inFlight = { fingerprint: submittedFingerprint, promise: tracked }
    pendingRequests.add(tracked)

    try {
      const result = await tracked
      if (disposed || gen !== generation) return   // 代际隔离：迟到回包不改任何 base
      chain.baseVersion = result?.version ?? null
      chain.baseFingerprint = submittedFingerprint
      if (chain.draftFingerprint === submittedFingerprint) {
        chain.draft = null
        chain.draftFingerprint = null
        chain.state = SaveState.SAVED
      } else {
        // 保存期间有了新草稿：base 前移到本次版本，新草稿继续排队。
        chain.state = SaveState.PENDING
        schedule(chain)
      }
    } catch (error) {
      if (disposed || gen !== generation) return
      // 在途期间可能已有下一轮 debounce：失败即取消，草稿仍保留。
      clearTimer(chain)
      if (error && error.code === 'version-conflict') {
        chain.state = SaveState.CONFLICT
        chain.conflict = { current: error.current ?? null, version: error.version ?? null }
        chain.error = error
        // 冲突必须停下：不自动覆盖、不偷换 base。草稿保留。
      } else {
        chain.state = SaveState.ERROR
        chain.error = error
        // 失败保留草稿，可显式重试。
      }
    } finally {
      pendingRequests.delete(tracked)
      if (chain.inFlight && chain.inFlight.promise === tracked) chain.inFlight = null
      chain.saving = false
      if (!disposed && gen === generation) emit()
    }
  }

  function save(key, dto) {
    if (disposed) return
    if (!dto || typeof dto !== 'object') return
    const chain = getChain(key)
    const fingerprint = fp(dto)
    // 最新草稿永远记下（哪怕当前是 ERROR/CONFLICT）。
    chain.draft = dto
    chain.draftFingerprint = fingerprint

    // ERROR/CONFLICT：必须由用户处理；回到旧本地基线也不能证明服务端同值。
    if (chain.state === SaveState.ERROR || chain.state === SaveState.CONFLICT) { emit(); return }
    // 与基线同值 → 不发。
    if (chain.baseFingerprint !== null && chain.baseFingerprint === fingerprint && !chain.inFlight && !chain.saving) {
      chain.draft = null
      chain.draftFingerprint = null
      chain.state = SaveState.SAVED
      emit()
      return
    }
    // 与当前在途目标相同 → 不生成第二次保存。
    if (chain.inFlight && chain.inFlight.fingerprint === fingerprint) { emit(); return }
    schedule(chain)
  }

  function retry(target) {
    if (disposed) return
    const list = (target === undefined || target === null)
      ? [...chains.values()]
      : [chains.get(normalizeKey(target))].filter(Boolean)
    for (const chain of list) {
      if (chain.state !== SaveState.ERROR) continue
      if (!chain.draft) continue
      chain.state = SaveState.PENDING
      chain.error = null
      void flushChain(chain)
    }
    emit()
  }

  function resolveConflict(key, options = {}) {
    if (disposed) return
    const chain = chains.get(normalizeKey(key))
    if (!chain || chain.state !== SaveState.CONFLICT) return
    if (options.discard) {
      // 用户明确放弃本地：只清这个 key 的草稿与当前基线（整库重载由父负责）。
      clearTimer(chain)
      chain.draft = null
      chain.draftFingerprint = null
      chain.baseVersion = null
      chain.baseFingerprint = null
      chain.state = SaveState.IDLE
      chain.error = null
      chain.conflict = null
      emit()
      return
    }
    // 用户明确选择「保留本地」：以冲突回包里的服务器版本作 CAS 基准，再存最新本地草稿。
    chain.baseVersion = chain.conflict?.version ?? null
    chain.baseFingerprint = null
    chain.conflict = null
    chain.error = null
    chain.state = SaveState.PENDING
    if (chain.draft) void flushChain(chain)
    else { chain.state = SaveState.IDLE; emit() }
  }

  function loadBase(key, version, payload) {
    if (disposed) return
    const chain = getChain(normalizeKey(key))
    const busy = Boolean(chain.draft) || chain.saving || Boolean(chain.inFlight)
    if (busy) {
      // 链不干净：不能动基线，也不能丢草稿（父在整库重载前会先 clear()）。
      emit()
      return
    }
    clearTimer(chain)
    chain.baseVersion = version ?? null
    chain.baseFingerprint = payload === undefined || payload === null ? null : fp(payload)
    chain.state = SaveState.IDLE
    chain.error = null
    chain.conflict = null
    emit()
  }

  function suspendAndWait() {
    suspended = true
    for (const chain of chains.values()) clearTimer(chain)
    emit()
    const pending = [...pendingRequests]
    if (!pending.length) return Promise.resolve()
    return Promise.allSettled(pending).then(() => undefined)
  }

  function resume() {
    if (disposed) return
    suspended = false
    for (const chain of chains.values()) {
      if (!chain.draft) continue
      if (chain.state === SaveState.ERROR || chain.state === SaveState.CONFLICT) continue  // 只恢复正常 pending
      if (chain.inFlight || chain.saving) continue
      schedule(chain)
    }
    emit()
  }

  function clear() {
    generation++
    for (const chain of chains.values()) {
      clearTimer(chain)
      chain.draft = null
      chain.draftFingerprint = null
      chain.inFlight = null
      chain.saving = false
    }
    chains.clear()
    emit()
  }

  function dispose() {
    disposed = true
    generation++
    for (const chain of chains.values()) clearTimer(chain)
    chains.clear()
    listeners.clear()
  }

  return {
    // 保存一个资源（新草稿会合并/替代同 key 草稿）
    saveResource(resource) {
      const id = String(resource?.id ?? '')
      if (!id) return
      save(id, resource)
    },
    saveLayout(layout) {
      save(LAYOUT_KEY, layout)
    },
    // 从 GET 载入后初始化 base 版本与基线指纹（第三参是基准 DTO）
    loadBase(key, version, payload) {
      loadBase(key, version, payload)
    },
    // 手动重试失败（非冲突失败时）；不给 key → 重试全部 ERROR
    retry(key) {
      retry(key)
    },
    // 冲突处理：{discard:true} 丢弃本地；否则以服务器版本为基准保存最新本地草稿
    resolveConflict(key, options) {
      resolveConflict(key, options)
    },
    // 挂起：禁止新的 outbound，保留草稿，等待已发请求真正 settle
    suspendAndWait() {
      return suspendAndWait()
    },
    // 清空全部链并推进代际（迟到回包不得污染新 base）
    clear() {
      clear()
    },
    // 恢复调度（只恢复正常 pending，不自动重发 ERROR/CONFLICT）
    resume() {
      resume()
    },
    isDirty() {
      for (const chain of chains.values()) {
        if (chain.draft || chain.state === SaveState.PENDING || chain.state === SaveState.SAVING
          || chain.state === SaveState.ERROR || chain.state === SaveState.CONFLICT) return true
      }
      return false
    },
    getStatus(key) {
      const chain = chains.get(normalizeKey(key))
      return chain ? statusOf(chain) : idleStatus()
    },
    // 全部已知 key 的状态表（父的 badge/dirty 订阅用）
    getStatuses() {
      const out = {}
      for (const [key, chain] of chains) out[key] = statusOf(chain)
      return out
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    dispose() { dispose() },
  }
}
