import React, { useState, useSyncExternalStore } from 'react';
import NoteEditor from './NoteEditor.jsx';
import { courseRef, courseKey, linkedNotes, sameSubject, sameCourse, notebookOf, ownedNote, resolveCourse } from './curriculum.js';
import './curriculum.css';

const EMPTY = Object.freeze({ resources: {}, folders: [], selectedId: '', canEdit: false, loadState: 'loading', saveStatus: {} });
const noopSubscribe = () => () => {};
export function useNotesWorkspace(bridge) {
  return useSyncExternalStore(bridge?.subscribe || noopSubscribe, bridge?.getSnapshot || (() => EMPTY), () => EMPTY);
}
export function NotesStatus({ state, dispatch }) {
  const [error, setError] = useState('');
  const run = async (name, ...args) => { try { setError(''); await dispatch(name, ...args); } catch (e) { setError(e.message); } };
  const values = Object.values(state.saveStatus || {});
  const conflict = values.some(item => item.state === 'conflict');
  const failed = values.some(item => item.state === 'error');
  const pending = values.some(item => item.dirty || ['saving', 'pending'].includes(item.state));
  return <div className="notes-status" role="status">
    {state.loadState === 'loading' ? '正在载入笔记…' : state.loadState === 'upgrade' ? <><p>旧笔记库保持只读。升级会先备份，旧版客户端随后不能写入。</p><button onClick={() => run('upgrade')}>备份并升级笔记库</button></> : state.loadState === 'error' ? <><p>载入失败，未覆盖已有笔记。</p><button onClick={() => run('reload')}>重试载入</button></> : conflict ? <><p>文件有新版本。此处草稿已保留，未覆盖原文件。</p><button onClick={() => run('retryConflicts')}>保留本地并重试保存</button></> : failed ? <><p>保存失败，草稿仍在。</p><button onClick={() => run('retry')}>重试保存</button></> : pending ? '正在保存…' : '已保存'}
    {(pending || conflict || failed) && <><button onClick={() => run('export')}>导出本地草稿</button><button onClick={() => run('reload')}>放弃草稿并重新载入</button></>}
    {(state.loadError || error) && <p role="alert">{error || state.loadError?.message}</p>}
  </div>;
}
function NotebookPicker({ scope, state, dispatch, onClose, onChosen }) {
  const books = state.folders.filter(item => item.kind === 'notebook');
  const defaultBook = books.find(item => (item.defaultForSubjects || []).some(ref => sameSubject(ref, scope)));
  const [id, setId] = useState(defaultBook?.id || books[0]?.id || 'new');
  const [name, setName] = useState(scope.title || '新笔记本');
  const [error, setError] = useState('');
  return <section className="notes-picker" role="dialog" aria-label="选择科目默认笔记本">
    <b>选择「{scope.title || scope.subject}」的默认笔记本</b><p>只影响以后新建的笔记，不搬动已有文件。</p>
    <label>笔记本<select aria-label="科目默认笔记本" value={id} onChange={event => setId(event.target.value)}>{books.map(book => <option key={book.id} value={book.id}>{book.name}</option>)}<option value="new">新建笔记本…</option></select></label>
    {id === 'new' && <label>名称<input aria-label="笔记本名称" value={name} maxLength={200} onChange={event => setName(event.target.value)} /></label>}
    {error && <p role="alert">{error}</p>}<div className="notes-actions"><button onClick={onClose}>取消</button><button disabled={!state.canEdit || (id === 'new' && !name.trim())} onClick={() => { try { const chosen = dispatch('setDefault', scope, id === 'new' ? null : id, name); if (chosen) onChosen(chosen); } catch (e) { setError(e.message); } }}>确认选择</button></div>
  </section>;
}
function NoteRow({ resource, state, dispatch, onOpen }) {
  const [rename, setRename] = useState(false);
  const [title, setTitle] = useState(resource.title);
  return <div className={'notes-md-row' + (state.selectedId === resource.id ? ' is-active' : '')} role="treeitem" draggable={state.canEdit} onDragStart={event => { event.dataTransfer.setData('application/studymate-note', resource.id); event.dataTransfer.setData('application/studymate-resource', resource.id); event.dataTransfer.effectAllowed = 'copyMove'; }}>
    {rename ? <form onSubmit={event => { event.preventDefault(); if (title.trim()) { dispatch('rename', resource.id, title.trim()); setRename(false); } }}><input autoFocus aria-label="笔记新名称" value={title} maxLength={2000} onChange={event => setTitle(event.target.value)} /><button type="submit">确定</button><button type="button" onClick={() => setRename(false)}>取消</button></form> : <><button className="notes-md-open" title={resource.title} onClick={() => { dispatch('select', resource.id); onOpen?.(); }}>▤ {resource.title || '未命名.md'}</button><button aria-label={'重命名 ' + resource.title} disabled={!state.canEdit} onClick={() => { setTitle(resource.title); setRename(true); }}>改名</button><button aria-label={'删除 ' + resource.title} disabled={!state.canEdit} onClick={() => { if (window.confirm('将原笔记放入废纸篓？所有视图及画布引用都会隐藏；可在废纸篓恢复。')) dispatch('trash', resource.id, true); }}>删除</button></>}
  </div>;
}
function NodeGroup({ refValue, title, resources, state, dispatch, onOpen, search = '' }) {
  const notes = linkedNotes(resources, refValue).filter(item => !search || (item.title + ' ' + item.markdown).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const [error, setError] = useState('');
  return <div className="notes-node-group" role="treeitem" aria-expanded="true" onDragOver={event => { if (state.canEdit && [...event.dataTransfer.types].includes('application/studymate-note')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={event => {
    const id = event.dataTransfer.getData('application/studymate-note'); if (!id) return; event.preventDefault(); event.stopPropagation();
    try { dispatch('associate', id, refValue); setError(''); } catch (e) { setError(e.message); }
  }}>
    <div className="notes-node-heading" draggable onDragStart={event => { event.dataTransfer.setData('application/studymate-course', JSON.stringify(refValue)); event.dataTransfer.effectAllowed = 'copy'; }}><span>{title}</span><small>{notes.length}</small></div>
    <div role="group">{notes.map(resource => <NoteRow key={resource.id} resource={resource} state={state} dispatch={dispatch} onOpen={onOpen} />)}{!notes.length && <p className="notes-empty-node">暂无笔记</p>}</div>{error && <p role="alert">{error}</p>}
  </div>;
}
function Trash({ state, dispatch, scope, notebook }) {
  const entries = Object.values(state.resources).filter(item => item.trashed && ownedNote(item) && (!scope || (item.associations || []).some(ref => sameSubject(ref, scope))) && (!notebook || notebookOf(item, state.folders)?.id === notebook));
  return <details className="notes-trash"><summary>废纸篓（{entries.length}）</summary>{entries.map(resource => <div key={resource.id}><span>{resource.title}</span><button disabled={!state.canEdit} onClick={() => dispatch('trash', resource.id, false)}>恢复</button></div>)}</details>;
}
export function LearningNotesTree({ bridge, scope, subject, node, onOpen }) {
  const state = useNotesWorkspace(bridge);
  const dispatch = (name, ...args) => bridge?.dispatch(name, ...args);
  const [picker, setPicker] = useState(null);
  const [error, setError] = useState('');
  const defaultBook = state.folders.find(item => (item.defaultForSubjects || []).some(ref => sameSubject(ref, scope)));
  const add = () => { if (!node) return; if (!defaultBook) { setPicker('newNote'); return; } try { dispatch('createNote', scope, node, defaultBook.id); onOpen?.(); } catch (e) { setError(e.message); } };
  return <section className="learning-notes-tree" aria-label="学习节点笔记">
    <NotesStatus state={state} dispatch={dispatch} /><div className="notes-actions"><button disabled={!state.canEdit || !node} onClick={add}>新建节点笔记</button><button disabled={!state.canEdit} onClick={() => setPicker('default')}>默认笔记本</button></div>
    <p className="notes-help">默认：{defaultBook?.name || '尚未选择'}。拖动笔记只改节点关联，不移动原件。</p>{error && <p role="alert">{error}</p>}
    {picker && <NotebookPicker scope={scope} state={state} dispatch={dispatch} onClose={() => setPicker(null)} onChosen={id => { try { if (picker === 'newNote') { dispatch('createNote', scope, node, id); onOpen?.(); } setPicker(null); } catch (e) { setError(e.message); } }} />}
    <div role="tree" aria-label="节点与 Markdown 笔记">{(subject.nodes || []).map(item => <NodeGroup key={item.id} refValue={courseRef(scope, item)} title={item.title || item.id} resources={state.resources} state={state} dispatch={dispatch} onOpen={onOpen} />)}</div>
    <Trash state={state} dispatch={dispatch} scope={scope} />
  </section>;
}
export function LearningNotesPanel({ bridge, scope, subject, node }) {
  const state = useNotesWorkspace(bridge);
  const dispatch = (name, ...args) => bridge?.dispatch(name, ...args);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState('');
  const candidates = Object.values(state.resources).filter(item => ownedNote(item) && !item.trashed && (item.associations || []).some(ref => sameSubject(ref, scope)));
  const selected = candidates.find(item => item.id === state.selectedId) || candidates.find(item => (item.associations || []).some(ref => sameCourse(ref, courseRef(scope, node))));
  const add = () => { const book = state.folders.find(item => (item.defaultForSubjects || []).some(ref => sameSubject(ref, scope))); if (!book) { setPicker(true); return; } try { dispatch('createNote', scope, node, book.id); } catch (e) { setError(e.message); } };
  return <section className="learning-notes-panel" aria-label="学习 Markdown 编辑">
    <NotesStatus state={state} dispatch={dispatch} /><div className="notes-actions"><select aria-label="选择学习笔记" value={selected?.id || ''} onChange={event => dispatch('select', event.target.value)}><option value="" disabled>选择笔记</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button disabled={!state.canEdit} onClick={add}>新建笔记</button></div>
    {picker && <NotebookPicker scope={scope} state={state} dispatch={dispatch} onClose={() => setPicker(false)} onChosen={id => { try { dispatch('createNote', scope, node, id); setPicker(false); } catch (e) { setError(e.message); } }} />}
    {error && <p role="alert">{error}</p>}{selected ? <><input className="notes-title-input" aria-label="学习笔记标题" value={selected.title} disabled={!state.canEdit} maxLength={2000} onChange={event => dispatch('rename', selected.id, event.target.value)} /><p className="notes-help">原件：{notebookOf(selected, state.folders)?.name || '未归属笔记本'} · {(selected.associations || []).find(ref => sameSubject(ref, scope))?.title || node.title}</p><NoteEditor key={selected.id} resource={selected} theme={state.theme || 'light'} readOnly={!state.canEdit} onChange={markdown => dispatch('markdown', selected.id, markdown)} /></> : <p className="notes-help">本节点还没有笔记。新建时会先确认原件所属的默认笔记本。</p>}
  </section>;
}
export function NodeNotebookTree({ bridge, library, search = '', onCanvas, onSelect }) {
  const state = useNotesWorkspace(bridge);
  const dispatch = (name, ...args) => bridge.dispatch(name, ...args);
  return <div className="node-notebook-tree" role="tree" aria-label="笔记本节点视图">{state.folders.filter(book => book.kind === 'notebook').map(book => {
    const owned = Object.fromEntries(Object.entries(state.resources).filter(([, resource]) => notebookOf(resource, state.folders)?.id === book.id));
    const refs = new Map();
    for (const scope of book.bindings || []) {
      const subject = library?.workspace === scope.workspace ? library.subjects?.find(item => item.slug === scope.subject) : null;
      for (const node of subject?.nodes || []) { const ref = courseRef(scope, node); refs.set(courseKey(ref), { ref, title: (subject.name || scope.title || scope.subject) + ' · ' + (node.title || node.id) }); }
    }
    for (const resource of Object.values(owned)) for (const ref of resource.associations || []) if (!refs.has(courseKey(ref))) {
      const resolved = resolveCourse(library, ref);
      refs.set(courseKey(ref), { ref, title: (resolved?.subject.name || ref.subject) + ' · ' + (resolved?.node.title || ref.title || ref.node) + (resolved ? '' : '（来源失效）') });
    }
    return <div key={book.id} role="treeitem" aria-expanded="true"><div className="notes-book-heading"><b>{book.name}</b><button onClick={() => onCanvas(book.id)} aria-label={'打开' + book.name + '画布'}>画布</button><button onClick={() => dispatch('relinkNotebook', book.id)} disabled={!state.canEdit}>手动绑定科目</button></div><div role="group">{[...refs.values()].map(({ ref, title }) => <NodeGroup key={courseKey(ref)} refValue={ref} title={title} resources={owned} state={state} dispatch={dispatch} search={search} onOpen={onSelect} />)}{!refs.size && <p className="notes-help">尚未绑定科目。可在学习笔记中选择此本，或手动绑定科目。</p>}</div><Trash state={state} dispatch={dispatch} notebook={book.id} /></div>;
  })}</div>;
}
