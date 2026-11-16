import React, { useState } from 'react';
import MarkdownPreview from './MarkdownPreview.jsx';
import { courseRef, resolveCourse } from './curriculum.js';

export default function CourseReference({ resource, library, renderCourse, onNavigate, onChange, canEdit }) {
  const found = resolveCourse(library, resource.courseRef);
  const [relink, setRelink] = useState(false);
  const [slug, setSlug] = useState(found?.subject.slug || library?.subjects?.[0]?.slug || '');
  const subject = library?.subjects?.find(item => item.slug === slug);
  const [nodeId, setNodeId] = useState(found?.node.id || subject?.nodes?.[0]?.id || '');
  const chosenNode = subject?.nodes?.find(item => item.id === nodeId);
  return <section className="course-readonly" aria-label="课程来源只读预览">
    <h2>{found?.node.title || resource.courseRef.title || resource.title}</h2>
    <p className="notes-help">课件只读，正文来自学习工作区；不会复制到笔记库。</p>
    {!found && <p role="alert">来源已失效。原关联仍保留；不会按同名课程自动替换。请手动重新关联。</p>}
    <div className="course-link-actions"><button disabled={!found} onClick={() => onNavigate?.(resource.courseRef)}>跳转到课程节点</button><button disabled={!canEdit} onClick={() => setRelink(value => !value)}>手动重新关联</button></div>
    {relink && <form onSubmit={event => { event.preventDefault(); if (!chosenNode || !canEdit) return; const ref = courseRef({ workspace: library.workspace, subject: subject.slug }, chosenNode); onChange({ courseRef: ref, title: chosenNode.title || chosenNode.id }); setRelink(false); }}>
      <label>来源科目<select aria-label="重新关联科目" value={slug} onChange={event => { const next = library.subjects.find(item => item.slug === event.target.value); setSlug(next.slug); setNodeId(next.nodes?.[0]?.id || ''); }}>{(library?.subjects || []).map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select></label>
      <label>来源节点<select aria-label="重新关联节点" value={nodeId} onChange={event => setNodeId(event.target.value)}>{(subject?.nodes || []).map(item => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}</select></label><button disabled={!chosenNode} type="submit">确认重新关联</button>
    </form>}
    {found && (renderCourse ? renderCourse(resource.courseRef) : found.node.lesson_md ? <div className="markdown-preview"><MarkdownPreview>{found.node.lesson_md}</MarkdownPreview></div> : <p>此节点尚无课件。</p>)}
  </section>;
}
