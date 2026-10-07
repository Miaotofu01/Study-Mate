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

import { parseYaml } from './yaml.mjs';

/** DSH 的 home：环境变量优先，其次是 ~/.dsh。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function configFile() {
  return path.join(dshHome(), 'studymate-config.yaml');
}

/** 先按 YAML 读；读不动再看它是不是「注释 + JSON」。 */
function readConfigObject(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = parseYaml(text, { file });
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // 落到下面的 JSON 兜底：安装器写的就是 JSON
  }
  try {
    const jsonText = text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n').trim();
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function stringField(file, key) {
  const parsed = readConfigObject(file);
  const value = parsed && parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function resolveWorkspace(file = configFile()) {
  return stringField(file, 'workspace');
}

/** 引擎项目根（.learning 之外的那些源码）也在配置里，暂时只有诊断用得上。 */
export function resolveRoot(file = configFile()) {
  return stringField(file, 'root');
}
