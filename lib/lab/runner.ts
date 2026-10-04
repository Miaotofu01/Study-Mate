/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 实验域 —— 跑手（真的把那条命令跑起来，只记事实）

   这个文件是整张 ticket 里唯一会 `spawn` 的地方。四条铁律，改之前先读：

     1. **不开 shell**：`spawn(argv[0], argv.slice(1), { shell: false })`。命令的文法在
        `contract.ts` 里已经被压到「程序 + 一堆裸词」，这里不再做第二次解释。
     2. **不做判定**：返回值里只有事实（退出码、时长、标准输出、标准错误、被杀没有、
        字节数、截断没有）。**没有** `通过` / `成功` / `passed` 这类字段——退出码非零
        **如实记**，它不是「失败判决」，只是「程序的退出码是 3」这个事实。
        issue #77 的验收第 3 条：通过与否不由模型判断。这里连「通过」两个字都不出现。
     3. **有上限**：超时（`TIMEOUT_MS`）到了先 SIGTERM、宽限 `KILL_GRACE_MS` 再 SIGKILL；
        两条流各留 `OUTPUT_LIMIT` 字节，超了**头尾都留**、中间截掉，并且把「截了」如实记下。
        没有上限的话，一条 `yes` 就能把 100MB 灌进作答数据。
     4. **不留孤儿**：POSIX 上开 `detached`，杀的时候杀**整个进程组**——测试命令常常自己
        再拉子进程，只杀爹会留下一堆还在写盘的孩子。

   环境变量是**白名单重建**的，不是从 `process.env` 继承再删几个：继承等于把学生的
   `SSH_AUTH_SOCK`、`AWS_*`、`GITHUB_TOKEN` 一起递给孩子。孩子的 `HOME` / `TMPDIR` 指向
   本次运行专用的临时目录，跑完删掉。
   ───────────────────────────────────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 单条命令的时间上限。够跑一轮单元测试，又不至于让任务永远挂在「运行」。 */
export const TIMEOUT_MS = 120_000;

/** SIGTERM 之后宽限多久再 SIGKILL。 */
export const KILL_GRACE_MS = 3_000;

/** 每条流最多留多少字节。超了头尾都留、中间截掉（两端那句话最能说明问题）。 */
export const OUTPUT_LIMIT = 64 * 1024;

/** 进度行里带多少字节的最新输出——够看出「它跑到哪了」，又不至于把进度刷爆。 */
const PROGRESS_TAIL = 240;

/** 进度上报间隔。500ms 是给人看的（阅读端画进度条），更密只是白写盘。 */
const PROGRESS_EVERY_MS = 500;

/** 头尾各留多少（截断时）。 */
const HEAD_KEEP = Math.floor(OUTPUT_LIMIT * 0.6);
const TAIL_KEEP = OUTPUT_LIMIT - HEAD_KEEP;

export interface RunFacts {
  /** 命令原文（题目里声明的那条，逐字）。 */
  命令: string;
  /** argv（切好的，方便人复核「到底跑了什么」）。 */
  argv: string[];
  /** 程序解析出来的绝对路径；没解析到就是空串（那时多半是 spawn 失败）。 */
  程序: string;
  /** 子进程的落脚点（绝对路径）。 */
  cwd: string;
  /** 声明的可写路径（相对 cwd 的原文 → 规范化后的绝对路径）。 */
  可写: { 声明: string; 路径: string }[];
  /** 退出码。被信号杀掉时是 null（**如实**：没有退出码就没有）。 */
  退出码: number | null;
  /** 结尾信号（`SIGTERM` 这类）；正常退出是空串。 */
  信号: string;
  /** 这次为什么结束：`跑完` / `超时` / `取消` / `起不来`。 */
  结局: '跑完' | '超时' | '取消' | '起不来';
  /** 从 spawn 到结束的毫秒数。 */
  毫秒: number;
  stdout: string;
  stderr: string;
  /** stdout / stderr 各留了多少字节（**原始**字节数，不是截断后的）。 */
  字节: { stdout: number; stderr: number };
  /** 有没有被截断。 */
  截断: { stdout: boolean; stderr: boolean };
  /** 起不来时的那句原因（ENOENT 这类）；起来了就是空串。 */
  起不来: string;
}

