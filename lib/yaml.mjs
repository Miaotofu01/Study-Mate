/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半数据层 —— 最小 YAML 子集解析器

   为什么自己写而不是引依赖：Host 半是零运行时依赖的插件，装不进 npm 包；而且这些学习
   文件用的 YAML 窄得可怜，实测（PyYAML 的 token 扫描，21 个真文件）只有这些构造：

     ScalarToken 6407（plain 3404 / double 2999 / single 4）、KeyToken 2948、
     ValueToken 2948、BlockEntryToken 1517、BlockMappingStart 587、
     BlockSequenceStart 444、FlowSequenceStart 28、FlowMappingStart 2。
     块标量 |、> 与锚点 &、别名 *、标签 !、多文档 --- 一个都没有；
     6407 个标量里跨行的 0 个；行尾注释 0 处（87 处全是整行注释）。

   所以这里只实现这个子集，别的构造一律**当场报错**并指出文件、行号与原文。宁可炸，
   也不要静默解析错——解析错的后果是学生界面上出现错的课件内容，比报错难查得多。

   标量的类型判定刻意对齐 PyYAML 的 SafeLoader 隐式解析器（含 yes/no/on/off 这种
   YAML 1.1 的布尔写法），因为验收标准是与 yaml.safe_load 深度相等。注意这带来一个
   已知后果：写 `title: no` 会得到布尔 false，跟 PyYAML 一样。这不是 bug，是对齐。
   ───────────────────────────────────────────────────────────────────────── */

/** PyYAML 把日期当 date 对象、`=`/`<<` 走特殊标签，这些本子集都不支持，见到就报错。 */
export class YamlParseError extends Error {
  constructor(file, line, column, text, message) {
    super(`${file}:${line}:${column}: ${message}${text == null ? '' : `\n    ${text}`}`);
    this.name = 'YamlParseError';
    this.file = file;
    this.line = line;
    this.column = column;
    this.text = text == null ? '' : text;
  }
}

/* ── Python 的空白集合 ──────────────────────────────────────────────────────
   Python 的 str.strip() 与正则 \s 认的空白，比 JS 的 trim()/\s 多 \x1c-\x1f、\x85，
   少 \ufeff。锚点归一化、去空白这些地方要跟 Python 逐字一致，所以显式写出这个集合，
   不用 JS 的 \s。 */
const PY_WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');

/** 等价于 Python 的 str.strip()。 */
export function pyStrip(text) {
  return String(text).replace(PY_STRIP_RE, '');
}

function fail(file, line, column, text, message) {
  throw new YamlParseError(file, line.line, column, text == null ? line.raw : text, message);
}

/* ── 隐式类型解析（对齐 PyYAML SafeLoader） ─────────────────────────────── */

const BOOL_TRUE = new Set(['yes', 'true', 'on']);
const BOOL_FALSE = new Set(['no', 'false', 'off']);

