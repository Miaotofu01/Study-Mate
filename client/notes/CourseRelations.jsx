// 课程关系（绑定 / 关联）的呈现件：学习端与无界笔记共用。
// 这里只渲染「谁绑了谁、谁关联了哪一节」，不写数据域——所有写操作都走调用方传进来的回调，
// 保存者仍只有 App 那一份（ADR-0017 / ADR-0019）。
import React, { useState } from 'react';
import { isMarkdownResource } from './note-types.js';
import { courseKey, ownedNote, resolveCourse, sameSubject, subjectKey } from './curriculum.js';
import { useNotesLocale } from './locale.js';
import './curriculum.css';

export function notebooksOf(folders) {
  return (folders || []).filter(folder => folder?.kind === 'notebook');
}

// 没有识别为 Markdown 的资源（显示名改成 .png 之类）在入口里只当占位：不打开、不编辑。
// 识别规则只有一份（note-types.js）；保留这个别名给已有调用方。
export function defaultIsMarkdown(resource) {
  return isMarkdownResource(resource);
}

// 原件目录（本名 / 子目录），不带文件名——学习右栏标题下不重复标题。
export function noteOriginFolder(resource, folders) {
  const byId = new Map((folders || []).map(folder => [folder.id, folder]));
  const chain = [];
  let folder = byId.get(resource?.parent);
  const visited = new Set();
  while (folder && !visited.has(folder.id) && chain.length < 24) {
    visited.add(folder.id);
    // 系统根（parent 为 null，如「我的资料」）不进路径：原件路径从本名开始。
    if (folder.parent) chain.unshift(folder.name);
    else if (!chain.length && folder.kind !== 'notebook') break;
    folder = byId.get(folder.parent);
  }
  return chain.length ? chain.join(' / ') : '未归属笔记本';
}

export function noteOriginPath(resource, folders) {
  return noteOriginFolder(resource, folders) + ' / ' + (resource?.title || '未命名');
}

export function notebookBindingNames(book, library) {
  return (book?.bindings || []).map(scope => {
    const subject = library && library.workspace === scope.workspace
      ? (library.subjects || []).find(item => item.slug === scope.subject)
      : null;
    const name = subject?.name || scope.title || scope.subject || '未知科目';
    return name + (subject ? '' : '（来源失效）');
  });
}

// 本名旁的摘要只放第一个科目名，其余折成「+N」；完整名单放在菜单的 title 里。
export function notebookBindingLabel(book, library) {
  const names = notebookBindingNames(book, library);
  if (!names.length) return '未绑定科目';
  return names.length > 1 ? names[0] + ' +' + (names.length - 1) : names[0];
}

export function associationLabel(library, ref) {
  const found = resolveCourse(library, ref);
  if (found) return { text: found.subject.name + ' › ' + (found.node.title || found.node.id), found: true };
  const subject = library && library.workspace === ref?.workspace
    ? (library.subjects || []).find(item => item.slug === ref.subject)
    : null;
  const subjectName = subject?.name || ref?.subject || '未知科目';
  return { text: subjectName + ' › ' + (ref?.title || ref?.node || '未知节点') + '（来源失效）', found: false };
}

function useErrors() {
  const [error, setError] = useState('');
  // 非破坏性回调的错误要看得到：同步 throw 与 rejected Promise 都落到同一处。
  const run = async (task) => {
    try { setError(''); return await task(); } catch (e) { setError(e?.message || String(e)); return undefined; }
  };
  return [error, setError, run];
}

export function CourseAssociationOption({ resource, library, onManage, canEdit }) {
  const t = useNotesLocale();
  const names = (resource.associations || []).map(ref => {
    const subject = library?.workspace === ref.workspace && library.subjects.find(item => item.slug === ref.subject);
    return (subject?.name || ref.subject) + (resolveCourse(library, ref) ? '' : t('unavailable_suffix'));
  });
  const label = names.length > 1 ? names[0] + ' +' + (names.length - 1) : names[0] || t('course_association_unlinked');
  return <button type="button" className="course-assoc-option" aria-haspopup="dialog"
    aria-label={t('manage_course_association', { name: label })} title={names.length ? names.join('、') : label}
    disabled={!canEdit} onClick={onManage}>{label}</button>;
}

