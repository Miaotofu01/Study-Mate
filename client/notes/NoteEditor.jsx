import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MAX_MARKDOWN_LENGTH } from './markdown-inline.js';
import MarkdownPreview from './MarkdownPreview.jsx';
import MarkdownInlineEditor from './MarkdownInlineEditor.jsx';
import MarkdownFormatToolbar from './MarkdownFormatToolbar.jsx';
import { formatMarkdown } from './markdown-formatting.js';
import { downloadNoteMarkdown } from './note-export.js';
import { Download } from 'lucide-react';
import './note-editor.css';
import { useNotesLocale, nt } from './locale.js';

const OVERSIZE_MESSAGE = 'oversize';
const SAVE_ERROR = 'save_error';

// 切资源、切画布/文档、聊天面板或学习节点都会把编辑器卸载，本地草稿随 state 一起消失。
// 这里在内存里留一份「离开时还没被父级确认的草稿」：不写文件、不落盘，回到同一文件时
// 恢复出来并标明未保存，由用户决定导出还是丢弃；期间文件被外部改过就按冲突锁定，绝不
// 用旧草稿盖新版本。
//
// 两个约束决定了它不是简单的一张 id→草稿表：
// 1. 同一份文件可能同时挂在无界笔记与学习节点两处（两个 NoteEditor 实例），任一「干净」
//    实例都不能把另一实例的未确认草稿清掉，所以按实例 token 分开存，只有写入者能删自己那条。
// 2. 未解决冲突一起存（conflict），否则「冲突中离开、回来」会被洗成干净预览，等于把
//    冲突悄悄抹掉。
const draftStash = new Map();
const liveDraftOwners = new Set();
// 同一 commit 里挂上的第二个同 id 实例，在它的 effect 跑之前也会来认领；只靠
// liveDraftOwners 会把前一个实例刚写下的条目当成「死实例遗物」抢走。所以 owner 在
// 首次 render 就登记为 reserved，认领时两者都算「还在页面上」。
const reservedDraftOwners = new Set();
let draftOwnerSeq = 0;
const nextDraftOwner = () => 'note-draft-' + (++draftOwnerSeq);
const draftOwnerAlive = (owner) => liveDraftOwners.has(owner) || reservedDraftOwners.has(owner);

// 关闭页面/刷新/宿主整页卸载时，未确认草稿只在内存里。监听器挂在 window 上（而不是某个
// 编辑器实例上），实例卸载后仍然有效；用 window 上的标记保证只挂一次，SSR 与热更新都安全。
function ensureDraftUnloadGuard() {
  if (typeof window === 'undefined') return;
  if (window.__studymateNotesDraftGuard) return;
  window.__studymateNotesDraftGuard = true;
  window.addEventListener('beforeunload', (event) => {
    if (!draftStash.size) return undefined;
    event.preventDefault();
    event.returnValue = '';
    return '';
  });
}

function writeStashedDraft(resourceId, owner, entry) {
  if (!resourceId) return;
  let entries = draftStash.get(resourceId);
  if (!entries) { entries = new Map(); draftStash.set(resourceId, entries); }
  entries.set(owner, { ...entry, owner, at: Date.now() });
  ensureDraftUnloadGuard();
}

