import React, { useState, useSyncExternalStore } from 'react';
import NoteEditor from './NoteEditor.jsx';
import NoteTitleInput from './NoteTitleInput.jsx';
import { isMarkdownResource } from './note-types.js';
import { courseRef, courseKey, linkedNotes, sameSubject, sameCourse, notebookOf, ownedNote, resolveCourse } from './curriculum.js';
import { SubjectNotebooksPicker, noteOriginFolder, notebookBindingLabel, notebookBindingNames } from './CourseRelations.jsx';
import { useNotesLocale, nt } from './locale.js';
import './curriculum.css';

const EMPTY = Object.freeze({ resources: {}, folders: [], selectedId: '', canEdit: false, loadState: 'loading', saveStatus: {} });
const noopSubscribe = () => () => {};
export function useNotesWorkspace(bridge) {
  return useSyncExternalStore(bridge?.subscribe || noopSubscribe, bridge?.getSnapshot || (() => EMPTY), () => EMPTY);
}
export function NotesStatus({ state, dispatch }) {
  useNotesLocale();
  const [error, setError] = useState('');
  const run = async (name, ...args) => { try { setError(''); await dispatch(name, ...args); } catch (e) { setError(e.message); } };
  const values = Object.values(state.saveStatus || {});
  const conflict = values.some(item => item.state === 'conflict');
  const failed = values.some(item => item.state === 'error');
  const pending = values.some(item => item.dirty || ['saving', 'pending'].includes(item.state));
  return <div className="notes-status" role="status">
    {state.loadState === 'loading' ? nt('loading_notes') : state.loadState === 'upgrade' ? <><p>{nt('upgrade_hint')}</p><button onClick={() => run('upgrade')}>{nt('upgrade')}</button></> : state.loadState === 'error' ? <><p>{nt('load_error')}</p><button onClick={() => run('reload')}>{nt('reload')}</button></> : conflict ? <><p>{nt('conflict_hint')}</p><button onClick={() => run('retryConflicts')}>{nt('keep_retry')}</button></> : failed ? <><p>{nt('save_failed_hint')}</p><button onClick={() => run('retry')}>{nt('retry_save')}</button></> : pending ? nt('saving_notes') : nt('saved')}
    {(pending || conflict || failed) && <><button onClick={() => run('export')}>{nt('export_drafts')}</button><button onClick={() => run('reload')}>{nt('discard_reload')}</button></>}
    {(state.loadError || error) && <p role="alert">{error || state.loadError?.message}</p>}
  </div>;
}
function NotebookPicker({ scope, state, dispatch, onClose, onChosen }) {
  useNotesLocale();
  const books = state.folders.filter(item => item.kind === 'notebook');
  const defaultBook = books.find(item => (item.defaultForSubjects || []).some(ref => sameSubject(ref, scope)));
  const [id, setId] = useState(defaultBook?.id || books[0]?.id || 'new');
  const [name, setName] = useState(scope.title || '新笔记本');
  const [error, setError] = useState('');
  return <section className="notes-picker" role="dialog" aria-label={nt('notebook_picker')}>
    <b>{nt('default_for', { name: scope.title || scope.subject })}</b><p>{nt('default_hint')}</p>
    <label>{nt('notebook')}<select aria-label={nt('default_notebook')} value={id} onChange={event => setId(event.target.value)}>{books.map(book => <option key={book.id} value={book.id}>{book.name}</option>)}<option value="new">{nt('new_notebook_option')}</option></select></label>
    {id === 'new' && <label>{nt('name')}<input aria-label={nt('notebook_name')} value={name} maxLength={200} onChange={event => setName(event.target.value)} /></label>}
    {error && <p role="alert">{error}</p>}<div className="notes-actions"><button onClick={onClose}>{nt('cancel')}</button><button disabled={!state.canEdit || (id === 'new' && !name.trim())} onClick={() => { try { const chosen = dispatch('setDefault', scope, id === 'new' ? null : id, name); if (chosen) onChosen(chosen); } catch (e) { setError(e.message); } }}>{nt('confirm')}</button></div>
  </section>;
}
function NoteRow({ resource, state, dispatch, onOpen, refValue, isMarkdown, onRename }) {
  useNotesLocale();
  const [rename, setRename] = useState(false);
  const [title, setTitle] = useState(resource.title);
  const [error, setError] = useState('');
  const bookName = notebookOf(resource, state.folders)?.name || '';
  const submit = value => {
    try { setError(''); if (onRename) onRename(resource.id, value); else dispatch('rename', resource.id, value); setRename(false); } catch (e) { setError(e.message); }
  };
  // 未识别的文件（显示名不再是 Markdown）只当不可编辑的占位：不能打开，但留一条改回
  // 支持扩展名的入口（换个名字恢复原状，正文、ID、关联都不动——ADR-0019「资源操作」）。
  // 识别规则以 note-types.js 为准；调用方仍可用 isMarkdown 覆写。
  const markdown = typeof isMarkdown === 'function' ? isMarkdown : isMarkdownResource;
  if (!markdown(resource)) {
    return <div className="notes-md-row is-unsupported" role="treeitem">
      {rename ? <form onSubmit={event => { event.preventDefault(); if (title.trim()) submit(title.trim()); }}><input autoFocus aria-label={nt('new_name')} value={title} maxLength={2000} onChange={event => setTitle(event.target.value)} /><button type="submit">{nt('ok')}</button><button type="button" onClick={() => setRename(false)}>{nt('cancel')}</button></form> : <>
        <span className="notes-md-unsupported" title={resource.title}>▤ {resource.title || '未命名'}</span>
        <small className="notes-book-of">类型不支持，不可打开</small>
        <button type="button" aria-label={nt('rename_named', { name: resource.title })} disabled={!state.canEdit} onClick={() => { setTitle(resource.title); setRename(true); }}>{nt('rename')}</button>
      </>}
      {error && <p role="alert">{error}</p>}
    </div>;
  }
  const open = () => {
    try { setError(''); dispatch('select', resource.id); onOpen?.(refValue, resource.id); } catch (e) { setError(e.message); }
  };
  return <div className={'notes-md-row' + (state.selectedId === resource.id ? ' is-active' : '')} role="treeitem" draggable={state.canEdit} onDragStart={event => { event.dataTransfer.setData('application/studymate-note', resource.id); event.dataTransfer.setData('application/studymate-resource', resource.id); event.dataTransfer.effectAllowed = 'copyMove'; }}>
    {rename ? <form onSubmit={event => { event.preventDefault(); if (title.trim()) submit(title.trim()); }}><input autoFocus aria-label={nt('new_name')} value={title} maxLength={2000} onChange={event => setTitle(event.target.value)} /><button type="submit">{nt('ok')}</button><button type="button" onClick={() => setRename(false)}>{nt('cancel')}</button></form> : <>
      <button className="notes-md-open" title={resource.title} onClick={open}>▤ {resource.title || '未命名.md'}</button>
      <small className="notes-book-of" title={bookName ? '所属本：' + bookName : '未归属笔记本'}>{bookName || '未归属'}</small>
      <button aria-label={nt('rename_named', { name: resource.title })} disabled={!state.canEdit} onClick={() => { setTitle(resource.title); setRename(true); }}>{nt('rename')}</button>
      <button aria-label={nt('delete_named', { name: resource.title })} disabled={!state.canEdit} onClick={() => { if (window.confirm(nt('trash_confirm'))) { try { dispatch('trash', resource.id, true); } catch (e) { setError(e.message); } } }}>{nt('delete')}</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
function NodeGroup({ refValue, title, resources, state, dispatch, onOpen, search = '', isMarkdown, onRename, current = false }) {
  useNotesLocale();
  const notes = linkedNotes(resources, refValue).filter(item => !search || (item.title + ' ' + item.markdown).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const [error, setError] = useState('');
  // 展开/收起只是左栏的呈现，不切课、不调 onOpen（ADR-0019「学习左树整科目可见」）。
  const [collapsed, setCollapsed] = useState(false);
  return <div className={'notes-node-group' + (current ? ' is-current' : '')} role="treeitem" aria-expanded={!collapsed} onDragOver={event => { if (state.canEdit && [...event.dataTransfer.types].includes('application/studymate-note')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={event => {
    const id = event.dataTransfer.getData('application/studymate-note'); if (!id) return; event.preventDefault(); event.stopPropagation();
    try { dispatch('associate', id, refValue); setError(''); } catch (e) { setError(e.message); }
  }}>
    <div className="notes-node-heading" draggable onDragStart={event => { event.dataTransfer.setData('application/studymate-course', JSON.stringify(refValue)); event.dataTransfer.effectAllowed = 'copy'; }}>
      <button type="button" className="notes-node-toggle" aria-label={(collapsed ? '展开 ' : '收起 ') + title} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? '▸' : '▾'}</button>
      <span>{title}</span><small>{notes.length}</small>
    </div>
    {!collapsed && <div role="group">{notes.map(resource => <NoteRow key={resource.id} resource={resource} state={state} dispatch={dispatch} onOpen={onOpen} refValue={refValue} isMarkdown={isMarkdown} onRename={onRename} />)}{!notes.length && <p className="notes-empty-node">{nt('no_notes')}</p>}</div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
function Trash({ state, dispatch, scope, notebook }) {
  useNotesLocale();
  const entries = Object.values(state.resources).filter(item => item.trashed && ownedNote(item) && (!scope || (item.associations || []).some(ref => sameSubject(ref, scope))) && (!notebook || notebookOf(item, state.folders)?.id === notebook));
  return <details className="notes-trash"><summary>{nt('trash', { n: entries.length })}</summary>{entries.map(resource => <div key={resource.id}><span>{resource.title}</span><button disabled={!state.canEdit} onClick={() => dispatch('trash', resource.id, false)}>{nt('restore')}</button></div>)}</details>;
}
// 学习左栏：整科目可见（含空节点），顶上是默认本与「课程笔记本」入口。
// 点某篇把「那篇所在分组的 ref」与 id 一起交给调用方——跨节点先切课再打开右栏；展开分组不切课。
export function LearningNotesTree({ bridge, scope, subject, node, onOpen, isMarkdown, onRename }) {
  useNotesLocale();
  const state = useNotesWorkspace(bridge);
  const dispatch = (name, ...args) => bridge?.dispatch(name, ...args);
  const [booksOpen, setBooksOpen] = useState(false);
  const [error, setError] = useState('');
  const defaultBook = state.folders.find(item => (item.defaultForSubjects || []).some(ref => sameSubject(ref, scope)));
  return <section className="learning-notes-tree" aria-label={nt('learning_notes')}>
    <NotesStatus state={state} dispatch={dispatch} />
    <div className="notes-tree-head">
      <span className="notes-default-book" data-proto="learning-default-book">默认本：{defaultBook?.name || '尚未选择'}</span>
      <button type="button" className="notes-books-toggle" aria-expanded={booksOpen} onClick={() => setBooksOpen(value => !value)}>课程笔记本</button>
    </div>
    {booksOpen && <SubjectNotebooksPicker scope={scope} folders={state.folders} canEdit={state.canEdit}
      onChooseDefault={(id, name) => {
        const result = dispatch('setDefault', scope, id, name);
        if (!result) throw new Error('默认本未改变，请稍后重试。');
        return result;
      }}
      onClose={() => setBooksOpen(false)} />}
    <p className="notes-help">默认本只影响以后新建的笔记。拖动笔记只改节点关联，不移动原件。</p>{error && <p role="alert">{error}</p>}
    <div role="tree" aria-label={nt('nodes_markdown')}>{(subject?.nodes || []).map(item => {
      const ref = courseRef(scope, item);
      return <NodeGroup key={item.id} refValue={ref} title={item.title || item.id} resources={state.resources} state={state} dispatch={dispatch} onOpen={onOpen} isMarkdown={isMarkdown} onRename={onRename} current={item.id === node?.id} />;
    })}</div>
    <Trash state={state} dispatch={dispatch} scope={scope} />
  </section>;
}
// 学习右栏：只跟随当前节点——选择器里只有本节点的笔记，切节点不沿用上一课的选中。
export function LearningNotesPanel({ bridge, scope, subject, node, isMarkdown, onRename }) {
  useNotesLocale();
  const state = useNotesWorkspace(bridge);
  const dispatch = (name, ...args) => bridge?.dispatch(name, ...args);
  const [titleActions, setTitleActions] = useState(null);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState('');
  const nodeRef = node ? courseRef(scope, node) : null;
  const markdown = typeof isMarkdown === 'function' ? isMarkdown : isMarkdownResource;
  const candidates = nodeRef ? linkedNotes(state.resources, nodeRef).filter(item => markdown(item)) : [];
  const selected = candidates.find(item => item.id === state.selectedId) || null;
  const defaultBook = state.folders.find(item => item.kind === 'notebook' && (item.defaultForSubjects || []).some(ref => sameSubject(ref, scope)));
  // 标题改名集中走 NoteTitleInput：本地编辑、失焦/Enter 才提交，扩展名确认也在那一处。
  const rename = (id, title) => {
    try { setError(''); const result = onRename ? onRename(id, title) : dispatch('rename', id, title); return result !== false; }
    catch (e) { setError(e.message); return false; }
  };
  const add = () => { if (!nodeRef) return; if (!defaultBook) { setPicker(true); return; } try { setError(''); dispatch('createNote', scope, node, defaultBook.id); } catch (e) { setError(e.message); } };
  return <section className="learning-notes-panel" aria-label={nt('learning_editor')}>
    <NotesStatus state={state} dispatch={dispatch} /><div className="notes-actions"><select aria-label={nt('select_learning_note')} value={selected?.id || ''} onChange={event => { try { setError(''); dispatch('select', event.target.value); } catch (e) { setError(e.message); } }}><option value="" disabled>{nt('select_note')}</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button disabled={!state.canEdit || !nodeRef} onClick={add}>{nt('new_note')}</button></div>
    {picker && <NotebookPicker scope={scope} state={state} dispatch={dispatch} onClose={() => setPicker(false)} onChosen={id => { try { dispatch('createNote', scope, node, id); setPicker(false); } catch (e) { setError(e.message); } }} />}
    {error && <p role="alert">{error}</p>}{selected ? <>
      <div className="notes-title-row"><NoteTitleInput resource={selected} label={nt('learning_title')} disabled={!state.canEdit} onRename={rename} /><div ref={setTitleActions} /></div>
      <p className="notes-help notes-origin">原件目录：{noteOriginFolder(selected, state.folders)}</p>
      <p className="notes-help notes-association">关联：{(subject?.name || scope.subject)} › {(node?.title || node?.id || '未选中节点')}</p>
      <NoteEditor key={selected.id} resource={selected} theme={state.theme || 'light'} readOnly={!state.canEdit} exportTarget={titleActions} onChange={markdown => dispatch('markdown', selected.id, markdown)} />
    </> : <p className="notes-help">{!node ? '尚未选中课程节点。' : candidates.length ? '从上方选择本节点的笔记。' : '本节点还没有可编辑的 Markdown 笔记。'}</p>}
  </section>;
}
// 无界「节点视图」：本名旁是绑定摘要，行内「⋯ → 课程绑定」替代手输 slug；
// 打开本/笔记走 onPickEntry({kind,id})，管理入口走 onManageNotebook(id)。
export function NodeNotebookTree({ bridge, library, search = '', onCanvas, onSelect, getNotebookBindingLabel, onManageNotebook, onPickEntry }) {
  useNotesLocale();
  const state = useNotesWorkspace(bridge);
  const dispatch = (name, ...args) => bridge.dispatch(name, ...args);
  const [menu, setMenu] = useState(null);
  // 两种入口不互斥：新接口拿 {kind:'folder'|'file', id}，旧回调照常调用（App 自己的
  // 「切画布 / 打开右栏」还在 onCanvas / onSelect 上）。
  const pick = entry => {
    onPickEntry?.(entry);
    if (entry.kind === 'folder') onCanvas?.(entry.id); else onSelect?.(entry.id);
  };
  const openNote = (ref, id) => pick({ kind: 'file', id });
  return <div className="node-notebook-tree" role="tree" aria-label={nt('notebook_nodes')}>{state.folders.filter(book => book.kind === 'notebook').map(book => {
    const owned = Object.fromEntries(Object.entries(state.resources).filter(([, resource]) => notebookOf(resource, state.folders)?.id === book.id));
    const refs = new Map();
    for (const scope of book.bindings || []) {
      const subject = library?.workspace === scope.workspace ? library.subjects?.find(item => item.slug === scope.subject) : null;
      for (const node of subject?.nodes || []) { const ref = courseRef(scope, node); refs.set(courseKey(ref), { ref, title: (subject.name || scope.title || scope.subject) + ' · ' + (node.title || node.id) }); }
    }
    for (const resource of Object.values(owned)) for (const ref of resource.associations || []) if (!refs.has(courseKey(ref))) {
      const resolved = resolveCourse(library, ref);
      refs.set(courseKey(ref), { ref, title: (resolved?.subject.name || ref.subject) + ' · ' + (resolved?.node.title || ref.title || ref.node) + (resolved ? '' : nt('unavailable_suffix')) });
    }
    const label = getNotebookBindingLabel?.(book) ?? notebookBindingLabel(book, library);
    // 摘要只放第一个科目名（+N），完整名单在 title 里；调用方给了 getNotebookBindingLabel 就以它为准。
    const bindingTitle = '绑定科目：' + (getNotebookBindingLabel ? label : notebookBindingNames(book, library).join('、'));
    return <div key={book.id} role="treeitem" aria-expanded="true"><div className="notes-book-heading"><b>{book.name}</b><span className="notes-book-binding" title={bindingTitle}>{label}</span><button onClick={() => pick({ kind: 'folder', id: book.id })} aria-label={nt('open_canvas', { name: book.name })}>{nt('canvas')}</button><div className="notes-row-menu-wrap"><button type="button" className="notes-more" aria-label={'更多 ' + book.name + ' 操作'} aria-haspopup="menu" aria-expanded={menu === book.id} onClick={() => setMenu(value => value === book.id ? null : book.id)}>⋯</button>{menu === book.id && <div className="notes-row-menu" role="menu"><button type="button" role="menuitem" disabled={!state.canEdit || !onManageNotebook} onClick={() => { setMenu(null); onManageNotebook?.(book.id); }}>课程绑定</button></div>}</div></div><div role="group">{[...refs.values()].map(({ ref, title }) => <NodeGroup key={courseKey(ref)} refValue={ref} title={title} resources={owned} state={state} dispatch={dispatch} search={search} onOpen={openNote} />)}{!refs.size && <p className="notes-help">尚未绑定科目。可在本行「⋯ → 课程绑定」里绑定，或在学习笔记中选择此本。</p>}</div><Trash state={state} dispatch={dispatch} notebook={book.id} /></div>;
  })}</div>;
}
