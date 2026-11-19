/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 监听域（#74）——「工作区里哪一片变了」的词表

   推送出去的是**变更通知**，不是整份数据（ticket 明文）。通知里必须带一句
   「变的是哪一片」，页面才可能只重取自己关心的那一片。这片就是 domain。

   词表按**阅读端 payload 的读法**切，不按文件后缀切：
   `lessons/0001-x.quiz.json` 是题库（payload 里进 node.pool），不是课件；
   `progress.yaml` 与 `curriculum.yaml` 同属科目但进的是两个不同的键。
   这样页面拿到 domains 就能说人话（「题库变了」），而不是「有个 .json 变了」。

   这是**纯函数**、不含 IO、不认识 ctx：单元测试直接喂一串路径断言就完事。
   认不出来的路径一律落 `workspace`——保守方向：宁可让页面整份重取一次，
   也不要漏报（漏报就是「页面停在旧内容上」，那是这张 ticket 要消灭的东西）。

   记忆文件名取自纯函数域的 `lib/core/memory.ts`（#190）：监听域只管「哪一片变了」，
   一个字节的内容都不带，所以它没有投影可做——它认的文件名必须与记忆模块同一个，
   否则页面收不到「记忆变了」，那份只含画像三节的载荷就永远停在旧内容上。
   两份记忆**同名不同位置**（#191）：`.learning/MEMORY.yaml` 是共享记忆那一域 `memory`，
   科目目录下那份是 `subject-memory`——认得出它，但不把它并进注入源那一片。
   ───────────────────────────────────────────────────────────────────────── */

import { MEMORY_FILE } from '../core/memory.ts';

/** 通知里 `domains` 的词表（稳定契约：阅读端、单测、真 DSH 探针都按它断言）。 */
export const WATCH_DOMAINS = [
  // 认不出来的路径、工作区根本身
  'workspace',
  // .learning/ 这一层（.learning 目录本身变了）
  'learning',
  // .learning/MEMORY.yaml —— 共享记忆（文件名与 `lib/core/memory.ts` 同一份词表）：
  // 这一片变了，页面重取载荷；载荷里只有画像三节（#190），`积累` 不进任何注入。
  'memory',
  // .learning/subjects/ 的**直接子项**变了：新建/删除/改名一个科目
  'subjects',
  // 单个科目内部
  'subject',
  // <科目>/MEMORY.yaml —— 科目记忆（只装「积累」，永不进任何上下文）。**自成一域**：
  // payload 里没有它对应的一片，也**不许**并进 `memory`（那一域的名分是「注入源变了」，
  // 而科目记忆的取值范围里根本没有画像三节）。它认的文件名与记忆模块同一份词表。
  'subject-memory',
  'curriculum',
  'progress',
  'lesson',
  'pool',
  'attempts',
  // <科目>/annotations/ —— 课件页标注（ADR-0021，与 attempts 同族）：页面收到它就重取
  // 那份 payload 里的 `node.annotations`；与 attempts 一样自成一域，不并进 lesson。
  'annotations',
  'records',
  'reference',
  'lab',
  'misconceptions',
  'mission',
  'glossary',
  'resources',
] as const;

export type WatchDomain = (typeof WATCH_DOMAINS)[number];

/** 学习工作区里科目的相对位置：`.learning/subjects/`。 */
const SUBJECTS_PREFIX = ['.learning', 'subjects'];

/** 路径切成段：两种分隔符都认（Windows 上 fs.watch 给的是反斜杠）。 */
function segments(relative: string): string[] {
  return String(relative ?? '').split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
}

/** 科目目录里「一级子目录 → domain」的对照表。 */
const SUBDIRECTORIES: Record<string, WatchDomain> = {
  lessons: 'lesson',
  attempts: 'attempts',
  // 课件页标注（ADR-0021）：与 attempts 同族、同一个 payload 消费点，所以同样自成一域
  annotations: 'annotations',
  'learning-records': 'records',
  reference: 'reference',
  lab: 'lab',
};

/** 科目目录里「根下文件 → domain」的对照表。 */
const SUBJECT_FILES: Record<string, WatchDomain> = {
  'curriculum.yaml': 'curriculum',
  'progress.yaml': 'progress',
  'subject.yaml': 'subject',
  'misconceptions.yaml': 'misconceptions',
  'MISSION.md': 'mission',
  'GLOSSARY.md': 'glossary',
  'RESOURCES.md': 'resources',
  // #191 科目记忆：与共享记忆**同名、不同位置**（科目目录下），所以文件名取自记忆模块
  // 那一份词表而不是手抄。域自成一片（见 `WATCH_DOMAINS` 里那段）：认出它、但不把它当
  // 注入源——它一个字节的内容都不会进任何上下文。
  [MEMORY_FILE]: 'subject-memory',
};

/**
 * 一条工作区内的相对路径（文件**或目录**）→ 它属于哪一片。
 *
 * 目录也要能映射：宿主的 `ctx.fs.watch` 只给「这个目录里有什么变了」，不给文件名
 * （`dsh-plugin-api.md` §7.1 的未核实项已核实：回调只有 error 位置）。
 * 所以 `…/demo/lessons` 与 `…/demo/lessons/0001-var.md` 必须都判成 `lesson`。
 */
export function domainsOfPath(relative: string): WatchDomain[] {
  const parts = segments(relative);
  if (parts.length === 0) return ['workspace'];
  if (parts[0] !== '.learning') return ['workspace'];

  const rest = parts.slice(1);
  if (rest.length === 0) return ['learning'];
  if (rest[0] === MEMORY_FILE) return ['memory'];
  if (rest[0] !== 'subjects') return ['workspace'];

  const inner = rest.slice(1);
  // `.learning/subjects` 本身，或一个科目目录（新建/删除科目）——都算 `subjects`
  if (inner.length <= 1) return ['subjects'];

  const within = inner.slice(1);
  const head = within[0];
  const base = within[within.length - 1];

  if (within.length === 1) {
    // 路径停在科目根下的一级名上，两种可能：
    //   · 它是个文件（progress.yaml / MISSION.md …）→ 查表；
    //   · 它是个目录（`…/demo/lessons` 自己变了）——没有文件名可分课件与题库，
    //     按课件报：题库与正文同目录，页面本来就会整份重取，域只是给人看的提示。
    if (SUBDIRECTORIES[head] !== undefined) return [SUBDIRECTORIES[head]];
    return [SUBJECT_FILES[head] ?? 'subject'];
  }
  const directory = SUBDIRECTORIES[head];
  if (directory === undefined) return ['subject'];
  // 题库与课件同在 lessons/ 下，靠文件名分：正文进 payload 的 lesson_md，题库进 pool
  if (head === 'lessons' && base.endsWith('.quiz.json')) return ['pool'];
  return [directory];
}

/** 一批路径 → 升序、去重后的 domain 列表（通知里就是这个形状）。 */
export function mergeDomains(paths: readonly string[]): WatchDomain[] {
  const found = new Set<WatchDomain>();
  for (const path of paths) for (const domain of domainsOfPath(path)) found.add(domain);
  if (found.size === 0) found.add('workspace');
  return [...found].sort();
}
