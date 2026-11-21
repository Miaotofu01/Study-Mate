/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半 —— 无界笔记持久化（#268）· 校验与 DTO 契约

   这份文件是 `lib/notes/` 的**纯校验层**：不认识 fs、不认识 sqlite，只回答一个问题——
   「这份 DTO/字节能不能进数据域、哪些字段要被剥掉」。存储与锁在 `store.ts`，HTTP 在
   `route.ts`，三份文件各有各的头注释，别在这里混。

   契约的唯一出处是 ADR-0016（docs/adr/0016-无界笔记持久化与单文件版本栅栏.md）与本文件
   `contracts.ts`（正式 issue #268）；这里不复述产品语义，只把「校验通过」这件事变成可测试的形状。

   几个刻意的口径（照契约，不是随手定的）：
     · ID 小写 ASCII `[a-z0-9-]`、1..96；资源 id 前缀 `r-` 由 store 负责拼文件名，这里只验 id 本身。
     · 自有 note（`type:'note'`）独占 `.md` 文件，媒体/引用等其余类型落在 `.json` 文件里——
       「不支持资源跨物理 kind 变更」说的是这个：一个 id 落过 .md 就不能再存成 .json，反过来也一样。
     · 资源 DTO 只保留白名单字段（`RESOURCE_META_FIELDS`），`markdown`/`html`/`src` 按类型单独放行；
       `refBody` / `canReopen` / 运行时句柄（`fileHandle`/`sourceFile`/`File`）这些**显式拒绝**，
       不静默落成副本——那是两件事，静默转换会让「引用」悄悄变成「副本」。
     · **外部文件引用（origin.kind==='file' && mode==='reference'）一律只存元信息**，与
       `type` 无关：引用一张图片 / 一个 SVG / 一段 HTML 同样不该把原文件内容抄一份进笔记库。
     · layout DTO 只留 `folders/nodes/edges/viewport`，剥掉 `selection`/`measured`/任意 CSS 字段。
     · **超限不静默截断**：用户的纯文本（节点文字、连线标签、标题类字段）超过上限就整条拒绝
       （400），草稿留在客户端；不谎报「保存成功」却把用户的尾巴吃掉。
   ───────────────────────────────────────────────────────────────────────── */

/* ── 体积上限（沿用原型 `client/notes/media.js` 的既有约束，不放宽）───────── */

/** 单次 HTTP 请求体上限（真实 UTF-8 字节数，不信 Content-Length）。 */
export const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
/** 自有 note 正文的字符数上限。 */
export const MAX_NOTE_CHARS = 128 * 1024;
/** 自有 note 文件（含元信息头）的 UTF-8 字节上限。 */
export const MAX_NOTE_BYTES = 512 * 1024;
/** 资源个数上限。 */
export const MAX_RESOURCES = 250;
/** 逻辑目录个数上限。 */
export const MAX_FOLDERS = 80;
/** 画布节点个数上限。 */
export const MAX_NODES = 120;
/** 画布连线条数上限。 */
export const MAX_EDGES = 240;
/** 资源占用的物理存储总上限（约 48 MiB，兼容 base64 扩展）。 */
export const MAX_TOTAL_RESOURCE_BYTES = 48 * 1024 * 1024;
/** 资源元信息类文本字段（title/owner/summary/source）的字符上限。 */
export const MAX_META_TEXT_CHARS = 2000;
/** 画布节点正文（data.text）的字符上限。 */
export const MAX_NODE_TEXT_CHARS = 20_000;
/** 画布连线标签（data.label）的字符上限。 */
export const MAX_EDGE_LABEL_CHARS = 500;

/** 媒体资源的尺寸/体积上限（照 `client/notes/media.js` 的 LIMITS，不放宽）。 */
export const MEDIA_LIMITS = Object.freeze({
  rasterBytes: 4 * 1024 * 1024,
  maxDimension: 8192,
  maxPixels: 16_000_000,
  svgBytes: 512 * 1024,
  svgElements: 2000,
  svgPathChars: 100_000,
  htmlBytes: 256 * 1024,
  htmlElements: 1500,
  htmlDepth: 32,
  svgDepth: 32,
});

/* ── DTO 白名单 ─────────────────────────────────────────────────────────── */

