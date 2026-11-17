/**
 * 无界笔记 · Markdown 原始文本格式化（纯函数，无 React / 无 DOM）
 * ────────────────────────────────────────────────────────────────────────────────
 * 编辑器保存的是用户原始 Markdown：这里只返回「原坐标上的最小改动 + 新选区」，
 * 不序列化、不规范化整篇文档。父组件用一次 CM6 transaction 应用 changes。
 *
 * 约束（照任务单与《阅读端呈现》§九）：
 * - changes 指原文坐标，已排序、互不重叠；insert 为空即删除。
 * - 空白、CRLF / LF / CR 混排、转义字符与代码字面量都原样保留；
 *   只有真正被格式化的前缀 / 标记进入 changes。
 * - 有歧义或会破坏原文时返回 null（不猜、不静默改写）。
 * - 强调标记只认未转义、且不在围栏代码块 / 行内代码里的 `*` 与 `~~`；
 *   `_` 不参与，避免误伤 snake_case。
 */

const HEADING_MAX = 6;
const HTTP_PROTOCOL = /^https?:\/\//i;
const MARKER = Object.freeze({ bold: '**', italic: '*', strike: '~~', 'inline-code': '`' });

/** 纯函数入口。返回 {changes, selection} 或 null。 */
export function formatMarkdown(input, command, value) {
  const target = normalizeTarget(input);
  if (!target) return null;
  const { text, from, to } = target;

  switch (command) {
    case 'heading':
      return headingCommand(text, from, to, value);
    case 'bold':
    case 'italic':
    case 'strike':
    case 'inline-code':
      return inlineCommand(text, from, to, command);
    case 'link':
      return linkCommand(text, from, to, value);
    case 'bullet-list':
      return listCommand(text, from, to, 'bullet');
    case 'ordered-list':
      return listCommand(text, from, to, 'ordered');
    case 'quote':
      return quoteCommand(text, from, to);
    case 'code-block':
      return codeBlockCommand(text, from, to);
    case 'table':
      return tableCommand(text, from, to);
    default:
      return null;
  }
}

/** 只接受明确的 http(s) 绝对地址；返回 URL 规范化结果或 null。 */
export function normalizeHttpHref(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /\s/.test(raw) || !HTTP_PROTOCOL.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * 工具栏用的只读状态：当前行/选区是否已带某种格式。
 * 文档文本不足或坐标失效时返回全 false 的空状态，不抛错。
 */
export function activeFormatState(text, from = 0, to = from) {
  const state = {
    heading: 0,
    bold: false,
    italic: false,
    strike: false,
    inlineCode: false,
    link: false,
    linkHref: '',
    linkText: '',
    bulletList: false,
    orderedList: false,
    quote: false,
  };
  if (typeof text !== 'string' || !Number.isInteger(from) || !Number.isInteger(to)) return state;
  if (from < 0 || to < from || to > text.length) return state;

  const lines = lineRanges(text);
  const lineIndex = lineIndexAt(lines, from);
  const line = lines[lineIndex];
  const prefix = parseLinePrefix(text.slice(line.start, line.contentEnd));
  state.quote = prefix.tokens.length > 0 && prefix.tokens[0].kind === 'quote';
  const listToken = prefix.tokens.filter((token) => token.kind === 'list').pop();
  state.bulletList = Boolean(listToken && listToken.bullet);
  state.orderedList = Boolean(listToken && listToken.ordered);

  const headings = fenceBlocks(text);
  if (!rangesOverlap([[line.start, line.end || line.start + 1]], headings.map((block) => [block.start, block.end]))) {
    const heading = parseHeadingAt(text.slice(line.start, line.contentEnd), prefix.end);
    state.heading = heading ? heading.level : 0;
  }

  const marks = emphasisSpans(text);
  const covers = (span) => (from === to
    ? span.start < from && from < span.end
    : span.start <= from && span.end >= to);

  state.bold = marks.some((span) => span.kind === 'bold' && covers(span));
  state.italic = marks.some((span) => span.kind === 'italic' && covers(span));
  state.strike = marks.some((span) => span.kind === 'strike' && covers(span));
  state.inlineCode = inlineCodeSpans(text).some(covers);

  const link = findLinks(text).find((span) => (from === to
    ? span.start < from && from < span.end
    : span.start < to && span.end > from));
  if (link) {
    state.link = true;
    state.linkHref = link.href;
    state.linkText = link.text;
  }
  return state;
}

/* ── 输入与结果 ───────────────────────────────────────────────────────────── */

function normalizeTarget(input) {
  if (!input || typeof input.text !== 'string') return null;
  const { text, from, to } = input;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 0 || to < from || to > text.length) return null;
  return { text, from, to };
}

