import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, ChevronDown, Folder, FolderOpen, NotebookPen, FileText, Link2, BookOpen, Image, FileCode, LayoutGrid, MoreHorizontal, Pencil, Trash2, Archive } from 'lucide-react';
import {
  initialParent, resourceFolder, folderDeleteBlockReason,
  canRenameResource, validateFolderName, validateFileTitle, FOLDER_NAME_MAX, FILE_TITLE_MAX,
} from './resource-tree-model.js';

const icons = { note: FileText, course: BookOpen, link: Link2, image: Image, svg: FileCode, html: FileCode };
export { initialFolders, initialParent } from './resource-tree-model.js';

// 键盘导航与初始焦点共用：只算真正可用的菜单项（aria-disabled / 原生 disabled 都排除）。
const ENABLED_MENU_ITEM = '[role="menuitem"]:not([aria-disabled="true"]):not(:disabled)';

export default function ResourceTree({
  folders, resources, search, selectedId, selectedFolder,
  onFolderSelect, onSelect, onOpenDocument, onCanvas,
  canEdit = true, onRenameFolder, onDeleteFolder, onRenameResource, hasCanvasContent,
}) {
  const [closed, setClosed] = useState(new Set());
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

  // ---- 更多菜单（portal 到 .app-shell，复用 import-menu-items 的成套样式） ----
  const rootRef = useRef(null), menuRef = useRef(null);
  const [menu, setMenu] = useState(null), [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const portalHost = useCallback(() => rootRef.current?.closest('.app-shell') || document.body, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const toggleMenu = (event, entry) => {
    event.stopPropagation();
    setMenu((previous) => previous && previous.kind === entry.kind && previous.id === entry.id ? null : { ...entry, trigger: event.currentTarget });
  };
  useEffect(() => {
    if (!menu) return undefined;
    const place = () => {
      const host = portalHost(), button = menu.trigger?.getBoundingClientRect(), box = host?.getBoundingClientRect?.();
      if (!button || !box || (!box.width && !box.height)) return;
      setMenuPos({
        left: Math.max(8, Math.min(button.left - box.left, box.width - 240)),
        top: Math.min(button.bottom - box.top + 4, Math.max(8, box.height - 140)),
      });
    };
    place();
    const outside = (event) => { if (!menuRef.current?.contains(event.target) && !event.target.closest?.('.tree-more')) closeMenu(); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', place);
    // 初始焦点给第一个可用项；全部禁用（如引用文件菜单）时退回首项——禁用项仍可聚焦、带 title 说明。
    (menuRef.current?.querySelector(ENABLED_MENU_ITEM) || menuRef.current?.querySelector('[role="menuitem"]'))?.focus();
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', place); };
  }, [menu, closeMenu, portalHost]);
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
    if (kind === 'folder') {
      const folder = folders.find((item) => item.id === id);
      if (!folder) return null;
      const name = folder.name;
      const deleteHint = deleteHintFor(folder);
      const canRename = Boolean(onRenameFolder), canDelete = Boolean(onDeleteFolder) && !deleteHint;
      return <div ref={menuRef} className="import-menu-items tree-more-menu" role="menu" aria-label={name + ' 的目录操作'}
        style={{ position: 'absolute', left: menuPos.left, top: menuPos.top }} onKeyDown={menuKeys}>
        <button role="menuitem" aria-disabled={!canRename || undefined} title={canRename ? '' : '当前环境未接入重命名。'}
          onClick={() => { if (canRename) startRename('folder', id, folder.name); }}>
          <Pencil size={15} /><span><b>重命名</b></span>
        </button>
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
    return <div ref={menuRef} className="import-menu-items tree-more-menu" role="menu" aria-label={name + ' 的文件操作'}
      style={{ position: 'absolute', left: menuPos.left, top: menuPos.top }} onKeyDown={menuKeys}>
      <button role="menuitem" aria-disabled={!canRename || undefined} title={renameHint}
        onClick={() => { if (canRename) startRename('file', id, resource.title || '未命名.md'); }}>
        <Pencil size={15} /><span><b>重命名</b>{renameHint && <small>{renameHint}</small>}</span>
      </button>
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
    return <div key={folder.id} role="treeitem" aria-expanded={!!open} aria-level={depth + 1}>
      <div className={'tree-row' + (folderActive(folder.id) ? ' is-active' : '') + (folder.kind === 'notebook' ? ' is-notebook' : '')}
        style={{ paddingLeft: 8 + depth * 16 }}>
        {renameField('folder', folder.id, '重命名 ' + folder.name) || <button className="tree-row-label" aria-label={folder.name + ' 文件夹'} onClick={() => {
          pickFolder(folder.id);
          onFolderSelect(folder.id);
          setClosed((prev) => { const next = new Set(prev); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; });
        }}>
          <span className="tree-toggle">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span><Icon size={16} className="tree-icon" /><span className="tree-label">{folder.name}</span>
        </button>}
        {renderMoreButton({ kind: 'folder', id: folder.id }, folder.name)}
      </div>
      {open && <div role="group">
        {folder.kind === 'notebook' && <button className="tree-row tree-canvas" style={{ paddingLeft: 24 + (depth + 1) * 16 }} onClick={() => onCanvas(folder.id)} aria-label={'打开' + folder.name + '画布'}><LayoutGrid size={15} /><span className="tree-label">画布</span></button>}
        {children.map((child) => renderFolder(child, depth + 1))}
        {files.map((resource) => {
          const IconForFile = icons[resource.type] || FileText;
          return <div className={'tree-row tree-file' + (fileActive(resource.id) ? ' is-active' : '')} key={resource.id} style={{ paddingLeft: 24 + (depth + 1) * 16 }}
            role="treeitem" aria-level={depth + 2} draggable={canEdit} onDragStart={(event) => { event.dataTransfer.setData('application/studymate-resource', resource.id); event.dataTransfer.effectAllowed = 'copy'; }}>
            {renameField('file', resource.id, '重命名 ' + resource.title) || <button className="tree-file-open" aria-label={'打开 ' + resource.title} onClick={() => { pickFile(resource.id); onSelect(resource.id); }} onDoubleClick={() => onOpenDocument(resource.id)}><IconForFile size={15} className="tree-icon" /><span className="tree-label">{resource.title || '未命名.md'}</span></button>}
            {resource.origin && <span className="resource-origin-badge" data-origin={resource.origin.mode === 'reference' ? 'link' : 'local'} title={resource.origin.mode === 'reference' ? '只读文件引用，不写回原件' : '独立副本，修改不影响来源'}>{resource.origin.mode === 'reference' ? '引用' : '副本'}</span>}
            {renderMoreButton({ kind: 'file', id: resource.id }, resource.title || '未命名.md')}
          </div>;
        })}
      </div>}
    </div>;
  };
  return <div ref={rootRef} className="resource-tree" role="tree" aria-label="文件层级" onPointerDownCapture={flushRename}>{folders.filter((folder) => !folder.parent).map((folder) => renderFolder(folder, 0))}{query && !Object.values(resources).some(matches) && <div className="empty-state">没有找到文档</div>}{menu && createPortal(renderMenu(), portalHost())}</div>;
}