/** 资源元信息允许的字段（不含正文/媒体体，那是按类型单独放行的）。 */
export const RESOURCE_META_FIELDS = Object.freeze([
  'id', 'type', 'title', 'parent', 'owner', 'summary', 'url', 'source', 'origin', 'mime', 'bytes', 'width', 'height',
  'courseRef', 'associations', 'trashed',
]);
/** 自有 note 额外允许的正文字段。 */
export const NOTE_BODY_FIELDS = Object.freeze(['markdown']);
/** 媒体资源额外允许的字段。 */
export const MEDIA_BODY_FIELDS = Object.freeze(['html', 'src']);

/** 资源类型全集。 */
export const RESOURCE_TYPES = Object.freeze(['note', 'course', 'link', 'image', 'svg', 'html']);

/** ID 合法性：小写 ASCII `[a-z0-9-]`，1..96 个字符。 */
const ID_RE = /^[a-z0-9-]{1,96}$/;
/** origin 对象允许的字段（外部引用只保留元信息，不带 markdown/html/src/句柄）。 */
const ORIGIN_FIELDS = Object.freeze(['kind', 'mode', 'name', 'lastModified', 'sourceId']);

/* ── 校验结果的形状：要么 ok，要么一条给人看的中文原因 ───────────────────── */

export interface CheckOk { ok: true }
export interface CheckFail { ok: false; message: string }
/** 布局校验结果的形状（要么 ok，要么一条给人看的中文原因）。 */
export type Check = CheckOk | CheckFail;

/** 课程关联里的稳定身份：workspace + subject +（可选）node；title 只用于显示，绝不参与匹配。 */
interface CourseRef { workspace: string; subject: string; node?: string; title?: string }
interface SubjectRef { workspace: string; subject: string; title?: string }

/** 关联数组上限（资源课程关联、笔记本绑定、默认科目共用）。 */
export const MAX_ASSOCIATIONS = 32;
/** 课程/科目标识的显示名上限；workspace 与 title 沿用 MAX_META_TEXT_CHARS。 */
export const MAX_SCOPE_TEXT_CHARS = 200;

const ok: Check = { ok: true };
const fail = (message: string): Check => ({ ok: false, message });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 课程/科目身份的闭口校验：显示名只用于 UI，不参与身份匹配；不截断、不猜同名课程。
 * `subjectOnly` 用于笔记本绑定（没有 node 字段）。
 */
function checkCourseRef(raw: unknown, subjectOnly = false): { ok: true; value: CourseRef } | CheckFail {
  if (!isPlainObject(raw)) return { ok: false, message: '课程来源必须是对象。' };
  const allowed = subjectOnly ? ['workspace', 'subject', 'title'] : ['workspace', 'subject', 'node', 'title'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return { ok: false, message: `课程来源不能带字段「${key}」。` };
  }
  const fields: Array<[keyof CourseRef, number, boolean]> = subjectOnly
    ? [['workspace', MAX_META_TEXT_CHARS, true], ['subject', MAX_SCOPE_TEXT_CHARS, true]]
    : [['workspace', MAX_META_TEXT_CHARS, true], ['subject', MAX_SCOPE_TEXT_CHARS, true], ['node', MAX_SCOPE_TEXT_CHARS, true]];
  const value: CourseRef = { workspace: '', subject: '' };
  for (const [key, limit, required] of fields) {
    const field = raw[key];
    if (typeof field !== 'string' || !field.trim() || [...field].length > limit) {
      return { ok: false, message: `课程来源 ${key} 必须是非空且不超过 ${limit} 字符的字符串。` };
    }
    value[key] = field;
  }
  if ('title' in raw) {
    const title = raw.title;
    if (typeof title !== 'string' || [...title].length > MAX_META_TEXT_CHARS) {
      return { ok: false, message: `课程来源 title 必须是不超过 ${MAX_META_TEXT_CHARS} 字符的字符串。` };
    }
    value.title = title;
  }
  return { ok: true, value };
}

/** 资源关联数组：<=32，按 workspace+subject 去重，不按 title 匹配。 */
function checkAssociations(raw: unknown): { ok: true; value: CourseRef[] } | CheckFail {
  if (!Array.isArray(raw)) return { ok: false, message: 'associations 必须是数组。' };
  if (raw.length > MAX_ASSOCIATIONS) return { ok: false, message: `associations 不能超过 ${MAX_ASSOCIATIONS} 项。` };
  const value: CourseRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const check = checkCourseRef(item);
    if (!check.ok) return check;
    const key = JSON.stringify([check.value.workspace, check.value.subject]);
    if (seen.has(key)) return { ok: false, message: '同一科目的笔记只能关联一个课程节点。' };
    seen.add(key);
    value.push(check.value);
  }
  return { ok: true, value };
}

