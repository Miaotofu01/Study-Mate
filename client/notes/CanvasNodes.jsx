import React, { memo, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position, NodeResizer, BaseEdge, EdgeLabelRenderer, getBezierPath, useStore, useUpdateNodeInternals } from '@xyflow/react';
import { Check, ChevronDown, ChevronRight, FileText, BookOpen, Link2, Image, FileCode } from 'lucide-react';
import { BoardContext } from './BoardContext.js';
import MarkdownPreview from './MarkdownPreview.jsx';
import { isMarkdownResource } from './note-types.js';
import MediaRenderer from './MediaRenderer.jsx';
import { resolveCourse } from './curriculum.js';

const icons = { note: FileText, course: BookOpen, link: Link2, image: Image, svg: FileCode, html: FileCode };

// 只有 http(s) 才当作可点的网页；其它协议（javascript:、data: 等）一律降级成纯文本，不渲染 href。
export const safeHttpUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
};
const hostOf = (href) => { try { return new URL(href).hostname; } catch { return ''; } };

// BoardContext 可能缺字段（例如别的入口只用节点组件）；缺省值让节点至少能渲染而不抛错。
const noop = () => {};

export const COLLAPSED_CARD_HEIGHT = 48;
// 纯内容节点框体纵向占用 38px（padding 18px×2 + 1px×2 边框），两行正文（14px×1.6 或 13px×1.65）约 43–45px，84px 恰好容纳两行且不出滚动条。
export const TEXT_NODE_MIN_HEIGHT = 84;

// 折叠：parent 在折叠时把节点高度压到 48（固定高度），此时卡片内只剩标题栏。
// 这里用 useStore 读回该节点自己的实际渲染高度（与 React Flow 一致，优先顶层 height 再看 style.height）：
// 节点容器被压到不高于标题栏时，正文、缩放控件都必须让位，不能只信 data.collapsed 这一份副本。
// 注意 hooks 必须无条件、在一切提前 return 之前调用。
function useCollapsedHeightFlag(id, data) {
  return useStore((store) => {
    const node = store.nodeLookup.get(id);
    const height = node?.height ?? node?.style?.height ?? node?.initialHeight ?? data?.collapsedHeight;
    const value = Number.parseFloat(height);
    return Number.isFinite(value) && value <= COLLAPSED_CARD_HEIGHT;
  });
}

function useNodeSizeKey(id) {
  return useStore((store) => {
    const node = store.nodeLookup.get(id);
    const width = node?.width ?? node?.style?.width ?? node?.initialWidth ?? '';
    const height = node?.height ?? node?.style?.height ?? node?.initialHeight ?? '';
    return `${width}x${height}`;
  });
}

function useSyncNodeInternals(id, collapsed = false) {
  // 折叠/展开或节点尺寸变化时通知 React Flow 重算 Handle 与连线端点坐标，避免连线停留在旧高度。
  const updateNodeInternals = useUpdateNodeInternals();
  const sizeKey = useNodeSizeKey(id);
  useLayoutEffect(() => {
    updateNodeInternals(id);
  }, [id, collapsed, sizeKey, updateNodeInternals]);
}

