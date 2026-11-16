import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { normalizeHttpHref } from './markdown-formatting.js';

export default function MarkdownPreview({ children = '', compact = false }) {
  const text = compact ? String(children).slice(0, 6000) : String(children).slice(0, 128 * 1024);
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false, maxExpand: 500, maxSize: 15 }], [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
    components={{
      a: ({ node, href, children: label, ...props }) => {
        const safe = normalizeHttpHref(href);
        return safe ? <a {...props} href={safe} className="nodrag nopan" target="_blank" rel="noopener noreferrer">{label}</a> : <span className="nodrag nopan">{label}</span>;
      },
      img: ({ alt }) => <span className="markdown-image-placeholder">[图片{alt ? '：' + alt : ''}]</span>,
    }}>{text || '*空白文档*'}</ReactMarkdown>;
}