function makeResult(text, rawChanges, anchor, head) {
  const changes = normalizeChanges(text, rawChanges);
  if (!changes) return null;
  const delta = changes.reduce((sum, change) => sum + change.insert.length - (change.to - change.from), 0);
  const max = text.length + delta;
  if (!Number.isFinite(anchor) || !Number.isFinite(head)) return null;
  return {
    changes,
    selection: {
      anchor: clamp(Math.trunc(anchor), 0, max),
      head: clamp(Math.trunc(head), 0, max),
    },
  };
}

function normalizeChanges(text, rawChanges) {
  if (!Array.isArray(rawChanges) || rawChanges.length === 0) return null;
  const changes = [];
  for (const change of rawChanges) {
    if (!change || !Number.isInteger(change.from) || !Number.isInteger(change.to)) return null;
    if (change.from < 0 || change.to < change.from || change.to > text.length) return null;
    if (typeof change.insert !== 'string') return null;
    if (change.from === change.to && change.insert === '') continue;
    if (change.insert === text.slice(change.from, change.to)) continue;
    changes.push({ from: change.from, to: change.to, insert: change.insert });
  }
  if (!changes.length) return null;
  changes.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let index = 1; index < changes.length; index += 1) {
    if (changes[index].from < changes[index - 1].to) return null;
    if (changes[index].from === changes[index - 1].from
      && changes[index].from === changes[index].to
      && changes[index - 1].from === changes[index - 1].to) return null;
  }
  return changes;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** 原始坐标 → 应用 changes 之后的新坐标。 */
function mapPosition(pos, changes, affinity = 'end') {
  let shift = 0;
  for (const change of changes) {
    if (pos < change.from) break;
    if (pos > change.to) {
      shift += change.insert.length - (change.to - change.from);
      continue;
    }
    if (change.from === change.to && pos === change.from) {
      return change.from + shift + (affinity === 'end' ? change.insert.length : 0);
    }
    if (pos === change.from) return change.from + shift + change.insert.length;
    if (pos < change.to) return change.from + shift + change.insert.length;
    shift += change.insert.length - (change.to - change.from);
  }
  return pos + shift;
}

function lineResult(text, changes, from, to) {
  const anchor = mapPosition(from, changes, from === to ? 'end' : 'start');
  const head = mapPosition(to, changes, from === to ? 'end' : 'end');
  return makeResult(text, changes, anchor, head);
}

/* ── 行、代码与转义 ───────────────────────────────────────────────────────── */

function eolOf(text, line) {
  return text.slice(line.contentEnd, line.end);
}

function lineRanges(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') {
      lines.push({ start, contentEnd: index, end: index + 1, eolLen: 1 });
      start = index + 1;
    } else if (char === '\r') {
      const crlf = text[index + 1] === '\n';
      lines.push({ start, contentEnd: index, end: index + (crlf ? 2 : 1), eolLen: crlf ? 2 : 1 });
      start = index + (crlf ? 2 : 1);
      index += crlf ? 1 : 0;
    }
  }
  lines.push({ start, contentEnd: text.length, end: text.length, eolLen: 0 });
  return lines;
}

function lineIndexAt(lines, pos) {
  for (let index = 0; index < lines.length; index += 1) {
    if (pos < lines[index].end) return index;
  }
  return lines.length - 1;
}

