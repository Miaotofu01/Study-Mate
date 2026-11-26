import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, ChevronDown, Folder, FolderOpen, NotebookPen, FileText, Link2, BookOpen, Image, FileCode, LayoutGrid, MoreHorizontal, Pencil, Trash2, Archive, Copy } from 'lucide-react';
import {
  resourceFolder, folderDeleteBlockReason, planResourceMove,
  canRenameResource, validateFolderName, validateFileTitle, FOLDER_NAME_MAX, FILE_TITLE_MAX,
} from './resource-tree-model.js';
import { useNotesLocale } from './locale.js';
import './resource-tree-menu.css';

const icons = { note: FileText, course: BookOpen, link: Link2, image: Image, svg: FileCode, html: FileCode };
export { initialFolders, initialParent } from './resource-tree-model.js';

// 键盘导航与初始焦点共用：只算真正可用的菜单项（aria-disabled / 原生 disabled 都排除）。
const ENABLED_MENU_ITEM = '[role="menuitem"]:not([aria-disabled="true"]):not(:disabled)';
// 菜单与触发按钮的间距、菜单离可用外框（视口 ∩ 宿主）的最小距离。
const MENU_GAP = 4;
const MENU_MARGIN = 8;

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);

const viewportRect = () => ({
  left: 0,
  top: 0,
  right: document.documentElement.clientWidth || window.innerWidth,
  bottom: document.documentElement.clientHeight || window.innerHeight,
});

// 从 element 起向上与每一层滚动/裁切祖先（overflow 非 visible）求交，再与 base 相交。
// 菜单与触发按钮都只能在「视口 ∩ 所有会裁切它们的祖先」里出现。
function clippingRect(element, base) {
  let { left, top, right, bottom } = base;
  for (let node = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (!/(auto|scroll|hidden|clip)/.test(style.overflowX + ' ' + style.overflowY)) continue;
    const rect = node.getBoundingClientRect();
    const nodeLeft = rect.left + (node.clientLeft || 0), nodeTop = rect.top + (node.clientTop || 0);
    left = Math.max(left, nodeLeft);
    top = Math.max(top, nodeTop);
    right = Math.min(right, nodeLeft + node.clientWidth);
    bottom = Math.min(bottom, nodeTop + node.clientHeight);
  }
  return { left, top, right, bottom };
}

// 菜单可用的外框：视口 ∩ portal 宿主及其裁切祖先（.app-shell / .studymate-notes 的
// overflow:hidden）。真实外壳里 .app-shell 可能是 static、只占宿主面板的一部分，
// 所以这里不能只拿 .app-shell 自己的矩形。
const usableBounds = (host) => clippingRect(host, viewportRect());

// 触发按钮实际可见的区域：视口再与每一层滚动/裁切祖先求交。
// 完全落在交集之外（被滚出滚动容器或被视口切掉）时，菜单不能继续挂在原地。
const visibleClip = (trigger) => clippingRect(trigger.parentElement, viewportRect());

