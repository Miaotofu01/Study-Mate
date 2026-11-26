// 资源树的纯逻辑：目录数据、空目录判定、重命名校验、可重命名判定。
// 刻意不依赖 React 与 DOM：Node 套件（scripts/tests/test_notes_resource_tree.mjs）
// 直接加载本文件做行为契约；ResourceTree.jsx 负责呈现并把这里的判定递进菜单。

// 初始目录与「没有显式 parent 的示例资源」的默认归属。
// App.jsx 一直从 ResourceTree.jsx 再导出的这两个名字取值，不能改名或搬走出处。
export const initialFolders = [
  { id: 'library', parent: null, name: '我的资料', kind: 'folder' },
  { id: 'book', parent: 'library', name: '学习与理解', kind: 'notebook' },
  { id: 'notes', parent: 'book', name: '概念', kind: 'folder' },
  { id: 'examples', parent: 'book', name: '例子', kind: 'folder' },
  { id: 'references', parent: 'library', name: '参考', kind: 'folder' },
];

export const initialParent = (resource) => resource.type === 'note' ? (resource.id === 'note-example' ? 'examples' : 'notes') : 'references';

// 资源的归属目录：显式 parent 优先，缺省回退到示例数据的默认目录。
export const resourceFolder = (resource) => resource.parent || initialParent(resource);

function folderTrail(folders, id) {
  const trail = [];
  const visited = new Set();
  while (id) {
    const folder = folders.find(item => item.id === id);
    if (!folder || visited.has(id)) return null;
    trail.push(folder);
    visited.add(id);
    id = folder.parent;
  }
  return trail;
}

// 拖动只改变原件所在目录，不重建 ID。无效目标不能接住拖动，也不能写入布局。
export function planResourceMove(folders, resources, entry, targetId) {
  const fromTree = entry.kind === 'folder';
  const source = fromTree ? folders.find(folder => folder.id === entry.id) : resources[entry.id];
  if (!source || (fromTree ? source.kind !== 'folder' || !source.parent : source.trashed)) return null;
  const parent = fromTree ? source.parent : resourceFolder(source);
  if (targetId === parent) return null;
  const targetTrail = folderTrail(folders, targetId);
  if (!targetTrail?.length || (fromTree && targetTrail.includes(source))) return null;
  const fromNotebook = folderTrail(folders, parent)?.find(folder => folder.kind === 'notebook');
  const toNotebook = targetTrail.find(folder => folder.kind === 'notebook');
  // 旧库可有放在公共目录下的笔记本，但拖动包含该本的目录不能造成笔记本嵌套。
  if (fromTree && toNotebook && folders.some(folder => folder.kind === 'notebook'
    && folderTrail(folders, folder.parent)?.includes(source))) return null;
  return { source, crossesNotebook: fromNotebook?.id !== toNotebook?.id };
}

// 与 App 新建文件夹输入框一致的名称上限（persistence.js 的目录 name 硬上限是 200）。
export const FOLDER_NAME_MAX = 80;
// 与文档标题输入框一致的标题上限（commands.rename 的代码点上限 2000 远宽于此）。
export const FILE_TITLE_MAX = 160;

// 目录是否为空。只有空目录允许删除：
// 1) 有子目录不算空；2) 任何资源都算内容——**含废纸篓里的 trashed 资源**，
//    删除目录不许顺带删除、移动或孤立任何资源（删除数据语义不在这里改变）；
// 3) hasCanvasContent 为真（笔记本画布上还有节点）不算空，由宿主侧传入。
export function folderIsEmpty(folders, resources, folderId, hasCanvasContent = false) {
  if (folders.some(folder => folder.parent === folderId)) return false;
  if (Object.values(resources).some(resource => resourceFolder(resource) === folderId)) return false;
  return !hasCanvasContent;
}