export const KnowledgeCard = memo(function KnowledgeCard({ id, data, selected }) {
  const board = useContext(BoardContext) || {};
  const { resources = {}, checkpoint = noop, toggleCardCollapsed = noop } = board;
  const resource = resources[data?.contentId];
  const sizedCollapsed = useCollapsedHeightFlag(id, data);
  const collapsed = Boolean(data?.collapsed) || sizedCollapsed;
  useSyncNodeInternals(id, collapsed);
  if (!resource) return <article className="knowledge-card">资源已移除</article>;
  const Icon = icons[resource.type] || FileText;
  const title = resource.title || '未命名.md';
  const toggle = () => toggleCardCollapsed(id);
  if (resource.type === 'course' && resource.courseRef) {
    const found = resolveCourse(board.courseLibrary, resource.courseRef);
    return <>
      <NodeResizer isVisible={Boolean(selected)} minWidth={220} minHeight={60} onResizeStart={checkpoint} />
      <Handle type="target" position={Position.Left} id="in" aria-label="连线接收点" />
      <article className={'knowledge-card course-reference-card' + (selected ? ' is-selected' : '')} data-type="course" data-content-id={resource.id}><header className="card-drag-handle"><BookOpen size={14} /><div className="card-title-row"><h3>{found?.node.title || resource.courseRef.title || title}</h3></div><button className="button ghost nodrag nopan" disabled={!found || !board.navigateCourse} title={found ? '跳转到来源节点' : '来源失效，请在侧栏重新关联'} onClick={event => { event.stopPropagation(); board.navigateCourse?.(resource.courseRef); }}>跳转</button></header></article>
      <Handle type="source" position={Position.Right} id="out" aria-label="拖出关系连线" />
    </>;
  }
  return <>
    <NodeResizer isVisible={Boolean(selected) && !collapsed} minWidth={220} minHeight={150} onResizeStart={checkpoint} />
    <Handle type="target" position={Position.Left} id="in" aria-label="连线接收点" />
    <article className={'knowledge-card' + (selected ? ' is-selected' : '') + (collapsed ? ' is-collapsed' : '')} data-type={resource.type} data-content-id={resource.id} data-collapsed={collapsed ? 'true' : 'false'}>
      <header className="card-drag-handle">
        <Icon size={14} />
        <div className="card-title-row"><h3>{title}</h3></div>
        {resource.origin && <span className="resource-origin-badge" data-origin={resource.origin.mode === 'reference' ? 'link' : 'local'}>{resource.origin.mode === 'reference' ? '引用' : '副本'}</span>}
        <button type="button" className="icon-button card-collapse nodrag nopan" aria-expanded={!collapsed} aria-controls={'card-body-' + id}
          title={collapsed ? '展开卡片' : '折叠卡片'} aria-label={(collapsed ? '展开卡片 ' : '折叠卡片 ') + title}
          onClick={(event) => { event.stopPropagation(); toggle(); }}>{collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</button>
      </header>
      {!collapsed && <div id={'card-body-' + id} className="card-body markdown-preview nowheel" onWheelCapture={(event) => event.stopPropagation()}>
        {resource.type === 'note' ? (isMarkdownResource(resource) ? <MarkdownPreview compact>{resource.markdown}</MarkdownPreview> : <p>不支持的文件类型</p>)
          : ['image', 'svg', 'html'].includes(resource.type) ? <MediaRenderer resource={resource} className="media-preview" />
          : <><p>{resource.summary}</p>{resource.type === 'link' && (safeHttpUrl(resource.url)
            ? <a className="card-link nodrag nopan" href={safeHttpUrl(resource.url)} target="_blank" rel="noopener noreferrer"><Link2 size={12} /> {hostOf(safeHttpUrl(resource.url))}</a>
            : <span className="card-link is-unsafe"><Link2 size={12} /> 链接不可用（仅支持 HTTP(S)）</span>)}</>}
      </div>}
    </article>
    <Handle type="source" position={Position.Right} id="out" aria-label="拖出关系连线" />
  </>;
});

// 网页引用在以纯内容节点呈现时只读：标题可点（安全 http(s) 才成链接），下面接已存描述。
function ResourceLinkBody({ resource }) {
  const href = safeHttpUrl(resource.url);
  const title = resource.title || (href ? hostOf(href) : '') || '网页引用';
  return <div className="text-node-content resource-link" data-type="link">
    {href ? <a className="resource-link-title nodrag nopan" href={href} target="_blank" rel="noopener noreferrer" title={href}><Link2 size={13} /> <span>{title}</span></a>
      : <span className="resource-link-title is-unsafe" title="仅支持 HTTP(S) 地址"><Link2 size={13} /> <span>{title}</span></span>}
    {href && <span className="resource-link-host">{hostOf(href)}</span>}
    {resource.summary ? <p className="resource-link-summary">{resource.summary}</p> : null}
  </div>;
}

export const TextNode = memo(function TextNode({ id, data, selected }) {
  const board = useContext(BoardContext) || {};
  const { resources = {}, editingNode = null, setEditingNode = noop, updateNodeText = noop, checkpoint = noop } = board;
  const resource = data?.contentId ? resources[data.contentId] : null;
  const resourceLink = Boolean(resource) && resource.type === 'link';
  const editing = !resourceLink && editingNode === id;
  const [draft, setDraft] = useState(data?.text || '');
  const cancelled = useRef(false);
  const input = useRef(null);
  useSyncNodeInternals(id);
  useEffect(() => { if (editing) { cancelled.current = false; setDraft(data?.text || ''); } }, [editing]);
  useEffect(() => {
    if (!editing) return undefined;
    let frame = 0, attempts = 0;
    // A new flow node is temporarily hidden while measuring; its ref can also arrive later.
    const focus = () => {
      const element = input.current;
      if (element?.isConnected && !element.closest('[inert]') && getComputedStyle(element).visibility === 'visible' && element.getClientRects().length) {
        element.focus({ preventScroll: true });
        if (document.activeElement === element) return;
      }
      if (++attempts < 60) frame = requestAnimationFrame(focus);
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [editing]);
  const finish = () => { if (!cancelled.current) updateNodeText(id, draft); setEditingNode(null); };
  return <>
    <NodeResizer isVisible={Boolean(selected)} minWidth={160} minHeight={TEXT_NODE_MIN_HEIGHT} onResizeStart={checkpoint} />
    <Handle type="target" position={Position.Left} id="in" aria-label="连线接收点" />
    {resourceLink
      ? <article className={'knowledge-card text-node is-resource-link' + (selected ? ' is-selected' : '')} data-type="link" data-content-id={resource.id}><ResourceLinkBody resource={resource} /></article>
      : <article className={'knowledge-card text-node' + (selected ? ' is-selected' : '') + (editing ? ' is-reading' : '')}>
        {editing ? <textarea className="text-node-editor nodrag nopan nowheel" ref={input} aria-label="纯节点内容" maxLength={8000} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={finish}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); cancelled.current = true; setEditingNode(null); } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finish(); } }} />
          : <div className="text-node-content nowheel" onWheelCapture={(event) => event.stopPropagation()}>{data?.text || '双击输入内容'}</div>}
      </article>}
    <Handle type="source" position={Position.Right} id="out" aria-label="拖出关系连线" />
  </>;
});