function selectedLineIndexes(lines, from, to) {
  const first = lineIndexAt(lines, from);
  if (to <= from) return [first];
  const last = lineIndexAt(lines, to - 1);
  const indexes = [];
  for (let index = first; index <= last; index += 1) indexes.push(index);
  return indexes;
}

function localEol(text, pos) {
  const lines = lineRanges(text);
  const index = lineIndexAt(lines, pos);
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const eol = eolOf(text, lines[cursor]);
    if (eol) return eol;
  }
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const eol = eolOf(text, lines[cursor]);
    if (eol) return eol;
  }
  return '\n';
}

function parseLinePrefix(content) {
  const indent = /^[ \t]*/.exec(content)[0];
  let pos = indent.length;
  const tokens = [];
  while (pos < content.length) {
    const quote = /^>[ \t]?/.exec(content.slice(pos));
    if (quote) {
      tokens.push({ kind: 'quote', start: pos, end: pos + quote[0].length });
      pos += quote[0].length;
      continue;
    }
    const list = /^(?:([-+*])|(\d{1,9})([.)]))([ \t]+)/.exec(content.slice(pos));
    if (list) {
      tokens.push({
        kind: 'list',
        start: pos,
        end: pos + list[0].length,
        marker: list[1] || `${list[2]}${list[3]}`,
        bullet: Boolean(list[1]),
        ordered: Boolean(list[2]),
      });
      pos += list[0].length;
      continue;
    }
    break;
  }
  return { indent, indentEnd: indent.length, tokens, end: pos };
}

function parseHeadingAt(content, pos) {
  const match = /^(#{1,6})(?=[ \t]|$)([ \t]*)/.exec(content.slice(pos));
  if (!match) return null;
  const hashStart = pos;
  const hashEnd = pos + match[1].length;
  const separatorEnd = hashEnd + match[2].length;
  const rest = content.slice(separatorEnd);
  const closing = /[ \t]+(#{1,6})[ \t]*$/.exec(rest);
  return {
    level: match[1].length,
    hashStart,
    hashEnd,
    separatorEnd,
    closingStart: closing ? separatorEnd + closing.index : -1,
    closingEnd: closing ? content.length : -1,
  };
}

function fenceBlocks(text) {
  const lines = lineRanges(text);
  const blocks = [];
  let open = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const content = text.slice(line.start, line.contentEnd);
    const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(content);
    if (open) {
      if (match && match[2][0] === open.char && match[2].length >= open.length && match[3].trim() === '') {
        blocks.push({
          ...open,
          closeLine: index,
          closeLineStart: line.start,
          closeLineEnd: line.end,
          end: line.end,
          unclosed: false,
        });
        open = null;
      }
    } else if (match) {
      if (match[2][0] === '`' && match[3].includes('`')) continue;
      open = {
        char: match[2][0],
        length: match[2].length,
        openLine: index,
        start: line.start,
        openLineEnd: line.end,
      };
    }
  }
  if (open) {
    blocks.push({
      ...open,
      closeLine: -1,
      closeLineStart: text.length,
      closeLineEnd: text.length,
      end: text.length,
      unclosed: true,
    });
  }
  return blocks;
}

function inlineCodeSpans(text, fences = fenceBlocks(text), occupied = fences.map((block) => [block.start, block.end])) {
  const spans = [];
  let index = 0;
  while (index < text.length) {
    const blocked = rangeContaining(occupied, index);
    if (blocked) {
      index = blocked[1];
      continue;
    }
    if (text[index] === '\\' && text[index + 1] === '`') {
      index += 2;
      while (text[index] === '`') index += 1;
      continue;
    }
    if (text[index] !== '`') {
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === '`') end += 1;
    const width = end - index;
    let cursor = end;
    let close = -1;
    while (cursor < text.length) {
      const inside = rangeContaining(occupied, cursor);
      if (inside) {
        cursor = inside[1];
        continue;
      }
      if (text[cursor] === '`') {
        let runEnd = cursor;
        while (text[runEnd] === '`') runEnd += 1;
        if (runEnd - cursor === width) {
          close = cursor;
          cursor = runEnd;
          break;
        }
        cursor = runEnd;
        continue;
      }
      if (text[cursor] === '\\' && text[cursor + 1] === '`') cursor += 2;
      else cursor += 1;
    }
    if (close < 0) {
      index = end;
      continue;
    }
    spans.push({
      start: index,
      openEnd: end,
      contentStart: end,
      contentEnd: close,
      closeStart: close,
      closeEnd: close + width,
      end: close + width,
      width,
    });
    index = close + width;
  }
  return spans;
}

function codeRanges(text) {
  const fences = fenceBlocks(text);
  const ranges = fences.map((block) => [block.start, block.end]);
  for (const span of inlineCodeSpans(text, fences, ranges)) ranges.push([span.start, span.end]);
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return ranges;
}

function rangeContaining(ranges, pos) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle];
    if (pos < start) high = middle - 1;
    else if (pos >= end) low = middle + 1;
    else return ranges[middle];
  }
  return null;
}

