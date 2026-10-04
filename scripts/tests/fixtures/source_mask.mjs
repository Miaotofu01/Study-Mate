/* 源码扫描骨架：把注释与正则抹成空格、字符串原样留下，并记下字符串与注释的区间。
   ────────────────────────────────────────────────────────────────────────
   两个套件共用这一份，因为「哪里是注释、哪里是字符串」只该有一个判据：

     · `test_architecture_boundaries.mjs` 拿它解析 import 说明符——说明符在字符串里，
       注释、正则、模板里的 `import … from 'x'` 字样都不是依赖；
     · `test_docs_references.mjs` 拿它**反过来**用：落在注释区间里的 `` `路径` `` 才是
       注释里的仓库路径引用，代码与字符串里出现的同形文字不是。

   两条用法要的正是同一件事：区间。所以状态机住在这里、不各写一份——两份扫描器早晚会在
   某个真实写法上分叉（模板里套模板、正则里带引号都是这个仓库里真有的写法），而分叉的表现
   是「一条检查悄悄放过了该报的东西」。

   下面这段状态机连同它的坑注一起从 `test_architecture_boundaries.mjs` 搬过来，只加了一件事：
   把注释区间也记下来（`comments`）。 */

/* ── 源码扫描：注释与正则抹掉、字符串原样留（说明符在里面），并记下字符串区间 ──
   为什么要区间：注释、字符串、模板里都可能出现 `import … from 'x'` 字样（本仓库的文档与提示语
   里就不少）。抹掉注释与正则、把落在字符串内容里的匹配丢掉，才不会把「文档里的示例」当依赖。

   三个真踩过的坑（不是理论洁癖，都是这个仓库里真实存在的写法）：
     · 模板里套模板：``value => `'${value}'` `` 嵌在另一个模板的 `${}` 里（`bin/openai-skill-compat.mjs`）。
       所以模板要按 `${}` 进出、记深度，不能见反引号就收尾。
     · 带引号的正则：`.replace(/"/g, '&quot;')`（`lib/core/format.ts`）。把正则当普通代码扫的话，
       里面的引号会把状态机带偏。所以按前导字符判正则，判到就整段抹成空格。
     · 引号在字符串内容里：靠「区间」而不是「引号计数」来判，才不会把内容里的引号当边界。 */
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
  'instanceof', 'do', 'else', 'yield', 'await']);
// 正则前面允许出现的「非值」字符：`= /re/`、`( /re/`、`, /re/`…；标识符、`)`、`]` 后面是除法。
const REGEX_LEADERS = '([{,;=:!&|?+-*%^~<>';

/**
 * 扫一遍源码，返回 `{ code, literals, comments }`：
 *   · `code`     —— 与源码**等长**的字符串，注释与正则整段抹成空格（换行保留）；
 *   · `literals` —— 字符串/模板字面量的区间 `[start, end)`（模板只算 `${}` 之外的文本）；
 *   · `comments` —— 注释的区间 `[start, end)`，含 `//` 与块注释的起手字符。
 */
export function maskSource(source) {
  let out = '';
  const literals = [];
  const comments = [];
  const stack = [{ kind: 'code' }];
  const top = () => stack[stack.length - 1];
  /** `/` 是正则还是除号：看已产出代码里最后一个有意义的字符/词。 */
  const regexAllowed = () => {
    const head = out.replace(/\s+$/, '');
    if (!head) return true;
    if (REGEX_LEADERS.includes(head[head.length - 1])) return true;
    const word = /[A-Za-z_$][\w$]*$/.exec(head);
    return word !== null && REGEX_KEYWORDS.has(word[0]);
  };
  let i = 0;
  while (i < source.length) {
    const frame = top();
    const char = source[i];
    const next = source[i + 1];
    if (frame.kind === 'code') {
      if (char === '/' && next === '/') { stack.push({ kind: 'line', start: i }); out += '  '; i += 2; continue; }
      if (char === '/' && next === '*') { stack.push({ kind: 'block', start: i }); out += '  '; i += 2; continue; }
      if (char === '/' && regexAllowed()) {
        // 正则字面量：转义与 `[…]` 字符组里的 `/` 不算收尾；撞到换行说明判错了，退回普通字符
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < source.length) {
          const inner = source[j];
          if (inner === '\\') { j += 2; continue; }
          if (inner === '\n') break;
          if (inner === '[') inClass = true;
          else if (inner === ']') inClass = false;
          else if (inner === '/' && !inClass) { closed = true; break; }
          j += 1;
        }
        if (closed) {
          let end = j + 1;
          while (end < source.length && /[a-z]/.test(source[end])) end += 1;
          out += ' '.repeat(end - i);
          i = end;
          continue;
        }
      }
      if (char === '`') { stack.push({ kind: 'template', start: i }); out += char; i += 1; continue; }
      if (char === '"' || char === "'") { stack.push({ kind: 'quote', quote: char, start: i }); out += char; i += 1; continue; }
      if (frame.hole) {
        if (char === '{') frame.depth += 1;
        else if (char === '}') {
          if (frame.depth === 0) {
            stack.pop();
            top().start = i + 1;  // 洞之后那段模板文本从 `}` 的下一格开始
            out += char; i += 1; continue;
          }
          frame.depth -= 1;
        }
      }
      out += char; i += 1; continue;
    }
    if (frame.kind === 'line') {
      out += char === '\n' ? '\n' : ' ';
      i += 1;
      if (char === '\n') { comments.push([frame.start, i]); stack.pop(); }
      continue;
    }
    if (frame.kind === 'block') {
      if (char === '*' && next === '/') { stack.pop(); out += '  '; i += 2; comments.push([frame.start, i]); continue; }
      out += char === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (frame.kind === 'quote') {
      if (char === '\\') { out += char + (next ?? ''); i += 2; continue; }
      out += char; i += 1;
      if (char === frame.quote) { literals.push([frame.start, i]); stack.pop(); }
      continue;
    }
    // 模板：`${` 之前的文本是一段字面量内容，洞里的代码照常扫（所以区间不含洞）
    if (char === '\\') { out += char + (next ?? ''); i += 2; continue; }
    if (char === '`') { out += char; i += 1; literals.push([frame.start, i]); stack.pop(); continue; }
    if (char === '$' && next === '{') {
      // 洞紧跟洞时（`…${a}${b}…`）这里会是一段空内容，别记空区间
      if (frame.start < i) literals.push([frame.start, i]);
      stack.push({ kind: 'code', hole: true, depth: 0 });
      out += '${'; i += 2; continue;
    }
    out += char; i += 1;
  }
  return { code: out, literals, comments };
}

/** 这个位置落在某段字符串内容里吗（说明符匹配按它筛）。 */
export const insideLiteral = (literals, index) => literals.some(([from, to]) => index >= from && index < to);

/** 这个位置落在某段注释里吗（注释里的路径引用按它筛）。 */
export const insideComment = (comments, index) => comments.some(([from, to]) => index >= from && index < to);
