/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半 —— 无界笔记持久化（#268）· 存储与锁

   这份文件回答「笔记数据域在盘上长什么样、怎么安全地写进去」。校验在 `contracts.ts`，
   HTTP 在 `route.ts`。契约的唯一出处是
   [ADR-0016](../../docs/adr/0016-无界笔记持久化与单文件版本栅栏.md)（数据域形状、版本栅栏、
   跨进程锁的决策都在那里）与 `contracts.ts`（DTO 白名单与上限）。

   目录形状（可信根 = `profileContext.home`，全 DSH 根，不是 cwd/学习工作区）：

     <home>/studymate-notes/
     ├── _format.json          {"format":"studymate-notes","version":2}（v1 只读，显式升级后写 v2）
     ├── layout.json           {folders,nodes,edges,viewport} —— 只有布局，不含正文
     ├── notes.lock.db         SQLite 文件：**只当跨进程锁用**，不存任何笔记内容
     └── resources/
        ├── r-<id>.md         自有 note 的单份权威 Markdown（带元信息头，见下）
        └── r-<id>.json       其余类型资源（course/link/image/svg/html/外部文件引用）

   自有 note（`r-<id>.md`）的文件格式只有开头 3 行是元信息头：

     ---
     studymate_notes: <单行 JSON 元信息>
     ---
     <原正文>

   解析时**只认开头这 3 行**（行尾容忍 CRLF），正文里出现的 `---` 不会把文件误切开
   （守卫见 `parseNoteFile`），正文本身**原样保留**（不规范化换行）。头缺失/损坏时
   明确报错，不猜元信息——猜错比报错难查。

   几条硬口径（都是踩过的坑，别回退）：
     · **读不创建**：GET 不建目录、不写格式标记；缺 marker 时只认空域、确切锁产物与
       本程序保留名的普通单链接 temp。其它陌生内容拒绝认领，清理只能在 OS 写锁内进行。
     · **坏即闭锁**：marker/layout/资源任一损坏或不认识 → 整个读取失败，绝不把损坏的
       layout 当成 `null` 让前端随后用空布局覆盖回去。
     · **版本按原始字节**：SHA256 一律对**文件原始 bytes** 计算，绝不 decode→re-encode
       （非法 UTF-8 文件会被 decode 换掉字符，导致版本永远对不上）。
     · **锁文件也查路径安全**：`notes.lock.db` 及其 `-journal`/`-wal`/`-shm` 一律 lstat，
       symlink/非普通文件/硬链接一律拒绝（SQLite 会跟随 symlink 打开目标）。
     · **锁内重扫**：资源个数、物理 kind、字节预算都在 SQLite 临界区内重新扫描，
       不靠临界区外的旧快照。

   并发：`node:sqlite` 的 `DatabaseSync` + `BEGIN IMMEDIATE` 提供 OS 级跨进程写锁；
   SQLite 里**只有一张无业务的 `lock_anchor` 表**，不存笔记内容。锁内是短同步 fs 临界区
   （重读文件→校验版本→临时文件 fsync→再核版本→rename），**绝不 await 异步文件操作**。
   `finally` 里 COMMIT/ROLLBACK/close，进程崩溃时 OS 自动放掉 SQLite 锁。

   原子发布：同目录随机 temp 文件 `open('wx')` → `writeFileSync` → `fsync` → `close` →
   **核对目标期望版本** → `rename` → 目录 fsync（Windows 不支持时明确降级）。
   rename 前失败保留旧目标、清 temp；rename 后同步失败则目标可能已更新，必须重新读取。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  MAX_META_TEXT_CHARS,
  MAX_NOTE_BYTES,
  MAX_NOTE_CHARS,
  MAX_REQUEST_BYTES,
  MAX_RESOURCES,
  MAX_TOTAL_RESOURCE_BYTES,
  RESOURCE_TYPES,
  checkLayout,
  checkResource,
  physicalKindOf,
} from './contracts.ts';

/* ── 数据域目录与格式标记 ───────────────────────────────────────────────── */

const STORE_DIR_NAME = 'studymate-notes';
const FORMAT_FILE = '_format.json';
const LAYOUT_FILE = 'layout.json';
const LOCK_DB_FILE = 'notes.lock.db';
const RESOURCES_DIR = 'resources';
const FORMAT_TOKEN = { format: 'studymate-notes', version: 2 };
const CURRENT_FORMAT_VERSION = 2;
const LEGACY_FORMAT_VERSION = 1;

/** 一次读/写的结果回执：失败一律带 `status`（HTTP 层直接用它）与 `code`/`message`。 */
export interface NotesStoreOk<T> { ok: true; status: number; value: T }
export interface NotesStoreFail { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown> }
export type NotesStoreResult<T> = NotesStoreOk<T> | NotesStoreFail;

const ok = <T>(value: T, status = 200): NotesStoreOk<T> => ({ ok: true, status, value });
const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>): NotesStoreFail =>
  ({ ok: false, status, code, message, ...(extra ? { extra } : {}) });

export function sha256Of(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 数据域根目录：`<home>/studymate-notes/`。`home` 是可信根（profileContext.home）。
 *
 * `home` 必须是**绝对路径**：相对路径会被 `path.join` 落到进程 cwd 底下，
 * 于是「笔记数据域」悄悄变成某个工作目录里的子目录——换台机器/换个 cwd 就不是同一份数据。
 * 空白串同理。校验放在这里（唯一入口），路由层也各自再挡一道。
 */
export function notesRoot(home: string): string {
  return path.join(home, STORE_DIR_NAME);
}

/**
 * 可信根合法性：非空、无空白、**绝对路径**。
 * 不合法时数据域根本不该被定位（更不该在 cwd 下建出来）。
 */
export function isValidNotesHome(home: unknown): home is string {
  if (typeof home !== 'string') return false;
  const trimmed = home.trim();
  if (trimmed.length === 0) return false;
  if (!path.isAbsolute(trimmed)) return false;
  // Windows 上 `C:\x` 合法；纯盘符 `C:` 不是绝对路径，isAbsolute 已排除。
  return true;
}

/**
 * 对外的 `storeId`：**不泄露本机绝对路径**。取根路径的 SHA256 前 16 位十六进制，
   外面包一层固定前缀。客户端只把它当「这是哪一份数据域」的不透明标识，不当路径用。
 */
export function storeIdOf(root: string): string {
  return `notes-${sha256Of(path.resolve(root)).slice(0, 16)}`;
}

function resourcesDir(root: string): string {
  return path.join(root, RESOURCES_DIR);
}

/**
 * 资源文件路径：`r-<id>.md`（自有 note）或 `r-<id>.json`（其余类型）。
 * `r-` 前缀避开 Windows 设备名；id 里的字符已由 `isResourceId` 限制在 `[a-z0-9-]`，
 * 不会有路径分隔符/点号，天然不会越出 `resources/`。
 */
function resourceFile(root: string, id: string, kind: 'md' | 'json'): string {
  return path.join(resourcesDir(root), `r-${id}.${kind}`);
}

/** 资源文件名的唯一判据（读、写、预算三处共用一份）。 */
const RESOURCE_FILE_RE = /^r-([a-z0-9-]{1,96})\.(md|json)$/;

/* ── UTF-8 严格解码：非法字节一律报错，不替换字符 ───────────────────────── */

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function shapeError(message: string): Error {
  return Object.assign(new Error(message), { code: 'file-shape-unknown' });
}

/** 严格 UTF-8 解码：非法字节序列直接报错，绝不静默变 U+FFFD。 */
function decodeUtf8Strict(buffer: Buffer, what = '文件'): string {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw shapeError(`${what} 不是合法的 UTF-8 文本，拒绝静默替换字符。`);
  }
}

/* ── 路径安全：symlink / reparse / 非普通文件一律拒绝 ─────────────────────── */