export function RelationEdge(props) {
  const board = useContext(BoardContext) || {};
  const { editingEdge = null, setEditingEdge = noop, commitEdgeLabel = noop } = board;
  const [path, x, y] = getBezierPath(props);
  // 空标注 = 无标注：连按钮带卡片一起不渲染。原位编辑框是唯一例外——parent 在新建连线时
  // 直接 setEditingEdge(新 id)，此时标注尚为空，仍要能输入。编辑框不在 svg 里，不会冒泡到
  // 连线的 onDoubleClick，因此双击真连线（EdgeWrapper 的 <g>）才是进入编辑的正路。
  const editing = editingEdge === props.id;
  const label = typeof props.data?.label === 'string' ? props.data.label : '';
  const [draft, setDraft] = useState(label);
  const input = useRef(null);
  const cancel = useRef(false);
  useEffect(() => {
    if (!editing) return;
    cancel.current = false; setDraft(label);
    let frame = requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    return () => cancelAnimationFrame(frame);
  }, [editing]);
  const finish = () => { if (!cancel.current) commitEdgeLabel(props.id, draft.trim()); setEditingEdge(null); };
  const style = { position: 'absolute', transform: `translate(-50%, -50%) translate(${x}px,${y}px)`, pointerEvents: 'all' };
  return <>
    <BaseEdge id={props.id} path={path} markerStart={props.markerStart} markerEnd={props.markerEnd} interactionWidth={24}
      style={{ ...props.style, stroke: props.selected ? '#1c7164' : '#9caea7', strokeWidth: props.selected ? 2.3 : 1.6 }} />
    <EdgeLabelRenderer>{editing
      ? <div className="inline-edge-editor nodrag nopan" style={style} onPointerDown={(event) => event.stopPropagation()}>
        <input className="edge-inline-input nodrag nopan" ref={input} maxLength={60} aria-label="原位关系说明" placeholder="添加说明" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={finish} onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finish(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current = true; setEditingEdge(null); }
        }} /><button type="button" className="icon-button" aria-label="确认关系说明" onMouseDown={(event) => event.preventDefault()} onClick={finish}><Check size={12} /></button>
      </div>
      : label
        ? <button type="button" className={'relation-label nodrag nopan' + (props.selected ? ' selected' : '')} style={style} aria-label={'编辑关系：' + label}
          onClick={(event) => { event.stopPropagation(); setEditingEdge(props.id); }}>{label}</button>
        : null}</EdgeLabelRenderer>
  </>;
}

export const nodeTypes = { knowledge: KnowledgeCard, text: TextNode };
export const edgeTypes = { relation: RelationEdge };
