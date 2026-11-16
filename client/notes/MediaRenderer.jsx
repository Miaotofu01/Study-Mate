import React from 'react';

export default function MediaRenderer({ resource, className = '' }) {
  if (!resource) return null;
  const title = resource.title || '媒体内容';
  if (resource.type === 'image') {
    return <img className={className} src={resource.src} alt={title} loading="lazy" draggable="false" />;
  }
  if (resource.type === 'svg' || resource.type === 'html') {
    // 静态页与 SVG 是独立文档：让 iframe 自己接收滚轮，长页面才能滚动。
    // 画布的缩放仍在空白处和卡片页头上可用；iframe 内的滚轮不会冒泡到 React Flow。
    return (
      <iframe
        className={className + ' media-scrollable'}
        title={title}
        srcDoc={resource.html}
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
        tabIndex={-1}
      />
    );
  }
  return null;
}
