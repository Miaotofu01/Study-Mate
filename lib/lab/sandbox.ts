/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 实验域 —— 沙箱边界（cwd / 可写范围 / 参数里的路径）

   issue #77 的验收第 4 条：「越界路径与未声明的写一律拒绝」。这条文件就是那两个「拒绝」的
   执行点，判据全部是**路径包含**（`isWithin`），没有例外表、没有「看情况」。

   边界怎么定的（**lab 目录之外一律不许**）：

     · `labRoot`   = `<工作区>/.learning/subjects/<slug>/lab/`
     · `runDir`    = `labRoot/<NNNN>-<短名>/`——这一课的实验目录，命令的落脚点
     · `cwd`       = `runDir` 之内的一个目录（可以就是 `runDir`）
     · `writable`  = `runDir` 之内的一组路径，命令**声明**它会写这些
     · 参数里的路径 = 相对 `cwd` 解析；**绝对路径只许落在工作区之内**（虚拟环境常写在
       工作区里），出了工作区直接拒

   为什么用「求解完再判包含」而不是「看到 `..` 就拒」：`a/../../b` 与 `..` 是同一件事的两种
   写法，逐字符查 `..` 会漏掉 `a/../..`，也会误伤名字里真有 `..` 的文件。所以先把路径
   **规范化成绝对路径**，再判它在不在范围内——判据只有一条。

   符号链接：`realpath` 会跟到真身，所以「lab 里放一个指向 `~/.ssh` 的软链，再让命令写它」
   这条路走不通（真身不在范围内）。这一条只覆盖**已有**的东西；命令自己现造的软链不在
   覆盖范围内（见文件末尾的残留风险）。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

/* 路径包含判据只有一份，在 `lib/paths.ts`（全仓四处调用点共用）。这里转出去是为了不改
   `lib/lab/index.ts` 的对外导出面——`isWithin` 本来就是从这个文件导出的。 */
import { isWithin } from '../paths.ts';
export { isWithin };

export interface PathVerdict {
  ok: boolean;
  /** 规范化后的绝对路径（`ok` 时才有意义）。 */
  resolved: string;
  reason: string;
  /**
   * 拒的**允许范围**（一个目录的绝对路径）。带上是刻意的：一句「你越界了」要配一句
   * 「边界在哪」，否则照着改的人只能猜。工具把它原样递进拒绝回执里。
   */
  within?: string;
}

function reject(reason: string, within?: string): PathVerdict {
  return { ok: false, resolved: '', reason, ...within === undefined ? {} : { within } };
}

/** 一个已存在的路径的真身（跟软链）。不存在返回 null——**不猜**。 */
function realOf(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** 是否存在（`lstat`：断链的软链也算占了位）。 */
export function lexists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
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

/**
 * 解析 `cwd`：相对 `runDir`，必须落在 `runDir` 之内，而且必须**已经存在**且是目录。
 *
 * 「必须存在」是刻意的：`cwd` 是命令的立足点，一个不存在的立足点让 `spawn` 报 ENOENT，
 * 那句报错读起来像「命令不存在」，排查会跑偏。在这里拒掉，报的是「看不到这个目录」。
 */
export function resolveCwd(runDir: string, raw: unknown): PathVerdict {
  if (typeof raw !== 'string' || raw.trim() === '') return reject('cwd 不能是空的');
  const given = raw.trim();
  if (path.isAbsolute(given)) {
    return reject('cwd 要相对实验目录写（例如 `.` 或 `src`）：绝对路径会让命令跑到别的地方去');
  }
  const resolved = path.resolve(runDir, given);
  if (!isWithin(runDir, resolved)) {
    return reject(`cwd「${given}」解析到 ${resolved}，跑到实验目录 ${runDir} 外面去了`, runDir);
  }
  if (!isDirectory(resolved)) {
    return reject(`cwd「${given}」不是一个看得到的目录（${resolved}）`, runDir);
  }
  // 真身也要在范围内：lab 里放一个指向外面的软链当 cwd，等于把命令放到外面跑
  const real = realOf(resolved);
  if (real === null || !isWithin(runDir, real)) {
    return reject(`cwd「${given}」的真身（${real ?? '解不开'}）在实验目录之外：软链指出去也不行`, runDir);
  }
  return { ok: true, resolved, reason: '' };
}

/**
 * 解析一条「声明会写」的路径：相对 `runDir`，必须落在 `runDir` 之内。
 *
 * 允许它**还不存在**（测试会新建文件、会写缓存），所以这里不要求存在；但只要它已经存在，
 * 真身就必须在范围内（软链指出去 → 拒）。
 */
export function resolveWritable(runDir: string, raw: unknown): PathVerdict {
  if (typeof raw !== 'string' || raw.trim() === '') return reject('可写路径不能是空串');
  const given = raw.trim();
  if (path.isAbsolute(given)) {
    return reject(`可写路径「${given}」是绝对路径：声明要相对实验目录写（例如 result.txt）`);
  }
  const resolved = path.resolve(runDir, given);
  if (!isWithin(runDir, resolved)) {
    return reject(`可写路径「${given}」解析到 ${resolved}，跑到实验目录 ${runDir} 外面去了`, runDir);
  }
  if (lexists(resolved)) {
    const real = realOf(resolved);
    if (real === null || !isWithin(runDir, real)) {
      return reject(`可写路径「${given}」的真身（${real ?? '解不开'}）在实验目录之外：软链指出去也不行`, runDir);
    }
  }
  return { ok: true, resolved, reason: '' };
}

/**
 * 解析命令里一个**带路径形态**的参数。相对路径按 `cwd` 解析（那就是子进程的落脚点），
 * 绝对路径照用，但归一化之后必须落在**工作区**之内。
 *
 * 为什么绝对路径的边界是工作区而不是 lab 目录：虚拟环境、构建产物常常写在科目或工作区里
 * （`<工作区>/.venv/bin/python`），把它们一刀切掉会让正常命令跑不了；而工作区之外
 * （`/etc`、`~/.ssh`、`/tmp` 里别人的文件）一条都不该被这条命令碰到。临时目录由我们自己
 * 指到本次运行专用的目录里（见 `runner.ts` 的 TMPDIR）。
 */
export function resolveArgumentPath(workspace: string, cwd: string, token: string): PathVerdict {
  const resolved = path.isAbsolute(token) ? path.normalize(token) : path.resolve(cwd, token);
  if (!isWithin(workspace, resolved)) {
    return reject(`命令参数里的路径「${token}」解析到 ${resolved}，出了工作区 ${workspace}——`
      + '这条命令不该碰到工作区外面的东西', workspace);
  }
  return { ok: true, resolved, reason: '' };
}

/* ── 残留风险（写在代码里，免得只有报告知道）────────────────────────────

   这一层**不是**操作系统级沙箱，命令仍然以本进程的身份跑，能力与本进程相同。能挡的是
   「命令的**固定部分**（cwd、参数、程序）指着外面」这一种；挡不住的是进程在运行期自己算出来
   的路径（`open(os.environ['HOME'] + '/x')` 这类）。两条缓释：

     · `HOME` / `TMPDIR` 被指到本次运行专用的临时目录（`runner.ts`），孩子的 `~` 不是学生的 `~`；
     · 跑完把**真实退出码与真实输出原样**记进作答数据——越界的痕迹留在那里面，人看得见。

   真要做强隔离得靠 OS 机制（bubblewrap / sandbox-exec / Job Object），那是另一张票的事，
   不在这张的范围里。 */