/** 笔记本科目绑定数组：<=32，按 workspace+subject 去重。 */
function checkSubjectRefs(raw: unknown, field: string): { ok: true; value: SubjectRef[] } | CheckFail {
  if (!Array.isArray(raw)) return { ok: false, message: `${field} 必须是数组。` };
  if (raw.length > MAX_ASSOCIATIONS) return { ok: false, message: `${field} 不能超过 ${MAX_ASSOCIATIONS} 项。` };
  const value: SubjectRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const check = checkCourseRef(item, true);
    if (!check.ok) return check;
    const { workspace, subject, title } = check.value;
    const ref: SubjectRef = { workspace, subject };
    if (title !== undefined) ref.title = title;
    const key = subjectKey(ref);
    if (seen.has(key)) return { ok: false, message: `${field} 有重复科目。` };
    seen.add(key);
    value.push(ref);
  }
  return { ok: true, value };
}

function subjectKey(ref: SubjectRef): string {
  return JSON.stringify([ref.workspace, ref.subject]);
}

/** 笔记本独立视口：闭口对象，有限数；非法值拒绝，不静默归零。 */
function checkFolderViewport(raw: unknown): { ok: true; value: { x: number; y: number; zoom: number } } | CheckFail {
  if (!isPlainObject(raw)) return { ok: false, message: '目录 viewport 必须是对象。' };
  for (const key of Object.keys(raw)) {
    if (!['x', 'y', 'zoom'].includes(key)) return { ok: false, message: `目录 viewport 不能带字段「${key}」。` };
  }
  if (!finiteNumber(raw.x, -1e6, 1e6) || !finiteNumber(raw.y, -1e6, 1e6) || !finiteNumber(raw.zoom, 0.01, 10)) {
    return { ok: false, message: '目录 viewport 的 x/y/zoom 必须是合法有限数。' };
  }
  return { ok: true, value: { x: raw.x, y: raw.y, zoom: raw.zoom } };
}

export function isResourceId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** 有限数：拒绝 NaN/Infinity/超大绝对值（几何/像素/字节都走这里）。 */
function finiteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** URI：只收 http(s)，这是 `link` 资源唯一允许的协议（照原型安全口径）。 */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.href;
}

/* ── 物理 kind 判定（唯一入口） ───────────────────────────────────────────── */

/**
 * 物理文件 kind：
 *  - **外部文件引用**（`origin.kind==='file' && mode==='reference'`，与 type 无关）→
 *    只存 metadata → `.json`；
 *  - 自有 note（`type==='note'` 且不是引用）→ `.md` 单份权威 Markdown；
 *  - 其余类型（course/link/image/svg/html）→ `.json`。
 */
export function physicalKindOf(resource: { type?: unknown; origin?: unknown }): 'md' | 'json' {
  if (isFileReference(resource)) return 'json';
  return resource.type === 'note' ? 'md' : 'json';
}

/**
 * 是否**外部文件引用**：判据只看 origin（`kind==='file' && mode==='reference'`），
 * **不限 type**——引用一张图片、一个 SVG、一段 HTML 同样只存元信息，
 * 不把原文件内容抄一份进笔记库（抄一份就等于把「引用」变成「副本」）。
 */
export function isFileReference(resource: { type?: unknown; origin?: unknown }): boolean {
  const origin = (resource as { origin?: unknown }).origin;
  if (!isPlainObject(origin)) return false;
  return origin.kind === 'file' && origin.mode === 'reference';
}

/* ── 资源校验 ───────────────────────────────────────────────────────────── */

/**
 * 校验并**归一化**一个资源 DTO：剥掉白名单外的字段，拒绝 `refBody`/`canReopen`/运行时句柄，
 * 按类型放行正文/媒体体。返回的 `{ok:true, value}` 是已经准备好写盘的形状。
 */
