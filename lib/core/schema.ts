/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— JSON Schema（Draft-07 最小子集）校验器

   为什么自己写：这个仓库是**零运行时依赖**的（`lib/yaml.mjs` 顶部明说 Host 半装不进
   npm 包），而 Python 侧那个 `jsonschema` 正随 Python 一起退场。`schemas/*.json` 六份
   文档合计只用到 17 个关键字（见下面的枚举表），引一个通用实现换不来什么，反而把
   「零依赖」这条硬约束破掉。

   **子集的边界是显式的，不是静默的**：碰到枚举表之外的关键字，这里不是放行，而是报一条
   `keyword` 为该关键字名的问题——调用方把这类问题一律当阻断处理。假装支持比不支持危险
   得多：`oneOf` 被无视的结果是「校验通过」而数据其实是错的。

   为什么在纯函数域：`decisions.md` §2 规定 `lib/core/**` 不 import 任何 `node:*`。
   这里只用 JS 内建（`RegExp`、`Object.keys`），出入都是已经解析好的值。
   ───────────────────────────────────────────────────────────────────────── */

/** draft-07 里只是注解、对校验结果没有影响的关键字：读到就跳过，不算「未实现」。 */
export const ANNOTATION_KEYWORDS: readonly string[] = ['$schema', 'title', 'description'];

/** 本子集**实现**的断言关键字（六份 schema 实际用到的全集，逐个核对过）。 */
export const ASSERTION_KEYWORDS: readonly string[] = [
  'type', 'required', 'properties', 'items', 'additionalProperties',
  'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
  'minItems', 'format',
];

/**
 * draft-07 里存在、但本子集**不实现**的关键字。写进 schema 会得到一条 `keyword` 等于它
 * 自己的问题（调用方按阻断处理），不会静默放行。替代方案：
 *   - `$ref` / `$defs` / `definitions`：把引用处**就地展开**（六份 schema 各自都很小，
 *     展开后仍可读），或在调用方组装出展开后的 schema 再传进来。
 *   - `oneOf` / `anyOf` / `allOf` / `not` / `if`-`then`-`else`：改成显式的 `enum`+`const`
 *     组合；组合表达不了的（如「恰好满足其一」）留在领域校验器里用代码写，别塞进 schema。
 *   - `patternProperties` / `propertyNames`：额外键目前都是同一种形状，可用
 *     `additionalProperties` + `required` 表达；差异化的键规则写进领域校验器。
 *   - `maxItems` / `uniqueItems` / `minProperties` / `maxProperties` / `contains`：
 *     同理，用代码断言（本文件不给假承诺）。
 *   - 布尔 schema（`true` / `false`）：本子集只认对象 schema；`false` 的等价写法是
 *     `{"not": {}}`，但我们连 `not` 也不支持——需要「什么都不许」就直接不写这个分支。
 */
export const UNSUPPORTED_KEYWORDS: readonly string[] = [
  '$ref', '$defs', 'definitions',
  'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else',
  'patternProperties', 'propertyNames', 'dependencies', 'dependentRequired', 'dependentSchemas',
  'maxItems', 'uniqueItems', 'contains', 'minProperties', 'maxProperties',
  'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum',
  'default', 'examples', 'readOnly', 'writeOnly', 'contentMediaType', 'contentEncoding',
];

/** 认得的 `type` 取值。draft-07 就这七种，全都能映射到 JS 的值域。 */
export const SUPPORTED_TYPES: readonly string[] = [
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
];

/**
 * `format` 在 draft-07 里**只是注解**，规范不要求校验器断言它。Python 侧的
 * `jsonschema.Draft7Validator` 默认也不查 format，所以今天 `format` 从未拦下过任何东西。
 * 本实现**按断言处理**——目标态要的是「取值」而不是「形状」，日期写错应该当场看见。
 * 这是个刻意的加强，记在报告里。
 */
export const SUPPORTED_FORMATS: readonly string[] = ['date', 'date-time'];

export type SchemaPath = readonly (string | number)[];

/** 一条 schema 级问题。`path` 指向出问题的**数据**位置，不是 schema 内部位置。 */
export interface SchemaProblem {
  path: SchemaPath;
  keyword: string;
  message: string;
}

