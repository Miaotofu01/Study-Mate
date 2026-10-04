#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · Codex 侧的交互断点（原 Python 版的 Node 移植）

   为什么移植而不是删掉：Codex / ChatGPT Work 没有阅读端也没有原生工具，总控靠这份
   状态文件接着上次的盘问往下走（`codex-interaction.md` 的「持久化与恢复」）。
   文件本身是 JSON，直接读写当然也行——但那会丢掉这里唯一一件脚本才做得到的事：
   **revision 栅栏**（用读到的 revision 提交，冲突就失败而不是覆盖另一个会话）。
   所以形状与命令一字不改地搬过来，只把宿主从 Python 换成 Node（这个插件本来就要求 Node）。

   零依赖、只用 Node 标准库；命令、字段、错误口径与 Python 版逐条对齐：

     node interaction_state.mjs --workspace <ABS> read
     node interaction_state.mjs --workspace <ABS> update --input <JSON> --expected-revision 0
     node interaction_state.mjs --workspace <ABS> answer --question-id <ID> --input <JSON> --expected-revision 1

   成功打印完整状态（JSON）；失败打 stderr 并退 1，且**不替换已有状态**。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;
const PHASES = new Set(['clarify', 'plan', 'produce', 'learn', 'practice', 'review', 'paused']);
export const FIELDS = ['active_subject', 'phase', 'node_id', 'intent', 'answers', 'pending', 'next_action'];
const PENDING_FIELDS = ['id', 'kind', 'topic', 'question', 'options', 'resume_phase'];

export class StateError extends Error {}

export function initial_state() {
  return {
    schema_version: SCHEMA_VERSION, revision: 0, active_subject: null, phase: 'clarify',
    node_id: null, intent: '', answers: {}, pending: null, next_action: '',
  };
}

/** 路径分隔符两侧都认（Windows 上 `\` 也是分隔符）。 */
function components(value) {
  return value.split(/[\\/]+/).filter(Boolean).map(part => part.toLowerCase());
}

