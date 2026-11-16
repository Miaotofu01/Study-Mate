/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Host 数据层 —— 共享记忆的一次性迁移（`studymate migrate`）

   一句话：把旧工作区的 `.learning/MEMORY.md`（`##` 分节 + bullet）转成
   `.learning/MEMORY.yaml`（四节 YAML），新文件落成后把旧文件**改名备份**成 `MEMORY.md.bak`。

   为什么需要它（而不是一条 `mv`）：ADR-0014 改名时「节一个都没动、读侧拿它当文本读」，
   所以当时改名就够；#190 之后读侧按 YAML 节取用，内容形状也变了——只改名读不出来。审计发现
   2.0.x 用户盘上只有旧格式时画像三节与「积累」会静默全丢，于是补这条迁移。

   四条硬承诺（也是套件钉的判据）：
     · **不覆盖**已有 `MEMORY.yaml`：新文件在就一个字节都不动，旧文件也留着（新旧并存要人判断）；
     · **幂等**：迁移成功后再跑一次是 `already-new`，不重复写、不重复备份；
     · **不丢内容**：转换规则在纯函数域（`lib/core/memory.ts`），转不了的进 warning 或原样
       带过去；旧文件本身也整份留在 `.bak` 里；
     · **可回滚**：删掉新的 `MEMORY.yaml`、把 `.bak` 改回 `MEMORY.md` 即可（命令输出里写了原路径）。

   迁移是过渡：读侧只在新文件缺席时兜底读旧名（`lib/memory-file.ts`），写侧永远只写新文件。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

import {
  LEGACY_MEMORY_FILE, MEMORY_FILE, migrateLegacyMemory, readMemory,
} from './core/memory.ts';
import { legacyMemoryNotice } from './memory-file.ts';
import { parseYaml } from './yaml.ts';
import { removeTreeSync } from './fs-remove.mjs';
import { resolveWorkspace } from './workspace.ts';

export type MemoryMigrateStatus = 'migrated' | 'dry-run' | 'already-new' | 'no-legacy' | 'refused';

