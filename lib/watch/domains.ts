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
   ───────────────────────────────────────────────────────────────────────── */

/** 通知里 `domains` 的词表（稳定契约：阅读端、单测、真 DSH 探针都按它断言）。 */
export const WATCH_DOMAINS = [
  // 认不出来的路径、工作区根本身
  'workspace',
  // .learning/ 这一层（.learning 目录本身变了）
  'learning',
  // .learning/MEMORY.md —— 共享记忆
  'memory',
  // .learning/subjects/ 的**直接子项**变了：新建/删除/改名一个科目
  'subjects',
  // 单个科目内部
  'subject',
  'curriculum',
  'progress',
  'lesson',
  'pool',
  'attempts',
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
  if (rest[0] === 'MEMORY.md') return ['memory'];
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
