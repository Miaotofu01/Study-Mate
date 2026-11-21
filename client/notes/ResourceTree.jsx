import React, { useState } from 'react';
import { useNotesLocale } from './locale.js';
import { ChevronRight, ChevronDown, Folder, FolderOpen, NotebookPen, FileText, Link2, BookOpen, Image, FileCode, LayoutGrid } from 'lucide-react';

const icons = { note: FileText, course: BookOpen, link: Link2, image: Image, svg: FileCode, html: FileCode };
export const initialFolders = [
  { id: 'library', parent: null, name: '我的资料', kind: 'folder' },
  { id: 'book', parent: 'library', name: '学习与理解', kind: 'notebook' },
  { id: 'notes', parent: 'book', name: '概念', kind: 'folder' },
  { id: 'examples', parent: 'book', name: '例子', kind: 'folder' },
  { id: 'references', parent: 'library', name: '参考', kind: 'folder' },
];
export const initialParent = (resource) => resource.type === 'note' ? (resource.id === 'note-example' ? 'examples' : 'notes') : 'references';

export default function ResourceTree({ folders, resources, search, selectedId, selectedFolder, onFolderSelect, onSelect, onOpenDocument, onCanvas }) {
  const t = useNotesLocale();
  const [closed, setClosed] = useState(new Set());
  const query = search.trim().toLocaleLowerCase();
  const matches = (resource) => !resource.trashed && (!query || (resource.title + ' ' + (resource.markdown || resource.summary || '')).toLocaleLowerCase().includes(query));
  const hasMatches = (folder) => Object.values(resources).some((resource) => (resource.parent || initialParent(resource)) === folder.id && matches(resource)) || folders.some((child) => child.parent === folder.id && hasMatches(child));
  const renderFolder = (folder, depth) => {
    const children = folders.filter((item) => item.parent === folder.id);
    const files = Object.values(resources).filter((item) => (item.parent || initialParent(item)) === folder.id && matches(item));
    if (query && !hasMatches(folder)) return null;
    const open = query || !closed.has(folder.id);
    const Icon = folder.kind === 'notebook' ? NotebookPen : open ? FolderOpen : Folder;
    return <div key={folder.id} role="treeitem" aria-expanded={!!open} aria-level={depth + 1}>
      <button className={'tree-row' + (selectedFolder === folder.id ? ' is-active' : '') + (folder.kind === 'notebook' ? ' is-notebook' : '')}
        style={{ paddingLeft: 8 + depth * 16 }} aria-label={t('folder', { name: folder.name })} onClick={() => {
          onFolderSelect(folder.id);
          setClosed((prev) => { const next = new Set(prev); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; });
        }}>
        <span className="tree-toggle">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span><Icon size={16} className="tree-icon" /><span className="tree-label">{folder.name}</span>
      </button>
      {open && <div role="group">
        {folder.kind === 'notebook' && <button className="tree-row tree-canvas" style={{ paddingLeft: 24 + (depth + 1) * 16 }} onClick={() => onCanvas(folder.id)} aria-label={t('open_canvas', { name: folder.name })}><LayoutGrid size={15} /><span className="tree-label">{t('canvas')}</span></button>}
        {children.map((child) => renderFolder(child, depth + 1))}
        {files.map((resource) => {
          const IconForFile = icons[resource.type] || FileText;
          return <div className={'tree-row tree-file' + (resource.id === selectedId ? ' is-active' : '')} key={resource.id} style={{ paddingLeft: 24 + (depth + 1) * 16 }}
            role="treeitem" aria-level={depth + 2} draggable onDragStart={(event) => { event.dataTransfer.setData('application/studymate-resource', resource.id); event.dataTransfer.effectAllowed = 'copy'; }}>
            <button className="tree-file-open" aria-label={t('open', { name: resource.title })} onClick={() => onSelect(resource.id)} onDoubleClick={() => onOpenDocument(resource.id)}><IconForFile size={15} className="tree-icon" /><span className="tree-label">{resource.title || t('untitled')}</span></button>
            {resource.origin && <span className="resource-origin-badge" data-origin={resource.origin.mode === 'reference' ? 'link' : 'local'} title={t(resource.origin.mode === 'reference' ? 'reference_hint' : 'copy_hint')}>{t(resource.origin.mode === 'reference' ? 'reference' : 'copy')}</span>}
          </div>;
        })}
      </div>}
    </div>;
  };
  return <div className="resource-tree" role="tree" aria-label={t('hierarchy')}>{folders.filter((folder) => !folder.parent).map((folder) => renderFolder(folder, 0))}{query && !Object.values(resources).some(matches) && <div className="empty-state">{t('no_documents')}</div>}</div>;
}