function rangesOverlap(ranges, others) {
  for (const [start, end] of ranges) {
    for (const [otherStart, otherEnd] of others) {
      if (start < otherEnd && end > otherStart) return true;
    }
  }
  return false;
}

function isEscaped(text, pos) {
  let count = 0;
  for (let cursor = pos - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) count += 1;
  return count % 2 === 1;
}

function maxBacktickRun(text) {
  let max = 0;
  let current = 0;
  for (const char of text) {
    if (char === '`') current += 1;
    else current = 0;
    if (current > max) max = current;
  }
  return max;
}

/* ── 强调 / 行内代码 ──────────────────────────────────────────────────────── */

/** 扫描 `*` / `~~` 的实际标记，返回嵌套后的 span（含标记坐标）。 */
function emphasisSpans(text) {
  const code = codeRanges(text);
  const spans = [];
  const stack = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      const next = text[index + 1];
      if (next === '*' || next === '~' || next === '`') {
        index += 2;
        while (text[index] === next) index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (char !== '*' && char !== '~') {
      index += 1;
      continue;
    }
    if (rangeContaining(code, index)) {
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === char) end += 1;
    const count = end - index;
    if (char === '~' && count < 2) {
      index = end;
      continue;
    }
    const prev = index > 0 ? text[index - 1] : '';
    const next = end < text.length ? text[end] : '';
    const canClose = Boolean(prev) && !/\s/.test(prev);
    const canOpen = Boolean(next) && !/\s/.test(next);

    let remaining = count;
    let cursor = index;
    while (remaining > 0 && stack.length) {
      const top = stack[stack.length - 1];
      if (top.char !== char || top.width > remaining) break;
      const closeStart = cursor;
      spans.push({
        kind: top.kind,
        start: top.openStart,
        openEnd: top.openEnd,
        contentStart: top.openEnd,
        contentEnd: closeStart,
        closeStart,
        closeEnd: closeStart + top.width,
        end: closeStart + top.width,
      });
      stack.pop();
      cursor += top.width;
      remaining -= top.width;
    }

    if (canOpen && remaining > 0) {
      const widths = char === '~'
        ? Array(Math.floor(remaining / 2)).fill(2)
        : starWidths(remaining);
      let openCursor = end;
      const tokens = [];
      for (let at = widths.length - 1; at >= 0; at -= 1) {
        openCursor -= widths[at];
        tokens[at] = { width: widths[at], openStart: openCursor, openEnd: openCursor + widths[at] };
      }
      for (const token of tokens) {
        stack.push({
          char,
          width: token.width,
          kind: char === '~' ? 'strike' : token.width === 2 ? 'bold' : 'italic',
          openStart: token.openStart,
          openEnd: token.openEnd,
        });
      }
    }
    index = end;
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

function starWidths(count) {
  const widths = [];
  let remaining = count;
  while (remaining >= 2) {
    widths.push(2);
    remaining -= 2;
  }
  if (remaining === 1) widths.push(1);
  return widths;
}

function insideCode(text, pos) {
  return Boolean(rangeContaining(codeRanges(text), pos));
}

function selectionHitsCode(text, from, to) {
  const code = codeRanges(text);
  for (const [start, end] of code) {
    if (from < end && to > start) return true;
    if (from === to && start < from && from < end) return true;
  }
  return false;
}

function enclosingMarks(spans, from, to) {
  const contained = spans.filter((span) => span.start >= from && span.end <= to);
  if (contained.length) return { spans: contained, mode: 'contained' };
  const containing = spans
    .filter((span) => span.start <= from && span.end >= to)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));
  if (containing.length) return { spans: [containing[0]], mode: 'containing' };
  const overlapping = spans.filter((span) => span.end > from && span.start < to);
  if (overlapping.length) return { spans: [], mode: 'partial' };
  return { spans: [], mode: 'none' };
}