export interface RunOptions {
  /** 命令原文（已经过 `parseCommand`）。 */
  command: string;
  /** argv（已经过 `parseCommand`）。 */
  argv: string[];
  /** 落脚点（已经在沙箱里判过）。 */
  cwd: string;
  /** 声明的可写路径：`{ 声明, 路径 }`（已经在沙箱里判过）。 */
  writable: { 声明: string; 路径: string }[];
  /** 工作区根：PATH 里额外的 `<工作区>/.venv/bin` 之类要用它，临时目录也放它下面。 */
  workspace: string;
  /** 协作式取消（任务域的 `job.signal`）。 */
  signal?: AbortSignal;
  /** 进度回调：一行给人看的话。 */
  onProgress?: (line: string) => void;
  /** 覆盖超时（测试要跑一条短的；**只给测试用**，工具面不暴露）。 */
  timeoutMs?: number;
  /** 注入时钟（测试用）。 */
  now?: () => number;
}

/** 有界缓冲：先收满，再收尾。两端都留是为了让「开头报了什么错」与「最后死在哪」都在。 */
class BoundedText {
  private head = '';
  private tail = '';
  private headBytes = 0;
  private total = 0;
  private readonly limit: number;

  constructor(limit: number = OUTPUT_LIMIT) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    this.total += chunk.byteLength;
    if (this.headBytes < HEAD_KEEP) {
      const room = HEAD_KEEP - this.headBytes;
      const taken = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
      this.head += taken.toString('utf8');
      this.headBytes += taken.byteLength;
      if (taken.byteLength === chunk.byteLength) return;
      chunk = chunk.subarray(taken.byteLength);
    }
    this.tail += chunk.toString('utf8');
    if (this.tail.length > TAIL_KEEP) this.tail = this.tail.slice(-TAIL_KEEP);
  }

  get bytes(): number {
    return this.total;
  }

  get truncated(): boolean {
    return this.total > this.limit;
  }

  text(): string {
    if (!this.truncated) return this.head + this.tail;
    return `${this.head}\n…（输出太长，中间省略：共 ${this.total} 字节，这里留了头 `
      + `${Buffer.byteLength(this.head)} 字节与尾 ${Buffer.byteLength(this.tail)} 字节。`
      + `要完整输出就让学生自己在终端里重跑这条命令）…\n${this.tail}`;
  }

  /** 最近一行的尾巴：进度行与「半路被杀时给孩子看的那一眼」。 */
  recent(): string {
    const raw = (this.head + this.tail).split('\n').filter((line) => line.trim() !== '');
    const last = raw[raw.length - 1] ?? '';
    return last.length > PROGRESS_TAIL ? `…${last.slice(-PROGRESS_TAIL)}` : last;
  }
}

/** 本次运行专用的临时目录：孩子的 `HOME` 与 `TMPDIR` 都指这里，跑完删掉。 */
function makeSandboxHome(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-lab-'));
}

/**
 * 孩子的环境变量。**白名单重建**（见文件头第 4 条）。
 *
 * `PATH` 前面插了 `<工作区>/.venv/bin` 与 `<工作区>/venv/bin`：学生的虚拟环境通常建在
 * 工作区里，而 `PATH` 里没有它——不插的话 `python3` 会解析到系统那个，跑出来的结果
 * 不是学生预期的那个（这是「真实输出」意义上的失真，不只是不方便）。
 */
function buildEnv(workspace: string, sandboxHome: string): NodeJS.ProcessEnv {
  const venv = ['/.venv/bin', '/venv/bin'].map((rel) => `${workspace}${rel}`)
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  const hostPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  return {
    PATH: [...venv, hostPath].join(path.delimiter),
    HOME: sandboxHome,
    TMPDIR: sandboxHome,
    TEMP: sandboxHome,
    TMP: sandboxHome,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'C.UTF-8',
    // 学生本机的时区：日志里的时间戳要跟学生看到的对得上
    ...process.env.TZ === undefined ? {} : { TZ: process.env.TZ },
    TERM: 'dumb',
    NO_COLOR: '1',
    // 给子进程一个可自查的标记：脚本里可以据此知道自己在 StudyMate 的沙箱里跑
    STUDYMATE_LAB: '1',
  };
}

function rmQuiet(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉不是运行结果的一部分，静默（它自己会被系统回收）
  }
}

/**
 * 跑一条命令，**只回事实**。
 *
 * 这个函数永远 resolve：起不来、超时、被杀都是**结果的一种**，不是异常。抛出去的只有
 * 真正不该发生的事（比如参数形状不对）——那种情况在调用方那边就已经拦住了。
 */
