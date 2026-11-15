import React, { useEffect, useRef, useState } from 'react';
import { AtSign, FileText, ArrowUp, X, MessageSquare, Plus } from 'lucide-react';

// Web acceptance placeholder only: local draft/chips, no host session or model transport.
// The DSH entry injects its existing native conversation component instead.
export default function ChatPanel({ resources, currentId, quoteIds, onQuote, onRemoveQuote, draft, onDraftChange }) {
  const [picker, setPicker] = useState(false), [query, setQuery] = useState(''), [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0), input = useRef(null);
  const available = Object.values(resources).filter((resource) => resource.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const accepts = (event) => [...event.dataTransfer.types].includes('application/studymate-resource');
  useEffect(() => { const end = () => { dragDepth.current = 0; setDragging(false); }; window.addEventListener('dragend', end); window.addEventListener('drop', end); return () => { window.removeEventListener('dragend', end); window.removeEventListener('drop', end); }; }, []);
  const insert = (id) => { if (resources[id]) { onQuote(id); requestAnimationFrame(() => input.current?.focus()); } };
  return <div className={'chat-panel dsh-chat chat-drop-zone' + (dragging ? ' is-dragging' : '')} data-testid="chat-drop-zone" aria-label="AI 对话区域"
    onDragEnter={(event) => { if (accepts(event)) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDragOver={(event) => { if (accepts(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false); insert(event.dataTransfer.getData('application/studymate-resource')); }}>
    <div className="chat-connection-state" role="status"><span className="connection-dot" />独立预览 · 未连接会话</div>
    <div className="chat-messages"><div className="chat-empty-state"><MessageSquare size={24} /><p>这里是网页验收占位，不读取 DSH 会话，也不会发送消息。</p></div></div>
    <div className={'chat-composer' + (dragging ? ' is-dragging' : '')}>
      {quoteIds.length > 0 && <div className="quote-list">{quoteIds.map((id) => resources[id] && <span className="quote-chip" key={id} data-resource-id={id}><FileText size={12} /><span>{resources[id].title}</span><button className="icon-button" aria-label={'移除引用 ' + resources[id].title} onClick={() => onRemoveQuote(id)}><X size={11} /></button></span>)}</div>}
      <textarea ref={input} aria-label="AI 对话草稿" placeholder="输入消息，@ 引用文件" value={draft} maxLength={16000} onChange={(event) => onDraftChange(event.target.value)} />
      <div className="chat-composer-actions"><button className="icon-button" aria-label="选择引用文件" title="引用文件" onClick={() => setPicker((prev) => !prev)}><AtSign size={17} /></button>
        <button className="button ghost" aria-label="引用当前文档" title="引用当前文档" disabled={!currentId} onClick={() => insert(currentId)}><Plus size={12} />当前文档</button><span className="topbar-spacer" /><button className="icon-button chat-send" disabled aria-label="发送（未连接）" title="独立预览不会发送消息"><ArrowUp size={18} /></button></div>
      {picker && <div className="quote-picker"><input className="text-input" aria-label="搜索引用文件" placeholder="搜索文件" value={query} onChange={(event) => setQuery(event.target.value)} />{available.map((resource) => <button key={resource.id} className="tree-row" onClick={() => { insert(resource.id); setPicker(false); }}><FileText size={14} /><span className="tree-label">{resource.title}</span></button>)}</div>}
    </div>
  </div>;
}