export default function ResourceTree({
  folders, resources, search, selectedId, selectedFolder,
  onFolderSelect, onSelect, onOpenDocument, onCanvas,
  canEdit = true, onRenameFolder, onDeleteFolder, onRenameResource, hasCanvasContent,
  onCopyMarkdown, canCopyMarkdown, onManageNotebook, getNotebookBindingLabel, onPickEntry, onMoveEntry,
}) {
  const t = useNotesLocale();
  const [closed, setClosed] = useState(new Set());
  const dragEntry = useRef(null);
  const [dropTarget, setDropTarget] = useState(null);
  const startDrag = (event, kind, id) => {
    if (event.target !== event.currentTarget) return;
    if (kind === 'file') {
      event.dataTransfer.setData('application/studymate-resource', id);
      event.dataTransfer.effectAllowed = onMoveEntry ? 'copyMove' : 'copy';
    } else {
      event.dataTransfer.setData('application/studymate-folder', id);
      event.dataTransfer.effectAllowed = 'move';
    }
    dragEntry.current = { kind, id };
  };
  const endDrag = () => { dragEntry.current = null; setDropTarget(null); };
  const canDrop = (id) => canEdit && onMoveEntry && dragEntry.current
    && planResourceMove(folders, resources, dragEntry.current, id);
  const dragOverFolder = (event, id) => {
    if (!canDrop(id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(id);
  };
  const dropOnFolder = (event, id) => {
    const entry = dragEntry.current;
    const accepted = canDrop(id);
    endDrag();
    if (!accepted) return;
    event.preventDefault();
    if (onMoveEntry(entry, id)) setClosed(previous => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  };
  const query = search.trim().toLocaleLowerCase();
  const matches = (resource) => !resource.trashed && (!query || (resource.title + ' ' + (resource.markdown || resource.summary || '')).toLocaleLowerCase().includes(query));
  const hasMatches = (folder) => Object.values(resources).some((resource) => resourceFolder(resource) === folder.id && matches(resource)) || folders.some((child) => child.parent === folder.id && hasMatches(child));

  // 单高亮互斥：文件与文件夹的高亮来自两个互相独立的外部状态（selectedId / selectedFolder），
  // 树内用一份内部 pick 收敛成「同一时刻最多一行 is-active」。点击哪边亮哪边；
  // 外部状态单独变化（画布点卡、程序切笔记本、删除后回退）时跟随变化的那一份。
  const [pick, setPick] = useState(() => selectedId ? { kind: 'file', id: selectedId } : selectedFolder ? { kind: 'folder', id: selectedFolder } : null);
  const lastFileId = useRef(selectedId), lastFolderId = useRef(selectedFolder);
  useEffect(() => {
    if (selectedId === lastFileId.current) return;
    lastFileId.current = selectedId;
    if (selectedId) setPick({ kind: 'file', id: selectedId });
  }, [selectedId]);
  useEffect(() => {
    if (selectedFolder === lastFolderId.current) return;
    lastFolderId.current = selectedFolder;
    if (selectedFolder) setPick({ kind: 'folder', id: selectedFolder });
  }, [selectedFolder]);
  const fileActive = (id) => pick?.kind === 'file' && pick.id === id;
  const folderActive = (id) => pick?.kind === 'folder' && pick.id === id;
  const pickFile = (id) => { lastFileId.current = id; setPick({ kind: 'file', id }); };
  const pickFolder = (id) => { lastFolderId.current = id; setPick({ kind: 'folder', id }); };
  // 只在用户主动点选行时向外报告；外部 selectedId/selectedFolder 变化不报告（那是我方跟随，不是用户选择）。
  // 画布行是笔记本的一部分，报告笔记本目录 id。
  const reportPick = (kind, id) => { onPickEntry?.({ kind, id }); };

  // 笔记本行的绑定摘要：只在调用方给出非空字符串时显示；菜单里的「课程绑定」同理借用这份数据。
  const bindingOf = (folder) => {
    if (folder?.kind !== 'notebook' || typeof getNotebookBindingLabel !== 'function') return '';
    const label = getNotebookBindingLabel(folder);
    return typeof label === 'string' ? label.trim() : '';
  };

  // ---- 更多菜单（portal 到 .app-shell）：锚定触发按钮、按实际尺寸选上下、滚动跟随 ----
  const rootRef = useRef(null), menuRef = useRef(null);
  const [menu, setMenu] = useState(null), [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const portalHost = useCallback(() => rootRef.current?.closest('.app-shell') || document.body, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const toggleMenu = (event, entry) => {
    event.stopPropagation();
    const trigger = event.currentTarget;
    // 先用「宿主坐标」给个即时位置，避免打开那一帧停在旧位置；准确的
    // offsetParent 坐标在 useLayoutEffect（绘制前）里由 placeMenu 校正。
    const buttonRect = trigger.getBoundingClientRect(), hostRect = portalHost().getBoundingClientRect();
    setMenuPos({
      left: Math.round(buttonRect.left - hostRect.left),
      top: Math.round(buttonRect.bottom - hostRect.top + MENU_GAP),
    });
    setMenu((previous) => previous && previous.kind === entry.kind && previous.id === entry.id ? null : { ...entry, trigger });
  };

  // 位置每次都用真实几何重算：按钮走到哪菜单跟到哪；按钮完全滚出视口/滚动容器则收起。
  const placeMenu = useCallback(() => {
    const trigger = menu?.trigger;
    const box = menuRef.current;
    if (!trigger) return;
    if (!trigger.isConnected) { setMenu(null); return; }
    const host = portalHost();
    if (!box || !host) return;
    const triggerRect = trigger.getBoundingClientRect();
    if (!(triggerRect.width > 0 && triggerRect.height > 0)) { setMenu(null); return; }

    const bounds = usableBounds(host);
    if (bounds.right - bounds.left < MENU_MARGIN * 2 || bounds.bottom - bounds.top < MENU_MARGIN * 2) { setMenu(null); return; }
    const clip = visibleClip(trigger);
    if (!(triggerRect.right > clip.left && triggerRect.left < clip.right && triggerRect.bottom > clip.top && triggerRect.top < clip.bottom)) {
      setMenu(null);
      return;
    }

    // 用菜单**实际渲染尺寸**：条目数/禁用项说明都会改变宽高，不能按 240×140 估。
    const menuRect = box.getBoundingClientRect();
    const width = Math.max(1, Math.round(menuRect.width));
    const height = Math.max(1, Math.round(menuRect.height));

    // 水平：优先让菜单左缘贴按钮左缘；右边放不下就改成右缘贴按钮右缘，再夹进可用外框。
    let left = triggerRect.left;
    if (left + width > bounds.right - MENU_MARGIN) left = triggerRect.right - width;
    left = clampNumber(left, bounds.left + MENU_MARGIN, Math.max(bounds.left + MENU_MARGIN, bounds.right - MENU_MARGIN - width));

    // 垂直：默认在按钮下方；下方放不下且上方放得下 → 翻到上方；两边都放不下时选空间大的一侧再夹紧。
    const below = triggerRect.bottom + MENU_GAP;
    const above = triggerRect.top - MENU_GAP - height;
    const spaceBelow = bounds.bottom - MENU_MARGIN - below;
    const spaceAbove = triggerRect.top - MENU_GAP - (bounds.top + MENU_MARGIN);
    let top;
    if (height <= spaceBelow) top = below;
    else if (height <= spaceAbove) top = above;
    else top = spaceAbove > spaceBelow ? above : below;
    top = clampNumber(top, bounds.top + MENU_MARGIN, Math.max(bounds.top + MENU_MARGIN, bounds.bottom - MENU_MARGIN - height));

    // absolute 的坐标原点是 offsetParent 的 padding box；portal 宿主可能是 static（真实外壳里
    // .app-shell 就不是定位元素，原点是 .studymate-notes），所以按菜单自己的 offsetParent 换算。
    const origin = box.offsetParent || host;
    const originRect = origin.getBoundingClientRect();
    const next = {
      left: Math.round(left - (originRect.left + (origin.clientLeft || 0))),
      top: Math.round(top - (originRect.top + (origin.clientTop || 0))),
    };
    setMenuPos((previous) => previous.left === next.left && previous.top === next.top ? previous : next);
  }, [menu, portalHost]);

  useLayoutEffect(() => { if (menu) placeMenu(); }, [menu, placeMenu]);

  // 菜单开着时逐帧锚定：滚动、宿主布局变化、面板滑入滑出都会改按钮几何；
  // 只在几何真的变了才重算（每帧一次 getBoundingClientRect，足够便宜）。
  useEffect(() => {
    if (!menu) return undefined;
    let frame = 0;
    let lastKey = '';
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const trigger = menu.trigger;
      if (!trigger?.isConnected) { setMenu(null); return; }
      const rect = trigger.getBoundingClientRect();
      // 菜单自身的尺寸也进 key：条目随调用方数据增减（如复制可用性变化）时，
      // 即使触发按钮没动也要重算上下方向，否则会压出可用外框。
      const box = menuRef.current?.getBoundingClientRect();
      const key = [rect.left, rect.top, rect.width, rect.height, box?.width, box?.height, window.innerWidth, window.innerHeight].join('|');
      if (key === lastKey) return;
      lastKey = key;
      placeMenu();
    };
    const invalidate = () => { lastKey = ''; };
    frame = requestAnimationFrame(tick);
    document.addEventListener('scroll', invalidate, true);
    window.addEventListener('resize', invalidate);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', invalidate, true);
      window.removeEventListener('resize', invalidate);
    };
  }, [menu, placeMenu]);

  // 外点关闭 + 初始焦点。焦点放在 placeMenu 的绘制前校正之后（useEffect 在 paint 后），
  // 菜单已落到正确位置，focus 不会触发外壳滚动。
  useEffect(() => {
    if (!menu) return undefined;
    const outside = (event) => { if (!menuRef.current?.contains(event.target) && !event.target.closest?.('.tree-more')) closeMenu(); };
    document.addEventListener('pointerdown', outside, true);
    // 初始焦点给第一个可用项；全部禁用（如引用文件菜单）时退回首项——禁用项仍可聚焦、带 title 说明。
    (menuRef.current?.querySelector(ENABLED_MENU_ITEM) || menuRef.current?.querySelector('[role="menuitem"]'))?.focus();
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [menu, closeMenu]);
  const menuKeys = (event) => {
    const items = [...(menuRef.current?.querySelectorAll(ENABLED_MENU_ITEM) || [])];
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); menu.trigger?.focus(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length) {
      event.preventDefault(); event.stopPropagation();
      const index = items.indexOf(document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
    if (event.key === 'Tab') closeMenu();
  };

  // ---- 行内重命名（Enter / 失焦提交，Escape 取消；名字没变不回调） ----
  const [renaming, setRenaming] = useState(null);
  const startRename = (kind, id, original) => { closeMenu(); setRenaming({ kind, id, original, value: original, error: '' }); };
  // 提交对象用调用时传入的快照，不读最新 state：切换目标（pointerdown 先于 click）时
  // 浏览器可能不给被卸载的输入框派发 blur，只靠 onBlur 会静默丢值。
  const commitRename = (state = renaming) => {
    if (!state) return;
    const result = state.kind === 'folder' ? validateFolderName(state.value) : validateFileTitle(state.value);
    if (!result.ok) { setRenaming({ ...state, error: result.error }); return; }
    setRenaming(null);
    if (result.name === state.original) return;
    (state.kind === 'folder' ? onRenameFolder : onRenameResource)?.(state.id, result.name);
  };
  // 根级 pointerdown 捕获阶段先提交未保存的重命名，再放行任何后续 click/失焦路径。
  // 点在重命名输入框（或其错误提示）内部除外——那是正常编辑交互，不能提前收尾。
  const flushRename = (event) => {
    if (!renaming || event.target.closest?.('.tree-rename')) return;
    commitRename(renaming);
  };
  const renameField = (kind, id, ariaLabel) => renaming && renaming.kind === kind && renaming.id === id && (
    <span className="tree-rename">
      <input
        key={kind + ':' + id}
        className={'tree-rename-input' + (renaming.error ? ' is-invalid' : '')}
        aria-label={ariaLabel} aria-invalid={renaming.error ? true : undefined}
        value={renaming.value} autoFocus maxLength={kind === 'folder' ? FOLDER_NAME_MAX : FILE_TITLE_MAX}
        onChange={(event) => setRenaming((previous) => previous && previous.id === id && previous.kind === kind ? { ...previous, value: event.target.value, error: '' } : previous)}
        onBlur={() => commitRename()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenaming(null); }
        }} />
      {renaming.error && <span className="tree-rename-error" role="alert">{renaming.error}</span>}
    </span>
  );

  // ---- 删除：阻断原因统一在 resource-tree-model 的 folderDeleteBlockReason（根目录 / 默认本 /
  //      绑定本 / 非空；含画布经 hasCanvasContent）。菜单里禁用并提醒，这里再兜底 + 二次确认 ----
  const deleteHintFor = (folder) => folderDeleteBlockReason(folders, resources, folder, hasCanvasContent?.(folder.id));
  const requestDelete = (folder) => {
    closeMenu();
    if (!onDeleteFolder || deleteHintFor(folder)) return;
    const label = folder.kind === 'notebook' ? '笔记本' : '文件夹';
    if (!window.confirm('确认删除空' + label + '「' + folder.name + '」？\n只移除这条目录记录，不影响任何笔记与文件；删除后无法撤销。')) return;
    onDeleteFolder(folder.id);
  };

  const renameHintFor = (resource) => {
    // 已移入废纸篓的资源在树里不显示；这里只是兜底（菜单开着时被外部标 trashed 的那一帧）。
    if (resource?.trashed) return '已移入废纸篓，暂不支持重命名。';
    if (!canRenameResource(resource)) return '引用文件的名称跟随来源，暂不支持重命名。';
    return onRenameResource ? '' : '当前环境未接入重命名。';
  };

  const renderMoreButton = (entry, name) => {
    const open = menu?.kind === entry.kind && menu?.id === entry.id;
    return <button
      className="icon-button tree-more" data-tree-more="1"
      aria-label={name + '的更多操作'} title="更多操作"
      aria-haspopup="menu" aria-expanded={open} disabled={!canEdit}
      onClick={(event) => toggleMenu(event, entry)}>
      <MoreHorizontal size={14} />
    </button>;
  };

  // 目标消失或转只读时收起菜单/行内编辑。不能放在 render 里做（渲染期 setState 是
  // 生命周期问题，且目标消失前的那一帧仍会把过期数据画到屏幕上）。
  const menuMissing = useCallback((state) => {
    if (!state) return false;
    if (state.kind === 'folder') return !folders.some((item) => item.id === state.id);
    const resource = resources[state.id];
    return !resource || Boolean(resource.trashed);
  }, [folders, resources]);
  useEffect(() => { if (menuMissing(menu)) setMenu(null); }, [menu, menuMissing]);
  useEffect(() => {
    if (renaming && menuMissing(renaming)) setRenaming(null);
  }, [renaming, menuMissing]);
  // 异步进入只读门禁（外部轮询失败 / reloadStore）时，已打开的菜单会 portal 到 .app-shell
  // 末尾并叠在 .persistence-gate 之上（同为 z-index 80，DOM 顺序在后），穿透 inert 仍可点。
  useEffect(() => { if (!canEdit) { setMenu(null); setRenaming(null); } }, [canEdit]);

  const renderMenu = () => {
    if (!menu || !canEdit) return null;
    const { kind, id } = menu;
    const menuStyle = { position: 'absolute', left: menuPos.left, top: menuPos.top };
    if (kind === 'folder') {
      const folder = folders.find((item) => item.id === id);
      if (!folder) return null;
      const name = folder.name;
      const deleteHint = deleteHintFor(folder);
      const canRename = Boolean(onRenameFolder), canDelete = Boolean(onDeleteFolder) && !deleteHint;
      const isNotebook = folder.kind === 'notebook';
      const canManageBinding = isNotebook && Boolean(onManageNotebook);
      return <div ref={menuRef} className="import-menu-items tree-more-menu" role="menu" aria-label={name + ' 的目录操作'}
        style={menuStyle} onKeyDown={menuKeys}>
        <button role="menuitem" aria-disabled={!canRename || undefined} title={canRename ? '' : '当前环境未接入重命名。'}
          onClick={() => { if (canRename) startRename('folder', id, folder.name); }}>
          <Pencil size={15} /><span><b>重命名</b></span>
        </button>
        {isNotebook && <button role="menuitem" aria-disabled={!canManageBinding || undefined}
          title={canManageBinding ? '管理「' + name + '」的课程绑定。' : '当前环境未接入课程绑定。'}
          onClick={() => { if (!canManageBinding) return; closeMenu(); onManageNotebook(id); }}>
          <BookOpen size={15} /><span><b>课程绑定</b>{!canManageBinding && <small>当前环境未接入课程绑定</small>}</span>
        </button>}
        <button role="menuitem" aria-disabled={!canDelete || undefined} title={deleteHint || (canDelete ? '' : '当前环境未接入删除。')}
          onClick={() => { if (canDelete) requestDelete(folder); }}>
          <Trash2 size={15} /><span><b>删除</b>{deleteHint && <small>{deleteHint}</small>}</span>
        </button>
      </div>;
    }
    const resource = resources[id];
    // 与 menuMissing 同口径的双保险：废纸篓里的资源在树里不显示，菜单也不该画出来
    // （effect 会在下一帧收掉，但这一帧不该把过期目标画到屏幕上）。
    if (!resource || resource.trashed) return null;
    const name = resource.title || '未命名.md';
    const renameHint = renameHintFor(resource);
    const canRename = !renameHint;
    // 「复制 Markdown」完全由调用方的 canCopyMarkdown 决定是否提供；回调没接上时仍保留条目但禁用，
    // 与重命名/删除的「有 UI 无接线」语义一致。
    const canCopy = typeof canCopyMarkdown === 'function' && canCopyMarkdown(resource) === true;
    const canCopyNow = canCopy && Boolean(onCopyMarkdown);
    return <div ref={menuRef} className="import-menu-items tree-more-menu" role="menu" aria-label={name + ' 的文件操作'}
      style={menuStyle} onKeyDown={menuKeys}>
      <button role="menuitem" aria-disabled={!canRename || undefined} title={renameHint}
        onClick={() => { if (canRename) startRename('file', id, resource.title || '未命名.md'); }}>
        <Pencil size={15} /><span><b>重命名</b>{renameHint && <small>{renameHint}</small>}</span>
      </button>
      {canCopy && <button role="menuitem" aria-disabled={!canCopyNow || undefined}
        title={canCopyNow ? '把这份 Markdown 复制到剪贴板。' : '当前环境未接入复制。'}
        onClick={() => { if (!canCopyNow) return; closeMenu(); onCopyMarkdown(id); }}>
        <Copy size={15} /><span><b>复制 Markdown</b>{!canCopyNow && <small>当前环境未接入复制</small>}</span>
      </button>}
      <button role="menuitem" aria-disabled="true" title="归档尚未实现，先占位。">
        <Archive size={15} /><span><b>归档</b><small>尚未实现，先占位</small></span>
      </button>
    </div>;
  };

  const renderFolder = (folder, depth) => {
    const children = folders.filter((item) => item.parent === folder.id);
    const files = Object.values(resources).filter((item) => resourceFolder(item) === folder.id && matches(item));
    if (query && !hasMatches(folder)) return null;
    const open = query || !closed.has(folder.id);
    const Icon = folder.kind === 'notebook' ? NotebookPen : open ? FolderOpen : Folder;
    const binding = bindingOf(folder);
    return <div key={folder.id} role="treeitem" aria-expanded={!!open} aria-level={depth + 1}>
      <div className={'tree-row' + (folderActive(folder.id) ? ' is-active' : '') + (folder.kind === 'notebook' ? ' is-notebook' : '')}
        style={{ paddingLeft: 8 + depth * 16 }} data-drop-target={dropTarget === folder.id || undefined}
        draggable={canEdit && Boolean(onMoveEntry) && folder.kind === 'folder' && Boolean(folder.parent) && renaming?.id !== folder.id}
        onDragStart={event => startDrag(event, 'folder', folder.id)} onDragEnd={endDrag}
        onDragOver={event => dragOverFolder(event, folder.id)} onDrop={event => dropOnFolder(event, folder.id)}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(previous => previous === folder.id ? null : previous); }}>
        {renameField('folder', folder.id, t('rename_named', { name: folder.name })) || <button className="tree-row-label" aria-label={t('folder', { name: folder.name })} onClick={() => {
          pickFolder(folder.id);
          onFolderSelect(folder.id);
          reportPick('folder', folder.id);
          setClosed((prev) => { const next = new Set(prev); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; });
        }}>
          <span className="tree-toggle">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span><Icon size={16} className="tree-icon" /><span className="tree-label">{folder.name}</span>
          {binding && <span className="tree-binding" data-tree-binding="1" title={binding}>{binding}</span>}
        </button>}
        {renderMoreButton({ kind: 'folder', id: folder.id }, folder.name)}
      </div>
      {open && <div role="group">
        {folder.kind === 'notebook' && <button className="tree-row tree-canvas" style={{ paddingLeft: 24 + (depth + 1) * 16 }} onClick={() => { onCanvas(folder.id); reportPick('folder', folder.id); }} aria-label={t('open_canvas', { name: folder.name })}><LayoutGrid size={15} /><span className="tree-label">{t('canvas')}</span></button>}
        {children.map((child) => renderFolder(child, depth + 1))}
        {files.map((resource) => {
          const IconForFile = icons[resource.type] || FileText;
          return <div className={'tree-row tree-file' + (fileActive(resource.id) ? ' is-active' : '')} key={resource.id} style={{ paddingLeft: 24 + (depth + 1) * 16 }}
            role="treeitem" aria-level={depth + 2} draggable={canEdit && renaming?.id !== resource.id}
            onDragStart={event => startDrag(event, 'file', resource.id)} onDragEnd={endDrag}>
            {renameField('file', resource.id, t('rename_named', { name: resource.title })) || <button className="tree-file-open" aria-label={t('open', { name: resource.title })} onClick={() => { pickFile(resource.id); onSelect(resource.id); reportPick('file', resource.id); }} onDoubleClick={() => onOpenDocument(resource.id)}><IconForFile size={15} className="tree-icon" /><span className="tree-label">{resource.title || t('untitled')}</span></button>}
            {resource.origin && <span className="resource-origin-badge" data-origin={resource.origin.mode === 'reference' ? 'link' : 'local'} title={t(resource.origin.mode === 'reference' ? 'reference_hint' : 'copy_hint')}>{t(resource.origin.mode === 'reference' ? 'reference' : 'copy')}</span>}
            {renderMoreButton({ kind: 'file', id: resource.id }, resource.title || t('untitled'))}
          </div>;
        })}
      </div>}
    </div>;
  };
  return <div ref={rootRef} className="resource-tree" role="tree" aria-label={t('hierarchy')} onPointerDownCapture={flushRename}>{folders.filter((folder) => !folder.parent).map((folder) => renderFolder(folder, 0))}{query && !Object.values(resources).some(matches) && <div className="empty-state">{t('no_documents')}</div>}{menu && createPortal(renderMenu(), portalHost())}</div>;
}
