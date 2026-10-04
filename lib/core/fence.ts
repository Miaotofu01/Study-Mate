/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 纯函数域 —— 写入栅栏的两件武器

   `reference/`（ADR-0010）与 `attempts/`（ADR-0007）都是**人机共写**的地方：阅读端与模型
   两侧随时可能同时写同一份东西。两边用的防护是同一套，规格 §4.3 与 ADR-0007 都点名了：

     · **幂等**：同一个 `operationId` 重放只回放上次的回执，不写第二遍（双击与超时重试）；
     · **版本号**：客户端写之前先报它看到的版本，对不上就拒绝并**重读**当前内容，
       绝不覆盖别人的改动（并发栅栏）。

   这两件事的判据是纯逻辑（比较、键、回执形状），所以住在纯函数域：`lib/reference.ts`
   与 `lib/attempts.ts` 各自持有一份台账实例，共用这里的判定——同一条规则只有一份实现。

   为什么台账做成**类**而不是一个模块级 Map：`reference/` 的台账键是「科目 + 标题 + 正文」，
   `attempts/` 的键是「节点 + 一次作答」，两者的**指纹算法与回执类型都不同**，共用一个
   模块级 Map 会让两份台账互相挤掉（`LEDGER_MAX` 是共享的），幂等就在最需要它的时候失效。
   台账实例各自模块级、进程内、有上限——与今天 `reference.ts` 的语义逐字一致。
   ───────────────────────────────────────────────────────────────────────── */

/** operationId 上限：它同时是内存台账的键，不设上限等于让请求方决定内存占用。 */
export const OPERATION_ID_MAX = 200;

/** 幂等台账上限：只防一次宿主生命周期内的双击与重试，记满就丢最旧的，不无界增长。 */
export const LEDGER_MAX = 200;

export type OperationIdVerdict =
  | { ok: true; id: string }
  | { ok: false; reason: 'empty' | 'too-long' };

/**
 * 归一化并检查 operationId。
 *
 * 先 `trim()` 再判长度：双击时多打一个空格算同一次提交（宿主粘贴常常带空白），
 * 而「200 个字符」这个上限是给台账的内存占用定的，不该被首尾空白挤掉一位。
 */
export function checkOperationId(raw: unknown): OperationIdVerdict {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (id === '') return { ok: false, reason: 'empty' };
  if ([...id].length > OPERATION_ID_MAX) return { ok: false, reason: 'too-long' };
  return { ok: true, id };
}

/**
 * 幂等键：把一次写入的**内容指纹**拼成一个字符串。
 *
 * 用 `\u0000` 分隔而不是 `|` 之类可打印字符：字段值本身可能含分隔符（标题里写一个竖线
 * 是常事），撞键的后果是「换了内容却回放了旧回执」——静默丢一次写入。`\u0000` 在
 * 文本字段里不合法，拼出来的键因此不会歧义。
 */
export function fingerprintOf(parts: readonly string[]): string {
  return parts.join('\u0000');
}

/** 版本号对不对得上。两边都先转字符串：文件里读出来的可能是数字（YAML 的 `updated_at`）。 */
export function versionMatches(expected: unknown, current: unknown): boolean {
  return String(expected).trim() === String(current);
}

/** 台账里记住的一次写入：指纹用来判「同一次提交」还是「换了内容」，回执原样回放。 */
export interface LedgerEntry<Response> {
  fingerprint: string;
  response: Response;
}

/** 一次查询的结论。`conflict` 时调用方负责补上当前内容与版本号（各域的形状不同）。 */
export type LedgerLookup<Response> =
  | { kind: 'replay'; response: Response }
  | { kind: 'conflict'; response: Response }
  | { kind: 'fresh'; fingerprint: string };

/**
 * 进程内的幂等台账：`operationId` → `{fingerprint, response}`，**只在内存里**。
 *
 * 只防同一个宿主进程内的双击与重试；宿主重启后台账就没了——所以 `operationId` 也该写进
 * 落盘的文件（`reference/` 的 front matter、`attempts/` 的顶层字段），留给以后做持久幂等
 * 或人工对账。记满 `max` 条就丢最旧的一条：Map 保持插入顺序，`keys().next()` 就是最旧的。
 */
export class IdempotencyLedger<Response> {
  private readonly entries = new Map<string, LedgerEntry<Response>>();
  readonly max: number;

  constructor(max: number = LEDGER_MAX) {
    this.max = max;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * 查一次提交。
   *
   * 三种结论：
   *   · 同一个 id + 同一个指纹 → `replay`：**原样回放**上次的回执，这次不写盘；
   *   · 同一个 id + 不同指纹 → `conflict`：调用方按 409 拒绝（这次也不写盘）；
   *   · 没见过这个 id        → `fresh`：调用方接着走版本校验与落盘，成功后 `remember`。
   *
   * **调用顺序不能反**：重放判定必须放在版本校验**之前**。第一次写成功之后版本号已经变了，
   * 重试带回来的 `expectedVersion` 必然是旧的——先校版本就会把一次正常的重试误判成冲突。
   */
  lookup(operationId: string, fingerprint: string): LedgerLookup<Response> {
    const remembered = this.entries.get(operationId);
    if (remembered === undefined) return { kind: 'fresh', fingerprint };
    if (remembered.fingerprint === fingerprint) return { kind: 'replay', response: remembered.response };
    return { kind: 'conflict', response: remembered.response };
  }

  /** 记下一次成功的写入；超过上限先丢最旧的一条。 */
  remember(operationId: string, fingerprint: string, response: Response): void {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(operationId, { fingerprint, response });
  }
}