// 逐个抄自 PyYAML resolver.py，含 _ 分隔与六十进制这两种冷门写法：
// 判错一个字符，`mastery: 0.85` 就会变成字符串混进统计里。
const INT_RE = /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const FLOAT_RE = /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9_]+(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
// 未加引号的日期在 PyYAML 里是 datetime.date。本解析器不建 date 对象，按字符串返回
// （str(date) 与原文逐字相同，下游 String() 的结果一致）；只是类型与 PyYAML 不同，
// 真出现这种写法时交叉校验会看见差异，不会静默错。
const TIMESTAMP_RE = /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;

/** 把 plain 标量转成 Python 侧等价的 JS 值。 */
export function resolvePlainScalar(raw) {
  if (raw === '' || raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return null;
  const lower = raw.toLowerCase();
  if (BOOL_TRUE.has(lower)) return true;
  if (BOOL_FALSE.has(lower)) return false;
  if (INT_RE.test(raw)) return constructInt(raw);
  if (FLOAT_RE.test(raw)) return constructFloat(raw);
  if (TIMESTAMP_RE.test(raw)) return raw;
  return raw;
}

function constructInt(raw) {
  let value = raw.replace(/_/g, '');
  let sign = 1;
  if (value[0] === '-') sign = -1;
  if (value[0] === '-' || value[0] === '+') value = value.slice(1);
  if (value === '0') return 0;
  if (value.startsWith('0b')) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith('0x')) return sign * parseInt(value.slice(2), 16);
  if (value[0] === '0') return sign * parseInt(value, 8);
  if (value.includes(':')) {
    let acc = 0;
    let base = 1;
    for (const part of value.split(':').reverse()) {
      acc += Number(part) * base;
      base *= 60;
    }
    return sign * acc;
  }
  return sign * Number(value);
}

function constructFloat(raw) {
  let value = raw.replace(/_/g, '').toLowerCase();
  let sign = 1;
  if (value[0] === '-') sign = -1;
  if (value[0] === '-' || value[0] === '+') value = value.slice(1);
  if (value === '.inf') return sign * Infinity;
  if (value === '.nan') return NaN;
  if (value.includes(':')) {
    let acc = 0;
    let base = 1;
    for (const part of value.split(':').reverse()) {
      acc += Number(part) * base;
      base *= 60;
    }
    return sign * acc;
  }
  return sign * Number(value);
}

/* ── 行索引 ────────────────────────────────────────────────────────────── */

function isSeqEntry(content) {
  return content === '-' || content.startsWith('- ') || content.startsWith('-\t');
}

/** 普通赋值遇到 __proto__ 会去改原型而不是加键；键来自文件，不能给它这种权力。 */
function setKey(obj, key, value) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
}

/** 去掉行尾注释。`#` 只有在行首或前面是空白时才是注释（YAML 的规则）。 */
function stripComment(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) return text.slice(0, i);
  }
  return text;
}

/**
 * 找 `key:` 里那个冒号。只在引号外、流式括号外、且后面是空白或行尾的冒号才算，
 * 所以 `url: https://a`（冒号后面是 `/`）和 `title: [a, b]` 都不会认错。
 * 找不到返回 -1，表示这一行不是映射项。
 */
function findKeyColon(text) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) return -1;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0 && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) return i;
  }
  return -1;
}

function indexLines(text, file) {
  // 实测 21 个真文件全是 \n 结尾；这里顺手归一 CRLF，免得 \r 混进标量尾巴。
  const rawLines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    let indent = 0;
    while (indent < raw.length && raw[indent] === ' ') indent++;
    if (indent < raw.length && raw[indent] === '\t') {
      fail(file, { line: i + 1, raw }, indent + 1, raw, '缩进里出现了制表符：YAML 不允许用 Tab 缩进');
    }
    const content = raw.slice(indent);
    if (content === '' || content[0] === '#') continue; // 空行与整行注释
    // `---` 只有在第 0 列才是文档分隔符；缩进后的 `---` 是普通标量。
    if (indent === 0 && (content === '---' || content.startsWith('--- ') || content === '...')) {
      fail(file, { line: i + 1, raw }, 1, raw, '不支持多文档分隔符 --- / ...：一个文件只解析一个文档');
    }
    if (indent === 0 && content[0] === '%') {
      fail(file, { line: i + 1, raw }, 1, raw, '不支持 YAML 指令 %');
    }
    lines.push({ indent, content, raw, line: i + 1 });
  }
  return lines;
}

/* ── 标量 ──────────────────────────────────────────────────────────────── */

const ESCAPES = {
  0: '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r',
  e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\',
  N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
};