export interface MemoryMigrateResult {
  status: MemoryMigrateStatus;
  /** 学习工作区（绝对路径）。 */
  workspace: string;
  /** 迁移后的新文件路径。 */
  newFile: string;
  /** 旧格式文件路径（可能不存在）。 */
  legacyFile: string;
  /** 旧文件改名后的备份路径（只在 `migrated` 时有）。 */
  backup?: string;
  /** 迁移产物（`dry-run` 时也给，方便先看再写）。 */
  yaml?: string;
  /** 需要人看一眼的提示：并节、原样保留的旧节、无法机械迁移…… */
  warnings: string[];
  /** 迁移出来的节名。 */
  sections: string[];
  /** 迁移后「积累」的条目数（两条来源：旧「积累」+ 旧「跨科目观察」）。 */
  accumulations: number;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** 备份名：`.bak` 被占了就依次 `.bak.1`、`.bak.2`——不覆盖上一次的备份。 */
function backupTarget(legacyFile: string): string {
  const first = `${legacyFile}.bak`;
  if (!fs.existsSync(first)) return first;
  for (let index = 1; ; index += 1) {
    const candidate = `${first}.${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * 迁移一个学习工作区的共享记忆。
 *
 * @throws 工作区/`.learning` 不存在、旧文件读不了、转换结果不是合法 YAML——这些都不写盘。
 */
export function migrateMemoryWorkspace(options: { workspace: string; dryRun?: boolean }): MemoryMigrateResult {
  const workspace = path.resolve(options.workspace);
  const learningDir = path.join(workspace, '.learning');
  const newFile = path.join(learningDir, MEMORY_FILE);
  const legacyFile = path.join(learningDir, LEGACY_MEMORY_FILE);
  const base = { workspace, newFile, legacyFile, warnings: [] as string[], sections: [] as string[], accumulations: 0 };

  if (!isDirectory(learningDir)) {
    throw new Error(`找不到学习工作区：${learningDir} 不是目录（workspace=${workspace}）`);
  }
  if (fs.existsSync(newFile)) {
    const warnings: string[] = [];
    if (fs.existsSync(legacyFile)) {
      warnings.push(`新旧两份记忆同时存在：保留 MEMORY.yaml 不动，旧文件 ${legacyFile} 未处理——确认内容已被新文件覆盖后自行删除或改名。`);
    }
    return { ...base, status: 'already-new', warnings };
  }
  if (!fs.existsSync(legacyFile)) {
    return { ...base, status: 'no-legacy' };
  }

  const text = fs.readFileSync(legacyFile, 'utf8');
  const conversion = migrateLegacyMemory('shared', text);
  if (!conversion.migratable) {
    return { ...base, status: 'refused', warnings: conversion.warnings };
  }
  if (conversion.yaml.trim() !== '') {
    try {
      parseYaml(conversion.yaml, { file: newFile });
    } catch (error) {
      throw new Error(`迁移结果不是合法 YAML，已中止（原文件未动）：${(error as Error).message}`);
    }
  }
  const accumulations = readMemory({ shared: conversion.yaml }).accumulations.length;
  if (options.dryRun) {
    return {
      ...base,
      status: 'dry-run',
      yaml: conversion.yaml,
      warnings: conversion.warnings,
      sections: conversion.sections,
      accumulations,
    };
  }

  // 先落新文件（同目录临时文件 + rename，避免半份文件），再搬旧文件；搬不动就把新文件撤回。
  const temp = path.join(learningDir, `.${MEMORY_FILE}.migrate-${process.pid}.tmp`);
  fs.writeFileSync(temp, conversion.yaml, 'utf8');
  try {
    fs.renameSync(temp, newFile);
  } catch (error) {
    removeTreeSync(temp);
    throw new Error(`写不了 ${newFile}：${(error as Error).message}（原文件未动）`);
  }
  const backup = backupTarget(legacyFile);
  try {
    fs.renameSync(legacyFile, backup);
  } catch (error) {
    // 撤回新文件。`fs.rmSync` 在中文路径上会静默不删（Node 24 + Windows），
    // 那样「已撤回」就成了一句空话：旧文件还在、新文件也还在。
    removeTreeSync(newFile);
    throw new Error(`旧文件改名备份失败，已撤回新文件（原文件未动）：${(error as Error).message}`);
  }
  return {
    ...base,
    status: 'migrated',
    backup,
    yaml: conversion.yaml,
    warnings: conversion.warnings,
    sections: conversion.sections,
    accumulations,
  };
}

function printWarnings(result: MemoryMigrateResult): void {
  for (const warning of result.warnings) console.log(`注意：${warning}`);
}

/**
 * `studymate migrate` 的命令实现（参数解析在 `bin/studymate.mjs`）：打印结果并给退出码。
 * 退出码 1 只给「需要人先处理」的 refused / 读不了盘；already-new / no-legacy 是正常的幂等结果。
 */
export function migrateCommand(options: { workspace?: string; dryRun?: boolean; json?: boolean } = {}): number {
  const configured = options.workspace ?? process.env.LEARN_WORKSPACE ?? resolveWorkspace();
  if (typeof configured !== 'string' || configured.trim() === '') {
    console.error('StudyMate：找不到学习工作区。先跑一次安装，或用 --workspace 指定学习工作区目录。');
    return 1;
  }
  try {
    const result = migrateMemoryWorkspace({ workspace: configured.trim(), dryRun: options.dryRun });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === 'migrated') {
      console.log(`共享记忆已迁移：${result.newFile}`);
      console.log(`旧文件已改名备份：${result.backup}`);
      console.log(`节：${result.sections.join('、')}；积累条目：${result.accumulations}`);
      printWarnings(result);
      console.log(`回滚：删掉 ${result.newFile}，再把 ${result.backup} 改回 ${result.legacyFile}。`);
    } else if (result.status === 'dry-run') {
      console.log(`【dry-run】将写入：${result.newFile}（没有落盘）`);
      console.log(`节：${result.sections.join('、')}；积累条目：${result.accumulations}`);
      printWarnings(result);
      if (typeof result.yaml === 'string') console.log(`\n${result.yaml}`);
    } else if (result.status === 'already-new') {
      console.log(`共享记忆已经是 ${MEMORY_FILE}，无需迁移：${result.newFile}`);
      printWarnings(result);
    } else if (result.status === 'no-legacy') {
      console.log(`没有找到旧格式共享记忆（${result.legacyFile}），无需迁移。`);
    } else {
      console.log(`没有迁移：${legacyMemoryNotice(result.legacyFile)}`);
      printWarnings(result);
    }
    return result.status === 'refused' ? 1 : 0;
  } catch (error) {
    console.error(`StudyMate：${(error as Error).message}`);
    return 1;
  }
}