// 只认「已经不在页面上的实例」留下的草稿，避免抢走同 id 另一个活实例手里的内容。
// 认领（adopt）必须发生在挂载时，而不是留在 Map 里等下一次：旧条的 owner 已经不在页面上，
// 新实例若只是「读了一份副本」而不接手，之后点「放弃」或变干净时删的是新 owner 的条目，
// 旧条会在下一次 remount 时复活。所以认领 = 把该 id 下所有已死实例的条目摘出 Map，
// 最新的一份由新实例接管（并立刻写下新 owner 的条目），更早且内容不同的并入 older，
// 由界面提供「导出更早的草稿」，不静默掩埋。
function adoptStashedDraft(resourceId, owner, markdown) {
  const entries = resourceId ? draftStash.get(resourceId) : null;
  if (!entries || !entries.size) return null;
  const dead = [];
  for (const entry of entries.values()) if (!draftOwnerAlive(entry.owner)) dead.push(entry);
  if (!dead.length) return null;
  // 认领时把每条死条目连同它自己带着的 older 一起摊平：older 里的旧草稿可能是更早
  // 一次认领并进来的，直接 delete 会把它们永久丢掉。
  const flat = [];
  for (const entry of dead) {
    flat.push({ draft: entry.draft, base: entry.base, conflict: Boolean(entry.conflict), at: entry.at || 0 });
    for (const old of entry.older || []) {
      flat.push({ draft: old.draft, base: old.base, conflict: Boolean(old.conflict), at: old.at || 0 });
    }
    entries.delete(entry.owner);
  }
  if (!entries.size) draftStash.delete(resourceId);
  flat.sort((a, b) => b.at - a.at);
  const best = flat[0];
  const older = [];
  for (const item of flat.slice(1)) {
    if (item.draft === best.draft || older.some(entry => entry.draft === item.draft)) continue;
    older.push(item);
  }
  // 最新一稿已经等于正文（父级其实确认过它）时也不能把 older 丢掉：它们仍是用户没保存
  // 过的东西，必须继续在界面上可导出/可显式丢弃，直到用户自己决定。
  const adopted = best.draft === markdown
    ? { draft: markdown, base: markdown, conflict: false, older }
    : { draft: best.draft, base: best.base, conflict: best.conflict, older };
  if (!adopted.older.length && adopted.draft === markdown) return null;
  writeStashedDraft(resourceId, owner, adopted);
  return adopted;
}

function deleteStashedDraft(resourceId, owner) {
  const entries = resourceId ? draftStash.get(resourceId) : null;
  if (!entries) return;
  entries.delete(owner);
  if (!entries.size) draftStash.delete(resourceId);
}

// Each resource owns its editor lifetime. A newly selected file never receives
// the previous file's draft, undo history, selection or deferred composition.
export default function NoteEditor(props) {
  return <NoteDocument key={props.resource?.id || 'empty-note'} {...props} />;
}