export function CourseAssociationBar({ resource, library, onNavigate, onManage, canEdit }) {
  const refs = [];
  const seen = new Set();
  for (const ref of [...(resource?.associations || []), ...(resource?.courseRef ? [resource.courseRef] : [])]) {
    if (!ref) continue;
    const key = ref.node ? courseKey(ref) : subjectKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return <div className="course-association-bar" data-proto="course-association-bar" role="group" aria-label="课程关联">
    <span className="course-association-label">课程</span>
    {!refs.length ? <span className="course-association-empty">未关联</span> : refs.map(ref => {
      const { text, found } = associationLabel(library, ref);
      return found && onNavigate
        ? <button key={courseKey(ref)} type="button" className="course-assoc-chip" onClick={() => onNavigate(ref)} title={'跳转到 ' + text}>{text}</button>
        : <span key={courseKey(ref)} className="course-assoc-chip is-broken" title="来源已失效：保留原名称，不按同名课程猜测，也不上跳">{text}</span>;
    })}
    <button type="button" className="course-assoc-manage" onClick={() => onManage?.()} disabled={!canEdit || !onManage}>管理关联</button>
  </div>;
}

export function NotebookBindingsForm({ book, folders, library, onBind, onSetDefault, onUnbind, canEdit }) {
  const [error, setError, run] = useErrors();
  const [replacement, setReplacement] = useState({});
  const [slug, setSlug] = useState('');
  const bindings = book?.bindings || [];
  const defaults = book?.defaultForSubjects || [];
  const others = notebooksOf(folders).filter(folder => folder.id !== book?.id);
  const boundKeys = new Set(bindings.map(subjectKey));
  const available = (library?.subjects || []).filter(subject =>
    !boundKeys.has(subjectKey({ workspace: library.workspace, subject: subject.slug })));
  const chosen = available.find(subject => subject.slug === slug);
  const isDefault = scope => defaults.some(ref => sameSubject(ref, scope));
  return <section className="notes-rel-form" data-proto="notebook-bindings-form" aria-label="笔记本课程绑定">
    <p className="notes-rel-title">「{book?.name || '未命名笔记本'}」的科目绑定</p>
    <p className="notes-help">一个科目可以绑多本，每科至多一本默认本。绑定不会让本里的笔记自动关联节点。</p>
    {!bindings.length
      ? <p className="notes-help">尚未绑定科目。</p>
      : <ul className="notes-rel-list">{bindings.map(scope => {
        const key = subjectKey(scope);
        const subject = library && library.workspace === scope.workspace
          ? (library.subjects || []).find(item => item.slug === scope.subject)
          : null;
        const fallbackDefault = isDefault(scope);
        return <li className="notes-rel-row" key={key}>
          <span className="notes-rel-name">{subject?.name || scope.title || scope.subject || '未知科目'}</span>
          <small className="notes-rel-meta">{scope.workspace === library?.workspace ? '' : '其它工作区 · '}{scope.subject}{subject ? '' : ' · 来源失效'}{fallbackDefault ? ' · 默认本' : ''}</small>
          {!fallbackDefault && <button type="button" disabled={!canEdit || !onSetDefault} onClick={() => run(() => onSetDefault?.(scope))}>设为默认本</button>}
          {fallbackDefault && <label className="notes-rel-replace">解除后默认本
            <select aria-label="解除绑定后的替代默认本" value={replacement[key] ?? ''} onChange={event => setReplacement(previous => ({ ...previous, [key]: event.target.value }))}>
              <option value="" disabled>请选择处理方式</option>
              <option value="__clear__">清除默认（下次新建再选）</option>
              {others.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>}
          <button type="button" disabled={!canEdit || (fallbackDefault && !replacement[key])} onClick={() => run(() => fallbackDefault
            ? onUnbind?.(scope, replacement[key] === '__clear__' ? null : replacement[key])
            : onUnbind?.(scope))}>解除绑定</button>
        </li>;
      })}</ul>}
    <form className="notes-rel-add" onSubmit={event => {
      event.preventDefault();
      if (!chosen) return;
      void run(() => onBind?.({ workspace: library.workspace, subject: chosen.slug, title: chosen.name }));
    }}>
      <label>绑定科目<select aria-label="要绑定的科目" value={slug} onChange={event => setSlug(event.target.value)}>
        <option value="">选择科目</option>
        {available.map(subject => <option key={subject.slug} value={subject.slug}>{subject.name}</option>)}
      </select></label>
      <button type="submit" disabled={!canEdit || !chosen}>绑定</button>
    </form>
    {!available.length && library?.subjects?.length ? <p className="notes-help">当前工作区的科目都已绑定。</p> : null}
    {error && <p role="alert" className="notes-rel-error">{error}</p>}
  </section>;
}

export function NoteAssociationsForm({ resource, library, onAssociate, onRemove, canEdit }) {
  const [error, setError, run] = useErrors();
  const refs = resource?.associations || [];
  const editable = ownedNote(resource) && !resource?.trashed;
  const current = refs.find(ref => ref.workspace === library?.workspace);
  const firstSlug = current?.subject || (library?.subjects || [])[0]?.slug || '';
  const [slug, setSlug] = useState(firstSlug);
  const subject = (library?.subjects || []).find(item => item.slug === slug);
  const [nodeId, setNodeId] = useState(() => {
    const same = refs.find(ref => ref.workspace === library?.workspace && ref.subject === firstSlug);
    return same?.node || subject?.nodes?.[0]?.id || '';
  });
  const node = (subject?.nodes || []).find(item => item.id === nodeId);
  return <section className="notes-rel-form" data-proto="note-associations-form" aria-label="笔记课程关联">
    <p className="notes-rel-title">「{resource?.title || '未命名'}」的课程关联</p>
    <p className="notes-help">同一篇在同一科目里只能归到一个节点；换到另一节时学习端会再确认一次。正文、原件目录与画布保持不变。</p>
    {!editable && <p role="alert" className="notes-rel-error">此资源不是可编辑笔记（或已移入废纸篓），课程关联只读。</p>}
    {!refs.length
      ? <p className="notes-help">尚未关联课程。可在下面选择科目与节点，或把它拖到学习左栏的节点分组上。</p>
      : <ul className="notes-rel-list">{refs.map(ref => {
        const { text, found } = associationLabel(library, ref);
        return <li className="notes-rel-row" key={courseKey(ref)}>
          <span className={'notes-rel-name' + (found ? '' : ' is-broken')}>{text}</span>
          <small className="notes-rel-meta">{ref.workspace === library?.workspace ? '' : '其它工作区'}</small>
          <button type="button" disabled={!canEdit || !editable} onClick={() => run(() => onRemove?.(ref))}>解除关联</button>
        </li>;
      })}</ul>}
    <form className="notes-rel-add" onSubmit={event => {
      event.preventDefault();
      if (!node) return;
      void run(() => onAssociate?.({ workspace: library.workspace, subject: subject.slug, node: node.id, title: node.title || node.id }));
    }}>
      <label>科目<select aria-label="关联科目" value={slug} onChange={event => {
        const next = (library?.subjects || []).find(item => item.slug === event.target.value);
        setSlug(event.target.value);
        setNodeId(next?.nodes?.[0]?.id || '');
      }}>{(library?.subjects || []).map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select></label>
      <label>节点<select aria-label="关联节点" value={nodeId} onChange={event => setNodeId(event.target.value)}>
        {(subject?.nodes || []).map(item => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}
      </select></label>
      <button type="submit" disabled={!canEdit || !editable || !node}>保存关联</button>
    </form>
    {error && <p role="alert" className="notes-rel-error">{error}</p>}
  </section>;
}

// 学习左栏「课程笔记本」入口展开的列表：当前科目绑定的全部本 + 改默认本（含新建一本并设为默认）。
// 这里只挑默认本；绑定/解绑本身在 App 的课程绑定弹窗里做。
export function SubjectNotebooksPicker({ scope, folders, library, canEdit, onChooseDefault, onClose }) {
  const [error, setError, run] = useErrors();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const books = notebooksOf(folders).filter(folder => (folder.bindings || []).some(ref => sameSubject(ref, scope)));
  const defaultBook = books.find(folder => (folder.defaultForSubjects || []).some(ref => sameSubject(ref, scope)));
  const create = () => {
    const value = name.trim();
    if (!value) return;
    void run(async () => { await onChooseDefault?.(null, value); setName(''); setCreating(false); });
  };
  return <section className="notes-books" role="dialog" aria-label={'「' + (scope?.title || scope?.subject || '当前科目') + '」的课程笔记本'} data-proto="subject-notebooks">
    <b>课程笔记本</b>
    <p className="notes-help">当前科目绑定的全部笔记本。改默认本只影响以后新建的笔记，不搬动已有文件。</p>
    {books.length ? <ul className="notes-books-list">{books.map(book => {
      const isDefault = defaultBook?.id === book.id;
      return <li key={book.id}>
        <span className="notes-books-name">{book.name}</span>
        {isDefault
          ? <span className="notes-books-default">默认本</span>
          : <button type="button" disabled={!canEdit} onClick={() => run(() => onChooseDefault?.(book.id))}>设为默认本</button>}
      </li>;
    })}</ul> : <p className="notes-help">还没有绑定笔记本。首次新建笔记时会先让你选择或新建一本。</p>}
    {creating
      ? <div className="notes-books-create">
        <label>新笔记本名称<input aria-label="新课程笔记本名称" value={name} maxLength={200} onChange={event => setName(event.target.value)} /></label>
        <div className="notes-actions">
          <button type="button" disabled={!canEdit || !name.trim()} onClick={create}>创建并设为默认本</button>
          <button type="button" onClick={() => { setCreating(false); setName(''); }}>取消</button>
        </div>
      </div>
      : <div className="notes-actions">
        <button type="button" disabled={!canEdit} onClick={() => setCreating(true)}>新建笔记本并设为默认本…</button>
        <button type="button" onClick={() => onClose?.()}>关闭</button>
      </div>}
    {error && <p role="alert" className="notes-rel-error">{error}</p>}
  </section>;
}