/** 路径包含判据（Windows 上大小写不敏感，与 `lib/paths.ts` 的口径一致）。 */
function isInsideRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * 校验一个路径在数据域内的每一级都是**真实存在的普通目录/文件**，且不是
 * symlink/reparse point。只向上核到数据域根为止（根以上的祖先目录不归我们管——
 * DSH home 本身可能在 junction 上，那不该让整份笔记不可用）。
 */
function assertSafePath(target: string, mode: 'dir' | 'file' | 'any', root: string): void {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(target);
  if (!isInsideRoot(current, resolvedRoot)) {
    throw Object.assign(new Error('路径越出数据域。'), { code: 'path-invalid' });
  }
  // 逐级往上核：每一级都必须是真实目录（不是 symlink），最终一级按 mode 判。
  const chain: string[] = [];
  let cursor = current;
  for (let depth = 0; depth < 64; depth += 1) {
    chain.push(cursor);
    if (cursor === resolvedRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const node of chain) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(node);
    } catch (error) {
      // 允许「还不存在」的最终一级（写入前的 temp 文件），其余必须存在。
      if (node === current && mode !== 'dir' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw Object.assign(new Error(`路径不存在或不可访问：${path.basename(node)}`), { code: 'path-invalid', cause: error });
    }
    if (stat.isSymbolicLink()) {
      throw Object.assign(new Error(`检测到符号链接，拒绝访问：${path.basename(node)}`), { code: 'path-invalid' });
    }
    // Windows 上 lstat 对 reparse point 也会给 isSymbolicLink/isDirectory 之外的特征；
    // 用 nlink/isFile 兜一层：非普通文件（FIFO/socket/设备）一律拒。
    const isFinal = node === current;
    if (isFinal) {
      if (mode === 'dir' && !stat.isDirectory()) {
        throw Object.assign(new Error('数据域路径不是目录。'), { code: 'path-invalid' });
      }
      if (mode === 'file' && !stat.isFile()) {
        throw Object.assign(new Error('数据域路径不是普通文件。'), { code: 'path-invalid' });
      }
      if (mode === 'any' && !stat.isDirectory() && !stat.isFile()) {
        throw Object.assign(new Error('数据域路径不是普通文件或目录。'), { code: 'path-invalid' });
      }
    } else if (!stat.isDirectory()) {
      throw Object.assign(new Error(`路径上级不是目录：${path.basename(node)}`), { code: 'path-invalid' });
    }
  }
}

/**
 * 可选文件的安全检查：文件**不存在**时放行（由调用方决定是否创建），
 * 存在时必须是普通文件、非 symlink、非硬链接（nlink>1 意味着同一 inode 还有别的
 * 名字，写/删都会波及数据域外）。
 */
function assertSafeOptionalFile(target: string, what: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw Object.assign(new Error(`${what} 是符号链接，拒绝使用。`), { code: 'path-invalid' });
  }
  if (!stat.isFile()) {
    throw Object.assign(new Error(`${what} 不是普通文件，拒绝使用。`), { code: 'path-invalid' });
  }
  if (stat.nlink > 1) {
    throw Object.assign(new Error(`${what} 是硬链接（nlink=${stat.nlink}），拒绝使用。`), { code: 'path-invalid' });
  }
}

/* ── _format.json：未知/损坏格式拒绝写 ───────────────────────────────────── */

/** 根目录里的「锁相关」文件（不算用户内容，认领检查时忽略）。
 *  只认**确切的**四个名字：`notes.lock.db` 及其 `-journal`/`-wal`/`-shm`。
 *  不能用 `startsWith('notes.lock.db-')`——那会把任何同前缀的外来文件
 *  （如 `notes.lock.db-mybackup`）当成锁产物，从而把一个**非空**的陌生目录
 *  误判成「空目录」并认领成数据域。 */
const LOCK_ARTIFACT_NAMES = new Set([LOCK_DB_FILE, `${LOCK_DB_FILE}-journal`, `${LOCK_DB_FILE}-wal`, `${LOCK_DB_FILE}-shm`]);

function isLockArtifact(name: string): boolean {
  return LOCK_ARTIFACT_NAMES.has(name);
}

/** marker 状态：v1 仍可读但必须显式升级；v2 才允许写入。 */
type MarkerState =
  | { state: 'ok'; version: 1 | 2 }
  | { state: 'missing' }
  | { state: 'broken'; message: string };

function readFormatMarker(root: string): MarkerState {
  const formatFile = path.join(root, FORMAT_FILE);
  if (!fs.existsSync(formatFile)) return { state: 'missing' };
  assertSafePath(formatFile, 'file', root);
  const raw = decodeUtf8Strict(fs.readFileSync(formatFile), '_format.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'broken', message: '笔记数据域的 _format.json 已损坏，拒绝写入以免覆盖。' };
  }
  if (
    typeof parsed !== 'object' || parsed === null
    || (parsed as Record<string, unknown>).format !== FORMAT_TOKEN.format
    || ((parsed as Record<string, unknown>).version !== CURRENT_FORMAT_VERSION
      && (parsed as Record<string, unknown>).version !== LEGACY_FORMAT_VERSION)
  ) {
    return { state: 'broken', message: '笔记数据域的 _format.json 格式不被识别，拒绝写入以免覆盖。' };
  }
  const version = (parsed as Record<string, unknown>).version as 1 | 2;
  return { state: 'ok', version };
}

/**
 * 根目录是否「除了空的 resources/ 与锁文件之外什么都没有」。
 * 用于判断「这是不是一份还没初始化的数据域」。
 */