function NoteDocument({ resource, onChange, readOnly = false, theme = 'light', label: suppliedLabel, exportTarget, mode = 'inline' }) {
  useNotesLocale();
  const label = suppliedLabel ?? nt('markdown');
  const [splitSide, setSplitSide] = useState('source');
  const [splitWidth, setSplitWidth] = useState(50);
  const [narrowSplit, setNarrowSplit] = useState(false);
  const panesRef = useRef(null);
  const split = mode === 'split';
  const showEditor = mode !== 'preview' && (!split || !narrowSplit || splitSide === 'source');
  const showPreview = mode === 'preview' || (split && (!narrowSplit || splitSide === 'preview'));
  const changeSplitWidth = (width) => setSplitWidth(Math.min(75, Math.max(25, Math.round(width))));
  const moveDivider = (event) => {
    const box = panesRef.current?.getBoundingClientRect();
    if (box?.width) changeSplitWidth((event.clientX - box.left) * 100 / box.width);
  };
  const markdown = String(resource?.markdown ?? '');
  const resourceId = resource?.id || '';
  // 本实例唯一 token：暂存按它分条，干净实例不会清掉别人的草稿。
  const ownerRef = useRef(null);
  // 首次 render 就登记（见 reservedDraftOwners 注释）：否则同一 commit 里后挂的实例
  // 会把先挂实例刚写下的条目误判成死实例遗物。
  if (!ownerRef.current) { ownerRef.current = nextDraftOwner(); reservedDraftOwners.add(ownerRef.current); }
  const owner = ownerRef.current;
  // 只读一次：恢复的是「上次离开时」的快照，之后由 effect 继续维护。
  const stashRef = useRef(adoptStashedDraft(resourceId, owner, markdown));
  const olderRef = useRef(stashRef.current ? stashRef.current.older : []);
  const [olderDrafts, setOlderDrafts] = useState(olderRef.current);
  const restored = Boolean(stashRef.current) && stashRef.current.draft !== markdown;
  const stashedConflict = restored && Boolean(stashRef.current.conflict || stashRef.current.base !== markdown);
  const [draft, setDraft] = useState(restored ? stashRef.current.draft : markdown);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState({ text: markdown, from: 0, to: 0 });
  const apiRef = useRef(null);
  const rootRef = useRef(null);
  const lastPropRef = useRef(markdown);
  const lastSentRef = useRef(null);
  const draftRef = useRef(markdown);
  // 渲染期同步：effect 里要拿「本次渲染的草稿」判断它是否已被父级确认。
  draftRef.current = draft;
  const oversize = draft.length > MAX_MARKDOWN_LENGTH;
  // 未确认的本地编辑：草稿与资源正文不一致，说明这次改动没被父级接受
  // （markEdit() 静默拒绝，或 onChange 抛错）。只读态不能把它当成已保存。
  const unconfirmed = draft !== markdown;
  // 草稿的 base 与当前文件版本不同：离开期间文件被外部改过，恢复出来的草稿不能当成干净预览。
  const [externalNotice, setExternalNotice] = useState(stashedConflict);
  const [recovered, setRecovered] = useState(restored);
  // 冲突：外部新版已到，但本地有一份没被父级确认的草稿。此时若放行编辑，用户的下一次
  // 输入会以「旧草稿 + 新字符」整体写回，把外部新版静默覆盖掉——所以冲突期间锁定编辑，
  // 只保留「看得见 / 导得出 / 显式载入文件版本」三条路。解冲突必须由用户点按钮完成。
  const conflict = externalNotice;
  const locked = readOnly || conflict;
  const readOnlySource = readOnly && !conflict && (mode === 'edit' || split);

  useEffect(() => {
    const panes = panesRef.current;
    if (!split || (locked && !readOnlySource) || !panes) return undefined;
    const measure = () => setNarrowSplit(panes.clientWidth < 540);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panes);
    return () => observer.disconnect();
  }, [split, locked, readOnlySource]);

  useEffect(() => {
    if (markdown === lastPropRef.current) return;
    const previous = lastPropRef.current;
    lastPropRef.current = markdown;
    // 冲突没解决之前，任何迟到的回声都不能把它自动清掉，也不许碰草稿：
    // 用户看到的告警只应由他自己的动作（载入文件版本）结束。
    if (conflict) return;
    if (lastSentRef.current !== null && markdown === lastSentRef.current) {
      lastSentRef.current = null;
      // 自己的回传：草稿已被父级确认，之前那条「文件已在外部更新」告警不再成立。
      setExternalNotice(false);
      return;
    }
    lastSentRef.current = null;
    // 到这里这个正文不是「刚落地的自己人」，正文本身又不能证明来源（外部写入完全可能
    // 碰巧等于某次旧输入）。草稿若已相对上一份 props 改过（只读、正常编辑都一样），
    // 就不能用这份正文静默覆盖——保留草稿并锁定，让用户决定导出还是显式载入。
    // 代价：迟到的旧回声可能被误判成外部更新并误锁；换来的是绝不覆盖。
    if (draftRef.current !== previous) {
      setExternalNotice(true);
      return;
    }
    setExternalNotice(false);
    setDraft(markdown);
    setError('');
    // The inline editor handles genuine external updates during IME; its own
    // echo must not recreate the view or move the user's cursor.
  }, [markdown, readOnly, conflict]);

  // 本实例在线期间登记；卸载后它的暂存才对别的实例可见。
  useEffect(() => {
    reservedDraftOwners.delete(owner);
    liveDraftOwners.add(owner);
    return () => {
      liveDraftOwners.delete(owner);
      reservedDraftOwners.delete(owner);
    };
  }, [owner]);

  // olderDrafts 也是依赖：用户点「丢弃这些旧草稿」后要立刻改写/删除暂存条目，
  // 否则条目里还留着 older，下一次挂载会把它复活。
  useEffect(() => {
    if (!resourceId) return;
    if (draft !== markdown || externalNotice || olderRef.current.length) {
      writeStashedDraft(resourceId, owner, { draft, base: markdown, conflict: externalNotice, older: olderRef.current });
    } else {
      deleteStashedDraft(resourceId, owner);
    }
  }, [resourceId, owner, draft, markdown, externalNotice, olderDrafts]);

  // 关闭页面/刷新的拦截由模块级 ensureDraftUnloadGuard() 挂在 window 上：实例卸载后
  // 仍然有效，也不受 StrictMode 双挂载影响（见文件顶部）。

  const handleChange = useCallback((value) => {
    const next = String(value ?? '');
    if (next.length > MAX_MARKDOWN_LENGTH) {
      setError(OVERSIZE_MESSAGE);
      return false;
    }
    setDraft(next);
    lastSentRef.current = next;
    try {
      onChange?.(next);
      setError('');
      return true;
    } catch {
      lastSentRef.current = null;
      setError(SAVE_ERROR);
      return false;
    }
  }, [onChange]);

  const acceptApi = useCallback((api) => {
    apiRef.current = api;
    setReady(Boolean(api));
    if (api) setSelection(api.read());
  }, []);
  const acceptSelection = useCallback((value) => setSelection(value), []);
  const runCommand = useCallback((command, value, popupSnapshot) => {
    const api = apiRef.current;
    if (!api || readOnly || oversize) return;
    if (command === 'undo' || command === 'redo') {
      api[command]?.();
      api.focus?.();
      setSelection(api.read());
      setError('');
      return;
    }
    try {
      // Ordinary buttons use the current raw coordinates. A link dialog keeps
      // its original selection, but cannot apply it to a changed document.
      const current = api.read();
      if (popupSnapshot && popupSnapshot.text !== current.text) {
        setError('stale_link');
        return;
      }
      const edit = formatMarkdown(popupSnapshot || current, command, value);
      if (!edit) {
        setError('');
        api.focus?.();
        return;
      }
      if (api.edit(edit) === false) {
        setError('format_refused');
        return;
      }
      setError('');
      setSelection(api.read());
    } catch (cause) {
      setError(cause?.message ? { message: cause.message } : 'format_error');
    }
  }, [readOnly, oversize]);

  const handleExport = useCallback(() => {
    try {
      // 编辑态导出编辑器持有的权威原稿（api.read().text 与格式命令同源，IME 期间
      // 也是同步读状态，不会拿到陈旧 draft）；编辑器未就绪时回退到 draft。
      // 只读与冲突锁定都导出 draft：这是用户眼前、且尚未写入文件的内容。
      const api = apiRef.current;
      const current = locked ? draft : (api ? api.read().text : draft);
      downloadNoteMarkdown({ title: resource?.title, markdown: current });
      setError('');
    } catch (cause) {
      setError(cause?.message || '导出失败，请重试。');
    }
  }, [resource?.title, locked, draft]);

  const exportOlderDrafts = useCallback(() => {
    const drafts = olderRef.current;
    if (!drafts.length) return;
    try {
      const markdown = drafts.map((entry, index) => `=== 更早的未保存草稿 ${index + 1}（未写入文件）===\n\n${entry.draft}`).join('\n\n');
      downloadNoteMarkdown({ title: `${resource?.title || '未命名'} 的未保存草稿`, markdown });
      setError('');
    } catch (cause) {
      setError(cause?.message || '导出失败，请重试。');
    }
  }, [resource?.title]);

  // 旧草稿只在用户显式动作后消失（导出或丢弃），不做「变干净就清空」。
  const dropOlderDrafts = useCallback(() => {
    olderRef.current = [];
    setOlderDrafts([]);
  }, []);

  // 用户显式确认：放弃本地草稿，改看文件版本（不写任何东西，只是把 props 正文装回草稿）。
  const loadExternalVersion = useCallback(() => {
    if (!conflict) return;
    // 直接在 window 上调用 confirm：调用点明确是浏览器的确认对话框，
    // 也不提前缓存方法引用，宿主/测试替换 window.confirm 即可接管此处行为。
    if (typeof window !== 'undefined' && typeof window.confirm === 'function'
      && !window.confirm('载入文件版本会放弃当前尚未保存的本地草稿（可先导出保存）。继续吗？')) return;
    lastSentRef.current = null;
    setDraft(markdown);
    setError('');
    setExternalNotice(false);
    setRecovered(false);
  }, [conflict, markdown]);

  const onKeyDown = (event) => {
    if (event.defaultPrevented || event.isComposing || event.nativeEvent?.isComposing || readOnly || oversize || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.target.closest?.('input, textarea, select')) return;
    const key = event.key.toLowerCase();
    if (key === 'b' || key === 'i') {
      event.preventDefault(); event.stopPropagation();
      runCommand(key === 'b' ? 'bold' : 'italic');
    } else if (key === 'k') {
      event.preventDefault(); event.stopPropagation();
      rootRef.current?.querySelector('[data-command="link"]')?.click();
    } else if (key === 'z' || key === 'y') {
      event.preventDefault(); event.stopPropagation();
      runCommand(key === 'y' || event.shiftKey ? 'redo' : 'undo');
    }
  };

  // 按钮渲染在所属标题栏，但仍由同一个编辑器实例读取原稿。
  // undefined 表示没有外部标题栏，null 表示标题栏尚未挂载。
  const exportButton = exportTarget === undefined ? <div className="note-editor__actions">
    <button type="button" className="note-editor__export" aria-label="导出当前 Markdown" title="导出当前 Markdown" onClick={handleExport}><Download size={14} aria-hidden="true" />导出 Markdown</button>
  </div> : exportTarget && createPortal(
    <button type="button" className="icon-button note-editor__export-icon" aria-label="导出当前 Markdown" title="导出当前 Markdown" onClick={handleExport}><Download size={16} aria-hidden="true" /></button>,
    exportTarget,
  );

  // error 可能是词典键（'oversize'/'save_error'/'stale_link'…）、动态句子或 { message } 对象；
  // 统一在这里翻译成可渲染文本，词典没有的键原样返回，不影响动态消息。
  const errorText = error == null ? '' : typeof error === 'string' ? nt(error) : String(error.message ?? error);

  // 只读与「外部新版 vs 未保存草稿」冲突共用这一屏：没有编辑器就没有写入路径，
  // 冲突期间不可能再用旧草稿覆盖新版本。解冲突只能由用户显式点「载入文件版本」。
  if (locked && !readOnlySource) return <section className="note-editor is-readonly" data-theme={theme} data-conflict={conflict ? '1' : undefined} aria-label={label} data-testid="note-editor">
    {exportButton}
    {conflict && <div className="note-editor__actions"><button type="button" className="note-editor__export" onClick={loadExternalVersion} aria-label="载入文件版本" title="放弃本地草稿，改为显示文件里的版本">载入文件版本（放弃本地草稿）</button></div>}
    {error && <p className="note-editor__error" role="alert">{errorText}</p>}
    {conflict && <p className="note-editor__error" role="alert">文件已在外部更新；这里保留你尚未保存的草稿（未写入文件）。为避免覆盖新版本，编辑已暂停。</p>}
    {unconfirmed && <p className="note-editor__error" role="status">当前显示的是尚未保存的本地草稿，未写入文件。</p>}
    {olderDrafts.length > 0 && <p className="note-editor__status" role="status">还有 {olderDrafts.length} 份更早的未保存草稿没有写入文件。
      <button type="button" className="note-editor__link" onClick={exportOlderDrafts}>导出更早的草稿</button>
      <button type="button" className="note-editor__link" onClick={dropOlderDrafts}>丢弃这些旧草稿</button>
    </p>}
    {/* 预览同样读 draft：只读切换前那一笔未提交的编辑（父级静默拒绝或 onChange 抛错）
        仍要看得见，不能退回旧的 resource.markdown；上面的状态行同时说明它没被保存。 */}
    <div className="note-editor__preview markdown-preview"><MarkdownPreview>{draft}</MarkdownPreview></div>
  </section>;

  return <section ref={rootRef} className="note-editor" data-theme={theme} data-mode={mode} aria-label={label} data-testid="note-editor" onKeyDownCapture={mode === 'inline' ? onKeyDown : undefined}>
    {mode === 'inline' && <MarkdownFormatToolbar onCommand={runCommand} selection={selection} disabled={!ready || oversize} />}
    {exportButton}
    {recovered && !conflict && <p className="note-editor__status" role="status">已恢复上次离开这个文件时的未保存草稿（未写入文件）。
      <button type="button" className="note-editor__link" onClick={() => { deleteStashedDraft(resourceId, owner); setDraft(markdown); setRecovered(false); setError(''); }}>放弃本地草稿，载入文件版本</button>
    </p>}
    {olderDrafts.length > 0 && <p className="note-editor__status" role="status">还有 {olderDrafts.length} 份更早的未保存草稿没有写入文件。
      <button type="button" className="note-editor__link" onClick={exportOlderDrafts}>导出更早的草稿</button>
      <button type="button" className="note-editor__link" onClick={dropOlderDrafts}>丢弃这些旧草稿</button>
    </p>}
    {oversize && <p className="note-editor__error" role="alert">{nt(OVERSIZE_MESSAGE)}</p>}
    {split && narrowSplit && <div className="note-editor__split-tabs" role="group" aria-label="双列可见侧">
      <button type="button" aria-pressed={splitSide === 'source'} onClick={() => setSplitSide('source')}>源码</button>
      <button type="button" aria-pressed={splitSide === 'preview'} onClick={() => setSplitSide('preview')}>预览</button>
    </div>}
    <div ref={panesRef} className={'note-editor__panes' + (split && !narrowSplit ? ' is-split' : '')} style={{ '--document-source-width': splitWidth + '%' }}>
      {/* 保持同一 EditorView：临时预览不能卸载/清空撤销、中文组合或原稿坐标。 */}
      <div className="note-editor__source" hidden={!showEditor}>
        <MarkdownInlineEditor value={draft} onChange={handleChange} onApi={acceptApi} onSelectionChange={acceptSelection} theme={theme} label={label} readOnly={readOnly} sourceMode={mode === 'edit' || split} />
      </div>
      {split && !narrowSplit && <div className="document-split-handle" role="separator" tabIndex={0} aria-label="调整编辑与预览宽度" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={splitWidth}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          moveDivider(event);
        }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveDivider(event); }}
        onDoubleClick={() => changeSplitWidth(50)}
        onKeyDown={event => {
          const changes = { ArrowLeft: splitWidth - 3, ArrowRight: splitWidth + 3, Home: 25, End: 75 };
          if (!Object.hasOwn(changes, event.key)) return;
          event.preventDefault();
          changeSplitWidth(changes[event.key]);
        }} />}
      {showPreview && <div className="note-editor__preview markdown-preview"><MarkdownPreview>{draft}</MarkdownPreview></div>}
    </div>
    {error && !oversize && <p className="note-editor__error" role="alert">{errorText}</p>}
  </section>;
}

export { MAX_MARKDOWN_LENGTH };
