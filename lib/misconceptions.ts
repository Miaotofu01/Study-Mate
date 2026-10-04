/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 半数据层 —— 误解记录的追加（目标态规格 §5.4，单一落点）

   阅读端的问答面板每次提问都要留一条记录：`topic / source / evidence / status / at`，
   落点是**科目目录下的 `misconceptions.yaml`**（`progress.yaml` 不再重复存一份）。

   「只追加」是这份文件的既有口径（工作区里的文件头自己写着「只追加，不做整篇重写」），
   所以这里也**不整篇重写**：读出现有字节，把新记录接在末尾。这样：

     · 学生/模型自己写的文件头注释、旧字段（`node` / `importance` / `follow_up`）原样留着——
       学习档案是学生的积累，一次面板提问不该把别人的写法洗掉；
     · 版本号是**内容哈希**（不是目录清单）：写之前对不上就拒绝并重读，绝不覆盖别人的改动
       （栅栏两件武器之一，判据在 `lib/core/fence.ts`）；
     · 幂等键沿用同一套：同一个 `operationId` 重放只回放上次的回执，不写第二遍
       （面板按钮双击、网络重试都会撞上这条）。

   为什么 `evidence` 写成**双引号标量**而不是块标量：它里面有提问原文与回答摘要，可能带引号、
   冒号、换行、甚至一段代码。块标量的缩进规则会被「内容里本来就有的空行 / 行首空白」咬到
   （少缩进一列就截断），而双引号标量把换行写成 `\n`，逐字符都能还原——`evidence` 的价值
   恰恰在原文，转义写法在这里比好看更重要。
   ───────────────────────────────────────────────────────────────────────── */

import { createHash } from 'node:crypto';
import { errorBody } from './route-envelope.ts';
import type { RouteErrorEnvelope } from './route-envelope.ts';
import fs from 'node:fs';
import path from 'node:path';

import { IdempotencyLedger, checkOperationId, fingerprintOf, versionMatches, OPERATION_ID_MAX } from './core/fence.ts';
import { normalizeMisconceptions } from './core/misconceptions.ts';
import type { Misconception } from './core/misconceptions.ts';
import { parseYaml } from './yaml.ts';

/** 一条误解记录的必填字段（与 `schemas/misconceptions.schema.json` 逐字对应）。 */
export interface MisconceptionInput {
  /** 卡在哪 */
  topic?: unknown;
  /** 从哪来：问答面板 / 讲解反馈 / 实验课验收 */
  source?: unknown;
  /** 证据：提问原文、作答引用或验收结论 */
  evidence?: unknown;
  /** 处置到哪一步；不写按「未处理」 */
  status?: unknown;
  /** 时间 YYYY-MM-DD；不写按今天 */
  at?: unknown;
}

/** 拒绝写入。形状就是阅读端路由的唯一错误信封（`lib/route-envelope.ts`）：
 *  `error` 是 `{ code, message }`，不是一句字符串——面板要按码分支，也要取那句话给人看。 */
export interface MisconceptionRefusal extends RouteErrorEnvelope {
  status: number;
  /** 冲突时顺手带回去的当前版本号（客户端不必再读一次） */
  version?: string;
}

export interface MisconceptionSuccess {
  ok: true;
  /** 刚落的那一条（定型后的字段） */
  entry: Misconception;
  /** 写完之后重读的版本号（下一次写入的 expectedVersion） */
  version: string;
  /** 这次是回放还是真写盘——面板据此知道要不要重读库 */
  replayed: boolean;
}

export type MisconceptionWriteResult = MisconceptionSuccess | MisconceptionRefusal;

/**
 * 幂等回放：回执原样回放，只把「这次没写盘」标出来。
 * 单独一个类型是因为回放的是**上次那份对象**（成功或拒绝都可能），直接返回它的话
 * `replayed` 永远是 false，调用方就分不出「真写了一次」与「重放了一次」——
 * 而这正是幂等唯一要告诉调用方的事。
 */
export type MisconceptionReplay = (MisconceptionSuccess | MisconceptionRefusal) & { replayed: true };

/** 幂等台账：与 `reference/` 的同一套判据，实例是本模块自己的（键的指纹不同，不能共用一份）。 */
const LEDGER = new IdempotencyLedger<MisconceptionWriteResult | MisconceptionReplay>();

const TOPIC_MAX = 120;
const EVIDENCE_MAX = 2000;

