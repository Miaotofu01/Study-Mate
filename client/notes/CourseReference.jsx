import React, { useState } from 'react';
import MarkdownPreview from './MarkdownPreview.jsx';
import { courseRef, resolveCourse } from './curriculum.js';
import { useNotesLocale } from './locale.js';

export default function CourseReference({ resource, library, renderCourse, onNavigate, onChange, canEdit }) {
  const nt = useNotesLocale();
  const found = resolveCourse(library, resource.courseRef);
  const [relink, setRelink] = useState(false);
  const [slug, setSlug] = useState(found?.subject.slug || library?.subjects?.[0]?.slug || '');
  const subject = library?.subjects?.find(item => item.slug === slug);
  const [nodeId, setNodeId] = useState(found?.node.id || subject?.nodes?.[0]?.id || '');
  const chosenNode = subject?.nodes?.find(item => item.id === nodeId);
  return <section className="course-readonly" aria-label={nt('course_preview')}>
    <h2>{found?.node.title || resource.courseRef.title || resource.title}</h2>
    <p className="notes-help">{nt('course_readonly')}</p>
    {!found && <p role="alert">{nt('course_missing')}</p>}
    <div className="course-link-actions"><button disabled={!found} onClick={() => onNavigate?.(resource.courseRef)}>{nt('goto_node')}</button><button disabled={!canEdit} onClick={() => setRelink(value => !value)}>{nt('relink')}</button></div>
    {relink && <form onSubmit={event => { event.preventDefault(); if (!chosenNode || !canEdit) return; const ref = courseRef({ workspace: library.workspace, subject: subject.slug }, chosenNode); onChange({ courseRef: ref, title: chosenNode.title || chosenNode.id }); setRelink(false); }}>
      <label>{nt('source_subject')}<select aria-label={nt('relink_subject')} value={slug} onChange={event => { const next = library.subjects.find(item => item.slug === event.target.value); setSlug(next.slug); setNodeId(next.nodes?.[0]?.id || ''); }}>{(library?.subjects || []).map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select></label>
      <label>{nt('source_node')}<select aria-label={nt('relink_node')} value={nodeId} onChange={event => setNodeId(event.target.value)}>{(subject?.nodes || []).map(item => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}</select></label><button disabled={!chosenNode} type="submit">{nt('confirm_relink')}</button>
    </form>}
    {found && (renderCourse ? renderCourse(resource.courseRef) : found.node.lesson_md ? <div className="markdown-preview"><MarkdownPreview>{found.node.lesson_md}</MarkdownPreview></div> : <p>{nt('no_lesson')}</p>)}
  </section>;
}