function inside(child, root) {
  const relative = path.relative(root, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function absolute_path(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new StateError(`${label} must be an explicit absolute path`);
  }
  return path.resolve(value);
}

export function workspace_path(value, forbidRoots = []) {
  const requested = absolute_path(value, '--workspace');
  let workspace;
  try {
    workspace = fs.realpathSync(requested);
  } catch {
    throw new StateError('workspace must be an existing directory');
  }
  if (!fs.statSync(workspace).isDirectory()) throw new StateError('workspace must be an existing directory');
  const forbidden = [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')];
  for (const root of forbidRoots) forbidden.push(absolute_path(root, '--forbid-root'));
  for (const candidate of [requested, workspace]) {
    const parts = components(candidate);
    for (let i = 0; i + 3 <= parts.length; i++) {
      const triple = parts.slice(i, i + 3).join('/');
      if (triple === '.codex/plugins/cache' || triple === '.agents/plugins/cache') {
        throw new StateError('workspace cannot be inside a plugin cache');
      }
    }
    for (const root of forbidden) {
      if (inside(candidate, root)) throw new StateError('workspace cannot be inside a plugin or forbidden root');
    }
  }
  for (let ancestor = workspace; ; ancestor = path.dirname(ancestor)) {
    if (fs.existsSync(path.join(ancestor, '.codex-plugin', 'plugin.json'))
        || fs.existsSync(path.join(ancestor, '.plugin', 'plugin.json'))) {
      throw new StateError('workspace cannot be inside a plugin root');
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  const learning = path.join(workspace, '.learning');
  const learningStat = fs.lstatSync(learning, { throwIfNoEntry: false });
  if (!learningStat || learningStat.isSymbolicLink() || !learningStat.isDirectory()
      || !inside(fs.realpathSync(learning), workspace)) {
    throw new StateError('workspace must have an existing .learning directory without a symlink or escaped path');
  }
  return workspace;
}

function require_text(value, field, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new StateError(`${field} must be ${allowEmpty ? 'a string' : 'a nonempty string'}`);
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => keys.includes(key));
}

export function validate_business(data, workspace) {
  if (!isObject(data) || !exactKeys(data, FIELDS)) {
    throw new StateError(`input must contain exactly these business fields: ${[...FIELDS].sort().join(', ')}`);
  }
  const subject = data.active_subject;
  if (subject !== null && subject !== undefined) {
    require_text(subject, 'active_subject');
    if (subject === '.' || subject === '..' || /[/\\:\0]/.test(subject)) {
      throw new StateError('active_subject must be a single relative subject slug');
    }
    const subjects = path.join(workspace, '.learning', 'subjects');
    const target = path.join(subjects, subject);
    const subjectsStat = fs.lstatSync(subjects, { throwIfNoEntry: false });
    if (!subjectsStat || subjectsStat.isSymbolicLink()
        || fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()
        || !inside(path.resolve(target), fs.realpathSync(subjects))) {
      throw new StateError('active_subject cannot escape subjects or use a symlink');
    }
    if (!inside(fs.realpathSync(subjects), path.join(workspace, '.learning'))) {
      throw new StateError('subjects cannot escape the workspace');
    }
  }
  if (typeof data.phase !== 'string' || !PHASES.has(data.phase)) {
    throw new StateError(`phase must be one of: ${[...PHASES].sort().join(', ')}`);
  }
  if (data.node_id !== null && data.node_id !== undefined) require_text(data.node_id, 'node_id');
  require_text(data.intent, 'intent', true);
  require_text(data.next_action, 'next_action', true);
  if (!isObject(data.answers)) throw new StateError('answers must be a JSON object');
  const pending = data.pending;
  if (pending === null || pending === undefined) return;
  if (data.phase === 'paused') throw new StateError('paused state must clear pending before saving');
  if (!isObject(pending) || !exactKeys(pending, PENDING_FIELDS)) {
    throw new StateError(`pending must be null or contain exactly: ${[...PENDING_FIELDS].sort().join(', ')}`);
  }
  for (const field of ['id', 'topic', 'question']) require_text(pending[field], `pending.${field}`);
  if (pending.kind !== 'preference' && pending.kind !== 'learning_check') {
    throw new StateError('pending.kind must be preference or learning_check');
  }
  if (typeof pending.resume_phase !== 'string' || !PHASES.has(pending.resume_phase)) {
    throw new StateError('pending.resume_phase must be a supported phase');
  }
  if (!Array.isArray(pending.options)) throw new StateError('pending.options must be an array');
  const optionIds = new Set();
  for (const option of pending.options) {
    if (!isObject(option) || !exactKeys(option, ['id', 'label'])) {
      throw new StateError('each pending option must contain exactly id and label');
    }
    require_text(option.id, 'option.id');
    require_text(option.label, 'option.label');
    if (optionIds.has(option.id)) throw new StateError('pending option ids must be unique');
    optionIds.add(option.id);
  }
}

/**
 * 读一个 JSON 文件。
 *
 * 与 Python 版的一处**记在案的差异**：那边用 `object_pairs_hook` 拒重复键，这里不拒
 * ——`JSON.parse` 的 reviver 拿到的 holder 早就带上了同名属性，判不出「这是第二次」，
 * 要判就得自己扫一遍 JSON。重复键在这里只会出现在人手写坏的输入文件里，取最后一个值是
 * 标准 JSON 行为；真出现了，后面那条「业务字段正好七个」的校验多半会先拦下。
 */
export function load_json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function read_state(workspace) {
  const file = path.join(workspace, '.learning', 'interaction.json');
  const fileStat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!fileStat) return initial_state();
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new StateError('interaction.json must be a regular file without a symlink');
  }
  const data = load_json(file);
  if (!isObject(data) || !Number.isInteger(data.schema_version) || data.schema_version !== SCHEMA_VERSION) {
    throw new StateError('unsupported or missing interaction schema_version; existing state was not changed');
  }
  if (!Number.isInteger(data.revision) || data.revision < 0) {
    throw new StateError('invalid interaction revision; existing state was not changed');
  }
  const business = {};
  for (const key of FIELDS) business[key] = data[key];
  validate_business(business, workspace);
  return data;
}

export function change_state(workspace, expectedRevision, change) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new StateError('expected revision must be a nonnegative integer');
  }
  const lock = path.join(workspace, '.learning', '.interaction.lock');
  let descriptor;
  try {
    // 独占、不等待：另一个更新在跑就失败，绝不等锁也绝不抢锁。
    descriptor = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new StateError(`update locked: ${lock}; no waiting or state changes were performed`);
    }
    throw error;
  }
  let temporary = null;
  let committed = false;
  try {
    fs.writeSync(descriptor, `${process.pid}\n`);
    fs.closeSync(descriptor);
    const current = read_state(workspace);
    if (current.revision !== expectedRevision) {
      throw new StateError(`revision conflict: expected ${expectedRevision}, found ${current.revision}; read again before updating`);
    }
    const data = change(current);
    validate_business(data, workspace);
    const updated = { ...data, schema_version: SCHEMA_VERSION, revision: expectedRevision + 1 };
    temporary = path.join(lock, '..', `.interaction-${process.pid.toString(36)}-${Date.now().toString(36)}.tmp`);
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeSync(handle, `${JSON.stringify(updated, null, 2)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, path.join(workspace, '.learning', 'interaction.json'));
    temporary = null;
    committed = true;
    return updated;
  } finally {
    if (temporary !== null) fs.rmSync(temporary, { force: true });
    try {
      fs.unlinkSync(lock);
    } catch (error) {
      if (!committed) throw error;
      // 原子提交已经成功：如实报告保存成功，别让调用方以为该重放一次回答。
      process.stderr.write(`interaction state saved; could not remove update lock ${lock}: ${error.message}\n`);
    }
  }
}

export function update_state(workspace, data, expectedRevision) {
  validate_business(data, workspace);
  return change_state(workspace, expectedRevision, () => data);
}

function has_answer(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(has_answer);
  if (typeof value === 'object') return Object.values(value).some(has_answer);
  return true; // JSON 里显式的 false 与 0 算回答，沉默不算。
}

export function answer_state(workspace, questionId, value, expectedRevision) {
  require_text(questionId, 'question id');
  if (!has_answer(value)) {
    throw new StateError('empty answer: silence or an empty reply cannot consume a pending question');
  }
  return change_state(workspace, expectedRevision, (current) => {
    const pending = current.pending;
    if (pending === null || pending === undefined) {
      throw new StateError('no pending question: late or duplicate answer was not recorded');
    }
    if (pending.id !== questionId) {
      throw new StateError(`question conflict: expected pending id ${JSON.stringify(pending.id)}, received ${JSON.stringify(questionId)}`);
    }
    if (Object.hasOwn(current.answers, questionId)) {
      throw new StateError(`question ${JSON.stringify(questionId)} was already answered; use a new id for a new question`);
    }
    const data = {};
    for (const key of FIELDS) data[key] = current[key];
    data.answers = { ...current.answers, [questionId]: { topic: pending.topic, value } };
    data.phase = pending.resume_phase;
    data.pending = null;
    data.next_action = `根据已收到的 ${pending.topic} 回答继续 ${pending.resume_phase}`;
    return data;
  });
}

/** 极简参数解析：与 Python 版 argparse 的命令行形状一一对应。 */
function parseArgs(argv) {
  const options = { forbidRoot: [], command: null };
  const rest = [...argv];
  while (rest.length) {
    const flag = rest.shift();
    if (flag === '--workspace') options.workspace = rest.shift();
    else if (flag === '--forbid-root') options.forbidRoot.push(rest.shift());
    else if (flag === 'read') { options.command = 'read'; }
    else if (flag === 'update' || flag === 'answer') {
      options.command = flag;
      while (rest.length) {
        const next = rest.shift();
        if (next === '--input') options.input = rest.shift();
        else if (next === '--expected-revision') options.expectedRevision = Number(rest.shift());
        else if (next === '--question-id') options.questionId = rest.shift();
        else throw new StateError(`unrecognized argument: ${next}`);
      }
    } else if (flag === '--help' || flag === '-h') { options.help = true; }
    else throw new StateError(`unrecognized argument: ${flag}`);
  }
  return options;
}

const USAGE = `usage: interaction_state.mjs --workspace ABS [--forbid-root ABS] <read|update|answer> [...]
  read
  update --input JSONFILE --expected-revision N
  answer --question-id ID --input JSONFILE --expected-revision N`;

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
    if (!options.command) throw new StateError(`a command is required\n${USAGE}`);
    const workspace = workspace_path(options.workspace, options.forbidRoot);
    let result;
    if (options.command === 'read') {
      result = read_state(workspace);
    } else {
      if (options.input === undefined) throw new StateError('--input is required');
      if (!Number.isInteger(options.expectedRevision)) throw new StateError('--expected-revision is required');
      if (options.command === 'answer') {
        result = answer_state(workspace, options.questionId, load_json(options.input), options.expectedRevision);
      } else {
        result = update_state(workspace, load_json(options.input), options.expectedRevision);
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof StateError) && !(error instanceof Error)) throw error;
    process.stderr.write(`interaction state: ${error.message}\n`);
    return 1;
  }
}

// 被当模块 import（测试）时**不执行**：判据与 bin/studymate.mjs 同一写法。
if (process.argv[1] && fs.existsSync(process.argv[1])
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
