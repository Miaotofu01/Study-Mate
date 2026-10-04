/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— 路径展开（校验器与改写工具共用）

   工具的参数是「路径」，而这些路径要先变成「盘上确实存在的那一份」。这一步**也走域 guard**
   （`workspace` 域：`read('workspace', target)` 回答「工作区里这个路径是什么」），
   工具自己不许直接碰 `fs`——域边界的执行点只有一个。

   为什么要有这个中间层：`renumber_lessons` 与 `validate_lesson` 都要「给科目目录或给科目
   slug 都认」这一条便利，两处各写一遍就会漂。
   ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';

import type { DomainAccess } from './access.ts';
import type { PathFacts, WorkspaceFacts } from './vault.ts';

export type { PathFacts };

/** `workspace` 域的目标读法：这个路径是什么。 */
export function pathFactsOf(access: DomainAccess, target: string): PathFacts {
  return access.read<PathFacts>('workspace', target);
}

export function joinPath(base: string, name: string): string {
  return path.join(base, name);
}

/**
 * 把参数里的路径解释成盘上的东西：先按工作区根解析，找不到再试 `.learning/subjects/<given>`
 * （总控手上既有绝对路径，也有 `numpy` / `numpy/lessons/x.md` 这种以 slug 开头的写法）。
 */
export function resolveGiven(access: DomainAccess, given: string): PathFacts {
  const direct = pathFactsOf(access, given);
  if (direct.kind !== 'missing') return direct;
  const workspace = access.read<WorkspaceFacts>('workspace');
  if (workspace.subjectsDir === '') return direct;
  const candidate = pathFactsOf(access, joinPath(workspace.subjectsDir, given));
  return candidate.kind === 'missing' ? direct : candidate;
}

/**
 * 定科目目录：给绝对 / 相对路径都认，给 slug（`numpy` 这种不带分隔符的短名）也认——
 * 总控手上两种写法都有。
 */
export function subjectDirOf(
  access: DomainAccess, given: string,
): { dir: string | null; tried: string[] } {
  const workspace = access.read<WorkspaceFacts>('workspace');
  const candidates = [given];
  if (workspace.subjectsDir !== '') candidates.push(joinPath(workspace.subjectsDir, given));
  const tried: string[] = [];
  for (const candidate of candidates) {
    tried.push(candidate);
    const facts = pathFactsOf(access, candidate);
    if (facts.kind === 'dir') return { dir: facts.path, tried };
  }
  return { dir: null, tried };
}

/**
 * 课件内容文件：给文件就是它自己；给目录就给目录下的 `*.md`——
 * 是科目目录就进它的 `lessons/`，是 `lessons/` 就用它自己。
 */
export function lessonFilesUnder(access: DomainAccess, target: string): string[] {
  const facts = resolveGiven(access, target);
  if (facts.kind === 'file') return [facts.path];
  if (facts.kind !== 'dir') return [facts.path];
  const nested = pathFactsOf(access, joinPath(facts.path, 'lessons'));
  const dir = nested.kind === 'dir' ? nested.path : facts.path;
  return pathFactsOf(access, dir).entries
    .filter((name) => name.endsWith('.md') && !name.endsWith('.quiz.json'))
    .map((name) => joinPath(dir, name));
}
