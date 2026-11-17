// 课程身份只做精确比较。显示名不是身份，资源 parent 也不是课程分类。
export const sameSubject = (a, b) => Boolean(a && b && a.workspace === b.workspace && a.subject === b.subject);
export const sameCourse = (a, b) => sameSubject(a, b) && a.node === b.node;
export const subjectKey = (scope) => JSON.stringify([scope.workspace, scope.subject]);
export const courseKey = (ref) => JSON.stringify([ref.workspace, ref.subject, ref.node]);
export const courseRef = (scope, node) => ({ workspace: scope.workspace, subject: scope.subject, node: node.id, title: node.title || node.id });
export function normalizeCourseRef(raw, { subjectOnly = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('课程来源必须是对象。');
  const out = {};
  for (const [key, limit] of [['workspace', 2000], ['subject', 200], ...(!subjectOnly ? [['node', 200]] : [])]) {
    if (typeof raw[key] !== 'string' || !raw[key].trim() || [...raw[key]].length > limit) throw new Error(`课程来源 ${key} 非法。`);
    out[key] = raw[key];
  }
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || [...raw.title].length > 2000) throw new Error('课程来源 title 非法。');
    out.title = raw.title;
  }
  return out;
}
export function normalizeAssociations(raw) {
  if (!Array.isArray(raw) || raw.length > 32) throw new Error('笔记课程关联必须是至多 32 项的数组。');
  const out = raw.map(ref => normalizeCourseRef(ref));
  if (new Set(out.map(subjectKey)).size !== out.length) throw new Error('同一科目的笔记只能归到一个节点。');
  return out;
}
export function associateNote(resource, ref) {
  const checked = normalizeCourseRef(ref);
  return { ...resource, associations: normalizeAssociations([...(resource.associations || []).filter(item => !sameSubject(item, checked)), checked]) };
}
export function notebookOf(resource, folders) {
  let id = resource?.parent;
  const visited = new Set();
  while (id && !visited.has(id)) {
    visited.add(id);
    const folder = folders.find(item => item.id === id);
    if (!folder) return null;
    if (folder.kind === 'notebook') return folder;
    id = folder.parent;
  }
  return null;
}
export const ownedNote = resource => resource?.type === 'note' && !(resource.origin?.kind === 'file' && resource.origin?.mode === 'reference');
export const linkedNotes = (resources, ref, includeTrash = false) => Object.values(resources).filter(resource => ownedNote(resource) && (includeTrash || !resource.trashed) && (resource.associations || []).some(item => sameCourse(item, ref)));
export function resolveCourse(library, ref) {
  if (!library || library.workspace !== ref?.workspace) return null;
  const subject = (library.subjects || []).find(item => item.slug === ref.subject);
  const node = subject?.nodes?.find(item => item.id === ref.node);
  return node ? { subject, node } : null;
}

// 一棵 main 一个 bridge；它不读写文件，不创建第二条保存队列。
const EMPTY = Object.freeze({ resources: {}, folders: [], selectedId: '', canEdit: false, loadState: 'loading', saveStatus: {}, conflictKeys: [] });
export function createNotesWorkspace() {
  let snapshot = EMPTY;
  let commands = null;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    publish(next, handlers) { snapshot = next; commands = handlers; for (const listener of listeners) listener(); },
    detach() { snapshot = EMPTY; commands = null; for (const listener of listeners) listener(); },
    dispatch(name, ...args) { return commands?.[name]?.(...args); },
  };
}