function readQuoted(text, start, line, file) {
  const quote = text[start];
  let i = start + 1;
  let out = '';
  for (;;) {
    if (i >= text.length) {
      // 跨行引号标量要按 YAML 的折行规则拼接；实测 6407 个标量里一个都没有，
      // 与其猜，不如报错让人看见。
      fail(file, line, start + 1, line.raw, `引号没有闭合（本解析器不支持跨行的引号标量）`);
    }
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, next: i + 1 };
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') return { value: out, next: i + 1 };
    if (ch === '\\') {
      const esc = text[i + 1];
      if (esc === undefined) fail(file, line, i + 1, line.raw, '双引号标量以反斜杠结尾');
      if (Object.prototype.hasOwnProperty.call(ESCAPES, esc)) {
        out += ESCAPES[esc];
        i += 2;
        continue;
      }
      if (esc === 'x' || esc === 'u' || esc === 'U') {
        const width = esc === 'x' ? 2 : esc === 'u' ? 4 : 8;
        const hex = text.slice(i + 2, i + 2 + width);
        if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) {
          fail(file, line, i + 1, line.raw, `转义 \\${esc} 后面需要 ${width} 位十六进制`);
        }
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + width;
        continue;
      }
      if (esc === '\n') {
        // YAML 的续行转义：\ 加换行等于把这个标量接下去。本解析器按行处理，走不到这里。
        i += 2;
        continue;
      }
      fail(file, line, i + 1, line.raw, `不认识的转义 \\${esc}`);
    }
    out += ch;
    i++;
  }
}

/** 拒绝所有「看起来像别的东西」的节点开头，附上人话解释。 */
function assertNodeStart(text, line, column, file) {
  const ch = text[0];
  if (ch === '|' || ch === '>') fail(file, line, column, line.raw, `不支持块标量 "${ch}"：本解析器只支持到行尾的标量`);
  if (ch === '&') fail(file, line, column, line.raw, '不支持锚点 &');
  if (ch === '*') fail(file, line, column, line.raw, '不支持别名 *');
  if (ch === '!') fail(file, line, column, line.raw, '不支持标签 !');
  if (ch === '?' && (text.length === 1 || text[1] === ' ' || text[1] === '\t')) {
    fail(file, line, column, line.raw, '不支持显式键 "? "');
  }
}

function skipFlowSpace(text, i) {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

/**
 * 流式集合里的一项。plain 标量在「映射用的冒号」处停下（冒号后面是空白、逗号或闭合符），
 * 所以 `{k: v}` 的键读成 `k`，而 `[https://a]`、`[1:30]` 里的冒号留在标量里。
 * 是不是映射由调用方看 next 指向的字符决定——同一段代码同时服务 `[...]` 与 `{...}`。
 */
function parseFlowValue(text, i, line, file) {
  i = skipFlowSpace(text, i);
  const ch = text[i];
  if (ch === undefined) fail(file, line, i + 1, line.raw, '流式集合没有闭合');
  if (ch === '[' || ch === '{') return parseFlowCollection(text, i, line, file);
  if (ch === '"' || ch === "'") return readQuoted(text, i, line, file);
  let j = i;
  while (j < text.length && text[j] !== ',' && text[j] !== ']' && text[j] !== '}') {
    if (text[j] === ':' && (j + 1 >= text.length || ' \t,]}\n'.includes(text[j + 1]))) break;
    j++;
  }
  const raw = pyStrip(text.slice(i, j));
  if (raw === '') fail(file, line, i + 1, line.raw, '流式集合里有空项');
  assertNodeStart(raw, line, i + 1, file);
  return { value: resolvePlainScalar(raw), next: j };
}

function parseFlowCollection(text, start, line, file) {
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  const isSeq = open === '[';
  const seq = [];
  const map = {};
  const put = (key, value) => {
    setKey(map, typeof key === 'string' ? key : String(key), value);
  };
  let i = skipFlowSpace(text, start + 1);
  if (text[i] === close) return { value: isSeq ? seq : map, next: i + 1 };
  for (;;) {
    i = skipFlowSpace(text, i);
    if (text[i] === undefined) fail(file, line, start + 1, line.raw, `流式集合缺少闭合的 "${close}"`);
    if (text[i] === close) {
      i++;
      break;
    }
    const item = parseFlowValue(text, i, line, file);
    i = skipFlowSpace(text, item.next);
    if (text[i] === ':') {
      // `{k: v}` 的键值对，或 `[k: v]` 这种单项映射（YAML 允许，PyYAML 解析成 [{k: v}]）。
      const val = parseFlowValue(text, skipFlowSpace(text, i + 1), line, file);
      if (isSeq) {
        const pair = {};
        setKey(pair, typeof item.value === 'string' ? item.value : String(item.value), val.value);
        seq.push(pair);
      } else {
        put(item.value, val.value);
      }
      i = skipFlowSpace(text, val.next);
    } else if (isSeq) {
      seq.push(item.value);
    } else {
      put(item.value, null); // `{a}`：键在、值为 null，与 PyYAML 一致
    }
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] === close) {
      i++;
      break;
    }
    if (text[i] === undefined) fail(file, line, start + 1, line.raw, `流式集合缺少闭合的 "${close}"`);
    fail(file, line, i + 1, line.raw, `流式集合里出现了意外的 "${text[i]}"`);
  }
  return { value: isSeq ? seq : map, next: i };
}

