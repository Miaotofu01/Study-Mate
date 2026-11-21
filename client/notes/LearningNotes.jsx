import React, { useState, useSyncExternalStore } from 'react';
import NoteEditor from './NoteEditor.jsx';
import { courseRef, courseKey, linkedNotes, sameSubject, sameCourse, notebookOf, ownedNote, resolveCourse } from './curriculum.js';
import './curriculum.css';
import { useNotesLocale } from './locale.js';

const EMPTY = Object.freeze({ resources: {}, folders: [], selectedId: '', canEdit: false, loadState: 'loading', saveStatus: {} });
const noopSubscribe = () => () => {};
export function useNotesWorkspace(bridge) {
  return useSyncExternalStore(bridge?.subscribe || noopSubscribe, bridge?.getSnapshot || (() => EMPTY), () => EMPTY);
}
export function NotesStatus({ state, dispatch }) {
  const nt = useNotesLocale();
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
  const nt = useNotesLocale();
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
function NoteRow({ resource, state, dispatch, onOpen }) {
  const nt = useNotesLocale();
  const [rename, setRename] = useState(false);
  const [title, setTitle] = useState(resource.title);
  return <div className={'notes-md-row' + (state.selectedId === resource.id ? ' is-active' : '')} role="treeitem" draggable={state.canEdit} onDragStart={event => { event.dataTransfer.setData('application/studymate-note', resource.id); event.dataTransfer.setData('application/studymate-resource', resource.id); event.dataTransfer.effectAllowed = 'copyMove'; }}>
    {rename ? <form onSubmit={event => { event.preventDefault(); if (title.trim()) { dispatch('rename', resource.id, title.trim()); setRename(false); } }}><input autoFocus aria-label={nt('new_name')} value={title} maxLength={2000} onChange={event => setTitle(event.target.value)} /><button type="submit">{nt('ok')}</button><button type="button" onClick={() => setRename(false)}>{nt('cancel')}</button></form> : <><button className="notes-md-open" title={resource.title} onClick={() => { dispatch('select', resource.id); onOpen?.(); }}>▤ {resource.title || nt('untitled')}</button><button aria-label={nt('rename_named', { name: resource.title })} disabled={!state.canEdit} onClick={() => { setTitle(resource.title); setRename(true); }}>{nt('rename')}</button><button aria-label={nt('delete_named', { name: resource.title })} disabled={!state.canEdit} onClick={() => { if (window.confirm(nt('trash_confirm'))) dispatch('trash', resource.id, true); }}>{nt('delete')}</button></>}
  </div>;
}
function NodeGroup({ refValue, title, resources, state, dispatch, onOpen, search = '' }) {
  const nt = useNotesLocale();
  const notes = linkedNotes(resources, refValue).filter(item => !search || (item.title + ' ' + item.markdown).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const [error, setError] = useState('');
  return <div className="notes-node-group" role="treeitem" aria-expanded="true" onDragOver={event => { if (state.canEdit && [...event.dataTransfer.types].includes('application/studymate-note')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={event => {
    const id = event.dataTransfer.getData('application/studymate-note'); if (!id) return; event.preventDefault(); event.stopPropagation();
    try { dispatch('associate', id, refValue); setError(''); } catch (e) { setError(e.message); }
  }}>
    <div className="notes-node-heading" draggable onDragStart={event => { event.dataTransfer.setData('application/studymate-course', JSON.stringify(refValue)); event.dataTransfer.effectAllowed = 'copy'; }}><span>{title}</span><small>{notes.length}</small></div>
    <div role="group">{notes.map(resource => <NoteRow key={resource.id} resource={resource} state={state} dispatch={dispatch} onOpen={onOpen} />)}{!notes.length && <p className="notes-empty-node">{nt('no_notes')}</p>}</div>{error && <p role="alert">{error}</p>}
  </div>;
}
function Trash({ state, dispatch, scope, notebook }) {
  const nt = useNotesLocale();
  const entries = Object.values(state.resources).filter(item => item.trashed && ownedNote(item) && (!scope || (item.associations || []).some(ref => sameSubject(ref, scope))) && (!notebook || notebookOf(item, state.folders)?.id === notebook));
  return <details className="notes-trash"><summary>{nt('trash', { n: entries.length })}</summary>{entries.map(resource => <div key={resource.id}><span>{resource.title}</span><button disabled={!state.canEdit} onClick={() => dispatch('trash', resource.id, false)}>{nt('restore')}</button></div>)}</details>;
}
export function LearningNotesTree({ bridge, scope, subject, node, onOpen }) {
  const nt = useNotesLocale();
  const state = useNotesWorkspace(bridge);
  const dispatch = (name, ...args) => bridge?.dispatch(name, ...args);
  const [picker, setPicker] = useState(null);
  const [error, setError] = useState('');
  const defaultBook = state.folders.find(item => (item.defaultForSubjects || []).some(ref => sameSubject(ref, scope)));
  const add = () => { if (!node) return; if (!defaultBook) { setPicker('newNote'); return; } try { dispatch('createNote', scope, node, defaultBook.id); onOpen?.(); } catch (e) { setError(e.message); } };
  return <section className="learning-notes-tree" aria-label={nt('learning_notes')}>
    <NotesStatus state={state} dispatch={dispatch} /><div className="notes-actions"><button disabled={!state.canEdit || !node} onClick={add}>{nt('new_node_note')}</button><button disabled={!state.canEdit} onClick={() => setPicker('default')}>{nt('default_book')}</button></div>
    <p className="notes-help">{nt('default_drag', { name: defaultBook?.name || nt('not_chosen') })}</p>{error && <p role="alert">{error}</p>}
    {picker && <NotebookPicker scope={scope} state={state} dispatch={dispatch} onClose={() => setPicker(null)} onChosen={id => { try { if (picker === 'newNote') { dispatch('createNote', scope, node, id); onOpen?.(); } setPicker(null); } catch (e) { setError(e.message); } }} />}
    <div role="tree" aria-label={nt('nodes_markdown')}>{(subject.nodes || []).map(item => <NodeGroup key={item.id} refValue={courseRef(scope, item)} title={item.title || item.id} resources={state.resources} state={state} dispatch={dispatch} onOpen={onOpen} />)}</div>
    <Trash state={state} dispatch={dispatch} scope={scope} />
  </section>;
}
export function LearningNotesPanel({ bridge, scope, subject, node }) {
  const nt = useNotesLocale();
  const state = useNotesWorkspace(bridge);
  const dispatch = (name, ...args) => bridge?.dispatch(name, ...args);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState('');
  const candidates = Object.values(state.resources).filter(item => ownedNote(item) && !item.trashed && (item.associations || []).some(ref => sameSubject(ref, scope)));
  const selected = candidates.find(item => item.id === state.selectedId) || candidates.find(item => (item.associations || []).some(ref => sameCourse(ref, courseRef(scope, node))));
  const add = () => { const book = state.folders.find(item => (item.defaultForSubjects || []).some(ref => sameSubject(ref, scope))); if (!book) { setPicker(true); return; } try { dispatch('createNote', scope, node, book.id); } catch (e) { setError(e.message); } };
  return <section className="learning-notes-panel" aria-label={nt('learning_editor')}>
    <NotesStatus state={state} dispatch={dispatch} /><div className="notes-actions"><select aria-label={nt('select_learning_note')} value={selected?.id || ''} onChange={event => dispatch('select', event.target.value)}><option value="" disabled>{nt('select_note')}</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button disabled={!state.canEdit} onClick={add}>{nt('new_note')}</button></div>
    {picker && <NotebookPicker scope={scope} state={state} dispatch={dispatch} onClose={() => setPicker(false)} onChosen={id => { try { dispatch('createNote', scope, node, id); setPicker(false); } catch (e) { setError(e.message); } }} />}
    {error && <p role="alert">{error}</p>}{selected ? <><input className="notes-title-input" aria-label={nt('learning_title')} value={selected.title} disabled={!state.canEdit} maxLength={2000} onChange={event => dispatch('rename', selected.id, event.target.value)} /><p className="notes-help">{nt('original', { name: notebookOf(selected, state.folders)?.name || nt('unassigned'), title: (selected.associations || []).find(ref => sameSubject(ref, scope))?.title || node.title })}</p><NoteEditor key={selected.id} resource={selected} theme={state.theme || 'light'} readOnly={!state.canEdit} onChange={markdown => dispatch('markdown', selected.id, markdown)} /></> : <p className="notes-help">{nt('empty_node')}</p>}
  </section>;
}
export function NodeNotebookTree({ bridge, library, search = '', onCanvas, onSelect }) {
  const nt = useNotesLocale();
  const state = useNotesWorkspace(bridge);
  const dispatch = (name, ...args) => bridge.dispatch(name, ...args);
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
    return <div key={book.id} role="treeitem" aria-expanded="true"><div className="notes-book-heading"><b>{book.name}</b><button onClick={() => onCanvas(book.id)} aria-label={nt('open_canvas', { name: book.name })}>{nt('canvas')}</button><button onClick={() => dispatch('relinkNotebook', book.id)} disabled={!state.canEdit}>{nt('bind_subject')}</button></div><div role="group">{[...refs.values()].map(({ ref, title }) => <NodeGroup key={courseKey(ref)} refValue={ref} title={title} resources={owned} state={state} dispatch={dispatch} search={search} onOpen={onSelect} />)}{!refs.size && <p className="notes-help">{nt('unbound')}</p>}</div><Trash state={state} dispatch={dispatch} notebook={book.id} /></div>;
  })}</div>;
}