// 与 atomicWrite 的生成器严格同名；不是任意 .tmp-*，也不跟随目录/链接。
const TEMP_FILE_RE = /^\.tmp-[0-9a-f]{16}$/;
function isOwnedTemp(dir: string, name: string): boolean {
  if (!TEMP_FILE_RE.test(name)) return false;
  const stat = fs.lstatSync(path.join(dir, name));
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function rootIsPristine(root: string): boolean {
  for (const entry of fs.readdirSync(root)) {
    if (isLockArtifact(entry)) {
      assertSafeOptionalFile(path.join(root, entry), '笔记锁文件');
      continue;
    }
    if (isOwnedTemp(root, entry)) continue;
    if (entry === RESOURCES_DIR) {
      const dir = path.join(root, entry);
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      if (fs.readdirSync(dir).some(name => !isOwnedTemp(dir, name))) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** 只在 OS 写锁内清理保留名字的普通单链接文件；读路径从不清理。 */
function cleanOrphanTemps(root: string): void {
  for (const dir of [root, resourcesDir(root)]) {
    if (!fs.existsSync(dir)) continue;
    assertSafePath(dir, 'dir', root);
    for (const name of fs.readdirSync(dir)) {
      if (isOwnedTemp(dir, name)) fs.unlinkSync(path.join(dir, name));
    }
  }
}

/**
 * 拿锁**之前**的只读格式守卫：v1 普通写入直接拒，不会先在旧库里建锁库/临时文件。
 * 锁内的 `ensureStoreForWrite` 仍负责并发下首次初始化与最终判定。
 */
function checkWritableFormatBeforeLock(root: string): NotesStoreResult<string> {
  if (!fs.existsSync(root)) return ok(root);
  try {
    assertSafePath(root, 'dir', root);
    const marker = readFormatMarker(root);
    if (marker.state === 'ok') {
      if (marker.version === LEGACY_FORMAT_VERSION) {
        return fail(503, 'notes-format-invalid', '笔记数据域仍是旧格式，请先备份并显式升级后再写入。');
      }
      return ok(root);
    }
    if (marker.state === 'broken') return fail(503, 'file-shape-unknown', marker.message);
    if (!rootIsPristine(root)) {
      return fail(503, 'file-shape-unknown', '笔记数据域目录非空却缺少 _format.json，拒绝认领以免覆盖已有文件。');
    }
    return ok(root);
  } catch (error) {
    return mapStoreError(error);
  }
}

/**
 * **写路径**的格式守卫（在锁内调用）：marker 缺失时只有**空目录**才认领为首次运行；
 * 非空目录一律拒绝——不能把别人的目录静默变成笔记数据域。
 */
function ensureStoreForWrite(root: string): NotesStoreResult<string> {
  const marker = readFormatMarker(root);
  if (marker.state === 'ok') {
    // v1 只留只读 GET；任何普通写入都要求先通过 POST operation:'upgrade' 显式升级。
    if (marker.version === LEGACY_FORMAT_VERSION) {
      return fail(503, 'notes-format-invalid', '笔记数据域仍是旧格式，请先备份并显式升级后再写入。');
    }
    return ok(root);
  }
  if (marker.state === 'broken') return fail(503, 'file-shape-unknown', marker.message);
  if (!rootIsPristine(root)) {
    return fail(503, 'file-shape-unknown', '笔记数据域目录非空却缺少 _format.json，拒绝认领以免覆盖已有文件。');
  }
  // 首次：只创建空数据域 + 格式标记，不 seed 任何演示正文。
  fs.mkdirSync(resourcesDir(root), { recursive: true });
  assertSafePath(resourcesDir(root), 'dir', root);
  atomicWrite(path.join(root, FORMAT_FILE), Buffer.from(`${JSON.stringify(FORMAT_TOKEN)}\n`, 'utf8'), root);
  return ok(root);
}

/* ── 原子文件发布：temp → fsync → 核版本 → rename ────────────────────────── */

/** POSIX 发布后同步目录项。Windows 不支持目录句柄 fsync 时明确降级，
 * 只承诺进程崩溃原子性，不冒充掉电持久性；其他 IO 错误仍报保存失败。 */
let warnedDirectorySync = false;
function syncDirectory(dir: string): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(dir, 'r');
    fs.fsyncSync(handle);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(code ?? '')) {
      if (!warnedDirectorySync) {
        warnedDirectorySync = true;
        console.warn('StudyMate：当前 Windows 文件系统不支持目录 fsync；笔记保存仅保证进程崩溃原子性，不保证掉电后的目录项持久性。');
      }
      return;
    }
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function atomicWrite(target: string, buffer: Buffer, root: string): void {
  const dir = path.dirname(target);
  assertSafePath(dir, 'dir', root);
  const temp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
  try {
    const handle = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, buffer);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    assertSafePath(target, 'any', root);
    fs.renameSync(temp, target);
    syncDirectory(dir);
  } catch (error) {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      // 清理失败不影响主错误。
    }
    throw error;
  }
}

/**
 * 原子发布的写侧：临时文件写完并 fsync 后，**再核一次目标文件的实际字节**，
 * 与 `expectedVersion` 不符就放弃（旧文件保持原样、temp 被清理），符合才 rename。
 *
 * 这道检查挡住的是「锁内两次写之间被别的路径插队」与「外部编辑器在我们写临时文件
 * 期间改了目标」这两种常见情形；它**不能**保证对任意外部程序的 check/rename 竞态
 * 免疫——那是文件系统层面的事实，这里不承诺。
 */
function atomicWriteChecked(
  target: string,
  buffer: Buffer,
  root: string,
  expectedVersion: string | null,
): { ok: true } | { ok: false; currentVersion: string | null } {
  const dir = path.dirname(target);
  assertSafePath(dir, 'dir', root);
  const temp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
  try {
    const handle = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, buffer);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    // 写前最后一道核：目标必须仍是「我们以为的那份 bytes」。
    let currentVersion: string | null = null;
    if (fs.existsSync(target)) {
      assertSafePath(target, 'file', root);
      currentVersion = sha256Of(fs.readFileSync(target));
    }
    if (currentVersion !== expectedVersion) {
      try { fs.unlinkSync(temp); } catch { /* 清理失败不影响主错误 */ }
      return { ok: false, currentVersion };
    }
    assertSafePath(target, 'any', root);
    fs.renameSync(temp, target);
    syncDirectory(dir);
    return { ok: true };
  } catch (error) {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      // 清理失败不影响主错误。
    }
    throw error;
  }
}

/* ── 自有 note 的 .md 文件：只解析开头 3 行元信息头 ────────────────────────── */

const NOTE_HEADER_KEY = 'studymate_notes: ';

/** 读出文件的一行（行尾 `\r` 去掉）；到文件尾返回 null。 */
function readLine(text: string, from: number): { line: string; next: number } | null {
  const index = text.indexOf('\n', from);
  if (index < 0) {
    if (from >= text.length) return null;
    return { line: text.slice(from).replace(/\r$/, ''), next: text.length };
  }
  return { line: text.slice(from, index).replace(/\r$/, ''), next: index + 1 };
}

function serializeNoteFile(resource: Record<string, unknown>): Buffer {
  const { markdown, ...meta } = resource;
  const body = typeof markdown === 'string' ? markdown : '';
  const head = `---\n${NOTE_HEADER_KEY}${JSON.stringify(meta)}\n---\n`;
  return Buffer.from(head + body, 'utf8');
}

/**
 * 解析 `r-<id>.md`：只认开头 3 行（`---` / `studymate_notes: {...}` / `---`），
 * 行尾允许 CRLF；正文**原样**返回（不规范化换行、不吃掉正文里的 `---`）。
 */
export function parseNoteFile(text: string): { meta: Record<string, unknown>; markdown: string } {
  const first = readLine(text, 0);
  if (!first || first.line.trim() !== '---') {
    throw shapeError('笔记文件缺少元信息头（应以 "---" 开头）。');
  }
  const second = readLine(text, first.next);
  if (!second) throw shapeError('笔记文件的元信息头不完整。');
  if (!second.line.startsWith(NOTE_HEADER_KEY)) {
    throw shapeError('笔记文件缺少 studymate_notes 元信息行。');
  }
  let meta: unknown;
  try {
    meta = JSON.parse(second.line.slice(NOTE_HEADER_KEY.length));
  } catch {
    throw shapeError('笔记文件的元信息不是合法 JSON。');
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw shapeError('笔记文件的元信息必须是 JSON 对象。');
  }
  const third = readLine(text, second.next);
  if (!third || third.line.trim() !== '---') {
    throw shapeError('笔记文件的元信息头没有正常收尾（第三行应为 "---"）。');
  }
  return { meta: meta as Record<string, unknown>, markdown: text.slice(third.next) };
}

/* ── 跨进程锁：node:sqlite DatabaseSync + BEGIN IMMEDIATE ────────────────── */

interface LockDb {
  db: DatabaseSync;
  run: (sql: string) => void;
}

const LOCK_BUSY_MS = 5000;

/**
 * 打开锁库。**路径安全同样适用**：SQLite 会跟随 symlink 打开目标文件，
 * 所以 `notes.lock.db`（以及它的 `-journal`/`-wal`/`-shm`）必须先 lstat：
 * symlink / 非普通文件 / 硬链接一律拒绝。
 */
function openLockDb(root: string): LockDb {
  const dbFile = path.join(root, LOCK_DB_FILE);
  assertSafePath(root, 'dir', root);
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    assertSafeOptionalFile(`${dbFile}${suffix}`, `笔记锁文件${suffix === '' ? '' : `（${suffix}）`}`);
  }
  // Node 内置 sqlite（node:sqlite），版本范围沿用根包 engines（>=24）；
  // busy_timeout 用 PRAGMA 设置（构造函数 timeout 只是附加保险）。
  const db = new DatabaseSync(dbFile, { timeout: LOCK_BUSY_MS });
  try {
    db.exec(`PRAGMA busy_timeout=${LOCK_BUSY_MS}`);
    // 打开之后再核一次：SQLite 刚创建的文件也要是普通单链接文件。
    assertSafeOptionalFile(dbFile, '笔记锁文件');
  } catch (error) {
    try { db.close(); } catch { /* 关闭失败不影响主错误 */ }
    throw error;
  }
  return {
    db,
    run: (sql: string) => {
      db.exec(sql);
    },
  };
}