/** 解析一个值：流式集合、引号标量，或到行尾为止的 plain 标量。 */
function parseInlineValue(text, line, column, file) {
  const ch = text[0];
  if (ch === '[' || ch === '{') {
    const flow = parseFlowCollection(text, 0, line, file);
    const rest = pyStrip(stripComment(text.slice(flow.next)));
    if (rest !== '') fail(file, line, flow.next + 1, line.raw, `流式集合后面还有多余内容：${rest}`);
    return flow.value;
  }
  if (ch === '"' || ch === "'") {
    const quoted = readQuoted(text, 0, line, file);
    const rest = pyStrip(stripComment(text.slice(quoted.next)));
    if (rest !== '') fail(file, line, quoted.next + 1, line.raw, `引号标量后面还有多余内容：${rest}`);
    return quoted.value;
  }
  assertNodeStart(text, line, column, file);
  if (findKeyColon(text) >= 0) {
    // 块上下文里 plain 标量含 ": " 是非法 YAML（PyYAML 直接报错）。静默当字面量会把
    // 作者想要的嵌套结构吞掉，所以这里也报错。
    fail(file, line, column, line.raw, `plain 标量里出现 ": "，YAML 不允许（要么加引号，要么它就是键）：${text}`);
  }
  return resolvePlainScalar(text);
}

function parseKey(raw, line, column, file) {
  if (raw === '') fail(file, line, column, line.raw, '键是空的');
  if (raw === '<<' || raw === '=') fail(file, line, column, line.raw, `不支持 YAML 合并键 / 特殊键 "${raw}"`);
  if (raw[0] === '"' || raw[0] === "'") {
    const quoted = readQuoted(raw, 0, line, file);
    const rest = pyStrip(stripComment(raw.slice(quoted.next)));
    if (rest !== '') fail(file, line, column, line.raw, `键的引号后面还有内容：${rest}`);
    return quoted.value;
  }
  assertNodeStart(raw, line, column, file);
  // PyYAML 会把 `true:` / `1:` 这样的键解析成布尔/整数键，JSON 序列化后仍是 "true" / "1"。
  // 直接用解析后的值做属性名，JS 的强制转换结果与 Python 的 json.dumps 一致。
  const value = resolvePlainScalar(raw);
  return typeof value === 'string' ? value : String(value);
}

/* ── 块结构 ────────────────────────────────────────────────────────────── */

function parseMapping(lines, start, indent, file) {
  const obj = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      fail(file, line, line.indent + 1, line.raw,
        `缩进比同级多了 ${line.indent - indent} 个空格：同级键必须对齐（多行 plain 标量也不支持）`);
    }
    if (isSeqEntry(line.content)) break; // 交回上层；在映射里出现通常是上一行漏了 key
    if (line.content[0] === '&' || line.content[0] === '*' || line.content[0] === '!') {
      assertNodeStart(line.content, line, line.indent + 1, file);
    }
    const colon = findKeyColon(line.content);
    if (colon < 0) {
      fail(file, line, line.indent + 1, line.raw,
        '这一行既不是 key: value 也不是 "- " 列表项（本解析器不支持多行 plain 标量）');
    }
    const key = parseKey(pyStrip(line.content.slice(0, colon)), line, line.indent + 1, file);
    const rest = pyStrip(stripComment(line.content.slice(colon + 1)));
    if (rest === '') {
      const child = parseChild(lines, i + 1, indent, file);
      setKey(obj, key, child.value);
      i = child.next;
    } else {
      setKey(obj, key, parseInlineValue(rest, line, line.indent + colon + 2, file));
      i++;
    }
  }
  return [obj, i];
}

