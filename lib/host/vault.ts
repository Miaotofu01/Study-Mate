/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 域 host —— 域数据的**唯一读法**

   这一层回答「域 X 里有什么」，`access.ts` 回答「你能不能读域 X」。两者合起来才是边界：
   工具的读盘入口只有 `access.read(domain, target?)`，而数据在这里——`lib/**` 与 `fs` 只被
   这一个文件碰，工具拿不到直连（issue #68 验收第 2 条要的是「真的拿不到」，不是「约好不拿」）。

   读法有两条，同一个 `read(domain, target?)` 按 `target` 分：

     · **没给 target** —— 这个域的**整体视图**。工作区里每个科目的那一份折在一起，
       主要是给 `studymate_workspace_context` 用（它要一次拿到全部科目的现状）。
     · **给了 target** —— 这个域里的**一份具体东西**（文件路径，或以 `/` 结尾的目录路径）。
       给校验器与改写工具用（它们指着盘上的某个文件干活）。

   视图是**逐域投影**的，不是把 `readLibrary()` 那份 payload 直接递出去：payload 里
   `nodes[].pool` 与 `nodes[].lesson_md` 是别的域的东西，`subjects` 的切片必须把它们摘掉——
   否则「声明了 subjects」的工具顺着节点就能读到题库，guard 就成了摆设。

   没工作区时 `workspace` 域照实说 `ready:false`（`workspace.context` 要把它变成一个可读的
   摘要，不是一个异常），其余域一律抛一句能照着做的消息。
   ───────────────────────────────────────────────────────────────────────── */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readLibrary } from '../library.ts';
import { configFile, resolveWorkspace } from '../workspace.ts';
import { parseYaml, YamlParseError } from '../yaml.ts';
import { cmpCodePoints } from '../core/format.ts';
import { readAttempts, attemptsVersion } from '../attempts.ts';
import type { Domain } from './domains.ts';

type LibraryPayload = ReturnType<typeof readLibrary>;
type SubjectPayload = LibraryPayload['subjects'][number];
type SubjectNode = SubjectPayload['nodes'][number];

/* ── 工作区事实 ─────────────────────────────────────────────────────────── */

export interface WorkspaceFacts {
  path: string;
  configFile: string;
  /** 配置里有 workspace、且 `<workspace>/.learning/subjects/` 真是目录。 */
  ready: boolean;
  /** 本地日期 `YYYY-MM-DD`。**不走 `readLibrary()` 的 today**：那个字段取的是科目
   *  `updated_at` 的字典序最大值的日期，是数据派生的，不是日历。总控要的是今天。 */
  today: string;
  timeZone: string;
  subjectsDir: string;
}

function localToday(now = new Date()): { today: string; timeZone: string } {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  // en-CA 的短日期就是 YYYY-MM-DD，省掉自己补零
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return { today, timeZone };
}

/* ── 按文件读的公用形状 ─────────────────────────────────────────────────── */

export interface FileView {
  file: string;
  present: boolean;
  text: string;
  bytes: number;
}

export interface YamlView extends FileView {
  /** 解析出来的值；解不开时是 null，原因在 `error`。 */
  value: unknown;
  error: { message: string; line: number } | null;
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readFileView(file: string): FileView {
  try {
    const raw = fs.readFileSync(file);
    return { file, present: true, text: raw.toString('utf8'), bytes: raw.byteLength };
  } catch (error) {
    // ENOENT / EISDIR 是「没有这份东西」，交给调用方决定怎么报；别的（EACCES 之类）是真故障
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') {
      return { file, present: false, text: '', bytes: 0 };
    }
    throw new Error(`读不了 ${file}：${(error as Error).message}`);
  }
}

/**
 * 读一份 YAML：**解析失败不抛**，变成 `error` 字段。
 * 校验工具要的是「逐条问题」，让解析异常穿透 guard 会把一条本该带行号的报告变成一句崩溃。
 */
function readYamlView(file: string): YamlView {
  const view = readFileView(file);
  if (!view.present) return { ...view, value: null, error: null };
  try {
    return { ...view, value: parseYaml(view.text, { file }), error: null };
  } catch (error) {
    if (error instanceof YamlParseError) {
      return { ...view, value: null, error: { message: error.message, line: error.line } };
    }
    throw error;
  }
}

/* ── 交接暂存区的盘上快照 ───────────────────────────────────────────────── */