/**
 * **开锁库之前**的数据域根守卫（必须在创建 `notes.lock.db` 之前跑）。
 *
 *  - 根不存在：幂等建出来（空目录，之后才允许认领）。
 *  - 根存在且 marker 合法：放行。
 *  - 根存在但 marker 缺失/损坏：**先看根是不是「除了空 resources/ 与确切的锁产物
 *    之外什么都没有」**；不是 → 立刻拒绝，**绝不在陌生目录里先落一个 lock.db**
 *    （那等于先把别人的目录标记成笔记数据域）。
 */
function prepareStoreRoot(root: string): NotesStoreResult<string> {
  if (!fs.existsSync(root)) {
    try {
      fs.mkdirSync(root, { recursive: true });
      syncDirectory(path.dirname(root));
    } catch (error) {
      return mapStoreError(error);
    }
  }
  try {
    assertSafePath(root, 'dir', root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(400, 'path-invalid', message);
  }
  const marker = readFormatMarker(root);
  if (marker.state === 'ok') return ok(root);
  if (marker.state === 'broken') return fail(503, 'file-shape-unknown', marker.message);
  if (!rootIsPristine(root)) {
    return fail(503, 'file-shape-unknown', '笔记数据域目录非空却缺少 _format.json，拒绝认领以免覆盖已有文件。');
  }
  return ok(root);
}

/**
 * 把临界区里冒出来的异常映射成正确的错误码。**不要一律 500**：
 *  - `path-invalid` → 400（路径被 symlink/硬链接/非普通文件占了）
 *  - `file-shape-unknown` → 503（数据域内容损坏，如同 id 双物理文件）
 *  - 其余 → 500 `write-failed`（不新增错误码；`write-verification-failed` 不在词表里）。
 */
function mapStoreError(error: unknown, reading = false): NotesStoreFail {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error ? (error as { code?: string }).code : undefined;
  if (code === 'path-invalid') return fail(400, 'path-invalid', message);
  if (code === 'file-shape-unknown') return fail(503, 'file-shape-unknown', message);
  // 原始 IO/SQLite 细节只在服务端诊断中出现，不能把绝对路径装进 HTTP 回包。
  console.warn('StudyMate：笔记数据域操作失败。', error);
  if (/SQLITE_BUSY|database is locked|busy/i.test(message)) {
    return fail(503, 'notes-unavailable', '笔记数据域正被其他进程写入，稍后重试。');
  }
  return reading
    ? fail(503, 'notes-unavailable', '笔记数据域暂时无法读取，请检查访问权限或稍后重试。')
    : fail(500, 'write-failed', '笔记保存失败，本地草稿仍可保留；请检查磁盘与访问权限后重试。');
}

/**
 * 拿到 OS 级跨进程写锁并执行一段**同步**临界区。
 *
 * `BEGIN IMMEDIATE` 在拿到写锁之前会阻塞/报 `SQLITE_BUSY`（busy_timeout 有界 5s）；
 * `lock_anchor` 里那条无业务的 UPDATE 只是为了确保写锁真的落到磁盘锁上，
 * 不承担任何业务语义。临界区里**绝不 await**——锁内 await 会让锁的持有时间不可控。
 */
function withWriteLock<T>(root: string, critical: () => T | NotesStoreResult<T>): NotesStoreResult<T> {
  let db: DatabaseSync | null = null;
  try {
    // 先守数据域根（可能建目录 / 拒绝陌生目录），再开锁库。
    const prepared = prepareStoreRoot(root);
    if (!prepared.ok) return prepared;
    const lock = openLockDb(root);
    db = lock.db;
    // 建表 + 种一行锚点：`lock_anchor` 是**无业务**表，只为让写锁有一个稳定的落点。
    lock.run('CREATE TABLE IF NOT EXISTS lock_anchor (id INTEGER PRIMARY KEY, held INTEGER NOT NULL DEFAULT 0)');
    lock.run('INSERT OR IGNORE INTO lock_anchor (id, held) VALUES (1, 0)');
    // BEGIN IMMEDIATE：立即取写锁（而不是推迟到第一次写）。下面那条无业务 UPDATE
    // 只为确认写锁真的持有（若 BEGIN IMMEDIATE 本身没落锁，这里会落）。
    lock.run('BEGIN IMMEDIATE');
    lock.run('UPDATE lock_anchor SET held = held + 1 WHERE id = 1');
    // 已有合法库或可认领的首次空库才清理；格式 1 只读时不动任何内容。
    const marker = readFormatMarker(root);
    if ((marker.state === 'ok' && marker.version === CURRENT_FORMAT_VERSION)
      || (marker.state === 'missing' && rootIsPristine(root))) cleanOrphanTemps(root);
    let value: T | NotesStoreResult<T>;
    try {
      value = critical();
    } catch (error) {
      try { lock.run('ROLLBACK'); } catch { /* 已回滚或未开事务 */ }
      db.close();
      db = null;
      return mapStoreError(error);
    }
    // critical() 可能直接返回一个 NotesStoreOk/NotesStoreFail 包装（含 fail(...)），
    // 不能二次包装：只在拿到裸 T 时才包 ok(value)。
    if (typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean') {
      const already = value as NotesStoreResult<T>;
      if (!already.ok) {
        try { lock.run('ROLLBACK'); } catch { /* 已回滚或未开事务 */ }
        db.close();
        db = null;
        return already;
      }
      lock.run('COMMIT');
      db.close();
      db = null;
      return already;
    }
    lock.run('COMMIT');
    db.close();
    db = null;
    return ok(value as T);
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // 已经是失败路径，不再处理关闭错误。
      }
    }
    return mapStoreError(error);
  }
}

/* ── 对外：读取整个数据域 ───────────────────────────────────────────────── */

export interface NotesResourceRecord { id: string; type: string; [key: string]: unknown }

export interface NotesStoreSnapshot {
  storeId: string;
  schemaVersion: 1 | 2;
  requiresUpgrade: boolean;
  resources: Record<string, NotesResourceRecord>;
  resourceVersions: Record<string, string | null>;
  layout: Record<string, unknown> | null;
  layoutVersion: string | null;
  /** 只在显式 `onCorrupt:'skip'` 的读取里出现；普通模式不带这个键。 */
  corrupt?: NotesCorruptResource[];
}

/** 坏资源里能**只读**提取出来的课程关联；形状与上限沿用 contracts 的课程来源。 */
export interface NotesCourseReference {
  workspace: string;
  subject: string;
  node: string;
  title?: string;
}

/**
 * 显式降级读取时返回的坏资源清单。
 *
 * 只带「用户能看懂、且不泄露本机路径」的元信息：`title` / `associations` 尽力提取，
 * 提取失败或超限就省略；`notebook` 只从 layout 的 node→notebook 映射里取名字，
 * 映射不到就是 null；`message` 是固定通用文案，绝不含路径或原始异常。
 */
export interface NotesCorruptResource {
  id: string;
  kind: 'md' | 'json';
  title?: string;
  associations?: NotesCourseReference[];
  notebook: string | null;
  message: string;
}

/** 单个资源文件的原始字节（版本按它算，绝不 decode→re-encode）。 */
interface ResourceRaw {
  bytes: Buffer;
  kind: 'md' | 'json';
}

/** 坏资源条目里的固定文案：不包含路径、原始异常或文件名。 */
const CORRUPT_RESOURCE_MESSAGE = '资源文件已损坏，暂时无法载入。';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从坏资源原始字节里只读提取元信息。任何解码/解析失败都返回 null——不猜、不回写。
 * `.md` 只读开头 3 行元信息头；`.json` 只接受 JSON 对象。
 */