function parseSequence(lines, start, indent, file) {
  const arr = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      fail(file, line, line.indent + 1, line.raw, `列表项的缩进比同级多了 ${line.indent - indent} 个空格：同级项必须对齐`);
    }
    if (!isSeqEntry(line.content)) break;
    let rest = line.content.slice(1);
    let column = indent + 1;
    while (rest[0] === ' ' || rest[0] === '\t') {
      rest = rest.slice(1);
      column++;
    }
    const value = pyStrip(stripComment(rest));
    if (value === '') {
      const child = parseChild(lines, i + 1, indent, file);
      arr.push(child.value);
      i = child.next;
      continue;
    }
    // `- key: v` 这一段本身就是个块，把它就地改写成「从 column 列开始的块」，再交给
    // 通用解析器递归。这样紧凑写法与展开写法走同一条路径，不用维护两套代码。
    line.indent = column;
    line.content = rest;
    if (isSeqEntry(rest)) {
      const inner = parseSequence(lines, i, column, file);
      arr.push(inner[0]);
      i = inner[1];
    } else if (findKeyColon(rest) >= 0) {
      const inner = parseMapping(lines, i, column, file);
      arr.push(inner[0]);
      i = inner[1];
    } else {
      arr.push(parseInlineValue(value, line, column + 1, file));
      i++;
    }
  }
  return [arr, i];
}

/** 一个键的值块：下一行更深就往下走；同级出现列表项也算（YAML 允许列表与键同缩进）。 */
function parseChild(lines, i, parentIndent, file) {
  if (i >= lines.length) return { value: null, next: i };
  const line = lines[i];
  if (line.indent > parentIndent) {
    if (isSeqEntry(line.content)) {
      const [value, next] = parseSequence(lines, i, line.indent, file);
      return { value, next };
    }
    const [value, next] = parseMapping(lines, i, line.indent, file);
    return { value, next };
  }
  if (line.indent === parentIndent && isSeqEntry(line.content)) {
    const [value, next] = parseSequence(lines, i, line.indent, file);
    return { value, next };
  }
  return { value: null, next: i };
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

/**
 * 解析这一小撮学习文件用的 YAML 子集。
 *
 * @param {string} text 文件全文
 * @param {{file?: string}} [options] 出错信息里要写的文件名（调用方从盘上读，只有它知道）
 * @returns {unknown} 映射、序列或标量；空文档返回 null
 */
export function parseYaml(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('parseYaml 只接受字符串');
  const file = options.file || '<yaml>';
  const lines = indexLines(text, file);
  if (lines.length === 0) return null;

  const first = lines[0];
  if (!isSeqEntry(first.content) && findKeyColon(first.content) < 0) {
    // 整个文档就是一个流式集合或标量，例如 misconceptions.yaml 里的裸 `[]`。
    if (lines.length > 1) {
      const second = lines[1];
      fail(file, second, second.indent + 1, second.raw,
        '第一行既不是 key: value 也不是 "- " 列表项，本解析器不支持多行 plain 标量（YAML 会把续行折进同一个标量）');
    }
    return parseInlineValue(pyStrip(stripComment(first.content)), first, first.indent + 1, file);
  }

  let value;
  let next;
  if (isSeqEntry(first.content)) [value, next] = parseSequence(lines, 0, first.indent, file);
  else [value, next] = parseMapping(lines, 0, first.indent, file);

  if (next < lines.length) {
    const line = lines[next];
    fail(file, line, line.indent + 1, line.raw, '多出来的内容：这一行的缩进与上一块对不上');
  }
  return value;
}

export default parseYaml;