/** 面板每次都写这个来源（另外两个值只有总控/讲解/验收那条路会写）。 */
export const ASK_SOURCE = '问答面板';

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readTextIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 科目目录的绝对路径。subject 里出现分隔符或 `..` 直接判不合法（与 lib/reference.ts 同一判据）。 */
function subjectDirOf(workspace: unknown, subject: unknown): string | null {
  if (typeof workspace !== 'string' || !workspace) return null;
  if (typeof subject !== 'string' || !subject || subject.includes('/') || subject.includes('\\') || subject.includes('..')) return null;
  return path.resolve(workspace, '.learning', 'subjects', subject);
}

/** 误解记录文件的绝对路径；科目名不合法时 null。 */
export function misconceptionsFile(workspace: unknown, subject: unknown): string | null {
  const dir = subjectDirOf(workspace, subject);
  return dir === null ? null : path.join(dir, 'misconceptions.yaml');
}

/**
 * 现有内容的版本号：**文件字节的哈希**。
 *
 * 为什么不用目录清单（`reference/` 那种「路径 + 大小 + mtime」）：误解记录是**一个文件**，
 * 哈希它的内容既准确又不看时钟——同一次写盘在两次读之间给出同一个版本号，测试能钉死。
 * 文件不存在时是「空内容的哈希」，**不是空串**：空串会让第一次写入没法带期望版本。
 */
export function misconceptionsVersion({ workspace, subject }: { workspace?: unknown; subject?: unknown } = {}): string {
  const file = misconceptionsFile(workspace, subject);
  const text = file === null ? null : readTextIfPresent(file);
  return createHash('sha256').update(text === null ? '' : text).digest('hex').slice(0, 16);
}

/** 读现有的全部记录（定型后的字段）；文件不在或读不动时给空数组，不抛。 */
export function readMisconceptions({ workspace, subject }: { workspace?: unknown; subject?: unknown } = {}): Misconception[] {
  const file = misconceptionsFile(workspace, subject);
  if (file === null) return [];
  const text = readTextIfPresent(file);
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { file });
  } catch {
    // 读不动就当没有：面板这一笔仍要写得进去，不能因为旧文件坏掉就整条路不通
    return [];
  }
  return normalizeMisconceptions(parsed);
}

/* ── 序列化 ────────────────────────────────────────────────────────────── */