function readCorruptMetadata(bytes: Buffer, kind: 'md' | 'json'): Record<string, unknown> | null {
  try {
    if (kind === 'md') {
      // 只解码前三行：正文损坏（甚至不是合法 UTF-8）也不能妨碍元信息提取。
      let end = 0;
      for (let line = 0; line < 3; line += 1) {
        const newline = bytes.indexOf(0x0a, end);
        if (newline === -1) return null;
        end = newline + 1;
      }
      const text = decodeUtf8Strict(bytes.subarray(0, end), '资源');
      return parseNoteFile(text).meta;
    }
    const text = decodeUtf8Strict(bytes, '资源');
    const parsed: unknown = JSON.parse(text);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** layout 的 `node.data.contentId → node.data.notebookId → folder.name` 索引。 */
function notebookNamesByContentId(layout: Record<string, unknown> | null): Map<string, string> {
  const byContentId = new Map<string, string>();
  if (!layout) return byContentId;
  const folderNames = new Map<string, string>();
  for (const folder of Array.isArray(layout.folders) ? layout.folders : []) {
    if (!isPlainRecord(folder)) continue;
    if (folder.kind !== 'notebook' || typeof folder.id !== 'string' || typeof folder.name !== 'string') continue;
    folderNames.set(folder.id, folder.name);
  }
  for (const node of Array.isArray(layout.nodes) ? layout.nodes : []) {
    if (!isPlainRecord(node) || !isPlainRecord(node.data)) continue;
    const contentId = node.data.contentId;
    const notebookId = node.data.notebookId;
    if (typeof contentId !== 'string' || typeof notebookId !== 'string') continue;
    const name = folderNames.get(notebookId);
    if (name !== undefined) byContentId.set(contentId, name);
  }
  return byContentId;
}

function corruptResourceEntry(
  id: string,
  kind: 'md' | 'json',
  bytes: Buffer | null,
  notebook: string | null,
): NotesCorruptResource {
  const metadata = bytes ? readCorruptMetadata(bytes, kind) : null;
  const entry: NotesCorruptResource = { id, kind, notebook, message: CORRUPT_RESOURCE_MESSAGE };
  if (metadata) {
    const title = metadata.title;
    if (typeof title === 'string' && title.length > 0 && [...title].length <= MAX_META_TEXT_CHARS) {
      entry.title = title;
    }
    if ('associations' in metadata) {
      // 借 checkResource 校验课程关联：形状/长度/去重规则只维护在 contracts 一处。
      const check = checkResource({
        id: 'corrupt-probe',
        type: 'note',
        markdown: '',
        associations: metadata.associations,
      });
      if (check.ok && Array.isArray(check.value.associations)) {
        entry.associations = check.value.associations as NotesCourseReference[];
      }
    }
  }
  return entry;
}

/** 单个 JSON 资源文件的读取上限。
 *  不能定成 2 MiB：一张合法的 4 MiB PNG 以 dataURL 存进 JSON 后约 5.33 MiB，
 *  定小了会把**合法**的图片读成坏库。取请求体上限 6 MiB 作同一边界
 * （能写进去的必然读得出来，读写用同一个上限才自洽）。 */
const MAX_JSON_RESOURCE_BYTES = MAX_REQUEST_BYTES;

/** layout.json 的读取上限（独立边界，同为 6 MiB）。 */
const MAX_LAYOUT_BYTES = MAX_REQUEST_BYTES;

/** 列出 resources/ 下所有合法命名的资源文件（不认识的副文件原样保留）。 */
function listResourceFiles(root: string): { id: string; kind: 'md' | 'json'; file: string }[] {
  const dir = resourcesDir(root);
  if (!fs.existsSync(dir)) return [];
  assertSafePath(dir, 'dir', root);
  const out: { id: string; kind: 'md' | 'json'; file: string }[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const match = RESOURCE_FILE_RE.exec(entry);
    if (!match) continue; // 不认识的副文件：保留原样，不删除、不报错。
    out.push({ id: match[1], kind: match[2] as 'md' | 'json', file: path.join(dir, entry) });
  }
  return out;
}

/**
 * 读取某个 id 的物理文件。**同 id 同时存在 .md 与 .json 是数据损坏**，整体拒绝
 * （不猜测、不静默挑一个）。
 */
function loadResourceRaw(root: string, id: string): ResourceRaw | null {
  const mdFile = resourceFile(root, id, 'md');
  const jsonFile = resourceFile(root, id, 'json');
  const mdExists = fs.existsSync(mdFile);
  const jsonExists = fs.existsSync(jsonFile);
  if (mdExists && jsonExists) {
    throw Object.assign(new Error(`资源「${id}」同时存在 .md 与 .json 文件，数据域已损坏。`), { code: 'file-shape-unknown' });
  }
  if (!mdExists && !jsonExists) return null;
  const kind: 'md' | 'json' = mdExists ? 'md' : 'json';
  const file = kind === 'md' ? mdFile : jsonFile;
  assertSafePath(file, 'file', root);
  const stat = fs.statSync(file);
  const cap = kind === 'md' ? MAX_NOTE_BYTES : MAX_JSON_RESOURCE_BYTES;
  if (!stat.isFile() || stat.size > cap) {
    throw Object.assign(new Error(`资源「${id}」的文件不是普通文件或超过 ${cap} 字节读取上限。`), {
      code: 'file-shape-unknown',
      // 单文件读取上限的超限文件也必须计入 48 MiB「实际文件总量」预算；
      // 否则 skip 会把一个超限大文件当成 0 字节，整库预算被绕过。
      byteLength: stat.size,
    });
  }
  return { bytes: fs.readFileSync(file), kind };
}

function parseResourceRecord(id: string, bytes: Buffer, kind: 'md' | 'json'): NotesResourceRecord {
  const text = decodeUtf8Strict(bytes, `资源 ${id}`);
  if (kind === 'md') {
    const { meta, markdown } = parseNoteFile(text);
    return { ...(meta as Record<string, unknown>), markdown } as unknown as NotesResourceRecord;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw shapeError(`资源 ${id} 的 JSON 文件已损坏。`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw shapeError(`资源 ${id} 的 JSON 文件必须是对象。`);
  }
  return { ...(parsed as Record<string, unknown>) } as NotesResourceRecord;
}

/** 读侧 DTO 也要过一遍契约校验：不认识的形状不许悄悄进客户端。 */
function normalizeLoadedRecord(id: string, bytes: Buffer, kind: 'md' | 'json'): NotesResourceRecord {
  const raw = parseResourceRecord(id, bytes, kind);
  const check = checkResource(raw);
  if (!check.ok) throw shapeError(`资源 ${id} 的内容非法：${check.message}`);
  const value = check.value;
  // 文件名 id 与元信息 id 必须一致，不能靠覆盖 id 来蒙混。
  if (value.id !== id) throw shapeError(`资源 ${id} 的元信息 id「${String(value.id)}」与文件名不一致，数据域已损坏。`);
  // 物理文件扩展名必须与内容自洽（自有 note → .md；外部文件引用/其它类型 → .json）。
  if (physicalKindOf(value) !== kind) {
    throw shapeError(`资源 ${id} 的物理文件扩展名（.${kind}）与其类型/来源不匹配，数据域已损坏。`);
  }
  return value as NotesResourceRecord;
}

/** 读 layout.json：形状不认识就报错，绝不返回 null 当作「没有布局」。 */
function parseLayoutStrict(bytes: Buffer): Record<string, unknown> {
  const text = decodeUtf8Strict(bytes, 'layout.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('layout.json 已损坏，拒绝把它当成空布局。'), { code: 'file-shape-unknown' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw Object.assign(new Error('layout.json 必须是 JSON 对象。'), { code: 'file-shape-unknown' });
  }
  const check = checkLayout(parsed);
  if (!check.ok) throw Object.assign(new Error(`布局文件已损坏：${check.message}`), { code: 'file-shape-unknown' });
  return check.value as Record<string, unknown>;
}

/**
 * 读取整个笔记数据域（不含写锁；读侧只读文件，不进 SQLite 临界区）。
 *
 * 读侧**不创建任何东西**：根不存在就是空域；根存在但没有合法 marker、或任何资源/
 * 布局损坏 → 整个读取失败（fail closed），绝不把坏数据当成「空」让后续保存覆盖掉。
 */
export function readNotesStore({ home, onCorrupt }: { home: string; onCorrupt?: unknown }): NotesStoreResult<NotesStoreSnapshot> {
  if (onCorrupt !== undefined && onCorrupt !== 'skip') {
    return fail(400, 'body-invalid', 'onCorrupt 只接受 skip（缺省表示严格读取）。');
  }
  const skipCorrupt = onCorrupt === 'skip';
  const emptySnapshot = (): NotesStoreSnapshot => ({
    storeId: storeIdOf(notesRoot(home)), schemaVersion: CURRENT_FORMAT_VERSION, requiresUpgrade: false,
    resources: {}, resourceVersions: {}, layout: null, layoutVersion: null,
    ...(skipCorrupt ? { corrupt: [] } : {}),
  });
  if (!isValidNotesHome(home)) {
    return fail(400, 'path-invalid', '数据根必须是绝对路径，不能是相对路径或空白——否则笔记会落到当前工作目录下。');
  }
  const root = notesRoot(home);
  if (!fs.existsSync(root)) {
    // 还没初始化：视作空数据域（**不建目录、不写格式标记**）。
    return ok(emptySnapshot());
  }
  try {
    assertSafePath(root, 'dir', root);
    const marker = readFormatMarker(root);
    if (marker.state === 'missing') {
      if (rootIsPristine(root)) return ok(emptySnapshot());
      return fail(503, 'file-shape-unknown', '笔记数据域缺少 _format.json，无法确认格式，拒绝读取。');
    }
    if (marker.state === 'broken') {
      return fail(503, 'file-shape-unknown', marker.message);
    }

    const markerVersion: 1 | 2 = marker.version;
    const resources: Record<string, NotesResourceRecord> = {};
    const resourceVersions: Record<string, string | null> = {};
    const skipped: { id: string; kind: 'md' | 'json'; bytes: Buffer | null }[] = [];
    const files = listResourceFiles(root);
    if (files.length > MAX_RESOURCES) {
      return fail(503, 'file-shape-unknown', `数据域资源数 ${files.length} 超过 ${MAX_RESOURCES} 篇上限，拒绝读取以免误清。`);
    }
    const seenIds = new Set<string>();
    let totalBytes = 0;
    for (const item of files) {
      if (seenIds.has(item.id)) {
        return fail(503, 'file-shape-unknown', `资源 ${item.id} 同时存在 .md 与 .json 两份物理文件，数据域已损坏。`);
      }
      seenIds.add(item.id);
      let raw: ResourceRaw | null;
      try {
        raw = loadResourceRaw(root, item.id);
      } catch (error) {
        // 只有显式 skip 才把「单个资源文件的形状问题」降级；EACCES/symlink/路径问题
        // 没有 file-shape-unknown 码，仍然整库失败。
        if (skipCorrupt && (error as { code?: string }).code === 'file-shape-unknown') {
          // 单文件超限时没有 bytes 可累加，但它的实际文件大小仍占整库预算。
          const byteLength = (error as { byteLength?: unknown }).byteLength;
          if (typeof byteLength === 'number' && byteLength > 0) {
            totalBytes += byteLength;
            if (totalBytes > MAX_TOTAL_RESOURCE_BYTES) {
              throw shapeError('笔记资源实际文件总量超过 48 MiB 上限。');
            }
          }
          skipped.push({ id: item.id, kind: item.kind, bytes: null });
          continue;
        }
        throw error;
      }
      if (!raw) throw shapeError('读取期间资源被移除，请重新加载。');
      const bytes = raw.bytes;
      totalBytes += bytes.byteLength;
      // 48 MiB 是整库读取预算，不能当成「某一个资源坏了」而跳过。
      if (totalBytes > MAX_TOTAL_RESOURCE_BYTES) throw shapeError('笔记资源实际文件总量超过 48 MiB 上限。');
      let record: NotesResourceRecord;
      try {
        record = normalizeLoadedRecord(item.id, bytes, item.kind);
      } catch (error) {
        if (skipCorrupt && (error as { code?: string }).code === 'file-shape-unknown') {
          skipped.push({ id: item.id, kind: item.kind, bytes });
          continue;
        }
        throw error;
      }
      // 版本 = 原始字节的 SHA256（绝不 decode→re-encode）。
      resourceVersions[item.id] = sha256Of(bytes);
      resources[item.id] = record;
    }

    let layout: Record<string, unknown> | null = null;
    let layoutVersion: string | null = null;
    const layoutFile = path.join(root, LAYOUT_FILE);
    if (fs.existsSync(layoutFile)) {
      assertSafePath(layoutFile, 'file', root);
      const layoutStat = fs.statSync(layoutFile);
      if (!layoutStat.isFile() || layoutStat.size > MAX_LAYOUT_BYTES) {
        return fail(503, 'file-shape-unknown', `layout.json 不是普通文件或超过 ${Math.floor(MAX_LAYOUT_BYTES / (1024 * 1024))} MiB 读取上限。`);
      }
      const bytes = fs.readFileSync(layoutFile);
      layoutVersion = sha256Of(bytes);
      // layout.json 损坏/非法：**整体拒绝读取**（fail closed），不把 null 当「首次库」——
      // 否则前端会把 null 当首次库提交 defaults，把原坏 layout 覆盖掉。
      layout = parseLayoutStrict(bytes);
    }
    const notebookNames = notebookNamesByContentId(layout);
    return ok({
      storeId: storeIdOf(root),
      schemaVersion: markerVersion,
      requiresUpgrade: markerVersion === LEGACY_FORMAT_VERSION,
      resources, resourceVersions, layout, layoutVersion,
      ...(skipCorrupt ? {
        corrupt: skipped.map(item => corruptResourceEntry(item.id, item.kind, item.bytes, notebookNames.get(item.id) ?? null)),
      } : {}),
    });
  } catch (error) {
    return mapStoreError(error, true);
  }
}

/* ── 对外：写入一个资源 ─────────────────────────────────────────────────── */

export interface WriteResourceInput {
  home: string;
  resource: unknown;
  expectedVersion: string | null | undefined;
}

export interface WriteResourceValue {
  resource: NotesResourceRecord;
  version: string;
}

/**
 * 校验 expectedVersion：必须**显式给出**（键存在），值为 `null`（首次创建）或 64 位
 * 小写 hex sha256。`undefined`（漏键）/非法格式都是客户端错误 → 400，
 * 绝不隐式当 null 处理（否则一次漏键就能覆盖别人的新内容）。
 */
function checkExpectedVersion(expectedVersion: unknown): { ok: true; value: string | null } | { ok: false } {
  if (expectedVersion === undefined) return { ok: false };
  if (expectedVersion === null) return { ok: true, value: null };
  if (typeof expectedVersion !== 'string' || !/^[0-9a-f]{64}$/.test(expectedVersion)) return { ok: false };
  return { ok: true, value: expectedVersion };
}

/** 锁内重扫预算：资源个数与总字节。 */
function scanResourceBudget(root: string): { totalBytes: number; count: number } {
  let totalBytes = 0;
  let count = 0;
  for (const item of listResourceFiles(root)) {
    count += 1;
    assertSafePath(item.file, 'file', root);
    totalBytes += fs.statSync(item.file).size;
  }
  return { totalBytes, count };
}

export function writeNotesResource(input: WriteResourceInput): NotesStoreResult<WriteResourceValue> {
  const { home, resource, expectedVersion } = input;
  if (!isValidNotesHome(home)) {
    return fail(400, 'path-invalid', '数据根必须是绝对路径，不能是相对路径或空白——否则笔记会落到当前工作目录下。');
  }
  const versionCheck = checkExpectedVersion(expectedVersion);
  if (!versionCheck.ok) {
    return fail(400, 'expected-version-required', 'expectedVersion 必须显式给出：读到过就是那串 64 位小写 sha256，第一次创建传 null；不接受省略或非法格式。');
  }
  const baseVersion = versionCheck.value;
  const check = checkResource(resource);
  if (!check.ok) return fail(400, 'body-invalid', check.message);
  const value = check.value;
  const id = value.id as string;
  const root = notesRoot(home);
  const preflight = checkWritableFormatBeforeLock(root);
  if (!preflight.ok) return preflight;

  // 物理 kind：note 非文件引用恒 .md，note+文件引用与其余类型恒 .json
  // （physicalKindOf 是唯一入口）；不允许跨类型变更（避免多文件事务）。
  const kind: 'md' | 'json' = physicalKindOf(value);

  return withWriteLock(root, (): WriteResourceValue | NotesStoreResult<WriteResourceValue> => {
    // 目录/格式标记的初始化也必须在锁内：两个进程同时首次写不能各建一份。
    const ensured = ensureStoreForWrite(root);
    if (!ensured.ok) return ensured;

    // 锁内**重新读**现状：existing/count/totalBytes 都不能在锁外缓存——否则两个并发写
    // 可越过总量/篇数预算，或同一新 id 跨 kind 双写。锁内 fs 操作都是同步的，绝不 await。
    const existingRaw = loadResourceRaw(root, id);
    if (existingRaw && existingRaw.kind !== kind) {
      return fail(400, 'body-invalid', `资源「${id}」已存在为${existingRaw.kind === 'md' ? 'Markdown' : 'JSON'}文件，不支持跨类型变更。`);
    }
    const currentBytes = existingRaw ? existingRaw.bytes : null;
    // 版本按**原始字节**算（不 decode→re-encode，否则非法 UTF-8 文件永远对不上）。
    const currentHash = currentBytes === null ? null : sha256Of(currentBytes);
    if (baseVersion !== currentHash) {
      return fail(409, 'version-conflict', '资源已被其他窗口修改，请先查看当前内容再决定如何合并。', {
        current: currentBytes === null ? null : safeResource(currentBytes, id, kind),
        resource: currentBytes === null ? null : safeResource(currentBytes, id, kind),
        version: currentHash,
      });
    }

    const buffer = kind === 'md' ? serializeNoteFile(value) : Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    const nextHash = sha256Of(buffer);
    if (currentHash === nextHash) {
      // 同目标 bytes 幂等：不重复写盘，但补做前次 rename 后可能失败的目录同步。
      syncDirectory(resourcesDir(root));
      return ok({ resource: normalizeLoadedRecord(id, buffer, kind), version: nextHash });
    }
    // 篇数预算（新增的第 251 篇拒绝）与总存储预算（约 48 MiB）都在锁内现算。
    const budget = scanResourceBudget(root);
    const isNew = currentBytes === null;
    if (isNew && budget.count >= MAX_RESOURCES) {
      return fail(413, 'body-invalid', `笔记资源数已达到 ${MAX_RESOURCES} 篇上限，不能再新增。`);
    }
    const nextTotal = budget.totalBytes - (currentBytes === null ? 0 : currentBytes.byteLength) + buffer.byteLength;
    if (nextTotal > MAX_TOTAL_RESOURCE_BYTES) {
      return fail(413, 'body-invalid', `笔记资源总量超过 ${Math.floor(MAX_TOTAL_RESOURCE_BYTES / (1024 * 1024))} MiB 上限。`);
    }
    if (kind === 'md') {
      if (buffer.byteLength > MAX_NOTE_BYTES) {
        return fail(413, 'body-invalid', `笔记文件超过 ${Math.floor(MAX_NOTE_BYTES / 1024)} KiB 上限。`);
      }
      const markdown = value.markdown;
      if (typeof markdown === 'string' && [...markdown].length > MAX_NOTE_CHARS) {
        return fail(413, 'body-invalid', `笔记正文超过 ${MAX_NOTE_CHARS} 字符上限。`);
      }
    }

    let written: { ok: true } | { ok: false; currentVersion: string | null };
    try {
      written = atomicWriteChecked(resourceFile(root, id, kind), buffer, root, currentHash);
    } catch (error) {
      // 失败时旧目标保留、temp 已清理；错误码按异常性质映射，不新增码表。
      return mapStoreError(error);
    }
    if (!written.ok) {
      return fail(409, 'version-conflict', '资源在写入前又被修改，请重试。', {
        current: null,
        resource: null,
        version: written.currentVersion,
      });
    }
    return ok({ resource: normalizeLoadedRecord(id, buffer, kind), version: nextHash });
  });
}

/** 冲突回包里的「当前内容」：解析失败就退化成 null，不让冲突回包自己变成 500。 */
function safeResource(bytes: Buffer, id: string, kind: 'md' | 'json'): NotesResourceRecord | null {
  try {
    return normalizeLoadedRecord(id, bytes, kind);
  } catch {
    return null;
  }
}

/* ── 对外：写入布局 ─────────────────────────────────────────────────────── */

export interface WriteLayoutInput {
  home: string;
  layout: unknown;
  expectedVersion: string | null | undefined;
}

export interface WriteLayoutValue {
  layout: Record<string, unknown>;
  version: string;
}

export function writeNotesLayout(input: WriteLayoutInput): NotesStoreResult<WriteLayoutValue> {
  const { home, layout, expectedVersion } = input;
  if (!isValidNotesHome(home)) {
    return fail(400, 'path-invalid', '数据根必须是绝对路径，不能是相对路径或空白——否则笔记会落到当前工作目录下。');
  }
  const versionCheck = checkExpectedVersion(expectedVersion);
  if (!versionCheck.ok) {
    return fail(400, 'expected-version-required', 'expectedVersion 必须显式给出：读到过就是那串 64 位小写 sha256，第一次创建传 null；不接受省略或非法格式。');
  }
  const baseVersion = versionCheck.value;
  const check = checkLayout(layout);
  if (!check.ok) return fail(400, 'body-invalid', check.message);
  const root = notesRoot(home);
  const preflight = checkWritableFormatBeforeLock(root);
  if (!preflight.ok) return preflight;

  return withWriteLock(root, (): WriteLayoutValue | NotesStoreResult<WriteLayoutValue> => {
    const ensured = ensureStoreForWrite(root);
    if (!ensured.ok) return ensured;
    const file = path.join(root, LAYOUT_FILE);
    let currentBytes: Buffer | null = null;
    if (fs.existsSync(file)) {
      assertSafePath(file, 'file', root);
      currentBytes = fs.readFileSync(file);
    }
    const currentHash = currentBytes === null ? null : sha256Of(currentBytes);
    if (baseVersion !== currentHash) {
      return fail(409, 'version-conflict', '布局已被其他窗口修改，请先查看当前内容再决定如何合并。', {
        current: currentBytes === null ? null : safeLayout(currentBytes),
        layout: currentBytes === null ? null : safeLayout(currentBytes),
        version: currentHash,
      });
    }
    const buffer = Buffer.from(`${JSON.stringify(check.value)}\n`, 'utf8');
    const nextHash = sha256Of(buffer);
    if (currentHash === nextHash) {
      syncDirectory(root);
      return ok({ layout: check.value, version: nextHash });
    }
    let written: { ok: true } | { ok: false; currentVersion: string | null };
    try {
      written = atomicWriteChecked(file, buffer, root, currentHash);
    } catch (error) {
      return mapStoreError(error);
    }
    if (!written.ok) {
      return fail(409, 'version-conflict', '布局在写入前又被修改，请重试。', {
        current: null,
        layout: null,
        version: written.currentVersion,
      });
    }
    return ok({ layout: check.value, version: nextHash });
  });
}

function safeLayout(bytes: Buffer): Record<string, unknown> | null {
  try {
    return parseLayoutStrict(bytes);
  } catch {
    return null;
  }
}

/* ── 显式升级：v1 只读取，确认可载入后备份并仅替换 marker ─────────────────── */

export interface UpgradeStoreValue {
  schemaVersion: 2;
  requiresUpgrade: false;
  backup: string;
  backupId: string;
}

const BACKUP_DIR_RE = /^backup-v1-[0-9a-f-]{36}$/;

/** 升级前的源文件必须是普通单链接文件：备份不跟随 symlink/硬链接。 */
function readBackupSource(root: string, target: string, what: string): Buffer {
  assertSafePath(target, 'file', root);
  assertSafeOptionalFile(target, what);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    throw Object.assign(new Error(`${what} 不是普通单链接文件，拒绝备份。`), { code: 'path-invalid' });
  }
  return fs.readFileSync(target);
}

/** 独占建目录：已存在的文件/目录/symlink 一律拒绝，绝不覆盖旧备份。 */
function createBackupDir(root: string, target: string): void {
  assertSafePath(root, 'dir', root);
  let exists = false;
  try {
    fs.lstatSync(target);
    exists = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw Object.assign(new Error('备份目录不可访问，拒绝升级。'), { code: 'path-invalid', cause: error });
    }
  }
  if (exists) {
    throw Object.assign(new Error('备份目录已存在，拒绝覆盖。'), { code: 'path-invalid' });
  }
  try {
    fs.mkdirSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw Object.assign(new Error('备份目录已存在，拒绝覆盖。'), { code: 'path-invalid' });
    }
    throw error;
  }
  assertSafePath(target, 'dir', root);
}