function unwrapSpans(changes, spans) {
  for (const span of spans) {
    changes.push({ from: span.start, to: span.openEnd, insert: '' });
    changes.push({ from: span.closeStart, to: span.closeEnd, insert: '' });
  }
}

function inlineCommand(text, from, to, command) {
  if (command === 'inline-code') return inlineCodeCommand(text, from, to);
  const kind = command;
  const spans = emphasisSpans(text).filter((span) => span.kind === kind);
  const markers = MARKER[kind];

  if (from === to) {
    if (insideCode(text, from)) return null;
    const span = spans
      .filter((candidate) => candidate.start < from && from < candidate.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    if (span) {
      const changes = [];
      unwrapSpans(changes, [span]);
      return makeResult(text, changes, mapPosition(from, changes, 'end'), mapPosition(from, changes, 'end'));
    }
    const changes = [{ from, to, insert: markers + markers }];
    return makeResult(text, changes, from + markers.length, from + markers.length);
  }

  if (selectionHitsCode(text, from, to)) return null;
  const found = enclosingMarks(spans, from, to);
  if (found.mode === 'partial') return null;
  if (found.spans.length) {
    const changes = [];
    unwrapSpans(changes, found.spans);
    return lineResult(text, changes, from, to);
  }

  const selected = text.slice(from, to);
  if (kind === 'bold' || kind === 'italic') {
    if (selected.startsWith('*') || selected.endsWith('*')) return null;
  }
  if (kind === 'strike' && (selected.startsWith('~') || selected.endsWith('~'))) return null;
  if (selected.startsWith('\\') && isEscapedEnd(selected)) return null;

  const changes = [
    { from, to: from, insert: markers },
    { from: to, to, insert: markers },
  ];
  return makeResult(text, changes, from + markers.length, to + markers.length);
}

function isEscapedEnd(text) {
  let count = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === '\\'; index -= 1) count += 1;
  return count % 2 === 1;
}

