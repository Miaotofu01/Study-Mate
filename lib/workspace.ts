// 学习工作区在哪：读 ~/.dsh/studymate-config.yaml 的 `workspace`。
//
// 只读、无副作用，刻意不走 bin/studymate.mjs 的 installPayload：那个函数会建目录、
// 迁移配置、写回文件，适合安装时跑一次，不适合每次开面板都跑。
// 配置读不了或没有 workspace 时返回空串，由调用方给出「先跑安装」这类可操作的提示。
//
// 这个文件有两种真实形态，都得认：
//   1. 安装器写的：`# 注释` + 一个 JSON 对象（bin/studymate.mjs 的 JSON.stringify）。
//      这**是合法 YAML**（多行流式映射），PyYAML 读得了，但本仓库的 YAML 子集解析器
//      按设计不支持多行流式映射——所以它要单独兜一下。
//   2. 手改过的：普通块映射 `workspace: "/path"`。
// 两种都读不出来才算「没配置」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseYaml } from './yaml.ts';

/** DSH 的 home：环境变量优先，其次是 ~/.dsh。 */
export function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function configFile(): string {
  return path.join(dshHome(), 'studymate-config.yaml');
}

/** 先按 YAML 读；读不动再看它是不是「注释 + JSON」。读不出来返回 null（调用方决定报不报错）。 */
export function readConfigObject(file: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = parseYaml(text, { file });
    // 解析器给的是 unknown：这里按运行期已有的「是对象才算配置」收窄（不是断言对象一定长什么样）
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // 落到下面的 JSON 兜底：安装器写的就是 JSON
  }
  try {
    const jsonText = text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n').trim();
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringField(file: string, key: string): string {
  const parsed = readConfigObject(file);
  const value = parsed && parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * 原生 config（`Config.workspace`，volatile）优先于安装器写的 YAML。
 *
 * 为什么是模块级的「来源」而不是给每个调用点加参数：读工作区的调用点有几十处
 *（阅读端路由、原生工具、监听、导出…），让它们各自认识「原生 config」等于把同一份
 * 优先级判断抄几十遍。这里只留一处，`bin/dsh-plugin.ts` 在 apply 时接上 volatile 引用。
 * 引用为空 / 抛错时**静默退回** YAML——那是安装器与 standalone 安装唯一的事实。
 */
let workspaceOverride: (() => string) | null = null;

/** 接上原生 config 的 workspace 来源；传 null 拆除（测试与插件卸载用）。 */
export function setWorkspaceOverride(source: (() => string) | null): void {
  workspaceOverride = typeof source === 'function' ? source : null;
}

export function resolveWorkspace(file: string = configFile()): string {
  try {
    const value = workspaceOverride?.();
    if (typeof value === 'string' && value.trim()) return value.trim();
  } catch {
    // 原生 config 读不到（服务未就绪 / 卸载中）→ 退回安装器配置
  }
  return stringField(file, 'workspace');
}

/** 当前生效的工作区来自哪里：插件配置 / 安装器配置 / 都没有。 */
export function resolveWorkspaceSource(file: string = configFile()): 'plugin-config' | 'installer-config' | '' {
  try {
    const value = workspaceOverride?.();
    if (typeof value === 'string' && value.trim()) return 'plugin-config';
  } catch {
    // 同 resolveWorkspace
  }
  return stringField(file, 'workspace') ? 'installer-config' : '';
}

/** 引擎项目根（.learning 之外的那些源码）也在配置里，暂时只有诊断用得上。 */
export function resolveRoot(file: string = configFile()): string {
  return stringField(file, 'root');
}