export function checkResource(input: unknown): { ok: true; value: Record<string, unknown> } | CheckFail {
  if (!isPlainObject(input)) return { ok: false, message: '资源必须是 JSON 对象。' };
  if (!isResourceId(input.id)) return { ok: false, message: '资源 id 必须是小写字母、数字或连字符，1..96 个字符。' };
  const type = input.type;
  if (typeof type !== 'string' || !RESOURCE_TYPES.includes(type)) {
    return { ok: false, message: '资源 type 不合法：只支持 note / course / link / image / svg / html。' };
  }

  // 显式拒绝：引用正文、可重开标记、运行时句柄——不静默落成副本。
  for (const key of ['refBody', 'canReopen', 'fileHandle', 'sourceFile']) {
    if (key in input) return { ok: false, message: `资源不能带运行时字段「${key}」：引用只保留元信息，不落正文/句柄。` };
  }

  // 外部文件引用判据唯一入口：origin.kind==='file' && mode==='reference'，
  // **与 type 无关**——引用一张图片 / 一个 SVG / 一段 HTML 同样只存 metadata（.json），
  // 不带 markdown/html/src；其余 note 走 .md 单份权威 Markdown。
  const fileReference = isFileReference(input as { type?: unknown; origin?: unknown });

  const value: Record<string, unknown> = { id: input.id, type };
  for (const key of RESOURCE_META_FIELDS) {
    if (key === 'id' || key === 'type') continue;
    if (!(key in input)) continue;
    const raw = (input as Record<string, unknown>)[key];
    switch (key) {
      case 'title':
      case 'owner':
      case 'summary':
      case 'source':
        // 超限**拒绝**，不静默截断：截断会吃掉用户写的尾巴，还报「保存成功」。
        if (typeof raw !== 'string') return { ok: false, message: `资源「${key}」要是字符串。` };
        if ([...raw].length > MAX_META_TEXT_CHARS) {
          return { ok: false, message: `资源「${key}」超过 ${MAX_META_TEXT_CHARS} 字符上限，请缩短后再保存。` };
        }
        value[key] = raw;
        break;
      case 'parent':
        if (raw !== null && !isResourceId(raw)) return { ok: false, message: '资源 parent 必须是合法的目录 id 或 null。' };
        value[key] = raw;
        break;
      case 'url':
        if (!isHttpUrl(raw)) return { ok: false, message: '资源 url 只支持 http(s) 地址。' };
        value[key] = raw;
        break;
      case 'mime':
        if (typeof raw !== 'string' || raw.length > 200) return { ok: false, message: '资源 mime 非法。' };
        value[key] = raw;
        break;
      case 'bytes':
        if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > MAX_TOTAL_RESOURCE_BYTES) {
          return { ok: false, message: '资源 bytes 必须是非负整数。' };
        }
        value[key] = raw;
        break;
      case 'width':
      case 'height':
        if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > MEDIA_LIMITS.maxDimension) {
          return { ok: false, message: `资源「${key}」必须是 0..${MEDIA_LIMITS.maxDimension} 的整数。` };
        }
        value[key] = raw;
        break;
      case 'origin': {
        const check = checkOrigin(raw);
        if (!check.ok) return check;
        value[key] = check.value;
        break;
      }
      case 'courseRef': {
        // courseRef 是课程卡的稳定身份元信息；外部文件引用也只允许存这类元信息，
        // 不存正文/句柄。判据只看 type，不看 fileReference。
        if (type !== 'course') return { ok: false, message: '只有课程卡能有 courseRef。' };
        const check = checkCourseRef(raw);
        if (!check.ok) return check;
        value[key] = check.value;
        break;
      }
      case 'associations': {
        if (type !== 'note' || fileReference) return { ok: false, message: '只有自有笔记能有课程关联。' };
        const check = checkAssociations(raw);
        if (!check.ok) return check;
        value[key] = check.value;
        break;
      }
      case 'trashed': {
        if (typeof raw !== 'boolean') return { ok: false, message: '资源 trashed 必须是布尔值。' };
        value[key] = raw;
        break;
      }
      default:
        break;
    }
  }

  // 按类型放行正文/媒体体。
  if (fileReference) {
    // 外部文件引用（任何 type）：只存元信息，markdown/html/src 一律拒绝
    // （重载后失效由前端提示；把原文件抄一份进来就等于把「引用」变成「副本」）。
    for (const key of ['markdown', 'html', 'src']) {
      if (key in (input as Record<string, unknown>)) {
        return { ok: false, message: `外部文件引用「${input.id}」只保留元信息，不能带「${key}」。` };
      }
    }
  } else if (type === 'note') {
    const markdown = (input as Record<string, unknown>).markdown;
    if (typeof markdown !== 'string') return { ok: false, message: '自有笔记必须带字符串 markdown。' };
    const chars = [...markdown].length;
    if (chars > MAX_NOTE_CHARS) return { ok: false, message: `笔记正文超过 ${MAX_NOTE_CHARS} 字符上限。` };
    const bytes = Buffer.byteLength(markdown, 'utf8');
    if (bytes > MAX_NOTE_BYTES) return { ok: false, message: `笔记正文 UTF-8 超过 ${MAX_NOTE_BYTES} 字节上限。` };
    value.markdown = markdown;
  } else if (type === 'image' || type === 'svg' || type === 'html') {
    const check = checkMediaBody(type, input as Record<string, unknown>);
    if (!check.ok) return check;
    Object.assign(value, check.value);
  } else if ('markdown' in (input as Record<string, unknown>) || 'html' in (input as Record<string, unknown>) || 'src' in (input as Record<string, unknown>)) {
    return { ok: false, message: `「${type}」资源不允许带正文/媒体字段。` };
  }

  // link / course：只留元信息，url/summary 已在上面放行。
  return { ok: true, value };
}

