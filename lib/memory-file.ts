/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 数据层 —— 共享记忆「读哪一份」

   一句话：`.learning/MEMORY.yaml` 优先；它不在、而改名前的 `.learning/MEMORY.md` 在时，
   读旧格式（转换见 `lib/core/memory.ts`），并且**每个文件每进程只提示一次**「这是旧格式，请迁移」。

   为什么这条兜底单独一个文件：取记忆正文的消费点有三个，各自读盘——答疑开张注入
   （`lib/ask/memory.ts`）、工作区摘要工具的 memory 域（`lib/host/vault.ts`）、图片库载荷
   （`lib/library.ts`）。「找哪一份、旧格式怎么读、什么时候提示」写三遍必然漂；尤其「只提示
   一次」是进程级状态，放各消费点里就变成每个调用点各提示一遍。投影与可见性（哪几节能进
   上下文）仍归纯函数域，这里只回答「文件在哪、读到的是什么」。

   写侧没有回退：写记忆永远写新文件。旧文件由 `studymate migrate` 一次性改名备份
   （`lib/memory-migrate.ts`），搬走之后这条兜底自然不再命中。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

import {
  LEGACY_MEMORY_FILE, MEMORY_FILE, readMemoryWithLegacy,
} from './core/memory.ts';
import type { MemoryFileView } from './core/memory.ts';

export interface SharedMemoryRead {
  /** 实际读到的文件：新名，或旧格式兜底时的旧名。 */
  file: string;
  /** 文件在盘上（旧格式但迁移不了也算在：内容还在，只是读不出来）。 */
  present: boolean;
  /** 统一成 YAML 后的正文；旧格式时是转换结果。没有文件（或旧格式无法迁移）时是 `null`。 */
  text: string | null;
  /** 真读到的是旧格式 `MEMORY.md`（尚未迁移）。 */
  legacy: boolean;
  /** 旧格式且连 `##` 分节都认不出来：文件在、内容还在，但**读不出来**（不是「内容为空」）。 */
  unreadable: boolean;
  /** 旧格式转换的提示（并节/原样保留/无法迁移）。 */
  warnings: string[];
  /** 判读结果。 */
  view: MemoryFileView;
}

/** 已经提示过旧格式的文件：每个进程只提醒一次，别让每次开面板/每次读载荷都刷一行。 */
const warnedLegacy = new Set<string>();

/** 旧格式、能机械迁移时的提示语：给日志（与工作区摘要的 notes）用同一句。 */
export function legacyMemoryNotice(file: string): string {
  return `共享记忆还是旧格式（${file}）：已按旧格式读取，规范内的分节照常生效。`
    + '运行 npx -y @yunmiao/studymate@latest migrate 可一次性迁移成 MEMORY.yaml（幂等；旧文件会改名备份）。';
}

/**
 * 旧格式、但**没有 `##` 分节**（转换不出任何一节）时的提示语。
 *
 * 这种盘面下 `readSharedMemory` 的 `text` 是 `null`、注入的是空串——文件在、内容还在，
 * 但一个字都读不出来。此时还说「内容不丢」就是骗人：学生以为它在上下文里。
 */
export function legacyUnreadableNotice(file: string): string {
  return `共享记忆还是旧格式（${file}）：旧文件里没有可识别的 \`## 分节\`，读不出来`
    + '（内容还在盘上，不是丢了）。先跑 npx -y @yunmiao/studymate@latest migrate --dry-run 看报告，'
    + '再按报告手工整理，或把能识别的部分搬进 MEMORY.yaml。';
}

/** 读文本；文件不在（ENOENT/EISDIR/ENOTDIR）返回 `null`，别的读盘故障照旧抛。 */
function readTextIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null;
    throw new Error(`读不了 ${file}：${(error as Error).message}`);
  }
}

/**
 * 读一个工作区的共享记忆正文。
 *
 * @param options.warn 旧格式兜底命中时是否 `console.warn` 一次（默认 true；套件里可关掉）
 */
export function readSharedMemory(workspace: string, options: { warn?: boolean } = {}): SharedMemoryRead {
  const learningDir = path.join(workspace, '.learning');
  const currentFile = path.join(learningDir, MEMORY_FILE);
  const current = readTextIfPresent(currentFile);
  if (current !== null) {
    const compat = readMemoryWithLegacy('shared', { current });
    return {
      file: currentFile, present: true, text: current, legacy: false, unreadable: false,
      warnings: [], view: compat.view,
    };
  }

  const legacyFile = path.join(learningDir, LEGACY_MEMORY_FILE);
  const legacy = readTextIfPresent(legacyFile);
  if (legacy !== null) {
    const compat = readMemoryWithLegacy('shared', { legacy });
    // 转换不出任何一节 = 读不出来。这时不许再说「内容不丢」——说清楚读不出来，
    // 才和 `text: null` / 注入空串的实际行为对得上。
    const unreadable = compat.text === null;
    if (options.warn !== false && !warnedLegacy.has(legacyFile)) {
      warnedLegacy.add(legacyFile);
      console.warn(unreadable ? legacyUnreadableNotice(legacyFile) : legacyMemoryNotice(legacyFile));
    }
    return {
      file: legacyFile,
      present: true,
      text: compat.text,
      legacy: true,
      unreadable,
      warnings: compat.warnings,
      view: compat.view,
    };
  }

  const compat = readMemoryWithLegacy('shared', {});
  return {
    file: currentFile, present: false, text: null, legacy: false, unreadable: false,
    warnings: [], view: compat.view,
  };
}
