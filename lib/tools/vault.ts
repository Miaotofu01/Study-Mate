/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 域数据的**唯一读法**

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
  load(domain: Domain, target?: string): unknown;
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

  /** 域的读法总入口：`target` 的含义见文件头。 */
  const load = (domain: Domain, target?: string): unknown => {
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

/** 图片库目录里的图片清单（名字 + 字节数）；目录不在就是空清单，不抛。 */
function listPoolFiles(dir: string): { name: string; bytes: number }[] {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, bytes: fs.statSync(path.join(dir, entry.name)).size }))
    .sort((a, b) => cmpCodePoints(a.name, b.name));
}

/** 一个科目的图片库整幅视图：索引原文、图片清单、以及「索引写错地方」的旁证。 */
export interface AssetsView {
  dir: string;
  poolDir: string;
  index: FileView;
  misplacedIndex: boolean;
  files: { name: string; bytes: number }[];
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