export interface StageEntryView {
  path: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  sha256?: string;
  target?: string;
}

export interface StageView {
  stage: string;
  present: boolean;
  entries: StageEntryView[];
  manifest: FileView;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** `deliver/` 与 `handoff.json` 的盘上快照——形状与 `lib/core/validate.ts` 的 `StageEntry` 对齐。 */
function stageSnapshot(stage: string): StageView {
  const entries: StageEntryView[] = [];
  const walk = (directory: string, prefix = ''): void => {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => cmpCodePoints(a.name, b.name))) {
      const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const full = path.join(directory, dirent.name);
      if (dirent.isSymbolicLink()) {
        entries.push({ path: relative, kind: 'symlink', target: fs.readlinkSync(full) });
      } else if (dirent.isDirectory()) {
        entries.push({ path: relative, kind: 'dir' });
        walk(full, relative);
      } else if (dirent.isFile()) {
        entries.push({ path: relative, kind: 'file', sha256: sha256(full) });
      } else {
        entries.push({ path: relative, kind: 'other' });
      }
    }
  };
  const present = isDirectory(stage);
  if (present) walk(stage);
  return { stage, present, entries, manifest: readFileView(path.join(stage, 'handoff.json')) };
}

/* ── 逐域投影 ───────────────────────────────────────────────────────────── */

/** 节点元信息：**没有** `lesson_md`（lessons 域）与 `pool`（pool 域）。 */
function nodeFacts(node: SubjectNode): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    kind: node.kind,
    number: node.number,
    level: node.level,
    tier: node.tier,
    raw_status: node.raw_status,
    lesson: node.lesson,
    prerequisites: node.prerequisites,
    objective: node.objective,
    problem: node.problem,
    practice: node.practice,
    lab: node.lab === null ? null : { dir: node.lab.dir, files: node.lab.files },
  };
}

/** 科目档案：`subject.yaml` / `MISSION.md` / `RESOURCES.md` / `GLOSSARY.md` + 节点元信息。 */
function subjectFacts(subject: SubjectPayload): Record<string, unknown> {
  return {
    slug: subject.slug,
    name: subject.name,
    goal: subject.goal,
    status: subject.status,
    created_at: subject.created_at,
    updated_at: subject.updated_at,
    project: subject.project,
    levels: subject.levels,
    stats: subject.stats,
    continue_node: subject.continue_node,
    mission: subject.mission,
    glossary: subject.glossary,
    resources_md: subject.resources_md,
    nodes: subject.nodes.map(nodeFacts),
  };
}

const SUBJECT_DIR = 'subjects';

/* ── 域的读法 ───────────────────────────────────────────────────────────── */

export interface Vault {
  /** 工作区事实：**永不抛**（没工作区就是 `ready:false`）。 */
  facts(): WorkspaceFacts;
  /** 域的装载器，交给 `createAccess`。 */
  load(domain: Domain, target?: string, options?: unknown): unknown;
}

/** 工作区里一个路径是什么：校验器与改写工具靠它展开目录、定位科目目录。 */
export interface PathFacts {
  path: string;
  /** `stat` 语义（跟着符号链接走）：符号链接指向文件时这里是 `file`。 */
  kind: 'file' | 'dir' | 'missing';
  /**
   * `lstat` 语义：路径**占了位**就算 true——断链的符号链接不是 file 也不是 dir，
   * 但它挡着一个目标名（`renumber_lessons` 的「目标名已存在」要按这个判）。
   */
  lexists: boolean;
  /** 离它最近的、含 `curriculum.yaml` 的上级目录；找不到是 null。 */
  subjectDir: string | null;
  /** `kind: dir` 时的下一层名字（按码位排）；不是目录就是空数组。 */
  entries: string[];
}

