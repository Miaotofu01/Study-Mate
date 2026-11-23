import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { normalizeHttpHref } from './markdown-formatting.js';

/* remark-rehype 给带信息串的围栏 code 加 language-* 类；没有语言标记的代码块不加标题。 */
function codeLanguageOf(children) {
  const stack = Array.isArray(children) ? [...children] : [children];
  while (stack.length) {
    const child = stack.shift();
    if (!React.isValidElement(child)) continue;
    const className = child.props?.className;
    const match = typeof className === 'string' && /(?:^|\s)language-([^\s]+)/.exec(className);
    if (match) return match[1];
    if (child.props?.children !== undefined) stack.push(child.props.children);
  }
  return '';
}

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
      pre: ({ node, children, ...props }) => {
        const lang = codeLanguageOf(children);
        return lang ? <div className="md-code-block">
          <div className="md-code-lang-bar"><span className="md-code-lang">{lang}</span></div>
          <pre {...props} data-md-lang={lang}>{children}</pre>
        </div> : <pre {...props}>{children}</pre>;
      },
    }}>{text || '*空白文档*'}</ReactMarkdown>;
}