function inlineCodeCommand(text, from, to) {
  const spans = inlineCodeSpans(text);
  if (from === to) {
    if (rangeContaining(fenceBlocks(text).map((block) => [block.start, block.end]), from)) return null;
    const span = spans
      .filter((candidate) => candidate.start < from && from < candidate.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    if (span) {
      const changes = [];
      unwrapSpans(changes, [span]);
      return makeResult(text, changes, mapPosition(from, changes, 'end'), mapPosition(from, changes, 'end'));
    }
    const changes = [{ from, to, insert: '``' }];
    return makeResult(text, changes, from + 1, from + 1);
  }

  if (rangesOverlap([[from, to]], fenceBlocks(text).map((block) => [block.start, block.end]))) return null;
  const found = enclosingMarks(spans, from, to);
  if (found.mode === 'partial') return null;
  if (found.spans.length) {
    const changes = [];
    unwrapSpans(changes, found.spans);
    return lineResult(text, changes, from, to);
  }

  const selected = text.slice(from, to);
  const width = Math.max(1, maxBacktickRun(selected) + 1);
  const fence = '`'.repeat(width);
  const pad = selected.startsWith('`') || selected.endsWith('`') ? ' ' : '';
  const changes = [{ from, to, insert: fence + pad + selected + pad + fence }];
  const shift = fence.length + pad.length;
  return makeResult(text, changes, from + shift, from + shift + selected.length);
}

/* ── 标题 / 列表 / 引用 ───────────────────────────────────────────────────── */

function headingCommand(text, from, to, value) {
  const level = Number(value);
  if (!Number.isInteger(level) || level < 0 || level > HEADING_MAX) return null;
  const lines = lineRanges(text);
  const indexes = selectedLineIndexes(lines, from, to);
  const blocks = fenceBlocks(text);
  if (indexes.some((index) => rangesOverlap(
    [[lines[index].start, lines[index].end || lines[index].start + 1]],
    blocks.map((block) => [block.start, block.end]),
  ))) return null;

  const changes = [];
  for (const index of indexes) {
    const line = lines[index];
    const content = text.slice(line.start, line.contentEnd);
    const blank = content.trim() === '';
    const prefix = parseLinePrefix(content);
    const heading = parseHeadingAt(content, prefix.end);
    if (blank && !(from === to && indexes.length === 1)) continue;

    if (level === 0) {
      if (!heading) continue;
      changes.push({ from: line.start + heading.hashStart, to: line.start + heading.separatorEnd, insert: '' });
      if (heading.closingStart >= 0) {
        changes.push({ from: line.start + heading.closingStart, to: line.start + heading.closingEnd, insert: '' });
      }
    } else if (!heading) {
      changes.push({ from: line.start + prefix.end, to: line.start + prefix.end, insert: `${'#'.repeat(level)} ` });
    } else if (heading.level !== level) {
      changes.push({
        from: line.start + heading.hashStart,
        to: line.start + heading.hashEnd,
        insert: '#'.repeat(level),
      });
    }
  }
  return changes.length ? lineResult(text, changes, from, to) : null;
}

function listCommand(text, from, to, type) {
  const lines = lineRanges(text);
  const indexes = selectedLineIndexes(lines, from, to);
  const blocks = fenceBlocks(text);
  if (indexes.some((index) => rangesOverlap(
    [[lines[index].start, lines[index].end || lines[index].start + 1]],
    blocks.map((block) => [block.start, block.end]),
  ))) return null;

  let targets = indexes.filter((index) => {
    const content = text.slice(lines[index].start, lines[index].contentEnd);
    return content.trim() !== '';
  });
  if (!targets.length) {
    if (from !== to) return null;
    targets = [indexes[0]];
  }

  const infos = targets.map((index) => {
    const line = lines[index];
    const prefix = parseLinePrefix(text.slice(line.start, line.contentEnd));
    const list = prefix.tokens.filter((token) => token.kind === 'list').pop();
    return { line, prefix, list };
  });

  const already = infos.every(({ list }) => list && (type === 'bullet' ? list.bullet : list.ordered));
  const changes = [];
  let number = 1;
  for (const { line, prefix, list } of infos) {
    if (already) {
      changes.push({ from: line.start + list.start, to: line.start + list.end, insert: '' });
      continue;
    }
    const marker = type === 'bullet' ? '- ' : `${number}. `;
    number += 1;
    if (list) {
      changes.push({ from: line.start + list.start, to: line.start + list.end, insert: marker });
    } else {
      changes.push({ from: line.start + prefix.end, to: line.start + prefix.end, insert: marker });
    }
  }
  return changes.length ? lineResult(text, changes, from, to) : null;
}

function quoteCommand(text, from, to) {
  const lines = lineRanges(text);
  const indexes = selectedLineIndexes(lines, from, to);
  const blocks = fenceBlocks(text);
  if (indexes.some((index) => rangesOverlap(
    [[lines[index].start, lines[index].end || lines[index].start + 1]],
    blocks.map((block) => [block.start, block.end]),
  ))) return null;

  const infos = indexes.map((index) => {
    const line = lines[index];
    const content = text.slice(line.start, line.contentEnd);
    const prefix = parseLinePrefix(content);
    return { line, content, prefix, quoted: prefix.tokens.length > 0 && prefix.tokens[0].kind === 'quote' };
  });
  const meaningful = infos.filter((info) => info.content.trim() !== '');
  const allQuoted = meaningful.length > 0 && meaningful.every((info) => info.quoted);
  const changes = [];
  for (const info of infos) {
    if (allQuoted) {
      if (info.quoted) {
        const quote = info.prefix.tokens[0];
        changes.push({ from: info.line.start + quote.start, to: info.line.start + quote.end, insert: '' });
      }
    } else if (!info.quoted) {
      const insert = info.content.trim() === '' ? '>' : '> ';
      changes.push({ from: info.line.start + info.prefix.indentEnd, to: info.line.start + info.prefix.indentEnd, insert });
    }
  }
  return changes.length ? lineResult(text, changes, from, to) : null;
}

/* ── 代码块 / 表格 ────────────────────────────────────────────────────────── */

function codeBlockCommand(text, from, to) {
  const blocks = fenceBlocks(text);
  const inside = blocks.find((block) => (from === to
    ? (block.start < from && (from < block.end || (block.end === text.length && from === text.length)))
    : block.start <= from && to <= block.end));

  if (inside) {
    if (inside.unclosed) return null;
    const changes = [
      { from: inside.start, to: inside.openLineEnd, insert: '' },
      { from: inside.closeLineStart, to: inside.closeLineEnd, insert: '' },
    ];
    return lineResult(text, changes, from, to);
  }
  if (blocks.some((block) => from < block.end && to > block.start)) return null;

  const lines = lineRanges(text);
  const indexes = selectedLineIndexes(lines, from, to);
  const first = lines[indexes[0]];
  const last = lines[indexes[indexes.length - 1]];
  const eol = localEol(text, first.start);
  const selected = text.slice(first.start, last.contentEnd);
  const fence = '`'.repeat(Math.max(3, maxBacktickRun(selected) + 1));
  const openInsert = `${fence}${eol}`;

  if (first.start === last.contentEnd && first.start === last.start && last.eolLen === 0) {
    const insert = `${fence}${eol}${eol}${fence}`;
    const changes = [{ from: first.start, to: first.start, insert }];
    return makeResult(text, changes, first.start + openInsert.length, first.start + openInsert.length);
  }

  const closeAt = last.eolLen > 0 ? last.end : last.contentEnd;
  const closeInsert = last.eolLen > 0 ? `${fence}${eol}` : `${eol}${fence}`;
  const changes = [
    { from: first.start, to: first.start, insert: openInsert },
    { from: closeAt, to: closeAt, insert: closeInsert },
  ];
  const collapsed = from === to;
  const anchor = mapPosition(from, changes, 'end');
  const head = mapPosition(to, changes, collapsed ? 'end' : 'start');
  return makeResult(text, changes, anchor, head);
}

function tableCommand(text, from, to) {
  const block = fenceBlocks(text).find((candidate) => candidate.start <= from && from < candidate.end);
  if (block) return null;
  const lines = lineRanges(text);
  const line = lines[lineIndexAt(lines, from)];
  const position = line.start;
  const eol = localEol(text, position);
  const body = `|  |  |${eol}| --- | --- |${eol}|  |  |`;
  const suffix = position < text.length ? eol : '';
  const changes = [{ from: position, to: position, insert: body + suffix }];
  return makeResult(text, changes, position + 2, position + 2);
}

/* ── 链接 ─────────────────────────────────────────────────────────────────── */

function findLinks(text) {
  const code = codeRanges(text);
  const links = [];
  let index = 0;
  while (index < text.length) {
    if (rangeContaining(code, index)) {
      index += 1;
      continue;
    }
    if (text[index] !== '[' || isEscaped(text, index)) {
      index += 1;
      continue;
    }
    let textEnd = index + 1;
    while (textEnd < text.length && text[textEnd] !== ']' && text[textEnd] !== '\n') {
      if (text[textEnd] === '\\') textEnd += 2;
      else textEnd += 1;
    }
    if (text[textEnd] !== ']' || text[textEnd + 1] !== '(') {
      index += 1;
      continue;
    }
    let cursor = textEnd + 2;
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
    const hrefStart = cursor;
    let hrefEnd = cursor;
    if (text[cursor] === '<') {
      hrefEnd = cursor + 1;
      while (hrefEnd < text.length && text[hrefEnd] !== '>' && text[hrefEnd] !== '\n') hrefEnd += 1;
      if (text[hrefEnd] !== '>') {
        index += 1;
        continue;
      }
      hrefEnd += 1;
      cursor = hrefEnd;
    } else {
      let depth = 0;
      while (hrefEnd < text.length && text[hrefEnd] !== '\n') {
        const char = text[hrefEnd];
        if (char === '\\') {
          hrefEnd += 2;
          continue;
        }
        if (char === ' ' || char === '\t') break;
        if (char === '(') depth += 1;
        else if (char === ')') {
          if (depth === 0) break;
          depth -= 1;
        }
        hrefEnd += 1;
      }
      cursor = hrefEnd;
    }
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
    if (text[cursor] === '"' || text[cursor] === "'" || text[cursor] === '(') {
      const opener = text[cursor];
      const closer = opener === '(' ? ')' : opener;
      cursor += 1;
      while (cursor < text.length && text[cursor] !== closer && text[cursor] !== '\n') {
        if (text[cursor] === '\\') cursor += 2;
        else cursor += 1;
      }
      if (text[cursor] !== closer) {
        index += 1;
        continue;
      }
      cursor += 1;
      while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
    }
    if (text[cursor] !== ')') {
      index += 1;
      continue;
    }
    const rawHref = text.slice(hrefStart, hrefEnd);
    links.push({
      start: index,
      end: cursor + 1,
      textStart: index + 1,
      textEnd,
      text: text.slice(index + 1, textEnd),
      hrefStart,
      hrefEnd,
      href: rawHref.replace(/^</, '').replace(/>$/, ''),
    });
    index = cursor + 1;
  }
  return links;
}

function linkDestination(href) {
  return /[()]/.test(href) ? `<${href}>` : href;
}

function linkCommand(text, from, to, value) {
  const href = normalizeHttpHref(value && value.href);
  if (!href) return null;
  const destination = linkDestination(href);
  const providedText = value && typeof value.text === 'string' ? value.text : undefined;
  if (providedText !== undefined && !isLinkTextSafe(providedText)) return null;

  const link = findLinks(text).find((candidate) => (from === to
    ? candidate.start < from && from < candidate.end
    : candidate.start < to && candidate.end > from));

  if (link) {
    if (from !== to && !(link.start <= from && link.end >= to)) return null;
    const changes = [];
    if (normalizeHttpHref(link.href) !== href) {
      changes.push({ from: link.hrefStart, to: link.hrefEnd, insert: destination });
    }
    if (providedText !== undefined && providedText !== link.text) {
      changes.push({ from: link.textStart, to: link.textEnd, insert: providedText });
    }
    if (!changes.length) return null;
    return lineResult(text, changes, from, to);
  }

  if (from !== to) {
    const selected = text.slice(from, to);
    const label = providedText === undefined ? selected : providedText;
    if (!isLinkTextSafe(label)) return null;
    if (label === selected) {
      const insert = `[${label}](${destination})`;
      const changes = [{ from, to: from, insert: '[' }, { from: to, to, insert: `](${destination})` }];
      return makeResult(text, changes, from + 1, from + 1 + label.length);
    }
    const insert = `[${label}](${destination})`;
    const changes = [{ from, to, insert }];
    return makeResult(text, changes, from + insert.length, from + insert.length);
  }

  const label = providedText === undefined ? '' : providedText;
  const insert = `[${label}](${destination})`;
  const changes = [{ from, to, insert }];
  if (!label) return makeResult(text, changes, from + 1, from + 1);
  return makeResult(text, changes, from + insert.length, from + insert.length);
}

function isLinkTextSafe(text) {
  return typeof text === 'string' && !text.includes(']') && !/[\r\n]/.test(text) && !isEscapedEnd(text);
}
