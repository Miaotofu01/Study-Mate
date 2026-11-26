import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, useReactFlow, useNodesInitialized, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, FolderPlus, FileText, Link2, HelpCircle, RotateCcw, X, Undo2, Redo2, ZoomIn, ZoomOut, Maximize, Hand, MousePointer2, Type, Trash2, LayoutDashboard, Sun, Moon, LocateFixed, Copy, RefreshCw, NotebookPen } from 'lucide-react';
import { makeDemo, card, textCard, edge } from './fixtures.js';
import { BoardContext } from './BoardContext.js';
import { nodeTypes, edgeTypes, COLLAPSED_CARD_HEIGHT, TEXT_NODE_MIN_HEIGHT } from './CanvasNodes.jsx';
import ResourceTree, { initialFolders, initialParent } from './ResourceTree.jsx';
import { folderDeleteBlockReason, canRenameResource, validateFolderName, validateFileTitle, planResourceMove } from './resource-tree-model.js';
import MediaRenderer from './MediaRenderer.jsx';
import ImportControls from './ImportControls.jsx';
import { IMPORT_FILE_ACCEPT, IMPORT_PICKER_TYPES, captureFileDrop, readImportedEntry, resolveFileReference, isFileReference, originDescription, gridAppearance } from './imports.js';
import useNotesPersistence, { SaveState } from './useNotesPersistence.js';
import ChatPanel from './ChatPanel.jsx';
import NoteEditor from './NoteEditor.jsx';
import NoteTitleInput from './NoteTitleInput.jsx';
import { isMarkdownResource, isUnsupportedNote, noteExtension, copyNoteTitle } from './note-types.js';
import CourseReference from './CourseReference.jsx';
import { NodeNotebookTree, NotesStatus } from './LearningNotes.jsx';
import { CourseAssociationBar, CourseAssociationOption, NotebookBindingsForm, NoteAssociationsForm, notebookBindingLabel } from './CourseRelations.jsx';
import { createNotesWorkspace, sameSubject, sameCourse, courseRef, normalizeCourseRef, associateNote, notebookOf, ownedNote, resolveCourse } from './curriculum.js';
import { corruptMessage } from './corrupt.js';
import { useNotesLocale, nt } from './locale.js';
import './layout-v2.css';
import './components-v2.css';
import './theme-v3.css';
import './ui-v4.css';
import './ui-v5.css';

const DOCUMENT_MODES = [['preview', 'document_mode_preview'], ['edit', 'document_mode_edit'], ['split', 'document_mode_split'], ['inline', 'document_mode_inline']];

const uid = (prefix) => prefix + '-' + crypto.randomUUID();
const standaloneMotionScale = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1;
function folderPath(folders, id) {
  const names = [], seen = new Set();
  while (id && !seen.has(id)) {
    const folder = folders.find(item => item.id === id);
    if (!folder) return '目标已不可用';
    seen.add(id); names.unshift(folder.name); id = folder.parent;
  }
  return names.join(' › ') || '目标已不可用';
}
const editable = (target) => target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"], .cm-editor, .note-editor'));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const fresh = () => {
  const demo = makeDemo();
  return { ...demo, resources: Object.fromEntries(Object.entries(demo.resources).map(([id, resource]) => [id, { ...resource, parent: initialParent(resource) }])), nodes: demo.scene.nodes.map(({ dragHandle, ...node }) => node), edges: demo.scene.edges };
};
const snapshot = (scene) => ({ nodes: scene.nodes.map(({ selected, dragging, resizing, measured, ...node }) => ({ ...node, data: { ...node.data }, style: { ...node.style } })), edges: scene.edges.map(({ selected, ...value }) => ({ ...value, data: { ...value.data } })) });
// 画布里的几何一律用画布坐标：缩放时节点与点阵一起缩放，不能把屏幕像素写回节点。
const COLLAPSED_ROW = COLLAPSED_CARD_HEIGHT;
const TEXT_NODE_DEFAULT_HEIGHT = TEXT_NODE_MIN_HEIGHT;
const nodeForResource = (id, resource, x, y, width = 310, height = 255) => resource?.type === 'link'
  ? textCard(id, resource.id, x, y, Math.max(240, width), Math.max(110, Math.min(160, height)))
  : (({ dragHandle, ...node }) => node)(card(id, resource.id, x, y, width, height));

function ResizeBar({ side, value, onChange, onResizing }) {
  useNotesLocale();
  const min = side === 'left' ? 200 : 270;
  const max = () => Math.max(min, Math.min(side === 'left' ? 480 : 600, window.innerWidth - 140));
  const start = (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); onResizing(true);
    const x = event.clientX, initial = value, direction = side === 'left' ? 1 : -1;
    const move = (next) => onChange(clamp(initial + (next.clientX - x) * direction, min, max()));
    const end = () => { onResizing(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('blur', end); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('blur', end);
  };
  return <div className="panel-resize-hit" role="separator" aria-label={nt(side === 'left' ? 'resize_left' : 'resize_right')} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max()} aria-valuenow={Math.round(value)} tabIndex={0} onPointerDown={start}
    onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); onChange(event.key === 'Home' ? min : event.key === 'End' ? max() : clamp(value + (event.key === 'ArrowRight' ? 16 : -16) * (side === 'left' ? 1 : -1), min, max())); } }} />;
}
function Modal({ title, onClose, children, className = '' }) {
  useNotesLocale();
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const focusables = () => [...ref.current.querySelectorAll('button:not(:disabled), input, textarea, [tabindex="0"]')];
    focusables()[0]?.focus();
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } else if (event.key === 'Tab') { const items = focusables(), first = items[0], last = items.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } };
    const el = ref.current; el.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={ref} className={"modal " + className} role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label={nt('close_dialog')} onClick={onClose}><X size={18} /></button></div>{children}</section></div>;
}

const CREATE_ENTRIES = [['notebook', 'new_notebook', NotebookPen], ['folder', 'new_folder', FolderPlus], ['note', 'new_note', FileText]];
function CreateMenu({ disabled, onChoose, getPortalHost }) {
  useNotesLocale();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({});
  const root = useRef(null), trigger = useRef(null), menu = useRef(null);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open || disabled) return undefined;
    const place = () => {
      const button = trigger.current?.getBoundingClientRect();
      const host = getPortalHost()?.getBoundingClientRect();
      if (!button || !host) return;
      const menuWidth = menu.current?.getBoundingClientRect().width || 0;
      const preferredLeft = button.right - host.left - menuWidth;
      const maxLeft = Math.max(8, host.width - menuWidth - 8);
      setPosition({
        position: 'absolute',
        left: Math.max(8, Math.min(preferredLeft, maxLeft)),
        top: button.bottom - host.top + 4,
      });
    };
    const outside = (event) => {
      if (!root.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    };
    place();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    menu.current?.querySelector('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, disabled, getPortalHost]);
  const keys = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      const items = [...(menu.current?.querySelectorAll('[role="menuitem"]') || [])];
      if (!items.length) return;
      const index = items.indexOf(document.activeElement);
      event.preventDefault();
      event.stopPropagation();
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };
  const portalHost = getPortalHost?.();
  return <div ref={root} className="notes-create-control" onKeyDown={keys}>
    <button ref={trigger} className="icon-button notes-create-trigger" type="button" disabled={disabled} aria-label={nt('new')} title={nt('new')} aria-expanded={open && !disabled} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}><Plus size={17} aria-hidden="true" /></button>
    {open && !disabled && portalHost && createPortal(<div ref={menu} className="import-menu-items notes-create-menu" role="menu" aria-label={nt('new_resource')} style={position} onKeyDown={keys}>
      {CREATE_ENTRIES.map(([kind, labelKey, Icon]) => <button key={kind} type="button" role="menuitem" onClick={() => { trigger.current?.focus(); setOpen(false); onChoose(kind); }}><Icon size={16} aria-hidden="true" /><span>{nt(labelKey)}</span></button>)}
    </div>, portalHost)}
  </div>;
}

function PersistenceBadge({ status, loadState }) {
  useNotesLocale();
  // 汇总所有 key 的保存状态：任一 conflict → 冲突；任一 error → 失败；任一 saving/pending → 保存中；否则已保存
  const values = Object.values(status || {})
  let kind = 'saved', label = 'saved'
  if (loadState === 'loading') { kind = 'loading'; label = 'loading'; }
  else if (loadState === 'error') { kind = 'error'; label = 'load_failed'; }
  else if (values.some((s) => s.state === SaveState.CONFLICT)) { kind = 'conflict'; label = 'conflict' }
  else if (values.some((s) => s.state === SaveState.ERROR)) { kind = 'error'; label = 'save_failed' }
  else if (values.some((s) => s.state === SaveState.SAVING)) { kind = 'saving'; label = 'saving' }
  else if (values.some((s) => s.state === SaveState.PENDING)) { kind = 'pending'; label = 'pending' }
  return <span className="prototype-badge persistence-badge" data-state={kind} role="status">{nt(label)}</span>
}

