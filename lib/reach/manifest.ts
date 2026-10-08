/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 核验域 —— 「资源清单」里有哪些链接

   这一步是**纯函数**：不碰盘、不发请求。给它一份 「资源清单」 的正文，它把里面唯一的
   HTTP(S) 链接连同行号与一句话标题摘出来。

   为什么不接受「一串 URL」当参数（虽然那样接口更小）：一份清单实测有 118 条链接
   （`terminal-workflow`，2026-10-07）。让调用方把 118 条抄进工具参数，既费上下文、又会
   与盘上的那一份悄悄不一致——**清单是唯一出处，就从清单里读**。

   行号是 1 起的，与校验器的 `line` 口径一致，报出来的问题直接指得回原文那一行。
   ───────────────────────────────────────────────────────────────────────── */

/** 清单里的一条链接。`title` 只用于人读与报错，不参与任何判断。 */
export interface ManifestEntry {
  readonly line: number;
  readonly title: string;
  readonly url: string;
}

/** Markdown 链接 `[文字](url)`。URL 里不允许空白与半角右括号（md 里那两种字符要转义）。 */
const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;

/** 裸链接。排除常见的包裹字符，免得把行尾的 `)` 或 `>` 一起吃进来。 */
const BARE_LINK = /https?:\/\/[^\s)<>\]"'`]+/g;

const TITLE_LIMIT = 60;

/** 去掉 `[Book/Article/Doc: `、`[Local: `、`[Source: ` 这类前缀，剩下的就是标题。 */
function titleOf(text: string, rawLine: string): string {
  const cleaned = text.replace(/^\[[^\]]*:\s*/, '').replace(/\s+/g, ' ').trim();
  if (cleaned !== '') return cleaned.slice(0, TITLE_LIMIT);
  const fromLine = rawLine.replace(/^[\s>*\-+]+/, '').replace(/\s+/g, ' ').trim();
  return fromLine.slice(0, TITLE_LIMIT);
}

/** 行尾的标点不属于链接。 */
function trimTail(url: string): string {
  return url.replace(/[.,;:]+$/, '');
}

/**
 * 摘出清单里的链接：**按 URL 去重**（同一处知识在正文里被引用两次，只核一次），
 * 保留第一次出现的行号。
 */
export function extractLinks(markdown: string): ManifestEntry[] {
  const seen = new Set<string>();
  const out: ManifestEntry[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const found: Array<{ url: string; title: string }> = [];
    // 先把 Markdown 链接摘掉，剩下的文本里再找裸链接——否则同一个 URL 会被算两次。
    const rest = rawLine.replace(MARKDOWN_LINK, (_match: string, text: string, url: string) => {
      found.push({ url: trimTail(url), title: titleOf(text, rawLine) });
      return ' ';
    });
    for (const match of rest.matchAll(BARE_LINK)) {
      const url = trimTail(match[0]);
      if (url !== '') found.push({ url, title: titleOf('', rawLine) });
    }
    for (const item of found) {
      if (item.url === '' || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push({ line: index + 1, title: item.title, url: item.url });
    }
  }
  return out;
}