/** JSON Pointer 风格的路径展示：`/nodes/0/id`，根是空串。 */
export function pointerOf(path: SchemaPath): string {
  if (path.length === 0) return '';
  return '/' + path.map((segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ANNOTATION_SET = new Set(ANNOTATION_KEYWORDS);
const ASSERTION_SET = new Set(ASSERTION_KEYWORDS);
const UNSUPPORTED_SET = new Set(UNSUPPORTED_KEYWORDS);
const SUPPORTED_TYPE_SET = new Set(SUPPORTED_TYPES);
const SUPPORTED_FORMAT_SET = new Set(SUPPORTED_FORMATS);

/* ── 值判定的小工具 ───────────────────────────────────────────────────── */

/**
 * JSON 值的深比较，给 `enum` / `const` 用。
 * 不用 `JSON.stringify` 比字符串：那对**键序**敏感，`{a:1,b:2}` 与 `{b:2,a:1}` 会判成不等，
 * 而 JSON Schema 要求它们相等（对象无序）。NaN 在这里恒不相等，JSON 里也不存在 NaN。
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * JSON Schema 的 `minLength` / `maxLength` 数的是 **Unicode 码点**，而 JS 的 `.length` 数的是
 * UTF-16 码元——一个 emoji 在 schema 眼里是 1、在 `.length` 里是 2。差一个字符就少拦一条，
 * 所以显式按码点数。
 */
function codePointLength(text: string): number {
  return Array.from(text).length;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    // JSON 里没有 Infinity / NaN；YAML 里有（`.inf` / `.nan`），它们不是合法 number。
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

/* ── format：只做 date 与 date-time，且要求是真实存在的日期 ─────────────── */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// RFC 3339：日期 + T（也认小写 t 与空格）+ 时间 + 可选小数秒 + 时区（Z 或 ±hh:mm）
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isRealDateParts(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

/**
 * `date` / `date-time` 的断言。比正则严一层：`2026-02-30` 形状合法但不是真实日期，
 * 只查正则会让它过。
 */
function checkFormat(value: string, format: string): string | null {
  if (format === 'date') {
    const match = DATE_RE.exec(value);
    if (!match) return '不是 YYYY-MM-DD 形状的日期';
    if (!isRealDateParts(Number(match[1]), Number(match[2]), Number(match[3]))) return `${value} 不是真实存在的日期`;
    return null;
  }
  const match = DATE_TIME_RE.exec(value);
  if (!match) return '不是 RFC 3339 形状的 date-time（例：2026-09-24T21:05:00+08:00）';
  if (!isRealDateParts(Number(match[1]), Number(match[2]), Number(match[3]))) return `${value} 的日期部分不存在`;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 60) return `${value} 的时刻越界`; // 60 是闰秒
  return null;
}

/* ── 主入口 ───────────────────────────────────────────────────────────── */

/**
 * 按 schema 校验一个已经解析好的值。返回**逐条**问题，空数组表示通过。
 *
 * 不抛异常：schema 本身写错（用了不支持的关键字、`type` 写了不存在的名字）也只产出一条问题。
 * 调用方拿到非空数组就该拦下数据——里面既有数据的问题，也有 schema 的问题，两者都必须看见。
 */
export function validateAgainstSchema(value: unknown, schema: unknown, path: SchemaPath = []): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  collectSchemaProblems(value, schema, path, problems);
  return problems;
}

function collectSchemaProblems(value: unknown, schema: unknown, path: SchemaPath, problems: SchemaProblem[]): void {
  if (!isPlainObject(schema)) {
    problems.push({
      path,
      keyword: 'schema',
      message: 'schema 不是对象：本子集不支持布尔 schema（true / false）',
    });
    return;
  }

  collectUnknownKeywords(schema, path, problems);

  // const / enum 与 type 无关，先查——它们的失败信息最直接。
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !deepEqual(value, schema.const)) {
    problems.push({
      path,
      keyword: 'const',
      message: `必须等于 ${JSON.stringify(schema.const)}，实际是 ${JSON.stringify(value)}`,
    });
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'enum')) {
    const allowed = schema.enum;
    if (!Array.isArray(allowed)) {
      problems.push({ path, keyword: 'enum', message: 'enum 必须是数组' });
    } else if (!allowed.some((candidate) => deepEqual(candidate, value))) {
      problems.push({
        path,
        keyword: 'enum',
        message: `不在允许值 ${JSON.stringify(allowed)} 中（实际 ${JSON.stringify(value)}）`,
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'type')) {
    const declared = schema.type;
    const names = Array.isArray(declared) ? declared : [declared];
    if (!names.every((name): name is string => typeof name === 'string')) {
      problems.push({ path, keyword: 'type', message: 'type 必须是字符串或字符串数组' });
    } else {
      const unknown = names.filter((name) => !SUPPORTED_TYPE_SET.has(name));
      if (unknown.length) {
        problems.push({
          path,
          keyword: 'type',
          message: `type 里出现本子集不认识的类型名 ${JSON.stringify(unknown)}（认得的是 ${JSON.stringify(SUPPORTED_TYPES)}）`,
        });
      }
      if (unknown.length === 0 && !names.some((name) => matchesType(value, name))) {
        problems.push({
          path,
          keyword: 'type',
          message: `类型应为 ${JSON.stringify(names)}，实际是 ${describeType(value)}`,
        });
        // 类型都不对，再往下查 minLength 之类只会产出一串噪声。
        return;
      }
    }
  }

  if (typeof value === 'string') collectStringProblems(value, schema, path, problems);
  if (typeof value === 'number') collectNumberProblems(value, schema, path, problems);
  if (isPlainObject(value)) collectObjectProblems(value, schema, path, problems);
  if (Array.isArray(value)) collectArrayProblems(value, schema, path, problems);
}

function collectUnknownKeywords(schema: JsonObject, path: SchemaPath, problems: SchemaProblem[]): void {
  for (const keyword of Object.keys(schema)) {
    if (ANNOTATION_SET.has(keyword) || ASSERTION_SET.has(keyword)) continue;
    problems.push({
      path,
      keyword,
      message: UNSUPPORTED_SET.has(keyword)
        ? `schema 用了本子集不实现的关键字 ${keyword}：不会假装支持（见 lib/core/schema.ts 的枚举表与替代方案）`
        : `schema 里有不认识的关键字 ${keyword}：本子集只认 ${JSON.stringify([...ANNOTATION_KEYWORDS, ...ASSERTION_KEYWORDS])}`,
    });
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

function collectStringProblems(value: string, schema: JsonObject, path: SchemaPath, problems: SchemaProblem[]): void {
  const length = codePointLength(value);
  if (typeof schema.minLength === 'number' && length < schema.minLength) {
    problems.push({ path, keyword: 'minLength', message: `至少 ${schema.minLength} 个字符，实际 ${length} 个` });
  }
  if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
    problems.push({ path, keyword: 'maxLength', message: `最多 ${schema.maxLength} 个字符，实际 ${length} 个` });
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'pattern')) {
    if (typeof schema.pattern !== 'string') {
      problems.push({ path, keyword: 'pattern', message: 'pattern 必须是字符串' });
    } else {
      let matched = true;
      try {
        // ECMA 262 与 Python `re` 在这些 ASCII 字符类上等价；用 search 语义（不加锚）与
        // Python 的 `re.search` 一致。
        matched = new RegExp(schema.pattern).test(value);
      } catch {
        problems.push({ path, keyword: 'pattern', message: `pattern ${schema.pattern} 不是合法正则` });
      }
      if (matched === false) {
        problems.push({ path, keyword: 'pattern', message: `不匹配要求的格式 ${schema.pattern}` });
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'format')) {
    if (typeof schema.format !== 'string' || !SUPPORTED_FORMAT_SET.has(schema.format)) {
      problems.push({
        path,
        keyword: 'format',
        message: `format ${JSON.stringify(schema.format)} 不在本子集里（只实现 ${JSON.stringify(SUPPORTED_FORMATS)}）`,
      });
    } else {
      const complaint = checkFormat(value, schema.format);
      if (complaint) problems.push({ path, keyword: 'format', message: complaint });
    }
  }
}

function collectNumberProblems(value: number, schema: JsonObject, path: SchemaPath, problems: SchemaProblem[]): void {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    problems.push({ path, keyword: 'minimum', message: `不能小于 ${schema.minimum}，实际 ${value}` });
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    problems.push({ path, keyword: 'maximum', message: `不能大于 ${schema.maximum}，实际 ${value}` });
  }
}

function collectObjectProblems(value: JsonObject, schema: JsonObject, path: SchemaPath, problems: SchemaProblem[]): void {
  if (Object.prototype.hasOwnProperty.call(schema, 'required')) {
    if (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === 'string')) {
      problems.push({ path, keyword: 'required', message: 'required 必须是字符串数组' });
    } else {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          problems.push({ path: [...path, key], keyword: 'required', message: `缺少必填字段 ${key}` });
        }
      }
    }
  }

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [key, child] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collectSchemaProblems(value[key], child, [...path, key], problems);
    }
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'additionalProperties')) {
    const extra = schema.additionalProperties;
    const declared = new Set(Object.keys(properties));
    const outside = Object.keys(value).filter((key) => !declared.has(key));
    if (extra === false) {
      if (outside.length) {
        problems.push({
          path,
          keyword: 'additionalProperties',
          message: `不允许额外字段 ${JSON.stringify(outside.sort())}`,
        });
      }
    } else if (isPlainObject(extra)) {
      for (const key of outside) collectSchemaProblems(value[key], extra, [...path, key], problems);
    } else if (extra !== true) {
      problems.push({ path, keyword: 'additionalProperties', message: 'additionalProperties 只能是布尔值或对象 schema' });
    }
  }
}

function collectArrayProblems(value: readonly unknown[], schema: JsonObject, path: SchemaPath, problems: SchemaProblem[]): void {
  if (Object.prototype.hasOwnProperty.call(schema, 'items')) {
    if (Array.isArray(schema.items)) {
      problems.push({
        path,
        keyword: 'items',
        message: 'items 写成数组（元组形式）不在本子集里：改用单个 schema，或把逐位不同的约束写进领域校验器',
      });
    } else {
      value.forEach((item, index) => collectSchemaProblems(item, schema.items, [...path, index], problems));
    }
  }
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    problems.push({ path, keyword: 'minItems', message: `至少 ${schema.minItems} 项，实际 ${value.length} 项` });
  }
}