export async function runCommand(options: RunOptions): Promise<RunFacts> {
  const now = options.now ?? ((): number => Date.now());
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const sandboxHome = makeSandboxHome();
  const started = now();

  const base: RunFacts = {
    命令: options.command,
    argv: options.argv,
    程序: '',
    cwd: options.cwd,
    可写: options.writable,
    退出码: null,
    信号: '',
    结局: '跑完',
    毫秒: 0,
    stdout: '',
    stderr: '',
    字节: { stdout: 0, stderr: 0 },
    截断: { stdout: false, stderr: false },
    起不来: '',
  };

  const out = new BoundedText();
  const err = new BoundedText();
  const env = buildEnv(options.workspace, sandboxHome);
  let done = false;

  try {
    const finished = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error: string }>((resolve) => {
      let child;
      try {
        child = spawn(options.argv[0] as string, options.argv.slice(1), {
          cwd: options.cwd,
          env,
          shell: false,
          // POSIX 上自成进程组：杀的时候连孩子一起杀（见文件头第 4 条）
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ code: null, signal: null, error: error instanceof Error ? error.message : String(error) });
        return;
      }

      let outcome: '跑完' | '超时' | '取消' = '跑完';
      const timers: NodeJS.Timeout[] = [];
      const clearTimers = (): void => {
        for (const timer of timers) clearTimeout(timer);
        timers.length = 0;
      };
      const killGroup = (signal: NodeJS.Signals): void => {
        try {
          if (process.platform !== 'win32' && typeof child.pid === 'number') process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // 已经死了（ESRCH）：要的就是它死，这条不算问题
        }
      };
      /** 先 SIGTERM，宽限之后还在就 SIGKILL。 */
      const terminate = (why: '超时' | '取消'): void => {
        if (outcome === '跑完') outcome = why;
        killGroup('SIGTERM');
        const timer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
        timer.unref?.();
        timers.push(timer);
      };

      const onAbort = (): void => terminate('取消');
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const timeoutTimer = setTimeout(() => terminate('超时'), timeoutMs);
      timeoutTimer.unref?.();
      timers.push(timeoutTimer);

      let progressTimer: NodeJS.Timeout | null = null;
      if (typeof options.onProgress === 'function') {
        const report = (): void => {
          const seconds = Math.round((now() - started) / 1000);
          const recent = out.recent() || err.recent();
          options.onProgress?.(`已跑 ${seconds} 秒｜标准输出 ${out.bytes} 字节、标准错误 ${err.bytes} 字节`
            + `${recent === '' ? '' : `｜最近一行：${recent}`}`);
        };
        options.onProgress(`已跑 0 秒｜${options.argv.join(' ')}（cwd ${options.cwd}）`);
        progressTimer = setInterval(report, PROGRESS_EVERY_MS);
        progressTimer.unref?.();
      }

      const settle = (code: number | null, signal: NodeJS.Signals | null, error: string): void => {
        if (done) return;
        done = true;
        clearTimers();
        if (progressTimer !== null) clearInterval(progressTimer);
        options.signal?.removeEventListener('abort', onAbort);
        base.结局 = error !== '' ? '起不来' : outcome;
        base.起不来 = error;
        resolve({ code, signal, error });
      };

      child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', (error: Error) => settle(null, null, error.message));
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => settle(code, signal, ''));
    });

    // 进度里最后那一眼：结束时把「跑到哪了」写清（超时与取消时它是最有用的一句）
    if (typeof options.onProgress === 'function') {
      const recent = out.recent() || err.recent();
      options.onProgress(`已结束（${base.结局}）｜标准输出 ${out.bytes} 字节、标准错误 ${err.bytes} 字节`
        + `${recent === '' ? '' : `｜最近一行：${recent}`}`);
    }

    base.退出码 = finished.code;
    base.信号 = finished.signal ?? '';
    base.毫秒 = Math.max(0, Math.round(now() - started));
    base.stdout = out.text();
    base.stderr = err.text();
    base.字节 = { stdout: out.bytes, stderr: err.bytes };
    base.截断 = { stdout: out.truncated, stderr: err.truncated };
    // 程序解析到的绝对路径：按孩子实际拿到的 PATH 找一遍（找不到就空串，`起不来` 那句会说明原因）
    base.程序 = resolveProgram(options.argv[0] as string, options.workspace, env);
    return base;
  } finally {
    rmQuiet(sandboxHome);
  }
}

/**
 * 程序名 → 绝对路径。`argv[0]` 含 `/` 时按工作区解析（`./run.sh` 这种写法在子进程里是
 * 相对它的 cwd 的，这里只为了**报告**它到底解析成了谁），否则在**孩子实际拿到的 PATH** 里找
 * ——报告的那条路径必须与孩子真正执行的那个一致，拿父进程的 PATH 去找会报出另一个程序。
 * 找不到返回空串。
 */
export function resolveProgram(argv0: string, workspace: string, env: NodeJS.ProcessEnv): string {
  const candidates: string[] = [];
  if (argv0.includes('/')) {
    candidates.push(path.resolve(workspace, argv0));
  } else {
    for (const dir of env.PATH?.split(path.delimiter) ?? []) candidates.push(path.join(dir, argv0));
  }
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // 这个候选不在，试下一个
    }
  }
  return '';
}