/** 一行标量：普通中文原样写；可能被 YAML 读成别的东西、或能把结构破相的加双引号。 */
function scalar(value: string): string {
  const unsafe = value === ''
    || value !== value.trim()
    || /^[-?:,[\]{}#&*!|>'"%@`]/.test(value)
    || /: |\s#|:$/.test(value)
    || /[\s\S]*[\n\r\t\u0000-\u001f\u007f]/.test(value)
    || /["'\\]/.test(value)
    // 日期裸着写会被 PyYAML 读成 datetime，而 schema 要求字符串
    || /^\d{4}-\d{1,2}-\d{1,2}/.test(value)
    // 会被读成 null / 布尔 / 数字的词（~、yes、no、on、off、12、1.5……）
    || /^(~|null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|no|No|on|On|off|Off)$/.test(value)
    || /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value);
  if (!unsafe) return value;
  const escaped = value
    .replace(/[\\"]/g, (ch) => `\\${ch}`)
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    .replace(/[\u0000-\u001f\u007f]/g, (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

/**
 * 一条记录 → YAML 列表项。字段顺序固定（topic / source / evidence / status / at）：
 * 顺序固定，diff 才读得懂。五个字段全是标量（`evidence` 走双引号标量，换行转义成 `\n`），
 * 所以任何原文都写得进去、也读得回来，不会被缩进规则咬到。
 */
export function serializeMisconception(entry: Misconception): string {
  return [
    `- topic: ${scalar(entry.topic)}`,
    `  source: ${scalar(entry.source)}`,
    `  evidence: ${scalar(entry.evidence)}`,
    `  status: ${scalar(entry.status)}`,
    `  at: ${scalar(entry.at)}`,
  ].join('\n');
}

/* ── 写入 ──────────────────────────────────────────────────────────────── */

function refusal(status: number, error: string, message: string): MisconceptionRefusal {
  return { status, ...errorBody(error, message) };
}

/** 本地日期 `YYYY-MM-DD`（与 learning-records 的写法一致；不走 toISOString，那按 UTC 算）。 */
export function localDay(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 追加一条误解记录。
 *
 * 返回 `{ok:true, entry, version, replayed}` 或 `{ok:false, status, error:{code,message}, version?}`。
 * 400 的口子：科目不合法/不存在、topic 或 evidence 空、缺 operationId、expectedVersion 对不上。
 */
export function writeMisconception({
  workspace, subject, record, expectedVersion, operationId, now,
}: {
  workspace?: unknown; subject?: unknown; record?: MisconceptionInput;
  expectedVersion?: unknown; operationId?: unknown; now?: unknown;
} = {}): MisconceptionWriteResult {
  // 先把请求体过一遍再碰台账：坏请求不该占用一个 operationId
  const verdict = checkOperationId(operationId);
  if (!verdict.ok) {
    return refusal(400, 'operation-id-invalid', `缺少或过长的 operationId（上限 ${OPERATION_ID_MAX} 字符）：没有它没法区分重复提交与新提交`);
  }
  const opId = verdict.id;
  const subjectDir = subjectDirOf(workspace, subject);
  if (subjectDir === null) {
    return refusal(400, 'subject-invalid', '科目名不合法：不能为空，也不能带 / 、\\ 或 ..');
  }
  if (!isDirectory(subjectDir)) {
    return refusal(400, 'subject-invalid', `科目不存在：${String(subject)}`);
  }

  const raw = record && typeof record === 'object' ? record : {};
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const topic = text(raw.topic);
  if (topic === '') return refusal(400, 'topic-invalid', 'topic 不能为空：它是这条记录在界面上的名字（卡在哪）');
  if ([...topic].length > TOPIC_MAX) return refusal(400, 'topic-invalid', `topic 太长（上限 ${TOPIC_MAX} 字）`);
  const evidence = text(raw.evidence);
  if (evidence === '') {
    return refusal(400, 'evidence-invalid', 'evidence 不能为空：没有证据的误解记录，下次开场读不出任何可用的东西');
  }
  if ([...evidence].length > EVIDENCE_MAX) return refusal(400, 'evidence-invalid', `evidence 太长（上限 ${EVIDENCE_MAX} 字）`);

  const entry: Misconception = {
    topic,
    source: text(raw.source) || ASK_SOURCE,
    evidence,
    status: text(raw.status) || '未处理',
    at: text(raw.at) || localDay(now instanceof Date ? now : new Date()),
  };

  const file = path.join(subjectDir, 'misconceptions.yaml');
  const current = readTextIfPresent(file);
  const currentVersion = createHash('sha256').update(current === null ? '' : current).digest('hex').slice(0, 16);
  const fingerprint = fingerprintOf([String(subject), entry.topic, entry.evidence, entry.at]);

  // 幂等回放放在版本校验**之前**：第一次写成功之后版本号已经变了，重试带回来的
  // expectedVersion 必然是旧的，先校版本就会把一次正常的重试误判成冲突。
  const lookup = LEDGER.lookup(opId, fingerprint);
  if (lookup.kind === 'replay') return { ...lookup.response, replayed: true } as MisconceptionReplay;
  if (lookup.kind === 'conflict') {
    return { ...refusal(409, 'operation-id-conflict', '同一个 operationId 又提交了不同的内容：换个 operationId 再写（这次不写盘）'), version: currentVersion };
  }

  // expectedVersion 是**可选**的：这份文件的口径是「只追加」，追加本身不会覆盖任何人的改动。
  // 客户端给了就校一次（挡的是「以为在改旧内容」的误用），不给也照写。
  if (expectedVersion !== undefined && expectedVersion !== null && String(expectedVersion).trim() !== ''
    && !versionMatches(expectedVersion, currentVersion)) {
    return { ...refusal(409, 'version-conflict', '误解记录已经变了：版本号对不上，这次不写（请按新内容重来）'), version: currentVersion };
  }

  // 现有内容必须以列表项结尾才接得上（文件头是注释、后面全是 `- ` 项）。
  // 不合形状时**不猜**：多半是手改坏了，让人看一眼比写出一份坏 YAML 强。
  if (current !== null && current.trim() !== '') {
    const lastLine = current.trimEnd().split(/\r?\n/).pop() ?? '';
    if (!lastLine.startsWith('- ') && !/^\s+\S/.test(lastLine)) {
      return { ...refusal(409, 'file-shape-unknown', `${path.basename(file)} 的末尾不是一条列表项，接不上去：请先看一眼这份文件（这次不写盘）`), version: currentVersion };
    }
  }

  const head = current === null || current === '' ? '' : (current.endsWith('\n') ? current : `${current}\n`);
  const content = `${head}${serializeMisconception(entry)}\n`;
  try {
    fs.mkdirSync(subjectDir, { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  } catch (error) {
    return refusal(500, 'write-failed', `写不了 ${path.basename(file)}：${error instanceof Error ? error.message : String(error)}`);
  }

  const nextVersion = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const response: MisconceptionWriteResult = { ok: true, entry, version: nextVersion, replayed: false };
  LEDGER.remember(opId, fingerprint, response);
  return response;
}