// 非空提醒用的计数：子目录数与资源数（trashed 计入，与 folderIsEmpty 同一口径）。
export function folderContentSummary(folders, resources, folderId) {
  const children = folders.filter(folder => folder.parent === folderId).length;
  const files = Object.values(resources).filter(resource => resourceFolder(resource) === folderId).length;
  return { children, files };
}

// initialParent（见上）的回退目标：缺显式 parent 的资源落到这三个目录。
// store（lib/notes/store.ts）不校验也不改写资源 parent，旧数据/外部回灌都可能缺 parent，
// 所以这三个 id 的目录按 id 保护，与当前是否为空无关。
const FALLBACK_FOLDER_IDS = new Set(['notes', 'examples', 'references']);

// 目录删除的阻断原因；返回 '' = 允许删除。
// 保护项（与 App 层对齐的口径，App 在 onDeleteFolder 里应再验一遍同一函数）：
// 1) 系统根（parent === null）不可删——App 侧多处按 id 'library' 引用根目录，删除会破坏建目录/建笔记本的父级回退；
// 2) 回退目录（notes/examples/references）不可删——删掉后缺显式 parent 的资源在树里永久隐形；
// 3) 最后一本笔记本不可删——学习面板「新建笔记」需要默认本/归属目录（createNote 按笔记本校验），
//    删光后新建无归属；本条优先于默认本/绑定本提醒：只剩一本时「先更换默认本」无从操作；
// 4) 笔记本有 defaultForSubjects（某科目的默认本）不可删——删除会断「该科目首次新建笔记进默认本」的创建流；
// 5) 笔记本有 bindings（绑定科目）不可删——静默删绑定属于变更数据语义，应先在界面上解除绑定；
// 6) 非空不可删——子目录、任何资源（含废纸篓 trashed）、画布节点（hasCanvasContent）都算内容。
export function folderDeleteBlockReason(folders, resources, folder, hasCanvasContent = false) {
  if (!folder || folder.parent === null) return '根目录不可删除。';
  if (FALLBACK_FOLDER_IDS.has(folder.id)) return '「' + folder.name + '」是未归属文件的默认去处，删除后这些文件将不再显示，不可删除。';
  if (folder.kind === 'notebook' && folders.filter(item => item.kind === 'notebook').length <= 1) return '这是最后一本笔记本，新建笔记需要归属目录，不能删除。';
  if ((folder.defaultForSubjects || []).length) return '该笔记本是 ' + folder.defaultForSubjects.length + ' 个科目的默认笔记本，请先更换默认本再删除。';
  if ((folder.bindings || []).length) return '该笔记本绑定了 ' + folder.bindings.length + ' 个科目，请先解除绑定再删除。';
  if (!folderIsEmpty(folders, resources, folder.id, hasCanvasContent)) {
    const { children, files } = folderContentSummary(folders, resources, folder.id);
    const parts = [];
    if (children) parts.push(children + ' 个子目录');
    if (files) parts.push(files + ' 个文件' + (Object.values(resources).some((resource) => resource.trashed && resourceFolder(resource) === folder.id) ? '（含废纸篓项）' : ''));
    if (!parts.length && hasCanvasContent) parts.push('画布上还有内容');
    return '「' + folder.name + '」不是空目录（' + parts.join('、') + '），清空后才能删除。';
  }
  return '';
}

// 引用型文件（origin.mode === 'reference'）名称跟随来源文件，不提供重命名；
// 其余资源（自有笔记、副本、网页、课程卡）重命名只改元数据 title。
export function canRenameResource(resource) {
  return Boolean(resource) && !resource.trashed && resource.origin?.mode !== 'reference';
}

const validateName = (value, max, label) => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return { ok: false, error: label + '不能为空。' };
  if ([...name].length > max) return { ok: false, error: label + '不能超过 ' + max + ' 个字符。' };
  return { ok: true, name };
};

export const validateFolderName = (value) => validateName(value, FOLDER_NAME_MAX, '文件夹名称');
export const validateFileTitle = (value) => validateName(value, FILE_TITLE_MAX, '文件标题');