function Board({ ChatComponent, hostTheme, onResourcesChange, active = true, scopedShortcuts = false, getMotionScale = standaloneMotionScale, persistence = null, persistenceSession, viewMemory, workspaceBridge = null, courseLibrary = null, onNavigateCourse, renderCourse }) {
  useNotesLocale();
  const localBridge = useRef(null); if (!localBridge.current) localBridge.current = createNotesWorkspace();
  const shared = workspaceBridge || localBridge.current;
  const [treeMode, setTreeMode] = useState(viewMemory?.treeMode || 'files');
  const [activeNotebook, setActiveNotebook] = useState(viewMemory?.activeNotebook || 'book');
  const flow = useReactFlow();
  const [themeOverride, setThemeOverride] = useState(null);
  const [systemTheme, setSystemTheme] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  // 默认跟宿主（独立网页跟系统）；顶栏的显式切换是本页会话内的覆盖，优先级最高，
  // 刷新后回到跟随宿主。规范：docs/规范/阅读端呈现.md §九「亮暗与对比度照 §四」。
  const theme = themeOverride || hostTheme || systemTheme;
  useEffect(() => { const query = window.matchMedia('(prefers-color-scheme: dark)'); const change = () => setSystemTheme(query.matches ? 'dark' : 'light'); query.addEventListener('change', change); return () => query.removeEventListener('change', change); }, []);
  useEffect(() => { if (hostTheme) return; document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, [theme, hostTheme]);
  const initial = useRef(null); if (!initial.current) initial.current = persistence ? { resources: {}, nodes: [], edges: [] } : fresh();
  const [resources, setResources] = useState(initial.current.resources);

  const [scene, setScene] = useState({ nodes: initial.current.nodes, edges: initial.current.edges });
  const sceneRef = useRef(scene); sceneRef.current = scene;
  const resourcesRef = useRef(resources); resourcesRef.current = resources;
  const history = useRef({ past: [], future: [] });
  const [, redraw] = useState(0);
  const [folders, setFolders] = useState(initialFolders);
  const foldersRef = useRef(folders); foldersRef.current = folders;
  const legacyNotebook = folders.find(folder => folder.kind === 'notebook')?.id;
  const nodeScope = node => node.data.notebookId || legacyNotebook;
  const visibleNodes = scene.nodes.filter(node => nodeScope(node) === activeNotebook && (!node.data.contentId || resources[node.data.contentId]) && !resources[node.data.contentId]?.trashed);
  const visibleIds = new Set(visibleNodes.map(node => node.id));
  const visibleEdges = scene.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const [selectedFolder, setSelectedFolder] = useState(viewMemory?.selectedFolder || 'notes');
  const [pickedEntry, setPickedEntry] = useState(viewMemory?.pickedEntry || null);
  const [createAt, setCreateAt] = useState(null);
  const [manageAt, setManageAt] = useState(null);
  const [currentId, setCurrentId] = useState(viewMemory?.currentId ?? (persistence ? '' : 'note-recall'));
  const [view, setView] = useState(viewMemory?.view || 'canvas');
  const [documentModes, setDocumentModes] = useState(viewMemory?.documentModes || {});
  const [documentActions, setDocumentActions] = useState(null);
  const [resourceActions, setResourceActions] = useState(null);
  const [leftOpen, setLeftOpen] = useState(viewMemory?.leftOpen ?? true), [rightOpen, setRightOpen] = useState(viewMemory?.rightOpen ?? false);
  const [leftWidth, setLeftWidth] = useState(264), [rightWidth, setRightWidth] = useState(352);
  const [resizing, setResizing] = useState(false);
  const [search, setSearch] = useState('');
  const [editingNode, setEditingNode] = useState(null), [editingEdge, setEditingEdge] = useState(null);
  const [tool, setTool] = useState('hand'), [space, setSpace] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [modal, setModal] = useState(null), [linkTitle, setLinkTitle] = useState(''), [linkUrl, setLinkUrl] = useState(''), [folderName, setFolderName] = useState('');
  const [formError, setFormError] = useState(''), [notice, setNotice] = useState('');
  const [quoteIds, setQuoteIds] = useState([]), [chatDraft, setChatDraft] = useState('');
  const root = useRef(null), stage = useRef(null), fileInput = useRef(null), panLayer = useRef(null);
  const selectedImportMode = useRef('copy');
  const [pendingImport, setPendingImport] = useState(null), [dropActive, setDropActive] = useState(false);
  const getPortalHost = useCallback(() => root.current, []);
  const mediaImport = useRef(false);
  const timer = useRef(null);
  const chosen = resources[currentId] && !resources[currentId].trashed ? resources[currentId] : null;
  const current = chosen || (view === 'canvas' ? Object.values(resources).find(resource => isMarkdownResource(resource) && !resource.trashed) : null);
  const referenceReadOnly = isFileReference(current);
  const currentMarkdown = isMarkdownResource(current);
  const documentMode = currentMarkdown ? (Object.hasOwn(documentModes, current.id) ? documentModes[current.id] : 'inline') : 'preview';
  const currentCard = visibleNodes.find((node) => node.data.contentId === current?.id);
  const grid = gridAppearance(zoom);
  const announce = useCallback((message) => { setNotice(message); clearTimeout(timer.current); timer.current = setTimeout(() => setNotice(''), 6000); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  // ---- 持久化（原生 DSH）：编辑门禁、自动保存、冲突处理 ----
  const notesPersistence = useNotesPersistence({
    persistence, persistenceSession,
    resources, setResources,
    scene, setScene,
    folders, setFolders,
    active,
    flow,
    initialFolders,
    announce,
  });
  const positionReady = !notesPersistence.isNative || ['ready', 'upgrade'].includes(notesPersistence.loadState);
  const pendingNotebook = useRef(viewMemory?.activeNotebook);
  useEffect(() => {
    if (!positionReady) return;
    if (view === 'document' && !chosen) {
      setView('canvas'); setCurrentId(''); setRightOpen(false);
      announce('原文档已不可用，已回到画布。');
    }
    const id = pendingNotebook.current;
    if (!id) return;
    pendingNotebook.current = undefined;
    const book = folders.find(folder => folder.id === id && folder.kind === 'notebook');
    if (book?.viewport) void flow.setViewport(book.viewport, { duration: 0 });
  }, [positionReady, view, chosen, folders, flow, announce]);
  useEffect(() => {
    if (!viewMemory || !positionReady || (view === 'document' && !chosen)) return;
    Object.assign(viewMemory, { treeMode, activeNotebook, selectedFolder, pickedEntry, currentId, view, documentModes, leftOpen, rightOpen });
  }, [viewMemory, positionReady, chosen, treeMode, activeNotebook, selectedFolder, pickedEntry, currentId, view, documentModes, leftOpen, rightOpen]);
  useEffect(() => { onResourcesChange?.(notesPersistence.canEdit ? resources : {}); }, [resources, onResourcesChange, notesPersistence.canEdit]);
  const workspaceRef = useRef(null);
  useEffect(() => { if (workspaceRef.current) workspaceRef.current.inert = !notesPersistence.canEdit; }, [notesPersistence.canEdit]);
  useEffect(() => {
    if (!notesPersistence.restoreRevision) return;
    history.current = { past: [], future: [] };
    setEditingNode(null); setEditingEdge(null);
    if (!folders.some(folder => folder.id === selectedFolder)) setSelectedFolder(folders[0]?.id || 'library');
  }, [notesPersistence.restoreRevision]);

  const checkpoint = useCallback(() => { if (!notesPersistence.canEdit) return; const h = history.current; h.past.push(snapshot(sceneRef.current)); if (h.past.length > 50) h.past.shift(); h.future = []; redraw((value) => value + 1); }, [notesPersistence.canEdit]);
  const restore = useCallback((direction) => { const h = history.current, source = direction === 'undo' ? h.past : h.future, target = direction === 'undo' ? h.future : h.past; if (!source.length || !notesPersistence.markEdit()) return; target.push(snapshot(sceneRef.current)); const next = source.pop(); sceneRef.current = next; setScene(next); setEditingNode(null); setEditingEdge(null); redraw((value) => value + 1); }, [notesPersistence.markEdit]);
  const applyScene = useCallback((updater) => setScene((previous) => { const next = updater(previous); sceneRef.current = next; return next; }), []);
  const changeScene = useCallback((updater) => { if (notesPersistence.markEdit()) applyScene(previous => {
    const ids = new Set(previous.nodes.map(node => node.id));
    const next = updater(previous);
    return { ...next, nodes: next.nodes.map(node => ids.has(node.id) || node.data.notebookId || !(activeNotebook || legacyNotebook) ? node : { ...node, data: { ...node.data, notebookId: activeNotebook || legacyNotebook } }) };
  }); }, [applyScene, notesPersistence.markEdit, activeNotebook, legacyNotebook]);
  const changeScenePersist = changeScene;
  const updateResource = (id, patch) => {
    if (!notesPersistence.markEdit()) return;
    setResources((previous) => previous[id] ? ({ ...previous, [id]: { ...previous[id], ...patch } }) : previous);
  };
  const switchNotebook = (id) => {
    const book = foldersRef.current.find(folder => folder.id === id && folder.kind === 'notebook');
    if (!book) return;
    setActiveNotebook(id); setSelectedFolder(id); setView('canvas'); setEditingNode(null); setEditingEdge(null);
    applyScene(previous => ({ nodes: previous.nodes.map(node => ({ ...node, selected: false })), edges: previous.edges.map(edge => ({ ...edge, selected: false })) }));
    void flow.setViewport(book.viewport || { x: 0, y: 0, zoom: 1 }, { duration: 0 });
  };
  useEffect(() => {
    if (positionReady && !folders.some(folder => folder.id === activeNotebook && folder.kind === 'notebook')) setActiveNotebook(legacyNotebook || '');
  }, [positionReady, folders, activeNotebook, legacyNotebook]);
  const storeResources = next => { resourcesRef.current = next; setResources(next); };
  const storeFolders = next => { foldersRef.current = next; setFolders(next); };
  const patchOwnedNote = (id, patch) => {
    const original = resourcesRef.current[id];
    if (!ownedNote(original)) throw new Error('只能修改自有 Markdown 笔记。');
    if (!notesPersistence.markEdit()) return false;
    storeResources({ ...resourcesRef.current, [id]: { ...original, ...patch } }); return true;
  };
  // ---- 资源树目录/文件操作（树侧菜单是第一道；这里用 ref 最新数据再验一遍同一判据）----
  // 判据统一取自 resource-tree-model.js（folderDeleteBlockReason / canRenameResource / 校验函数），
  // 防「菜单打开期间数据变化」的竞态：外部轮询回灌、在途保存落地、另一面板改动——
  // 一律以 foldersRef/resourcesRef/sceneRef 里的当前值为准，不信菜单打开时的快照。
  const hasCanvasContent = useCallback((folderId) => {
    const legacyNotebookId = foldersRef.current.find(folder => folder.kind === 'notebook')?.id;
    // 阻断口径（主代理拍板）：scene 里只要还有任何归属本笔记本的节点就不可删——
    // 包括内容被扔进废纸篓的节点，以及旧数据无 notebookId、按 legacy 实际归属的节点。
    // 删除不许留下无归属/归属漂移的节点；资源口径（含废纸篓）另在 folderIsEmpty 里拦。
    return sceneRef.current.nodes.some(node => (node.data.notebookId || legacyNotebookId) === folderId);
  }, []);
  const renameFolder = useCallback((folderId, name) => {
    const folder = foldersRef.current.find(item => item.id === folderId);
    if (!folder || folder.name === name || !validateFolderName(name).ok) return;
    if (!notesPersistence.markEdit()) return;
    storeFolders(foldersRef.current.map(item => item.id === folderId ? { ...item, name } : item));
  }, [notesPersistence.markEdit]);
  const deleteFolder = useCallback((folderId) => {
    const folder = foldersRef.current.find(item => item.id === folderId);
    if (!folder) return;
    const block = folderDeleteBlockReason(foldersRef.current, resourcesRef.current, folder, hasCanvasContent(folderId));
    if (block) { announce(block); return; }
    // 最后一本笔记本不可删：删光后 legacyNotebook 变 undefined，无显式 notebookId 的
    // 节点会失去归属、新建节点也不再盖 notebookId（App.jsx 的 nodeScope/changeScene）。
    if (folder.kind === 'notebook' && foldersRef.current.filter(item => item.kind === 'notebook').length <= 1) {
      announce('至少保留一个笔记本；请先新建另一本笔记本再删除。');
      return;
    }
    if (!notesPersistence.markEdit()) return;
    const next = foldersRef.current.filter(item => item.id !== folderId);
    storeFolders(next);
    // 选中回退：删的是当前选中目录时退到父目录，再退唯一根/首项；树侧高亮 pick 跟随 selectedFolder。
    setSelectedFolder(previous => next.some(item => item.id === previous) ? previous
      : next.find(item => item.id === folder.parent)?.id || next.find(item => item.parent === null)?.id || next[0]?.id || 'library');
    // 删的是活动笔记本时把相机切到回退笔记本的视口：否则 layout.json 顶层全局 viewport
    // 仍停在已删本的位置，下次刷新会恢复到一个陌生空画布。
    if (folderId === activeNotebook) {
      const fallback = next.find(item => item.kind === 'notebook');
      void flow.setViewport(fallback?.viewport || { x: 0, y: 0, zoom: 1 }, { duration: 0 });
    }
  }, [notesPersistence.markEdit, hasCanvasContent, announce, activeNotebook, flow]);
  const moveEntry = (entry, parent) => {
    const all = foldersRef.current;
    const items = resourcesRef.current;
    const move = planResourceMove(all, items, entry, parent);
    if (!move || !notesPersistence.canEdit) return false;
    if (move.crossesNotebook && !window.confirm(nt('confirm_resource_move', {
      name: move.source.name || move.source.title, path: folderPath(all, parent),
    }))) return false;
    if (!notesPersistence.markEdit()) return false;
    if (entry.kind === 'folder') storeFolders(all.map(folder => folder === move.source ? { ...folder, parent } : folder));
    else storeResources({ ...items, [entry.id]: { ...move.source, parent } });
    return true;
  };
  const renameResource = useCallback((resourceId, title) => {
    const resource = resourcesRef.current[resourceId];
    const result = validateFileTitle(title);
    if (!canRenameResource(resource) || !result.ok || !notesPersistence.canEdit) return false;
    const name = result.name;
    if (name === resource.title) return true;
    if (resource.type === 'note' && noteExtension(resource.title) !== noteExtension(name)
      && !window.confirm('更改扩展名可能导致文件无法识别。确定要更改扩展名吗？')) return false;
    if (resourcesRef.current[resourceId] !== resource || !notesPersistence.markEdit()) return false;
    storeResources({ ...resourcesRef.current, [resourceId]: { ...resource, title: name } });
    return true;
  }, [notesPersistence.markEdit, notesPersistence.canEdit]);
  const withoutSubject = (list, ref) => (list || []).filter(item => !sameSubject(item, ref));
  const withDefault = (book, ref) => {
    const bindings = [...withoutSubject(book.bindings, ref), ref];
    const defaultForSubjects = [...withoutSubject(book.defaultForSubjects, ref), ref];
    if (bindings.length > 32 || defaultForSubjects.length > 32) throw new Error('每本最多绑定 32 个科目。');
    return { ...book, bindings, defaultForSubjects };
  };
  const bindNotebook = (id, scope) => {
    const ref = normalizeCourseRef(scope, { subjectOnly: true });
    const book = foldersRef.current.find(folder => folder.id === id && folder.kind === 'notebook');
    if (!book) throw new Error('请选择有效的笔记本。');
    if (book.bindings?.some(item => sameSubject(item, ref))) return id;
    const bindings = [...(book.bindings || []), ref];
    if (bindings.length > 32) throw new Error('每本最多绑定 32 个科目。');
    if (!notesPersistence.markEdit()) return false;
    storeFolders(foldersRef.current.map(folder => folder.id === id ? { ...folder, bindings } : folder));
    return id;
  };
  const unbindNotebook = (id, scope, replacement) => {
    const ref = normalizeCourseRef(scope, { subjectOnly: true });
    const all = foldersRef.current;
    const book = all.find(folder => folder.id === id && folder.kind === 'notebook');
    if (!book?.bindings?.some(item => sameSubject(item, ref))) throw new Error('绑定已变化，请重新查看。');
    const wasDefault = book.defaultForSubjects?.some(item => sameSubject(item, ref));
    const target = all.find(folder => folder.id !== id && folder.id === replacement && folder.kind === 'notebook');
    if (wasDefault && replacement !== null && !target) throw new Error('请明确选择替代本或清除默认本。');
    const substituted = wasDefault && target ? withDefault(target, ref) : null;
    if (!notesPersistence.markEdit()) return false;
    storeFolders(all.map(folder => folder.id === id
      ? { ...folder, bindings: withoutSubject(folder.bindings, ref), defaultForSubjects: withoutSubject(folder.defaultForSubjects, ref) }
      : folder.id === substituted?.id ? substituted : folder));
    return true;
  };
  const commands = {
    select(id) { if (resourcesRef.current[id] && !resourcesRef.current[id].trashed) setCurrentId(id); },
    rename: renameResource,
    markdown(id, markdown) {
      if (!isMarkdownResource(resourcesRef.current[id])) return false;
      if (typeof markdown !== 'string' || markdown.length > 128 * 1024 || new TextEncoder().encode(markdown).length > 512 * 1024) throw new Error('笔记正文超过大小上限，原稿未截断。');
      return patchOwnedNote(id, { markdown });
    },
    trash(id, trashed) { return patchOwnedNote(id, { trashed: Boolean(trashed) }); },
    associate(id, ref) {
      const original = resourcesRef.current[id];
      if (!isMarkdownResource(original) || !ownedNote(original) || original.trashed) throw new Error('请选择有效的自有笔记。');
      const resolved = resolveCourse(courseLibrary, ref);
      if (!resolved) throw new Error('课程节点已失效，原关联未改变。');
      const nextRef = courseRef(ref, resolved.node);
      const previous = original.associations?.find(item => sameSubject(item, nextRef));
      if (sameCourse(previous, nextRef)) return true;
      const next = associateNote(original, nextRef);
      if (previous && !window.confirm('将本笔记在「' + resolved.subject.name + '」的关联从「' + (previous.title || previous.node) + '」移到「' + nextRef.title + '」？原件和画布不会移动。')) return false;
      if (resourcesRef.current[id] !== original) throw new Error('笔记已变化，请重新确认。');
      return patchOwnedNote(id, { associations: next.associations });
    },
    removeAssociation(id, ref) {
      const original = resourcesRef.current[id];
      if (!ownedNote(original) || original.trashed) throw new Error('请选择有效的自有笔记。');
      const associations = original.associations || [];
      if (!associations.some(item => sameCourse(item, ref))) return true;
      return patchOwnedNote(id, { associations: associations.filter(item => !sameCourse(item, ref)) });
    },
    bind: bindNotebook,
    unbind: unbindNotebook,
    setDefault(scope, id, name) {
      const ref = normalizeCourseRef(scope, { subjectOnly: true });
      if (!notesPersistence.canEdit) return null;
      let next = foldersRef.current;
      if (!id) {
        const title = validateFolderName(name);
        if (!title.ok || next.length >= 80) throw new Error('笔记本名称或目录数量不合法。');
        id = uid('book'); next = [...next, { id, name: title.name, parent: next.find(folder => folder.parent === null)?.id ?? null, kind: 'notebook' }];
      }
      const book = next.find(folder => folder.id === id && folder.kind === 'notebook');
      if (!book) throw new Error('请选择有效的笔记本。');
      if (book.defaultForSubjects?.some(item => sameSubject(item, ref))) return id;
      const target = withDefault(book, ref);
      if (!notesPersistence.markEdit()) return null;
      storeFolders(next.map(folder => folder.id === id ? target : folder.defaultForSubjects?.some(item => sameSubject(item, ref))
        ? { ...folder, defaultForSubjects: withoutSubject(folder.defaultForSubjects, ref) } : folder));
      return id;
    },
    createNote(scope, node, notebookId) {
      if (!foldersRef.current.some(folder => folder.id === notebookId && folder.kind === 'notebook')) throw new Error('请先确认默认笔记本。');
      if (Object.keys(resourcesRef.current).length >= 250) throw new Error('最多保留 250 个资源（含废纸篓）。');
      const ref = courseRef(scope, node); normalizeCourseRef(ref);
      if (!notesPersistence.markEdit()) return null;
      const id = uid('note'); storeResources({ ...resourcesRef.current, [id]: { id, type: 'note', title: (node.title || '未命名') + '.md', markdown: '', parent: notebookId, associations: [ref] } }); setCurrentId(id); return id;
    },
    upgrade: notesPersistence.upgradeStore,
    retry: notesPersistence.retryAll,
    reload: () => notesPersistence.reloadStore({ confirmDiscard: true }),
    retryConflicts() { if (window.confirm('保留本地最新草稿，并针对刚看到的文件版本重试保存？文件再次变化仍会停止。')) notesPersistence.conflictKeys.forEach(key => notesPersistence.resolveConflict(key, { discard: false })); },
    export() { const blob = new Blob([JSON.stringify(notesPersistence.exportDrafts(), null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'studymate-notes-draft.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); },
  };
  useEffect(() => {
    shared.publish({ resources, folders, theme, selectedId: currentId, canEdit: notesPersistence.canEdit, loadState: notesPersistence.loadState, loadError: notesPersistence.loadError, saveStatus: notesPersistence.saveStatus, conflictKeys: notesPersistence.conflictKeys }, commands);
  });
  useEffect(() => () => shared.detach(), [shared]);
  const quote = (id) => { if (resources[id]) { setQuoteIds((previous) => previous.includes(id) ? previous : [...previous, id].slice(-20)); setRightOpen(true); if (view === 'canvas') setView('document'); } };
  const refreshResource = async (id) => {
    const resource = resourcesRef.current?.[id];
    if (!isFileReference(resource)) return;
    try {
      const next = await resolveFileReference(resource);
      const otherBytes = Object.values(resourcesRef.current).reduce((sum, value) => sum + (value.id === id ? 0 : value.bytes || 0), 0);
      if (otherBytes + (next.bytes || 0) > 32 * 1024 * 1024) throw new Error('重新读取后超过本页 32 MiB 总量限制');
      // 同步推进编辑栅栏：在途 GET 不得把刚重读的 File/正文换回旧对象。
      if (resourcesRef.current?.[id] !== resource || !notesPersistence.markEdit()) return;
      setResources((previous) => previous[id] === resource ? { ...previous, [id]: next } : previous);
    } catch (error) {
      if (resourcesRef.current?.[id] !== resource || !notesPersistence.markEdit()) return;
      setResources((previous) => previous[id] === resource ? { ...previous, [id]: { ...resource, referenceError: error.message } } : previous);
      announce(error.message);
    }
  };
  const selectResource = (id) => { setCurrentId(id); setEditingNode(null); if (view === 'canvas') setRightOpen(true); void refreshResource(id); };
  const openDocument = (id) => { if (!resources[id]) return; setCurrentId(id); setView('document'); setRightOpen(true); setEditingNode(null); setEditingEdge(null); void refreshResource(id); };
  const fit = () => flow.fitView({ padding: 0.2, duration: 220 * getMotionScale(), maxZoom: 1.25 });
  // 初始适应画布要等所有节点都量到尺寸：文本节点比卡片晚一帧，过早 fitView 会把它留在屏幕外。
  const initialized = useNodesInitialized();
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (!active || !initialized || didInitialFit.current || (notesPersistence.isNative && notesPersistence.restoredViewportRef.current)) return;
    didInitialFit.current = true;
    fit();
  }, [active, initialized]);
  // 隐藏面不接快捷键：切走时把「按住空格」的状态一并放掉，回来不会卡在平移模式。
  useEffect(() => { if (!active) setSpace(false); }, [active]);
  const center = () => { const rect = stage.current?.getBoundingClientRect(); return flow.screenToFlowPosition({ x: rect ? rect.left + rect.width / 2 : 700, y: rect ? rect.top + rect.height / 2 : 420 }); };
  const placeResource = (id, position) => {
    if (!notesPersistence.canEdit) return;
    const existing = sceneRef.current.nodes.find((node) => node.data.contentId === id && nodeScope(node) === activeNotebook);
    if (existing) { if (view === 'canvas') flow.setCenter(existing.position.x + (existing.width || existing.style?.width || 300) / 2, existing.position.y + 130, { zoom: 1, duration: 220 * getMotionScale() }); else setView('canvas'); announce('已定位画布中的卡片'); return; }
    if (sceneRef.current.nodes.length >= 120) { announce('此体验版最多放置 120 个节点'); return; }
    const point = position || (view === 'canvas' ? center() : { x: 420, y: 240 });
    const resource = resourcesRef.current[id];
    if (!resource || resource.trashed) return;
    const node = nodeForResource(uid('node'), resource, point.x - 150, point.y - 120, ['image', 'svg', 'html'].includes(resource.type) ? 360 : 310, resource.courseRef ? 90 : 260);
    checkpoint(); changeScene((previous) => ({ ...previous, nodes: [...previous.nodes, { ...node, selected: true }] })); setView('canvas');
  };
  const addText = () => { if (sceneRef.current.nodes.length >= 120) { announce('此体验版最多放置 120 个节点'); return; } if (!notesPersistence.markEdit()) return; const point = center(), id = uid('text'); checkpoint(); changeScene((previous) => ({ ...previous, nodes: [...previous.nodes.map((node) => ({ ...node, selected: false })), { id, type: 'text', position: { x: point.x - 130, y: point.y - TEXT_NODE_DEFAULT_HEIGHT / 2 }, style: { width: 260, height: TEXT_NODE_DEFAULT_HEIGHT }, data: { text: '' }, selected: true }] })); setEditingNode(id); setView('canvas'); };
  const beginCreate = (kind) => {
    const all = foldersRef.current;
    const selected = pickedEntry?.kind === 'file' ? resourcesRef.current[pickedEntry.id] : null;
    const rootFolder = all.find(folder => folder.parent === null);
    const id = kind === 'notebook' ? rootFolder?.id : pickedEntry?.kind === 'folder' ? pickedEntry.id
      : selected && !selected.trashed ? selected.parent || initialParent(selected) : null;
    const parent = all.find(folder => folder.id === id) || all.find(folder => folder.id === activeNotebook) || rootFolder;
    if (!parent || !notesPersistence.canEdit) return;
    setCreateAt({ kind, parent: parent.id });
    setFolderName(kind === 'note' ? '未命名.md' : '');
    setFormError(''); setModal('create');
  };
  const finishCreate = (event) => {
    event.preventDefault();
    const all = foldersRef.current;
    const parent = all.find(folder => folder.id === createAt?.parent);
    const kind = createAt?.kind;
    const check = kind === 'note' ? validateFileTitle(folderName) : validateFolderName(folderName);
    if (!parent || (kind === 'notebook' && parent.parent !== null)) { setFormError('目标目录已变化，请关闭后重新选择。'); return; }
    if (!check.ok) { setFormError(check.error); return; }
    if (kind === 'note') {
      if (Object.keys(resourcesRef.current).length >= 250) { setFormError('最多保留 250 个资源（含废纸篓）。'); return; }
      if (isUnsupportedNote({ type: 'note', title: check.name })) { setFormError('新建笔记请使用 Markdown 扩展名。'); return; }
    } else if (all.length >= 80) { setFormError('目录数量已达上限。'); return; }
    const title = kind === 'note' && !noteExtension(check.name) ? check.name + '.md' : check.name;
    if (kind === 'note' && !validateFileTitle(title).ok) { setFormError('加上 .md 后名称过长。'); return; }
    if (!notesPersistence.markEdit()) { setFormError('当前无法写入。'); return; }
    const id = uid(kind === 'notebook' ? 'book' : kind);
    if (kind === 'note') {
      storeResources({ ...resourcesRef.current, [id]: { id, type: 'note', title, markdown: '', parent: parent.id } });
      setCurrentId(id); setPickedEntry({ kind: 'file', id }); setView('document'); setRightOpen(true);
    } else {
      storeFolders([...all, { id, name: check.name, parent: parent.id, kind }]);
      setSelectedFolder(id); setPickedEntry({ kind: 'folder', id });
    }
    setModal(null);
  };
  const deleteSelection = useCallback(() => { const previous = sceneRef.current, scoped = new Set(previous.nodes.filter(node => nodeScope(node) === activeNotebook).map(node => node.id)), ids = new Set(previous.nodes.filter(node => scoped.has(node.id) && node.selected).map(node => node.id)), edgeIds = new Set(previous.edges.filter(edge => scoped.has(edge.source) && scoped.has(edge.target) && edge.selected).map(edge => edge.id)); if (!ids.size && !edgeIds.size) return; checkpoint(); changeScene(value => ({ nodes: value.nodes.filter(node => !ids.has(node.id)), edges: value.edges.filter(edge => !edgeIds.has(edge.id) && !ids.has(edge.source) && !ids.has(edge.target)) })); setEditingNode(null); setEditingEdge(null); }, [checkpoint, changeScene, activeNotebook, legacyNotebook]);
  const removeCurrentCard = () => { const node = sceneRef.current.nodes.find((node) => node.data.contentId === current?.id && nodeScope(node) === activeNotebook); if (!node) return; checkpoint(); changeScene((previous) => ({ nodes: previous.nodes.filter((value) => value.id !== node.id), edges: previous.edges.filter((value) => value.source !== node.id && value.target !== node.id) })); announce('已移出画布，文件保留'); };
  // 折叠只留标题栏：节点自身高度压到 48，展开时恢复折叠前的高度；两者都进画板历史。
  // 清掉顶层 height 让 React Flow 一律以 style.height 驱动外框高度，避免缩放后顶层 height 盖住折叠/展开。
  const toggleCardCollapsed = (id) => {
    const node = sceneRef.current.nodes.find((value) => value.id === id);
    if (!node) return;
    const collapsed = Boolean(node.data?.collapsed);
    checkpoint();
    changeScene((previous) => ({ ...previous, nodes: previous.nodes.map((value) => {
      if (value.id !== id) return value;
      const { height: _topHeight, ...rest } = value;
      if (collapsed) {
        const height = Math.round(Number.parseFloat(value.data?.expandedHeight) || 255);
        return { ...rest, data: { ...value.data, collapsed: false }, style: { ...value.style, height } };
      }
      const height = Number.parseFloat(value.height ?? value.style?.height ?? value.measured?.height ?? value.initialHeight) || 255;
      return { ...rest, data: { ...value.data, collapsed: true, expandedHeight: Math.round(height) }, style: { ...value.style, height: COLLAPSED_ROW } };
    }) }));
  };
  const updateNodeText = (id, text) => { const previous = sceneRef.current.nodes.find((node) => node.id === id); if (previous && previous.data.text !== text) { checkpoint(); changeScene((value) => ({ ...value, nodes: value.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, text } } : node) })); } };
  const commitEdgeLabel = (id, label) => { if (sceneRef.current.edges.find((value) => value.id === id)?.data?.label === label) return; checkpoint(); changeScene((previous) => ({ ...previous, edges: previous.edges.map((value) => value.id === id ? { ...value, data: { ...value.data, label } } : value) })); };
  const onConnect = (connection) => { if (connection.source === connection.target) return; if (sceneRef.current.edges.length >= 240) { announce('此体验版最多建立 240 条关系'); return; } checkpoint(); const id = uid('edge'); changeScene((previous) => ({ ...previous, edges: [...previous.edges, { ...edge(id, connection.source, connection.target, ''), ...connection }] })); setEditingEdge(id); };
  useEffect(() => {
    // 笔记被切走时整棵画布仍在（保数据），但键盘监听必须跟着面一起停：否则学习页打字、
    // 按 1/Delete/空格都会落到隐藏笔记上。
    if (!active || !notesPersistence.canEdit) return undefined;
    const keyDown = (event) => {
      if (modal || (scopedShortcuts && !root.current?.contains(event.target instanceof Node ? event.target : null))) return;
      if (event.code === 'Space' && view === 'canvas') { setSpace(true); if (!editable(event.target)) event.preventDefault(); return; }
      if (editable(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); restore(event.shiftKey ? 'redo' : 'undo'); }
      else if (event.key === 'Escape') { setEditingNode(null); setEditingEdge(null); }
      else if (view === 'canvas' && ['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); deleteSelection(); }
      else if (view === 'canvas' && event.key.toLowerCase() === 'h') setTool('hand');
      else if (view === 'canvas' && event.key.toLowerCase() === 'v') setTool('select');
      else if (view === 'canvas' && event.key === '1') { event.preventDefault(); fit(); }
    };
    const keyUp = (event) => { if (event.code === 'Space') setSpace(false); };
    const blur = () => setSpace(false);
    window.addEventListener('keydown', keyDown, true); window.addEventListener('keyup', keyUp, true); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', keyDown, true); window.removeEventListener('keyup', keyUp, true); window.removeEventListener('blur', blur); };
  }, [active, scopedShortcuts, modal, view, restore, deleteSelection, notesPersistence.canEdit]);
  const forcedPan = (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    let lastX = event.clientX, lastY = event.clientY;
    const move = (next) => {
      const camera = flow.getViewport();
      flow.setViewport({ ...camera, x: camera.x + next.clientX - lastX, y: camera.y + next.clientY - lastY });
      lastX = next.clientX; lastY = next.clientY;
    };
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('blur', end); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('blur', end);
  };
  useEffect(() => {
    const layer = panLayer.current;
    if (!space || !layer) return undefined;
    const wheel = (event) => {
      event.preventDefault(); event.stopPropagation();
      const camera = flow.getViewport(), rect = stage.current.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      const nextZoom = clamp(camera.zoom * Math.exp(-clamp(delta, -400, 400) * 0.002), 0.2, 2);
      const x = event.clientX - rect.left, y = event.clientY - rect.top, scale = nextZoom / camera.zoom;
      flow.setViewport({ zoom: nextZoom, x: x - (x - camera.x) * scale, y: y - (y - camera.y) * scale });
      setZoom(nextZoom);
    };
    layer.addEventListener('wheel', wheel, { passive: false });
    return () => layer.removeEventListener('wheel', wheel);
  }, [space, flow]);
  const importEntries = async (entries, importMode, position) => {
    if (mediaImport.current) { announce('请等待上一批文件处理完成'); return; }
    mediaImport.current = true;
    try {
      let total = Object.values(resources).reduce((sum, value) => sum + (value.bytes || 0), 0), count = Object.keys(resources).length;
      const accepted = [], errors = [];
      for (const entry of entries.slice(0, 12)) {
        try {
          const resource = await readImportedEntry(entry, importMode);
          if (total + (resource.bytes || 0) > 32 * 1024 * 1024 || count >= 250) throw new Error('本页文件总量不得超过 32 MiB，资源不得超过 250 项');
          const id = uid('resource'); accepted.push({ ...resource, id, parent: selectedFolder || 'references' }); total += resource.bytes || 0; count++;
        } catch (error) { errors.push((entry.file?.name || '文件') + '：' + error.message); }
      }
      if (entries.length > 12) errors.push('每次最多导入 12 个文件');
      if (accepted.length) {
        if (!notesPersistence.markEdit()) { announce('载入中，未导入文件；请载入完成后重试'); return; }
        setResources((previous) => ({ ...previous, ...Object.fromEntries(accepted.map((resource) => [resource.id, resource])) }));
        checkpoint(); const point = position || center();
        changeScene((previous) => ({ ...previous, nodes: [...previous.nodes, ...accepted.slice(0, Math.max(0, 120 - previous.nodes.length)).map((resource, index) => nodeForResource(uid('node'), resource, point.x - 170 + index * 32, point.y - 120 + index * 32, 340, 260))] }));
        setCurrentId(accepted[0].id); setView('canvas'); setRightOpen(true);
      }
      if (errors.length) { setFormError(errors.join('\n')); setModal('import-error'); }
      else if (accepted.length) announce('已以' + (importMode === 'copy' ? '副本' : '引用') + '模式导入 ' + accepted.length + ' 个文件' + (accepted.some((item) => isFileReference(item) && !item.origin.canReopen) ? '；此环境仅保留本次文件引用，原件变化需重新选择' : ''));
    } finally { mediaImport.current = false; }
  };
  const chooseFiles = async (importMode) => {
    selectedImportMode.current = importMode; setModal(null);
    if (importMode === 'reference' && typeof window.showOpenFilePicker === 'function') {
      try {
        const handles = await window.showOpenFilePicker({ multiple: true, excludeAcceptAllOption: true, types: IMPORT_PICKER_TYPES });
        await importEntries(handles.map((handle) => ({ handle })), 'reference'); return;
      } catch (error) {
        if (error.name === 'AbortError') return;
        announce('无法建立持续文件引用，将改用本次文件选择；不写回原文件');
      }
    }
    fileInput.current?.click();
  };
  const importFiles = (event) => { const entries = [...event.target.files].map((file) => ({ file })); event.target.value = ''; void importEntries(entries, selectedImportMode.current); };
  // 重新关联文件：用户显式选择原文件，同 id/parent 复活 .live File/handle，保存仍仅 metadata
  const relinkFileReference = async (id) => {
    const resource = resourcesRef.current?.[id];
    if (!isFileReference(resource) || !notesPersistence.canEdit) return;
    const applyFile = async (file, handle) => {
      try {
        const next = await resolveFileReference({ ...resource, sourceFile: file, fileHandle: handle });
        if (resourcesRef.current?.[id] !== resource || !notesPersistence.markEdit()) return;
        setResources((previous) => previous[id] === resource ? { ...previous, [id]: { ...next, parent: resource.parent, referenceError: '' } } : previous);
        announce('已重新关联原文件；保存仍仅保留元信息');
      } catch (error) {
        // DOM onchange 不等待 Promise；在这里收口，失败不能假报成功或变未捕获异常。
        if (resourcesRef.current?.[id] === resource) announce(error?.message || '重新关联失败，原引用未改变');
      }
    };
    try {
      if (typeof window.showOpenFilePicker === 'function') {
        const [handle] = await window.showOpenFilePicker({ multiple: false, excludeAcceptAllOption: true, types: IMPORT_PICKER_TYPES });
        await applyFile(await handle.getFile(), handle);
      } else {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = IMPORT_FILE_ACCEPT;
        input.onchange = () => { const file = input.files?.[0]; if (file) void applyFile(file, null); };
        input.click();
      }
    } catch (error) {
      if (error?.name !== 'AbortError') announce(error?.message || '重新关联失败，原引用未改变');
    }
  };
  const beginImport = (importMode) => {
    if (importMode === 'copy') { void chooseFiles('copy'); return; }
    setLinkTitle(''); setLinkUrl(''); setFormError(''); setModal('reference-source');
  };
  const drop = (event) => {
    const draggedCourse = event.dataTransfer.getData('application/studymate-course');
    if (draggedCourse) {
      event.preventDefault(); event.stopPropagation(); setDropActive(false);
      try {
        const ref = normalizeCourseRef(JSON.parse(draggedCourse));
        const found = resolveCourse(courseLibrary, ref);
        if (!found) throw new Error('课程来源已失效，请手动重新绑定。');
        if (!notesPersistence.canEdit) return;
        let resource = Object.values(resourcesRef.current).find(item => item.type === 'course' && sameCourse(item.courseRef, ref));
        if (!resource) {
          if (Object.keys(resourcesRef.current).length >= 250) throw new Error('资源数量已达上限。');
          if (!notesPersistence.markEdit()) return;
          const id = uid('course'); resource = { id, type: 'course', title: found.node.title || ref.node, courseRef: { ...ref, title: found.node.title || ref.node }, parent: activeNotebook || legacyNotebook || null };
          storeResources({ ...resourcesRef.current, [id]: resource });
        }
        placeResource(resource.id, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
        setCurrentId(resource.id); setRightOpen(true); return;
      } catch (error) { announce(error.message); return; }
    }
    const id = event.dataTransfer.getData('application/studymate-resource');
    const source = id && resourcesRef.current[id];
    const entries = source ? null : captureFileDrop(event.dataTransfer);
    if (!source && !entries?.length) return;
    event.preventDefault(); event.stopPropagation(); setDropActive(false);
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (source) {
      if (!notesPersistence.canEdit || source.trashed) return;
      placeResource(id, position);
      setCurrentId(id); setRightOpen(true);
      return;
    }
    setPendingImport({ entries, position });
    setModal('drop-mode');
  };
  const applyDropMode = async (importMode) => {
    const pending = pendingImport; setPendingImport(null); setModal(null);
    if (!pending) return;
    if (!notesPersistence.canEdit) { announce('笔记数据未就绪或只读，导入被拒绝'); return; }
    await importEntries(pending.entries, importMode, pending.position);
  };
  const canCopyMarkdown = (resource) => isMarkdownResource(resource) && !resource.trashed
    && (!isFileReference(resource) || Boolean(resource.fileHandle || resource.sourceFile));
  const copyMarkdown = async (sourceId) => {
    const source = resourcesRef.current[sourceId];
    if (!notesPersistence.canEdit || !canCopyMarkdown(source)) return;
    try {
      const original = isFileReference(source) ? await resolveFileReference(source) : source;
      const latest = resourcesRef.current;
      if (latest[sourceId] !== source) throw new Error('原文件已变化，副本未创建，请重试。');
      if (Object.keys(latest).length >= 250) throw new Error('最多保留 250 个资源（含废纸篓）。');
      if (!isMarkdownResource(original) || typeof original.markdown !== 'string') throw new Error('无法读取原始 Markdown，副本未创建。');
      const bytes = new TextEncoder().encode(original.markdown).length;
      const total = Object.values(latest).reduce((sum, item) => sum + (item.bytes || 0), 0);
      if (total + bytes > 32 * 1024 * 1024) throw new Error('复制后超过本页 32 MiB 总量限制。');
      if (!notesPersistence.markEdit()) return;
      const id = uid('note');
      storeResources({ ...latest, [id]: { id, type: 'note', title: copyNoteTitle(source.title), markdown: original.markdown, parent: source.parent || initialParent(source), bytes, mime: 'text/markdown', origin: { kind: 'workspace', mode: 'copy', sourceId } } });
      announce('已在同目录复制 Markdown，未复制课程关联或画布卡片。');
    } catch (error) { announce(error.message); }
  };
  const reset = () => { const next = fresh(); setResources(next.resources); const value = { nodes: next.nodes, edges: next.edges }; sceneRef.current = value; setScene(value); history.current = { past: [], future: [] }; setFolders(initialFolders); setCurrentId('note-recall'); setSelectedFolder('notes'); setQuoteIds([]); setChatDraft(''); setEditingNode(null); setEditingEdge(null); setSearch(''); setModal(null); setPendingImport(null); setDropActive(false); setView('canvas'); setRightOpen(false); requestAnimationFrame(() => fit()); };
  const manageNotebook = (id) => { setManageAt(id); setModal('notebook-bindings'); };
  const manageAssociation = (id) => { setManageAt(id); setModal('note-associations'); };
  const managedBook = folders.find(folder => folder.id === manageAt && folder.kind === 'notebook');
  const managedNote = resources[manageAt];
  const canEditAssociation = notesPersistence.canEdit && currentMarkdown && ownedNote(current);
  const openAssociation = () => manageAssociation(current.id);
  const ctx = { resources, openDocument, editingNode, setEditingNode, editingEdge, setEditingEdge, checkpoint, updateNodeText, commitEdgeLabel, toggleCardCollapsed, navigateCourse: onNavigateCourse, courseLibrary };
  const documentBody = current?.courseRef ? <CourseReference key={current.id} resource={current} library={courseLibrary} renderCourse={renderCourse} onNavigate={onNavigateCourse} canEdit={notesPersistence.canEdit} onChange={patch => updateResource(current.id, patch)} /> : currentMarkdown ? <NoteEditor key={current.id} resource={current} theme={theme} mode={documentMode} exportTarget={documentActions} onChange={markdown => updateResource(current.id, { markdown })} readOnly={referenceReadOnly || !notesPersistence.canEdit || !active} /> : isUnsupportedNote(current) ? <p className="unsupported-note" role="status">{nt('unsupported_note')}</p> : <div className="document-preview-pane">{current && ['image', 'svg', 'html'].includes(current.type) ? <div className="document-content"><MediaRenderer resource={current} className="media-preview document-media" /></div>
    : <div className="document-content"><h1>{current?.title}</h1><p>{current?.summary}</p>{current?.type === 'link' && <a href={current.url} target="_blank" rel="noopener noreferrer">{nt('open_web')}</a>}</div>}</div>;

  return <BoardContext.Provider value={ctx}><div ref={root} className={"app-shell v2 v3 v4 v5" + (hostTheme ? " is-hosted" : "")} data-theme={theme} data-resizing={resizing} style={{ '--v2-left-width': leftWidth + 'px', '--v2-right-width': rightWidth + 'px', '--v5-keep-left': leftWidth + 'px', '--v5-keep-right': rightWidth + 'px' }}>
    {notesPersistence.isNative && notesPersistence.loadState === 'loading' && <div className="persistence-gate" role="status"><p>{nt('loading_data')}</p></div>}
    {notesPersistence.isNative && notesPersistence.loadState === 'error' && <div className="persistence-gate persistence-gate--error" role="alert"><p>{nt('load_data_error')}</p><p>{notesPersistence.loadError?.message}</p><button className="button ghost" onClick={() => notesPersistence.reloadStore({ confirmDiscard: true })}>{nt('reload')}</button><button className="button ghost" onClick={() => notesPersistence.reloadStore({ confirmDiscard: true, skipCorrupt: true })}>{nt('load_rest')}</button></div>}
    {notesPersistence.isNative && notesPersistence.loadState === 'upgrade' && <div className="persistence-gate"><NotesStatus state={notesPersistence} dispatch={(name, ...args) => commands[name]?.(...args)} /></div>}
    {notesPersistence.isNative && notesPersistence.corrupt.length > 0 && <div className="persistence-corrupt-list" role="status">{notesPersistence.corrupt.map(entry => <div className="persistence-corrupt" key={entry.id}>{corruptMessage(entry, courseLibrary, folders, scene)}</div>)}</div>}
    {notesPersistence.isNative && notesPersistence.conflictKeys.length > 0 && <div className="persistence-conflict" role="alert"><p>{nt('conflict_data')}</p><button className="button ghost" onClick={() => { if (window.confirm(nt('retry_confirm'))) notesPersistence.conflictKeys.forEach(key => notesPersistence.resolveConflict(key, { discard: false })); }}>{nt('keep_retry')}</button></div>}
    <header className="topbar">
      <button className="icon-button topbar-panel-toggle topbar-panel-toggle--left" type="button" aria-label={nt(leftOpen ? 'close_files' : 'open_files')} title={nt(leftOpen ? 'close_files' : 'open_files')} aria-expanded={leftOpen} aria-controls="left-panel" onClick={() => setLeftOpen((value) => !value)}>{leftOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
      <div className="view-switch" aria-label={nt('main_view')}><button className={view === 'canvas' ? 'is-active' : ''} aria-pressed={view === 'canvas'} onClick={() => { setView('canvas'); setEditingNode(null); }}><LayoutDashboard size={13} />{nt('canvas')}</button><button className={view === 'document' ? 'is-active' : ''} aria-pressed={view === 'document'} onClick={() => openDocument(current?.id)}><FileText size={13} />{nt('document')}</button></div>
      <span className="topbar-spacer" />{notesPersistence.isNative && <div className="persistence-actions">
        {Object.values(notesPersistence.saveStatus).some(state => state.state === SaveState.ERROR) && <button className="button ghost" onClick={notesPersistence.retryAll}>{nt('retry_save')}</button>}
        {/* 草稿恢复按钮只在真实失败态出现（ERROR/CONFLICT 稳定存在直到解决）；
            普通 dirty（在途保存/未落盘草稿）不再让这两个按钮闪现——那条路只由
            PersistenceBadge 如实显示。恢复路径仍完整：失败可导出/重试/重载，冲突另有
            冲突条与「保留本地并重试」。 */}
        {Object.values(notesPersistence.saveStatus).some(state => state.state === SaveState.ERROR || state.state === SaveState.CONFLICT) && <><button className="button ghost" onClick={() => { const blob = new Blob([JSON.stringify(notesPersistence.exportDrafts(), null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'studymate-notes-draft.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>{nt('export_drafts')}</button><button className="button ghost" onClick={() => notesPersistence.reloadStore({ confirmDiscard: true })}>{nt('discard_local')}</button></>}
      </div>}{notesPersistence.isNative
        ? <PersistenceBadge status={notesPersistence.saveStatus} loadState={notesPersistence.loadState} />
        : <span className="prototype-badge">开发中 · 刷新重置</span>}
      <button className="icon-button theme-switch" aria-label={theme === 'dark' ? '切换浅色模式' : '切换暗色模式'} title={theme === 'dark' ? '当前：暗色模式（覆盖仅本页，刷新后跟宿主）' : '当前：浅色模式（覆盖仅本页，刷新后跟宿主）'} onClick={() => setThemeOverride(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>
      <button className="icon-button" aria-label="操作说明" title="操作说明" onClick={() => setModal('help')}><HelpCircle size={17} /></button>{!notesPersistence.isNative && <button className="icon-button" aria-label="恢复示例" title="恢复示例" onClick={() => setModal('reset')}><RotateCcw size={16} /></button>}
      <button className="icon-button topbar-panel-toggle topbar-panel-toggle--right" type="button" aria-label={nt(rightOpen ? 'close_right' : 'open_right')} title={nt(rightOpen ? 'close_right' : 'open_right')} aria-expanded={rightOpen} aria-controls="right-panel" onClick={() => setRightOpen((value) => !value)}>{rightOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button>
    </header>
    <div className="workspace" ref={workspaceRef}>
      <aside id="left-panel" className={'side-panel left-panel' + (!leftOpen ? ' is-collapsed' : '')} style={{ width: leftOpen ? leftWidth : 0 }} inert={!leftOpen ? true : undefined} aria-hidden={!leftOpen}>
        <div className="panel-inner"><div className="panel-header"><span className="panel-title">{nt('files')}</span><div className="panel-actions"><ImportControls onChooseMode={beginImport} getPortalHost={getPortalHost} /><CreateMenu disabled={!notesPersistence.canEdit} onChoose={beginCreate} getPortalHost={getPortalHost} /></div></div>
          <div className="tree-tools"><input className="tree-search" aria-label={nt('search_files')} placeholder={nt('search')} value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          <div className="view-switch" aria-label={nt('directory_view')}><button className={treeMode === 'files' ? 'is-active' : ''} aria-pressed={treeMode === 'files'} onClick={() => setTreeMode('files')}>{nt('resources_view')}</button><button className={treeMode === 'nodes' ? 'is-active' : ''} aria-pressed={treeMode === 'nodes'} onClick={() => setTreeMode('nodes')}>{nt('nodes_view')}</button></div>
          {treeMode === 'nodes' ? <NodeNotebookTree bridge={shared} library={courseLibrary} search={search} onCanvas={switchNotebook} onSelect={view === 'document' ? openDocument : selectResource} onPickEntry={setPickedEntry} onManageNotebook={manageNotebook} /> : <ResourceTree folders={folders} resources={resources} search={search} selectedId={current?.id} selectedFolder={selectedFolder} onFolderSelect={setSelectedFolder} onSelect={view === 'document' ? openDocument : selectResource} onOpenDocument={openDocument} onCanvas={switchNotebook} canEdit={notesPersistence.canEdit} onRenameFolder={renameFolder} onDeleteFolder={deleteFolder} onRenameResource={renameResource} hasCanvasContent={hasCanvasContent} onPickEntry={setPickedEntry} onManageNotebook={manageNotebook} getNotebookBindingLabel={book => notebookBindingLabel(book, courseLibrary)} onCopyMarkdown={copyMarkdown} canCopyMarkdown={canCopyMarkdown} onMoveEntry={moveEntry} />}

        </div>{leftOpen && <ResizeBar side="left" value={leftWidth} onChange={setLeftWidth} onResizing={setResizing} />}
      </aside>
      <main className="main-stage">
        <section ref={stage} className={'canvas-stage' + (space ? ' is-space-panning' : '') + (dropActive ? ' is-drop-target' : '')} style={view !== 'canvas' ? { position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none' } : undefined} aria-hidden={view !== 'canvas'} inert={view !== 'canvas' ? true : undefined} onDragOver={(event) => { if ([...event.dataTransfer.types].some((type) => ['application/studymate-resource', 'application/studymate-course', 'Files'].includes(type))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropActive(false); }} onDrop={drop}>
          <ReactFlow nodes={visibleNodes.map((node) => ({ ...node, type: resources[node.data.contentId]?.type === 'link' ? 'text' : node.type, draggable: !space && node.id !== editingNode }))} edges={visibleEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={(changes) => {
              const resizeChanges = new Map();
              for (const change of changes) {
                if (change.type === 'dimensions' && (change.setAttributes || typeof change.resizing === 'boolean')) resizeChanges.set(change.id, change);
              }
              const update = (previous) => {
                const applied = applyNodeChanges(changes, previous.nodes);
                if (!resizeChanges.size) return { ...previous, nodes: applied };
                return {
                  ...previous,
                  nodes: applied.map((node) => {
                    const change = resizeChanges.get(node.id);
                    if (!change) return node;
                    const { width: topW, height: topH, ...rest } = node;
                    const nextStyle = { ...node.style };
                    const nextW = topW ?? (change.resizing === false ? change.dimensions?.width : undefined);
                    const nextH = topH ?? (change.resizing === false ? change.dimensions?.height : undefined);
                    if (Number.isFinite(nextW) && nextW > 0) nextStyle.width = nextW;
                    if (Number.isFinite(nextH) && nextH > 0) nextStyle.height = nextH;
                    return { ...rest, style: nextStyle };
                  }),
                };
              };
              if (changes.every((change) => change.type === 'dimensions' && change.resizing === undefined && !change.setAttributes)) applyScene(update);
              else changeScenePersist(update);
            }} onEdgesChange={(changes) => changeScenePersist((previous) => ({ ...previous, edges: applyEdgeChanges(changes, previous.edges) }))}
            onNodeDragStart={checkpoint} onSelectionDragStart={checkpoint} onConnect={onConnect} nodesDraggable={notesPersistence.canEdit} nodesConnectable={notesPersistence.canEdit} elementsSelectable={notesPersistence.canEdit}
            onNodeClick={(event, node) => { if (editingNode && editingNode !== node.id) setEditingNode(null); if (node.data.contentId) { setCurrentId(node.data.contentId); setRightOpen(true); } }}
            onNodeDoubleClick={(event, node) => { const resource = resources[node.data.contentId]; if (resource?.type === 'link') { setCurrentId(resource.id); setRightOpen(true); void refreshResource(resource.id); return; } setEditingNode(node.id); if (node.data.contentId) { setCurrentId(node.data.contentId); setRightOpen(true); void refreshResource(node.data.contentId); } }}
            onEdgeDoubleClick={(event, value) => { if (value.type === 'relation') setEditingEdge((current) => current === value.id ? current : value.id); }}
            onPaneClick={() => { setEditingNode(null); setEditingEdge(null); }} onMove={(event, camera) => setZoom(camera.zoom)} onMoveEnd={(event, camera) => { if (!event) return; if (notesPersistence.markEdit() && activeNotebook) setFolders(previous => previous.map(folder => folder.id === activeNotebook ? { ...folder, viewport: camera } : folder)); notesPersistence.saveViewport(camera); }}
            panOnDrag={notesPersistence.canEdit ? (tool === 'hand' ? true : [1, 2]) : false} selectionOnDrag={notesPersistence.canEdit && tool === 'select' && !space} zoomOnScroll={notesPersistence.canEdit} zoomOnPinch={notesPersistence.canEdit} panActivationKeyCode={null} selectionKeyCode="Shift" multiSelectionKeyCode="Shift"
            colorMode={theme} noWheelClassName="nowheel" deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={0.2} maxZoom={2} fitViewOptions={{ padding: 0.2, maxZoom: 1.25 }} onlyRenderVisibleElements elevateNodesOnSelect>
            <Background id="studymate-grid" variant={BackgroundVariant.Dots} gap={grid.gap} size={grid.size} color="var(--grid-dot)" bgColor="var(--canvas)" /><MiniMap style={{ width: 138, height: 90, overflow: 'hidden' }} pannable zoomable nodeColor={(node) => node.type === 'text' ? (theme === 'dark' ? '#8f8453' : '#d8c88e') : resources[node.data.contentId]?.type === 'course' ? (theme === 'dark' ? '#a68b61' : '#dfcba4') : (theme === 'dark' ? '#6d9c8a' : '#aacbbb')} maskColor="var(--minimap-mask)" />
          </ReactFlow>
          {space && <div ref={panLayer} className="pan-capture-layer" data-testid="space-pan-layer" onPointerDown={forcedPan} />}
          <div className={'canvas-drop-hint' + (dropActive ? ' is-active' : '')}>从左树拖入即引用同一原件；外部文件可选导入方式</div>
          <div className="canvas-toolbar" role="toolbar" aria-label={nt('canvas_tools')}><button className={'icon-button' + (tool === 'select' ? ' active' : '')} aria-label={nt('select_tool')} title={nt('select_shortcut')} onClick={() => setTool('select')}><MousePointer2 size={17} /></button><button className={'icon-button' + (tool === 'hand' ? ' active' : '')} aria-label={nt('pan_tool')} title={nt('pan_shortcut')} onClick={() => setTool('hand')}><Hand size={17} /></button><i />
            <button className="icon-button" aria-label={nt('add_text')} title={nt('text_node')} disabled={!notesPersistence.canEdit} onClick={addText}><Type size={18} /></button><i />
            <button className="icon-button" aria-label={nt('undo_canvas')} title={nt('undo')} disabled={!history.current.past.length} onClick={() => restore('undo')}><Undo2 size={17} /></button><button className="icon-button" aria-label={nt('redo_canvas')} title={nt('redo')} disabled={!history.current.future.length} onClick={() => restore('redo')}><Redo2 size={17} /></button><i />
            <button className="icon-button" aria-label={nt('zoom_out')} onClick={() => flow.zoomOut({ duration: 140 * getMotionScale() })}><ZoomOut size={17} /></button><span className="zoom-label">{Math.round(zoom * 100)}%</span><button className="icon-button" aria-label={nt('zoom_in')} onClick={() => flow.zoomIn({ duration: 140 * getMotionScale() })}><ZoomIn size={17} /></button><button className="icon-button" aria-label={nt('fit')} title={nt('fit_shortcut')} onClick={fit}><Maximize size={17} /></button>
          </div>
        </section>
        {view === 'document' && <section className="document-stage"><div className="document-toolbar" ref={setDocumentActions}>{current?.type === 'note' && !referenceReadOnly ? <NoteTitleInput resource={current} label={nt('document_title')} onRename={renameResource} disabled={!notesPersistence.canEdit} /> : <span className="document-title">{current?.title}</span>}
        </div>{currentMarkdown && <CourseAssociationBar resource={current} library={courseLibrary} onNavigate={onNavigateCourse} onManage={openAssociation} canEdit={canEditAssociation} />}{currentMarkdown && <div className="editor-mode-switch document-mode-switch" role="group" aria-label={nt('document_view_mode')}>{DOCUMENT_MODES.map(([mode, labelKey]) => <button key={mode} type="button" className={documentMode === mode ? 'is-active' : ''} aria-pressed={documentMode === mode} onClick={() => setDocumentModes(previous => ({ ...previous, [current.id]: mode }))}>{nt(labelKey)}</button>)}</div>}
          <div className={'document-scroll is-' + documentMode + (currentMarkdown ? ' note-document-scroll' : '')}>{documentBody}</div></section>}
      </main>
      <aside id="right-panel" className={'side-panel right-panel' + (!rightOpen ? ' is-collapsed' : '')} style={{ width: rightOpen ? rightWidth : 0 }} inert={!rightOpen ? true : undefined} aria-hidden={!rightOpen}><div className="panel-inner">
        <div className="panel-header resource-header"><span className="panel-title resource-header-title" title={current?.title}>{view === 'document' ? nt('chat') : current?.title || nt('files')}</span>
          {view === 'canvas' && currentMarkdown && <CourseAssociationOption resource={current} library={courseLibrary} onManage={openAssociation} canEdit={canEditAssociation} />}
          {view === 'canvas' && <div className="resource-header-actions" ref={setResourceActions}>
            <button className="icon-button" disabled={!current} aria-label={nt(currentCard ? 'locate' : 'place')} title={nt(currentCard ? 'locate' : 'place')} onClick={() => placeResource(current.id)}>{currentCard ? <LocateFixed size={16} /> : <Plus size={16} />}</button>
            <button className="icon-button" disabled={!current} aria-label={nt('open_document')} title={nt('open_document')} onClick={() => openDocument(current.id)}><FileText size={16} /></button>
            <button className="icon-button danger" disabled={!currentCard} title={nt('remove_node_hint')} aria-label={nt('remove_canvas')} onClick={removeCurrentCard}><Trash2 size={16} /></button>
          </div>}
        </div>
        {view === 'document' ? <ChatComponent resources={resources} currentId={current?.id} quoteIds={quoteIds} onQuote={quote} onRemoveQuote={(id) => setQuoteIds((previous) => previous.filter((value) => value !== id))} draft={chatDraft} onDraftChange={setChatDraft} />
          : <div className={'resource-detail panel-body' + (currentMarkdown ? ' is-note-detail' : '')}>
            {originDescription(current) && <div className="resource-origin-badge" data-origin={current.referenceError ? 'missing' : referenceReadOnly ? 'link' : 'local'}>{originDescription(current)}</div>}
            {referenceReadOnly && <button className="button ghost" onClick={() => refreshResource(current.id)}><RefreshCw size={13} />{nt('reread')}</button>}
            {referenceReadOnly && notesPersistence.isNative && <button className="button ghost" onClick={() => relinkFileReference(current.id)}><FileText size={13} />{nt('relink_file')}</button>}
            {current?.referenceError && <p className="validation-error" role="alert">{current.referenceError}</p>}
            {current?.courseRef ? <CourseReference key={current.id} resource={current} library={courseLibrary} renderCourse={renderCourse} onNavigate={onNavigateCourse} canEdit={notesPersistence.canEdit} onChange={patch => updateResource(current.id, patch)} /> : currentMarkdown ? <NoteEditor key={current.id} resource={current} theme={theme} exportTarget={resourceActions} readOnly={referenceReadOnly || !notesPersistence.canEdit || !active || !rightOpen} onChange={markdown => updateResource(current.id, { markdown })} /> : isUnsupportedNote(current) ? <p className="unsupported-note" role="status">{nt('unsupported_note')}</p> : current && ['image', 'svg', 'html'].includes(current.type) ? <MediaRenderer resource={current} className="media-preview" /> : <><h2>{current?.title}</h2><p>{current?.summary}</p>{current?.type === 'link' && <a href={current.url} target="_blank" rel="noopener noreferrer">{nt('open_web')}</a>}</>}
          </div>}
        </div>{rightOpen && <ResizeBar side="right" value={rightWidth} onChange={setRightWidth} onResizing={setResizing} />}
      </aside>
    </div>
    <input type="file" ref={fileInput} hidden multiple accept={IMPORT_FILE_ACCEPT} aria-label={nt('import_files')} onChange={importFiles} />
    {notice && <div className="toast" role="status">{notice}</div>}
    {modal === 'help' && <Modal title="操作说明" className="help-modal" onClose={() => setModal(null)}><div className="help-dialog">
      <div className="help-sections"><section><h3>画布与关系</h3><ul><li>拖动卡片移动；双击后阅读选字或编辑纯内容节点。网页链接本身就是一个文本节点。</li><li>按住空格拖动，随时平移；保持空格时滚轮也可缩放。</li><li>拖动圆形连接点建立关系；双击连线可写说明，说明可以为空，空说明不显示标签。</li><li>点阵与节点使用同一套画布坐标，缩放时一起放大缩小，相对间距不变。</li></ul></section>
      <section><h3>文件与导入</h3><ul><li>从电脑导入或拖入画布时选择副本或引用。从左树拖入画布只添加引用；要复制 Markdown，在文件的「更多」菜单选择「复制 Markdown」。</li><li>副本是独立内容，不随来源变化；资源引用仍指向同一原件，已有节点会定位。</li><li>本地文件引用只读、不写回。有文件句柄时打开/引用发送会重新读取；不支持句柄的环境仅保留本次文件，原件变化需重新选择。</li><li>带标题的卡片可用标题右侧箭头折叠为仅标题；箭头已替换原来的“打开文档”图标。</li><li>右详情标题栏集中放置定位、打开文档和移出画布；删除节点不删除文件。</li></ul></section>
      <section><h3>编辑与布局</h3><ul><li>文件名下的格式栏直接修改同一份 Markdown；光标触及的格式片段显示可编辑灰色标记，其他内容保留排版。</li><li>Ctrl / ⌘ + B、I、K 对当前正文应用粗体、斜体、链接；正文撤销与画布历史分开。侧栏边界仍可拖宽。</li><li>左右侧栏开关分别在顶栏最左侧与最右侧。独立文档有预览、编辑、双列和渲染编辑，每篇分别记忆；窄双列可切换源码或预览。明暗默认跟随宿主或系统，也可在本页切换。</li></ul></section>
      <section><h3>安全与保存</h3><p>{notesPersistence.isNative
        ? '笔记内容与画布已接入 DSH 持久化服务，刷新或重启宿主后可恢复。保存中/未保存/已保存/失败/冲突状态见顶栏。'
        : '笔记、导入内容与画布仍只存本页，刷新即重置。'}项目内 examples/static-page.html 是可直接用“导入”打开的安全静态页面示例。{hostTheme ? 'DSH 会话由宿主管理，先显式选择，不自动发送。' : '独立预览未连接宿主会话，发送禁用。'}</p><p>图片 ≤4 MiB / 8192边长 / 1600万像素；SVG ≤512 KiB / 2000元素；HTML ≤256 KiB / 1500元素；本页文件总量 ≤32 MiB。不执行脚本、不加载外部资源、不递归访问文件夹。</p></section></div>
      <div className="help-shortcuts"><table><caption>快捷键</caption><thead><tr><th>按键</th><th>作用</th></tr></thead><tbody>
        {[['空格 + 拖动', '强制平移画布'], ['滚轮 / 空格 + 滚轮', '缩放画布（卡内滚动除外）'], ['H / V', '平移 / 选择工具'], ['1', '适应全部节点'], ['Shift + 点击', '多选节点'], ['Delete / Backspace', '删除所选节点/连线，保留文件'], ['Ctrl / ⌘ + Z', '撤销当前焦点所属的操作'], ['Ctrl / ⌘ + Shift + Z', '重做'], ['Esc', '退出编辑 / 关闭弹窗'], ['Ctrl / ⌘ + Enter', '提交纯内容节点编辑'], ['行号点击 / 拖动', '选择整行 / 连续多行']].map(([key, action]) => <tr key={key}><td><kbd>{key}</kbd></td><td>{action}</td></tr>)}
      </tbody></table></div></div></Modal>}
    {!notesPersistence.isNative && modal === 'reset' && <Modal title="恢复示例？" onClose={() => setModal(null)}><p>会清除本页的编辑、导入文件与草稿，不能撤销。</p><div className="modal-actions"><button className="button ghost" onClick={() => setModal(null)}>取消</button><button className="button primary" onClick={reset}>确认恢复</button></div></Modal>}
    {modal === 'create' && createAt && <Modal title={nt(CREATE_ENTRIES.find(([kind]) => kind === createAt.kind)?.[1])} onClose={() => setModal(null)}><form onSubmit={finishCreate}>
      <p className="notes-create-target">{nt('create_target', { path: folderPath(folders, createAt.parent) })}</p>
      <label>{nt('name')}<input className="text-input" aria-label={nt(createAt.kind === 'notebook' ? 'notebook_name' : createAt.kind === 'folder' ? 'folder_name' : 'note_name')} value={folderName} maxLength={createAt.kind === 'note' ? 160 : 80} onChange={event => setFolderName(event.target.value)} /></label>
      {formError && <p className="validation-error" role="alert">{formError}</p>}
      <div className="modal-actions"><button className="button primary" disabled={!folderName.trim()} type="submit">{nt('create')}</button></div>
    </form></Modal>}
    {modal === 'notebook-bindings' && <Modal title="课程绑定" onClose={() => setModal(null)}>{managedBook
      ? <NotebookBindingsForm key={manageAt} book={managedBook} folders={folders} library={courseLibrary} canEdit={notesPersistence.canEdit}
          onBind={scope => bindNotebook(manageAt, scope)} onSetDefault={scope => commands.setDefault(scope, manageAt)} onUnbind={(scope, replacement) => unbindNotebook(manageAt, scope, replacement)} />
      : <p role="status">笔记本已不可用。</p>}</Modal>}
    {modal === 'note-associations' && <Modal title="管理课程关联" onClose={() => setModal(null)}>{managedNote && !managedNote.trashed
      ? <NoteAssociationsForm key={manageAt} resource={managedNote} library={courseLibrary} canEdit={notesPersistence.canEdit && isMarkdownResource(managedNote)}
          onAssociate={ref => commands.associate(manageAt, ref)} onRemove={ref => commands.removeAssociation(manageAt, ref)} />
      : <p role="status">笔记已不可用。</p>}</Modal>}
    {modal === 'link' && <Modal title={nt('add_web')} onClose={() => setModal(null)}><form onSubmit={(event) => { event.preventDefault(); try { const url = new URL(linkUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP 或 HTTPS 地址'); if (Object.keys(resources).length >= 250) throw new Error('资源数量已达上限'); if (!notesPersistence.markEdit()) return; const id = uid('link'); setResources((previous) => ({ ...previous, [id]: { id, type: 'link', title: linkTitle.trim() || url.hostname, url: url.href, summary: '网页引用', parent: selectedFolder || 'references' } })); setCurrentId(id); setModal(null); announce('已添加网页引用，不抓取网页正文'); } catch (error) { setFormError(error.message); } }}><label>{nt('heading')}<input className="text-input" aria-label={nt('web_title')} value={linkTitle} maxLength={160} onChange={(event) => setLinkTitle(event.target.value)} /></label><label>{nt('address')}<input className="text-input" aria-label={nt('web_address')} value={linkUrl} maxLength={2048} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://" /></label>{formError && <p className="validation-error" role="alert">{formError}</p>}<div className="modal-actions"><button className="button primary" type="submit">{nt('add')}</button></div></form></Modal>}
    {modal === 'reference-source' && <Modal title={nt('add_reference')} onClose={() => setModal(null)}><div className="import-mode-dialog"><p>{nt('choose_reference')}</p><div className="import-mode-options"><button className="button ghost" onClick={() => chooseFiles('reference')}><FileText size={16} />{nt('choose_file')}</button><button className="button ghost" onClick={() => setModal('link')}><Link2 size={16} />{nt('add_web_reference')}</button></div><p className="muted">{nt('reference_lifetime')}</p></div></Modal>}
    {modal === 'drop-mode' && pendingImport && <Modal title={nt('choose_import')} className="import-choice-modal" onClose={() => { setPendingImport(null); setModal(null); }}><div className="import-mode-dialog"><p>{nt('external_files', { n: pendingImport.entries.length })}</p><div className="import-mode-options" role="group" aria-label={nt('copy_or_reference')}><button className="import-mode-option" aria-label={nt('import_copy')} onClick={() => applyDropMode('copy')}><Copy size={20} /><span><strong>{nt('copy')}</strong><small>{nt('independent_copy')}</small></span></button><button className="import-mode-option" aria-label={nt('import_reference')} onClick={() => applyDropMode('reference')}><Link2 size={20} /><span><strong>{nt('reference')}</strong><small>{nt('readonly_original')}</small></span></button></div><p className="muted">{nt('import_checks')}</p></div></Modal>}
    {modal === 'import-error' && <Modal title={nt('partial_import')} onClose={() => setModal(null)}><p className="validation-error import-error" role="alert">{formError}</p></Modal>}
  </div></BoardContext.Provider>;
}
export default function App({ ChatComponent = ChatPanel, ...props }) { return <ReactFlowProvider><Board ChatComponent={ChatComponent} {...props} /></ReactFlowProvider>; }
