// #304 坏资源横幅文案：只呈现能确定的事实，按「课程 → 笔记本 → 未知」逐档降级。
// 纯函数、不碰 DOM，Node 测试可直接覆盖三档文案与回退规则。
import { resolveCourse } from './curriculum.js';

export function corruptCourseName(entry, courseLibrary) {
  for (const ref of entry.associations || []) {
    const found = resolveCourse(courseLibrary, ref);
    if (found) return found.node.title || found.subject?.name || ref.node;
  }
  return null;
}

export function corruptNotebookName(entry, folders, scene) {
  if (entry.notebook) return entry.notebook;
  const node = (scene?.nodes || []).find(item => item?.data?.contentId === entry.id);
  const folder = (folders || []).find(item => item.id === node?.data?.notebookId && item.kind === 'notebook');
  return folder?.name || null;
}

export function corruptMessage(entry, courseLibrary, folders, scene) {
  const name = entry.title || entry.id;
  const course = corruptCourseName(entry, courseLibrary);
  if (course) return `课程「${course}」下的笔记「${name}」的文件已损坏，未载入；其余笔记可正常编辑。`;
  const notebook = corruptNotebookName(entry, folders, scene);
  if (notebook) return `笔记本「${notebook}」中的资源「${name}」的文件已损坏，未载入。`;
  return `元数据损坏、无法确定课程（文件 ${entry.id}）：内容无法解析，未载入。`;
}