function checkOrigin(raw: unknown): { ok: true; value: Record<string, unknown> } | CheckFail {
  if (!isPlainObject(raw)) return { ok: false, message: '资源 origin 必须是对象。' };
  // 显式拒绝 canReopen（哪怕是 false）：它是会话内的句柄能力标记，
  // 落盘就等于宣称「重载后还能重开原文件」，那是假的。
  if ('canReopen' in raw) {
    return { ok: false, message: '资源 origin 不能带 canReopen：引用重载后必然失效，请重新选择原文件。' };
  }
  // 一次性校验：origin 里所有值必须是标量（字符串/数字/布尔/null），
  // 任何嵌套对象/数组都拒绝——防止把 canReopen/refBody/句柄藏进深层字段带过白名单。
  for (const [key, val] of Object.entries(raw)) {
    if (val !== null && typeof val === 'object') {
      return { ok: false, message: `资源 origin.${key} 只能是标量，不接受嵌套对象/数组。` };
    }
  }
  const value: Record<string, unknown> = {};
  for (const key of ORIGIN_FIELDS) {
    if (!(key in raw)) continue;
    const field = raw[key];
    if (key === 'kind' || key === 'mode' || key === 'name') {
      if (typeof field !== 'string') return { ok: false, message: `资源 origin.${key} 要是字符串。` };
      if (field.length > 2000) return { ok: false, message: `资源 origin.${key} 超过 2000 字符上限，拒绝截断。` };
      value[key] = field;
    } else if (key === 'lastModified') {
      if (!Number.isSafeInteger(field) || (field as number) < 0) return { ok: false, message: '资源 origin.lastModified 非法。' };
      value[key] = field;
    } else if (key === 'sourceId') {
      if (!isResourceId(field)) return { ok: false, message: '资源 origin.sourceId 非法。' };
      value[key] = field;
    }
  }
  return { ok: true, value };
}

