/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— 「带位置的 JSON 读取」

   交接 manifest（`handoff.json`）是 JSON。`JSON.parse` 只给值不给位置，于是
   `check_handoff.py` 今天报的是一句「schema 校验失败：<路径>: …」，没有行号——角色拿着
   这句话得自己在文件里找。这一层补上位置，顺带补上 Python 侧有、JS 侧会丢的那条检查：
   **重复键**（`json.load(object_pairs_hook=unique_object)` 会拒，`JSON.parse` 只会静默取最后一个）。

   只扫位置、不构造值（值仍由 `JSON.parse` 给），所以不存在「两份解析器谁说了算」的问题；
   两边不一致的地方（接受范围）由测试钉住。
   ───────────────────────────────────────────────────────────────────────── */

import type { Path, Position, PositionHit } from './yamlpos.ts';

export interface JsonDuplicateKey {
  path: Path;
  key: string;
  line: number;
  column: number;
}

export interface JsonPositionIndex {
  at(path: Path): PositionHit;
  readonly duplicates: readonly JsonDuplicateKey[];
  readonly size: number;
}

export class JsonSyntaxError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`第 ${line} 行第 ${column} 列：${message}`);
    this.name = 'JsonSyntaxError';
    this.line = line;
    this.column = column;
  }
}

function pathKey(path: Path): string {
  let out = '';
  for (const segment of path) out += typeof segment === 'number' ? `#${segment}/` : `$${segment}/`;
  return out;
}

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const LITERALS = ['true', 'false', 'null'] as const;

class JsonScanner {
  private readonly text: string;
  private index = 0;
  private line = 1;
  private column = 1;
  private readonly positions = new Map<string, Position>();
  private readonly duplicates: JsonDuplicateKey[] = [];

  constructor(text: string) {
    this.text = text;
  }

  get size(): number {
    return this.positions.size;
  }

  get duplicateKeys(): readonly JsonDuplicateKey[] {
    return this.duplicates;
  }

  get indexOfPath(): Map<string, Position> {
    return this.positions;
  }

  private here(): Position {
    return { line: this.line, column: this.column };
  }

  private bump(count = 1): void {
    for (let step = 0; step < count; step++) {
      if (this.text[this.index] === '\n') {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
      this.index++;
    }
  }

  private fail(message: string): never {
    throw new JsonSyntaxError(message, this.line, this.column);
  }

  /** JSON 的空白只有这四种：空格、Tab、LF、CR。 */
  private skipWhitespace(): void {
    while (this.index < this.text.length && /[ \t\n\r]/.test(this.text[this.index])) this.bump();
  }

  private record(path: Path): void {
    const key = pathKey(path);
    if (this.positions.has(key)) return;
    this.positions.set(key, this.here());
  }

  parseDocument(): void {
    this.skipWhitespace();
    if (this.index >= this.text.length) this.fail('文件是空的：JSON 文档至少要有一个值');
    this.parseValue([]);
    this.skipWhitespace();
    if (this.index < this.text.length) this.fail(`文档结束后还有多余内容 ${JSON.stringify(this.text[this.index])}`);
  }

  private parseValue(path: Path): void {
    this.skipWhitespace();
    if (this.index >= this.text.length) this.fail('值不完整');
    const ch = this.text[this.index];
    if (ch === '{') this.parseObject(path);
    else if (ch === '[') this.parseArray(path);
    else if (ch === '"') {
      this.record(path);
      this.readString();
    } else if (/[-0-9]/.test(ch)) {
      this.record(path);
      this.readNumber();
    } else {
      const literal = LITERALS.find((word) => this.text.startsWith(word, this.index));
      if (!literal) this.fail(`不认识的值起始字符 ${JSON.stringify(ch)}`);
      this.record(path);
      this.bump(literal.length);
    }
  }

  private parseObject(path: Path): void {
    this.record(path);
    this.bump(); // {
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.bump();
      return;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.fail('对象的键必须是双引号字符串');
      const keyPosition = this.here();
      const key = this.readString();
      const childPath = [...path, key];
      if (this.positions.has(pathKey(childPath))) {
        this.duplicates.push({ path: childPath, key, line: keyPosition.line, column: keyPosition.column });
      } else {
        // 键位置取键自己（与 YAML 层的口径一致）：缺字段时回退到父对象，报的值也刚好是那一行。
        this.positions.set(pathKey(childPath), keyPosition);
      }
      this.skipWhitespace();
      if (this.text[this.index] !== ':') this.fail(`键 ${JSON.stringify(key)} 后面缺少冒号`);
      this.bump();
      this.parseValue(childPath);
      this.skipWhitespace();
      const ch = this.text[this.index];
      if (ch === ',') {
        this.bump();
        continue;
      }
      if (ch === '}') {
        this.bump();
        return;
      }
      this.fail(`对象里期待 , 或 }，实际是 ${ch === undefined ? '文件结尾' : JSON.stringify(ch)}`);
    }
  }

  private parseArray(path: Path): void {
    this.record(path);
    this.bump(); // [
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.bump();
      return;
    }
    let index = 0;
    for (;;) {
      this.parseValue([...path, index]);
      index++;
      this.skipWhitespace();
      const ch = this.text[this.index];
      if (ch === ',') {
        this.bump();
        continue;
      }
      if (ch === ']') {
        this.bump();
        return;
      }
      this.fail(`数组里期待 , 或 ]，实际是 ${ch === undefined ? '文件结尾' : JSON.stringify(ch)}`);
    }
  }

  private readString(): string {
    if (this.text[this.index] !== '"') this.fail('期待字符串');
    this.bump(); // 开引号
    let out = '';
    for (;;) {
      if (this.index >= this.text.length) this.fail('字符串没有闭合');
      const ch = this.text[this.index];
      if (ch === '"') {
        this.bump();
        return out;
      }
      if (ch === '\\') {
        this.bump();
        const escape = this.text[this.index];
        if (escape === 'u') {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('\\u 后面需要 4 位十六进制');
          out += String.fromCharCode(parseInt(hex, 16));
          this.bump(5);
          continue;
        }
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(escape in simple)) this.fail(`不认识的转义 \\${escape}`);
        out += simple[escape];
        this.bump();
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) this.fail('字符串里不能出现未转义的控制字符');
      out += ch;
      this.bump();
    }
  }

  private readNumber(): void {
    NUMBER_RE.lastIndex = this.index;
    const match = NUMBER_RE.exec(this.text);
    if (!match || match.index !== this.index) this.fail('数字格式非法');
    this.bump(match[0].length);
  }
}

export function indexJson(text: string): JsonPositionIndex {
  const scanner = new JsonScanner(String(text));
  scanner.parseDocument();
  const positions = scanner.indexOfPath;
  const duplicates = scanner.duplicateKeys;
  return {
    get size(): number {
      return positions.size;
    },
    duplicates,
    at(path: Path): PositionHit {
      for (let depth = path.length; depth >= 0; depth--) {
        const hit = positions.get(pathKey(path.slice(0, depth)));
        if (hit) return { line: hit.line, column: hit.column, exact: depth === path.length };
      }
      return { line: 1, column: 1, exact: false };
    },
  };
}