function lexists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function pathFacts(target: string): PathFacts {
  const kind = isFile(target) ? 'file' : (isDirectory(target) ? 'dir' : 'missing');
  let subjectDir: string | null = null;
  let directory = kind === 'dir' ? target : path.dirname(target);
  for (let depth = 0; depth < 4; depth += 1) {
    if (isFile(path.join(directory, 'curriculum.yaml'))) {
      subjectDir = directory;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const entries = kind === 'dir'
    ? fs.readdirSync(target, { withFileTypes: true }).map((entry) => entry.name).sort(cmpCodePoints)
    : [];
  return { path: target, kind, lexists: kind !== 'missing' || lexists(target), subjectDir, entries };
}

/* ── #77 的两个域：实验目录与作答数据 ────────────────────────────────────
   这两个读法的共同点是「一个 slug 加一个节点」才定位得到东西，所以 `target` 之外还要一个
   `options`。

   **这里没有路径包含判据，也没有 realpath**——不是漏了，是这条路根本不由用户拼路径：
     · 科目目录 = `<工作区>/.learning/subjects/<slug>`，而 slug 先验过「非空、不带 `/` 与 `\`、
       不含 `..`」，再要求盘上真有这个目录（`requireSubjectDir`）；
     · 实验目录名 = `readdirSync(<科目>/lab)` 列出来的**真实目录名**里挑一个，不是 `options`
       里的字符串（`labRead`）。
   两条都只吃盘上已有的名字，所以 `..` 没有入口。工具域那侧真正需要判包含的是
   `lib/lab/sandbox.ts`（命令的 cwd、可写路径、参数里的路径），那里的判据只有一份，在
   `lib/paths.ts`。 */

/** `options` 里的一个字符串字段；不是字符串就当没给。 */
function optionString(options: unknown, key: string): string {
  if (typeof options !== 'object' || options === null) return '';
  const value = (options as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** 科目 slug → 科目目录的绝对路径。slug 不合法/不存在就抛一句能照着改的话。 */
function requireSubjectDir(subject: string): string {
  const workspace = resolveWorkspace();
  if (workspace === '') {
    throw new Error('读不了这个域：没找到学习工作区——`~/.dsh/studymate-config.yaml` 里没有 '
      + 'workspace。先跑一次 npx @yunmiao/studymate install。');
  }
  if (subject === '' || subject.includes('/') || subject.includes('\\') || subject.includes('..')) {
    throw new Error(`科目名「${subject}」不合法：它就是 subjects/ 下那个目录名，不能为空、不能带分隔符或 ..`);
  }
  const dir = path.join(workspace, '.learning', SUBJECT_DIR, subject);
  if (!isDirectory(dir)) throw new Error(`没有这个科目：${dir} 不是一个目录`);
  return dir;
}

/**
 * 给科目 slug、给科目目录、给它的 `lessons/` 目录，都给回 `lessons/` 目录
 * （课件与题库都在这一层）。定位不到返回 null——**不猜**，猜错就是把别的科目的题库读出来。
 */
function lessonDirOf(target: string): string | null {
  if (isDirectory(target) && isDirectory(path.join(target, 'lessons'))) return path.join(target, 'lessons');
  if (isDirectory(target)) return target;
  const dir = requireSubjectDir(target);
  if (isDirectory(path.join(dir, 'lessons'))) return path.join(dir, 'lessons');
  return isDirectory(dir) ? dir : null;
}

/** 课件编号：`lessons/` 里 `<NNNN>-<节点id>.md` 前缀的那四位数字。找不到返回 `0000`。 */
function lessonNumberOf(lessonsDir: string, node: string): string {
  let names: string[];
  try {
    names = fs.readdirSync(lessonsDir);
  } catch {
    return '0000';
  }
  const hit = names
    .filter((name) => name.endsWith('.md') && name.slice(0, -3).endsWith(`-${node}`))
    .sort(cmpCodePoints)
    .map((name) => /^(\d{4})/.exec(name)?.[1] ?? '')
    .find((value) => value !== '');
  return hit ?? '0000';
}

/** `lab` 域的一份读法：定到「这个节点的实验目录」，没有就 null（不是抛）。 */
function labRead(subjectDir: string, slug: string, options: unknown):
{ slug: string; node: string; dir: string; run: string | null; runDir: string | null; entries: string[] } | null {
  const labRoot = path.join(subjectDir, 'lab');
  const node = optionString(options, 'node');
  if (node === '') return null;
  if (!isDirectory(labRoot)) return null;
  const entries = fs.readdirSync(labRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'solutions')
    .map((entry) => entry.name)
    .sort(cmpCodePoints);
  // 节点 id → 课件编号：与 `attempts.ts`、`library.ts` 走同一条（节点 id 里没有编号，
  // 凭空造一个就会错位）。
  const number = lessonNumberOf(path.join(subjectDir, 'lessons'), node);
  if (number === '0000') return null;
  const run = entries.find((name) => name.startsWith(`${number}-`)) ?? null;
  const runDir = run === null ? null : path.join(labRoot, run);
  return { slug, node, dir: labRoot, run, runDir, entries };
}

export function createWorkspaceVault(): Vault {
  let factsCache: WorkspaceFacts | null = null;
  let libraryCache: LibraryPayload | null = null;
  let libraryError: Error | null = null;

  const facts = (): WorkspaceFacts => {
    if (factsCache) return factsCache;
    const root = resolveWorkspace();
    const subjectsDir = root === '' ? '' : path.join(root, '.learning', SUBJECT_DIR);
    factsCache = {
      path: root,
      configFile: configFile(),
      ready: root !== '' && isDirectory(subjectsDir),
      subjectsDir,
      ...localToday(),
    };
    return factsCache;
  };

  const workspaceOrThrow = (domain: Domain): string => {
    const current = facts();
    if (current.path === '') {
      throw new Error(`读不了「${domain}」域：没找到学习工作区——${current.configFile} 里没有 `
        + 'workspace。先跑一次 npx @yunmiao/studymate install。');
    }
    return current.path;
  };

  /** `readLibrary()` 的懒加载 + 缓存：一次工具调用里多个域只读一遍盘。 */
  const library = (domain: Domain): LibraryPayload => {
    const workspace = workspaceOrThrow(domain);
    if (libraryCache) return libraryCache;
    if (libraryError) throw libraryError;
    try {
      libraryCache = readLibrary({ workspace });
      return libraryCache;
    } catch (error) {
      libraryError = error instanceof Error ? error : new Error(String(error));
      throw libraryError;
    }
  };

  const subjectDirs = (): string[] => {
    const current = facts();
    if (!current.ready) return [];
    return fs.readdirSync(current.subjectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(cmpCodePoints);
  };

  /** 相对路径按工作区根解析；绝对路径照用。校验器的参数是人给的，两种都要认。 */
  const resolveTarget = (target: string): string => {
    if (path.isAbsolute(target)) return path.normalize(target);
    const workspace = facts().path;
    return workspace === '' ? path.resolve(target) : path.resolve(workspace, target);
  };

  /** 域的读法总入口：`target` 的含义见文件头，`options` 的含义见 `access.ts` 的 `DomainLoader`。 */
  const load = (domain: Domain, target?: string, options?: unknown): unknown => {
    switch (domain) {
      case 'workspace':
        // 没给 target = 工作区事实；给了 target = 「工作区里这个路径是什么」。
        // 校验器的参数是文件或目录，展开目录、定位科目目录都问这一处——
        // 别的地方不许直接碰 fs（域边界只有一个执行点）。
        if (target !== undefined) return pathFacts(resolveTarget(target));
        return facts();

      case 'memory': {
        const workspace = workspaceOrThrow(domain);
        const file = path.join(workspace, '.learning', 'MEMORY.md');
        const view = readFileView(file);
        return { file, present: view.present, markdown: view.text };
      }

      case 'subjects': {
        if (target === undefined) return library(domain).subjects.map(subjectFacts);
        // 文件支：`subject.yaml` 的原文与解析值（校验器要用），外加科目目录（比 slug 用）
        const file = resolveTarget(target);
        const view = readYamlView(file);
        const located = pathFacts(file);
        return {
          ...view,
          subjectDir: located.subjectDir ?? (located.kind === 'dir' ? file : path.dirname(file)),
        };
      }

      case 'curriculum': {
        if (target === undefined) {
          return library(domain).subjects.map((subject) => ({
            slug: subject.slug,
            nodes: subject.nodes.map((node) => ({
              id: node.id, title: node.title, kind: node.kind, number: node.number,
              level: node.level, prerequisites: node.prerequisites,
            })),
            edges: subject.edges,
            order: subject.order,
          }));
        }
        const file = resolveTarget(target);
        const view = readYamlView(file);
        const located = pathFacts(file);
        return {
          ...view,
          subjectDir: located.subjectDir ?? (located.kind === 'dir' ? file : path.dirname(file)),
        };
      }

      case 'progress': {
        if (target === undefined) {
          return library(domain).subjects.map((subject) => ({
            slug: subject.slug,
            updated_at: subject.updated_at,
            project: subject.project,
            stats: subject.stats,
            nodes: subject.nodes.map((node) => ({
              id: node.id, tier: node.tier, raw_status: node.raw_status, notes: node.notes,
            })),
          }));
        }
        const file = resolveTarget(target);
        const view = readYamlView(file);
        // 引用完整性要的另一半：同一科目的大纲节点 id（不额外声明 curriculum 就拿不到）
        const located = pathFacts(file);
        const dir = located.subjectDir ?? (located.kind === 'dir' ? file : path.dirname(file));
        const curriculumFile = path.join(dir, 'curriculum.yaml');
        const curriculum = isFile(curriculumFile) ? readYamlView(curriculumFile).value : null;
        return { ...view, subjectDir: dir, curriculum };
      }

      case 'lessons': {
        if (target === undefined) {
          return library(domain).subjects.flatMap((subject) => subject.nodes.map((node) => ({
            slug: subject.slug, node: node.id, number: node.number,
            file: node.lesson, markdown: node.lesson_md,
          })));
        }
        return readFileView(resolveTarget(target));
      }

      case 'pool': {
        if (target === undefined) {
          return library(domain).subjects.flatMap((subject) => subject.nodes.map((node) => ({
            slug: subject.slug, node: node.id, file: node.lesson.replace(/\.md$/, '.quiz.json'),
            pool: node.pool,
          })));
        }
        // #77 起多一种给法：`subject` 定位到科目目录（或它下面的 lessons/），再给 `options.node`。
        // 为什么不把「拼题库文件路径」交给调用方：文件名是 `<NNNN>-<节点id>.quiz.json`，那个
        // 编号只能从课件文件名上取（`lib/attempts.ts` 的 lessonNumberOf 是同一套）——
        // 让每个调用方各拼一次，迟早有一处拼错。
        const wantsNode = optionString(options, 'node');
        if (wantsNode !== '') {
          const dir = lessonDirOf(target);
          if (dir === null) throw new Error(`定位不到科目「${target}」的 lessons/ 目录：题库与课件都在那一层`);
          const file = path.join(dir, `${lessonNumberOf(dir, wantsNode)}-${wantsNode}.quiz.json`);
          const view = readFileView(file);
          if (!view.present) return { ...view, value: null, error: null };
          try {
            return { ...view, value: JSON.parse(view.text), error: null };
          } catch (error) {
            return { ...view, value: null, error: error instanceof Error ? error : new Error(String(error)) };
          }
        }
        const file = resolveTarget(target);
        const view = readFileView(file);
        if (!view.present) return { ...view, value: null, error: null };
        try {
          return { ...view, value: JSON.parse(view.text), error: null };
        } catch (error) {
          return { ...view, value: null, error: error instanceof Error ? error : new Error(String(error)) };
        }
      }

      case 'assets': {
        // 目录（科目目录）= 图片库的整幅视图（索引原文 + 图片清单）；
        // 文件 = 单份东西的存在性与字节数（`::: figure` 的图片存在性就走这一支）。
        // 图片是二进制，文件支**不**返回文本——校验器不需要把 500 KB 的 PNG 读成字符串。
        if (target === undefined) {
          return subjectDirs().map((slug) => assetsView(path.join(facts().subjectsDir, slug)));
        }
        const resolved = resolveTarget(target);
        if (isDirectory(resolved)) return assetsView(resolved);
        const view = readFileView(resolved);
        return { file: resolved, present: view.present, bytes: view.bytes };
      }

      case 'records': {
        if (target === undefined) {
          return library(domain).subjects.map((subject) => ({
            slug: subject.slug, records: subject.records,
          }));
        }
        return readFileView(resolveTarget(target));
      }

      case 'reference': {
        if (target === undefined) {
          return library(domain).subjects.map((subject) => ({
            slug: subject.slug,
            version: subject.reference_version,
            entries: subject.reference,
          }));
        }
        return readFileView(resolveTarget(target));
      }

      case 'resources': {
        // #125：核验域要读的就是这一份资源清单。**只认 `RESOURCES.md` 这一个文件名**——
        // 这不是「顺手能读任意文件」的入口：核验工具的定位那一步会把目录展开成
        // `<目录>/RESOURCES.md`（或 `<暂存目录>/deliver/RESOURCES.md`），交给这里的永远是这一份。
        // 放开文件名等于给一个「按路径读工作区任何文件」的读法，而这份读法只需要一份清单。
        if (target === undefined) throw new Error('「resources」域要指定资源清单文件');
        const file = resolveTarget(target);
        if (path.basename(file) !== 'RESOURCES.md') {
          throw new Error(`「resources」域只认 RESOURCES.md 这一份文件，不读 ${path.basename(file)}`
            + `（收到的是 ${file}）：要读别的文件请用对应的域。`);
        }
        const view = readFileView(file);
        return { file, present: view.present, markdown: view.text, bytes: view.bytes };
      }

      case 'misconceptions': {
        if (target === undefined) {
          return library(domain).subjects.map((subject) => ({
            slug: subject.slug,
            fromProgress: subject.misconceptions,
            library: subject.misconception_library,
          }));
        }
        return readYamlView(resolveTarget(target));
      }

      case 'lab': {
        // #77：命令的落脚点。`target` 是科目 slug，`options.node` 是节点 id——
        // 实验目录按 `<NNNN>-<短名>` 命名、编号与课件位次对齐（`lib/library.ts` 的 readLab
        // 是同一套命名），所以不给出节点就定位不到「这一课的实验目录」。
        // 返回 null 而不是抛：**「这一课没有实验材料」是正常结果**（概念课就没有），
        // 拒绝的话由工具那边说（它有更完整的一句话，见 lib/lab/tools.ts）。
        if (target === undefined) throw new Error('「lab」域要指定科目 slug：实验目录属于某个科目');
        return labRead(requireSubjectDir(target), target, options);
      }

      case 'attempts': {
        // #77：作答数据的读法。`target` 是科目 slug，`options.node` 是节点 id。
        // 与 `library.ts` 挂进 payload 的 `node.attempts` **同一份数据、同一套函数**
        // （lib/attempts.ts），不是第二份真相。
        if (target === undefined) throw new Error('「attempts」域要指定科目 slug：作答数据属于某个科目的某个节点');
        const node = optionString(options, 'node');
        if (node === '') return { present: false, version: '', questions: {} };
        const read = readAttempts({ workspace: facts().path, subject: target, node });
        return read === null
          ? { present: false, version: attemptsVersion({ workspace: facts().path, subject: target, node }), questions: {} }
          : { present: true, version: read.version, file: read.file, questions: read.data.题 };
      }

      case 'handoff':
        if (target === undefined) {
          throw new Error('「handoff」域要指定 stage 目录：它是角色暂存区，不属于工作区布局');
        }
        return stageSnapshot(resolveTarget(target));

      /* v8 ignore next 3 -- export 是只写域，access.read 在到这儿之前就抛了 */
      case 'export':
        throw new Error('「export」域是只写的，没有读法');

      default:
        throw new Error(`域「${domain as string}」还没有读法——domains.ts 加了域就要在这里补上`);
    }
  };

  return { facts, load };
}

/** 文件头取几个字节：四种位图的宽高都在前 30 字节里（`lib/core/image.ts`）。 */
const POOL_HEAD_BYTES = 64;

/** 只读文件头那几个字节——**不把整张图读进内存**（图片库单张上限 500 KB，一份库几十张）。 */
function poolHead(file: string): Uint8Array {
  try {
    const handle = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(POOL_HEAD_BYTES);
      const read = fs.readSync(handle, buffer, 0, POOL_HEAD_BYTES, 0);
      return buffer.subarray(0, read);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return new Uint8Array(0);
  }
}

/** 图片库目录里的图片清单（名字 + 字节数 + 文件头）；目录不在就是空清单，不抛。 */
function listPoolFiles(dir: string): { name: string; bytes: number; head: Uint8Array }[] {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(dir, entry.name);
      return { name: entry.name, bytes: fs.statSync(file).size, head: poolHead(file) };
    })
    .sort((a, b) => cmpCodePoints(a.name, b.name));
}

/** 一个科目的图片库整幅视图：索引原文、图片清单（含文件头）、以及「索引写错地方」的旁证。 */
export interface AssetsView {
  dir: string;
  poolDir: string;
  index: FileView;
  misplacedIndex: boolean;
  files: { name: string; bytes: number; head: Uint8Array }[];
}

function assetsView(subjectDir: string): AssetsView {
  const poolDir = path.join(subjectDir, 'assets', 'img', 'pool');
  return {
    dir: subjectDir,
    poolDir,
    index: readFileView(path.join(subjectDir, 'assets', 'img', 'pool.md')),
    misplacedIndex: isFile(path.join(poolDir, 'pool.md')),
    files: listPoolFiles(poolDir),
  };
}