function checkMediaBody(type: string, input: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | CheckFail {
  const value: Record<string, unknown> = {};
  if (type === 'image') {
    const src = input.src;
    if (typeof src !== 'string') return { ok: false, message: '图片资源必须带 src。' };
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(src);
    if (!match) return { ok: false, message: '图片 src 只接受 png/jpeg/webp 的 dataURL。' };
    const base64 = match[2];
    // 严格 base64：长度必须是 4 的倍数，padding 只能是末尾的 1 或 2 个 '='。
    // 之前用 `len*3/4` 估算，把 padding 也算成了数据，会让**恰好 4 MiB** 的合法 PNG
    // （base64 末尾带 '='）被算成 4 MiB + 2 而误拒——那是在拒绝一张完全合法的图。
    if (base64.length % 4 !== 0) return { ok: false, message: '图片 src 的 base64 长度不合法。' };
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    const body = base64.slice(0, base64.length - padding);
    if (body.length % 4 === 1) return { ok: false, message: '图片 src 的 base64 长度不合法。' };
    // 真实解码字节数 = 3 * (len/4) - padding。
    const declaredBytes = (base64.length / 4) * 3 - padding;
    if (declaredBytes > MEDIA_LIMITS.rasterBytes) return { ok: false, message: `图片 src 超过 ${MEDIA_LIMITS.rasterBytes} 字节上限。` };
    value.src = src;
  } else {
    const html = input.html;
    if (typeof html !== 'string') return { ok: false, message: `${type} 资源必须带 html。` };
    const bytes = Buffer.byteLength(html, 'utf8');
    const cap = type === 'svg' ? MEDIA_LIMITS.svgBytes : MEDIA_LIMITS.htmlBytes;
    if (bytes > cap) return { ok: false, message: `${type} 的 html 超过 ${cap} 字节上限。` };
    value.html = html;
  }
  return { ok: true, value };
}

/* ── 布局校验 ───────────────────────────────────────────────────────────── */

const FOLDER_KINDS = Object.freeze(['folder', 'notebook']);
/** 画布节点类型的封闭集合（只有内容卡与纯文本卡两种）。 */
const NODE_TYPES = Object.freeze(['knowledge', 'text']);

export interface LayoutFolders {
  id: string;
  parent: string | null;
  name: string;
  kind?: string;
  bindings?: SubjectRef[];
  defaultForSubjects?: SubjectRef[];
  viewport?: { x: number; y: number; zoom: number };
}

/**
 * 校验并归一化 layout DTO：只留 `{folders,nodes,edges,viewport}`，剥掉
 * `selection`/`measurement`/任意 CSS 字段；有限几何、目录防环、重复 id、非法边都要拒绝。
 */
export function checkLayout(input: unknown): { ok: true; value: Record<string, unknown> } | CheckFail {
  if (!isPlainObject(input)) return { ok: false, message: '布局必须是 JSON 对象。' };
  for (const key of ['selection', 'measurements', 'measurement', 'css', 'styles']) {
    if (key in input) return { ok: false, message: `布局不能带字段「${key}」。` };
  }

  const rawFolders = input.folders ?? [];
  const rawNodes = input.nodes ?? [];
  const rawEdges = input.edges ?? [];
  const rawViewport = input.viewport ?? { x: 0, y: 0, zoom: 1 };
  if (!Array.isArray(rawFolders)) return { ok: false, message: '布局 folders 必须是数组。' };
  if (!Array.isArray(rawNodes)) return { ok: false, message: '布局 nodes 必须是数组。' };
  if (!Array.isArray(rawEdges)) return { ok: false, message: '布局 edges 必须是数组。' };
  if (!isPlainObject(rawViewport)) return { ok: false, message: '布局 viewport 必须是对象。' };

  if (rawFolders.length > MAX_FOLDERS) return { ok: false, message: `目录数量超过 ${MAX_FOLDERS} 上限。` };
  if (rawNodes.length > MAX_NODES) return { ok: false, message: `节点数量超过 ${MAX_NODES} 上限。` };
  if (rawEdges.length > MAX_EDGES) return { ok: false, message: `连线数量超过 ${MAX_EDGES} 上限。` };

  // folders
  const folderIds = new Set<string>();
  const folders: LayoutFolders[] = [];
  for (const raw of rawFolders) {
    if (!isPlainObject(raw)) return { ok: false, message: '目录必须是对象。' };
    const id = raw.id;
    if (!isResourceId(id)) return { ok: false, message: '目录 id 非法。' };
    if (folderIds.has(id)) return { ok: false, message: `目录 id 重复：${id}。` };
    folderIds.add(id);
    const parent = raw.parent ?? null;
    if (parent !== null && !isResourceId(parent)) return { ok: false, message: `目录「${id}」的 parent 非法。` };
    const name = raw.name;
    if (typeof name !== 'string' || name.length > 200) return { ok: false, message: `目录「${id}」的 name 非法。` };
    const kind = raw.kind;
    if (kind !== undefined && (typeof kind !== 'string' || !FOLDER_KINDS.includes(kind))) {
      return { ok: false, message: `目录「${id}」的 kind 非法。` };
    }
    const notebookFields = ['bindings', 'defaultForSubjects', 'viewport', 'binding', 'defaultForSubject'];
    for (const key of notebookFields) {
      if (!(key in raw)) continue;
      if (kind !== 'notebook') return { ok: false, message: `只有笔记本目录能有「${key}」。` };
      // 旧单值字段不能静默剥掉：静默丢弃会让「首次选择」把已有绑定抹没。
      if (key === 'binding' || key === 'defaultForSubject') {
        return { ok: false, message: `目录「${id}」的「${key}」已废弃，请改用 bindings / defaultForSubjects 数组。` };
      }
    }
    const folder: LayoutFolders = kind === undefined ? { id, parent, name } : { id, parent, name, kind };
    if ('bindings' in raw) {
      const check = checkSubjectRefs(raw.bindings, 'bindings');
      if (!check.ok) return check;
      folder.bindings = check.value;
    }
    if ('defaultForSubjects' in raw) {
      const check = checkSubjectRefs(raw.defaultForSubjects, 'defaultForSubjects');
      if (!check.ok) return check;
      folder.defaultForSubjects = check.value;
    }
    if ('viewport' in raw) {
      const check = checkFolderViewport(raw.viewport);
      if (!check.ok) return check;
      folder.viewport = check.value;
    }
    if (folder.defaultForSubjects?.some((ref) => !folder.bindings?.some((binding) => subjectKey(binding) === subjectKey(ref)))) {
      return { ok: false, message: `目录「${id}」的默认科目必须先出现在本笔记本的 bindings 里。` };
    }
    folders.push(folder);
  }
  const defaults = folders.flatMap((folder) => folder.defaultForSubjects ?? []);
  if (new Set(defaults.map(subjectKey)).size !== defaults.length) {
    return { ok: false, message: '同一科目只能有一个默认笔记本。' };
  }
  for (const folder of folders) {
    if (folder.parent === null) continue;
    if (!folderIds.has(folder.parent)) return { ok: false, message: `目录「${folder.id}」的 parent「${folder.parent}」不存在。` };
    let walk: string | null = folder.parent;
    const seen = new Set<string>([folder.id]);
    while (walk !== null) {
      if (seen.has(walk)) return { ok: false, message: `目录「${folder.id}」的父子关系成环。` };
      seen.add(walk);
      walk = folders.find((item) => item.id === walk)?.parent ?? null;
    }
  }

  // nodes
  const nodeIds = new Set<string>();
  const nodes: Record<string, unknown>[] = [];
  for (const raw of rawNodes) {
    if (!isPlainObject(raw)) return { ok: false, message: '节点必须是对象。' };
    const id = raw.id;
    if (!isResourceId(id)) return { ok: false, message: '节点 id 非法。' };
    if (nodeIds.has(id)) return { ok: false, message: `节点 id 重复：${id}。` };
    nodeIds.add(id);
    const type = raw.type;
    // 节点类型是**封闭集合**：只有 knowledge（内容卡）与 text（纯文本卡）。
    // 放开成任意字符串会让不认识的节点静默进库，渲染时落成空白卡片。
    if (typeof type !== 'string' || !NODE_TYPES.includes(type)) {
      return { ok: false, message: `节点「${id}」的 type 只能是 ${NODE_TYPES.join(' / ')}。` };
    }
    const position = raw.position;
    if (!isPlainObject(position) || !finiteNumber(position.x, -1e6, 1e6) || !finiteNumber(position.y, -1e6, 1e6)) {
      return { ok: false, message: `节点「${id}」的 position 非法。` };
    }
    const styleRaw = raw.style ?? {};
    if (!isPlainObject(styleRaw)) return { ok: false, message: `节点「${id}」的 style 非法。` };
    const style: Record<string, number> = {};
    for (const key of ['width', 'height']) {
      const val = styleRaw[key];
      if (val === undefined) continue;
      if (!finiteNumber(val, 1, 100000)) return { ok: false, message: `节点「${id}」的 style.${key} 非法。` };
      style[key] = val;
    }
    const dataRaw = raw.data ?? {};
    if (!isPlainObject(dataRaw)) return { ok: false, message: `节点「${id}」的 data 非法。` };
    const data: Record<string, unknown> = {};
    if ('contentId' in dataRaw) {
      const contentId = dataRaw.contentId;
      // knowledge 卡片必须挂一个真实内容 id；纯文本卡可以没有（contentId 为 null 时剥掉）。
      if (contentId === null) {
        if (type === 'knowledge') return { ok: false, message: `节点「${id}」是内容卡，必须有 data.contentId。` };
      } else {
        if (!isResourceId(contentId)) return { ok: false, message: `节点「${id}」的 data.contentId 非法。` };
        data.contentId = contentId;
      }
    } else if (type === 'knowledge') {
      return { ok: false, message: `节点「${id}」是内容卡，必须有 data.contentId。` };
    }
    if ('text' in dataRaw) {
      const text = dataRaw.text;
      if (typeof text !== 'string') return { ok: false, message: `节点「${id}」的 data.text 非法。` };
      // 超限**拒绝**，不静默截断（截断会吃掉用户写的尾巴还报「保存成功」）。
      if ([...text].length > MAX_NODE_TEXT_CHARS) {
        return { ok: false, message: `节点「${id}」的文字超过 ${MAX_NODE_TEXT_CHARS} 字符上限，请缩短后再保存。` };
      }
      data.text = text;
    }
    if ('collapsed' in dataRaw) {
      if (typeof dataRaw.collapsed !== 'boolean') return { ok: false, message: `节点「${id}」的 data.collapsed 非法。` };
      data.collapsed = dataRaw.collapsed;
    }
    if ('expandedHeight' in dataRaw) {
      const height = dataRaw.expandedHeight;
      if (!finiteNumber(height, 1, 100000)) return { ok: false, message: `节点「${id}」的 data.expandedHeight 非法。` };
      data.expandedHeight = height;
    }
    if ('notebookId' in dataRaw) {
      if (!isResourceId(dataRaw.notebookId)) return { ok: false, message: `节点「${id}」的 data.notebookId 非法。` };
      const notebook = folders.find((folder) => folder.id === dataRaw.notebookId);
      if (!notebook || notebook.kind !== 'notebook') {
        return { ok: false, message: `节点「${id}」的 data.notebookId 指向不存在的笔记本。` };
      }
      data.notebookId = dataRaw.notebookId;
    }
    // 旧布局里没有 notebookId 的节点保持原样：既不强转，也不丢弃。
    nodes.push({ id, type, position: { x: position.x, y: position.y }, style, data });
  }

  // edges
  const edgeIds = new Set<string>();
  const edges: Record<string, unknown>[] = [];
  for (const raw of rawEdges) {
    if (!isPlainObject(raw)) return { ok: false, message: '连线必须是对象。' };
    const id = raw.id;
    if (!isResourceId(id)) return { ok: false, message: '连线 id 非法。' };
    if (edgeIds.has(id)) return { ok: false, message: `连线 id 重复：${id}。` };
    edgeIds.add(id);
    const source = raw.source;
    const target = raw.target;
    if (!isResourceId(source) || !isResourceId(target)) return { ok: false, message: `连线「${id}」的 source/target 非法。` };
    if (source === target) return { ok: false, message: `连线「${id}」不能连接到自身。` };
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      // 缺失资源的稳定引用可以保留，但缺失**节点**的边没法画，拒绝。
      return { ok: false, message: `连线「${id}」引用了不存在的节点。` };
    }
    const type = raw.type;
    if (type !== 'relation') return { ok: false, message: `连线「${id}」的 type 必须是 relation。` };
    const edge: Record<string, unknown> = { id, source, target, type };
    for (const key of ['sourceHandle', 'targetHandle']) {
      const val = raw[key];
      if (val === undefined) continue;
      if (typeof val !== 'string' || val.length > 96) return { ok: false, message: `连线「${id}」的 ${key} 非法。` };
      edge[key] = val;
    }
    const dataRaw = raw.data ?? {};
    if (!isPlainObject(dataRaw)) return { ok: false, message: `连线「${id}」的 data 非法。` };
    const label = dataRaw.label;
    if (typeof label !== 'string') return { ok: false, message: `连线「${id}」的 data.label 非法。` };
    // 超限**拒绝**，不静默截断（标签是用户写的字，截断了还报「保存成功」是骗人）。
    if ([...label].length > MAX_EDGE_LABEL_CHARS) {
      return { ok: false, message: `连线「${id}」的标签超过 ${MAX_EDGE_LABEL_CHARS} 字符上限，请缩短后再保存。` };
    }
    edge.data = { label };
    edges.push(edge);
  }

  // viewport
  const viewport = {
    x: finiteNumber(rawViewport.x, -1e6, 1e6) ? rawViewport.x : 0,
    y: finiteNumber(rawViewport.y, -1e6, 1e6) ? rawViewport.y : 0,
    zoom: finiteNumber(rawViewport.zoom, 0.01, 10) ? rawViewport.zoom : 1,
  };

  return { ok: true, value: { folders, nodes, edges, viewport } };
}