/** 备份文件：目标必须不存在；写完再核一次不是 symlink/硬链接。 */
function writeBackupFile(root: string, target: string, bytes: Buffer, what: string): void {
  assertSafePath(path.dirname(target), 'dir', root);
  assertSafeOptionalFile(target, what);
  const handle = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    throw Object.assign(new Error(`${what} 不是普通单链接文件，拒绝备份。`), { code: 'path-invalid' });
  }
  syncDirectory(path.dirname(target));
}

/** 失败清理：只删本轮建的备份目录里的名字，绝不跟随 symlink 去删域外文件。 */
function removeBackupDir(root: string, target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    try { fs.unlinkSync(target); } catch { /* 清理失败不影响主错误 */ }
    return;
  }
  const walk = (dir: string): void => {
    try {
      assertSafePath(dir, 'dir', root);
    } catch {
      return;
    }
    for (const entry of fs.readdirSync(dir)) {
      const child = path.join(dir, entry);
      let childStat: fs.Stats;
      try {
        childStat = fs.lstatSync(child);
      } catch {
        continue;
      }
      if (childStat.isDirectory() && !childStat.isSymbolicLink()) walk(child);
      else { try { fs.unlinkSync(child); } catch { /* 清理失败不影响主错误 */ } }
    }
    try { fs.rmdirSync(dir); } catch { /* 清理失败不影响主错误 */ }
  };
  walk(target);
}

export function upgradeNotesStore({ home }: { home: string }): NotesStoreResult<UpgradeStoreValue> {
  if (!isValidNotesHome(home)) {
    return fail(400, 'path-invalid', '数据根必须是绝对路径，不能是相对路径或空白——否则笔记会落到当前工作目录下。');
  }
  const root = notesRoot(home);
  // 坏 v1 库要在**拿锁、建锁库之前**就 fail closed；锁内 critical 仍会再校验一次。
  if (fs.existsSync(root)) {
    try {
      assertSafePath(root, 'dir', root);
      const marker = readFormatMarker(root);
      if (marker.state === 'broken') return fail(503, 'file-shape-unknown', marker.message);
      if (marker.state === 'ok' && marker.version === LEGACY_FORMAT_VERSION) {
        const snapshot = readNotesStore({ home });
        if (!snapshot.ok) return fail(snapshot.status, snapshot.code, snapshot.message, snapshot.extra);
      }
    } catch (error) {
      return mapStoreError(error);
    }
  }
  const already: UpgradeStoreValue = {
    schemaVersion: CURRENT_FORMAT_VERSION,
    requiresUpgrade: false,
    backup: 'already-v2',
    backupId: 'already-v2',
  };
  return withWriteLock(root, (): UpgradeStoreValue | NotesStoreResult<UpgradeStoreValue> => {
    const marker = readFormatMarker(root);
    if (marker.state === 'broken') return fail(503, 'file-shape-unknown', marker.message);
    if (marker.state === 'missing') {
      if (!rootIsPristine(root)) {
        return fail(503, 'file-shape-unknown', '笔记数据域目录非空却缺少 _format.json，拒绝认领以免覆盖已有文件。');
      }
      fs.mkdirSync(resourcesDir(root), { recursive: true });
      assertSafePath(resourcesDir(root), 'dir', root);
      atomicWrite(path.join(root, FORMAT_FILE), Buffer.from(`${JSON.stringify(FORMAT_TOKEN)}\n`, 'utf8'), root);
      return ok(already);
    }
    if (marker.version === CURRENT_FORMAT_VERSION) {
      syncDirectory(root);
      return ok(already);
    }

    // v1：先按现有契约完整载入一次；坏 layout / 坏资源 / 路径异常都不允许升级。
    const snapshot = readNotesStore({ home });
    if (!snapshot.ok) return fail(snapshot.status, snapshot.code, snapshot.message, snapshot.extra);
    if (snapshot.value.schemaVersion === CURRENT_FORMAT_VERSION) return ok(already);

    const backupId = `backup-v1-${crypto.randomUUID()}`;
    if (!BACKUP_DIR_RE.test(backupId)) {
      return fail(500, 'write-failed', '备份标识生成失败，拒绝升级。');
    }
    const backupDir = path.join(root, backupId);
    let backupCreated = false;
    let publicationStarted = false;
    let result: NotesStoreResult<UpgradeStoreValue>;
    try {
      const formatBytes = readBackupSource(root, path.join(root, FORMAT_FILE), '格式标记');
      const layoutFile = path.join(root, LAYOUT_FILE);
      const layoutBytes = fs.existsSync(layoutFile)
        ? readBackupSource(root, layoutFile, 'layout.json')
        : null;
      const resourceBackups = listResourceFiles(root).map((item) => ({
        name: path.basename(item.file),
        bytes: readBackupSource(root, item.file, `资源 ${item.id}`),
      }));

      createBackupDir(root, backupDir);
      backupCreated = true;
      writeBackupFile(root, path.join(backupDir, FORMAT_FILE), formatBytes, '格式标记备份');
      if (layoutBytes) writeBackupFile(root, path.join(backupDir, LAYOUT_FILE), layoutBytes, '布局备份');
      const backupResourcesDir = path.join(backupDir, RESOURCES_DIR);
      fs.mkdirSync(backupResourcesDir);
      assertSafePath(backupResourcesDir, 'dir', root);
      for (const item of resourceBackups) {
        writeBackupFile(root, path.join(backupResourcesDir, item.name), item.bytes, `资源备份 ${item.name}`);
      }

      syncDirectory(backupResourcesDir);
      syncDirectory(backupDir);
      syncDirectory(root);
      // 仅替换 marker；正文、布局与资源文件原始 bytes 一字不动。
      // 从这里开始，失败也可能已发布新版 marker；不再删除完整备份。
      publicationStarted = true;
      const written = atomicWriteChecked(
        path.join(root, FORMAT_FILE),
        Buffer.from(`${JSON.stringify(FORMAT_TOKEN)}\n`, 'utf8'),
        root,
        sha256Of(formatBytes),
      );
      if (!written.ok) {
        result = fail(409, 'version-conflict', '格式标记在升级期间被其他窗口修改，请重试。', {
          version: written.currentVersion,
        });
      } else {
        result = ok({ schemaVersion: CURRENT_FORMAT_VERSION, requiresUpgrade: false, backup: backupId, backupId });
      }
    } catch (error) {
      result = mapStoreError(error);
    }
    if (backupCreated && !result.ok && !publicationStarted) removeBackupDir(root, backupDir);
    return result;
  });
}

export { FORMAT_TOKEN, RESOURCE_TYPES, MAX_RESOURCES, MAX_TOTAL_RESOURCE_BYTES, MAX_REQUEST_BYTES };
