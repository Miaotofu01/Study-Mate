/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 插件页状态（`GET /api/studymate/status`）

   这张卡的重点是「空态也是状态」：没配置、没建科目、一门坏数据、读盘失败，都不能把
   插件页打成 500 或空白。所以这里逐个状态钉：
     · 没配置 → configured:false / initialized:false / subjects:[]，仍然 200；
     · 配了工作区但还没有 .learning/subjects → initialized:false；
     · 正常工作区 → 每门课只投影 slug/name/status/updated_at/levels/continue_node/stats；
     · 一门坏数据 → unreadable 点名，好的那门照常；
     · 原生 config 的 workspace 优先于安装器 YAML（来源标 plugin-config）；
     · 路由始终 200，GET 形状固定。
   ───────────────────────────────────────────────────────────────────────── */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildStatus } from '../../lib/status.ts';
import { configFile, resolveWorkspace, resolveWorkspaceSource, setWorkspaceOverride } from '../../lib/workspace.ts';
import { registerStatusRoute } from '../../lib/status-route.ts';
import { writeSubject } from './fixtures/tools.mjs';

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-status-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(() => {
    setWorkspaceOverride(null);
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeConfig(workspace, extra = {}) {
  fs.writeFileSync(configFile(), JSON.stringify({ workspace, ...extra }));
}

test('状态：没配置 → configured=false / subjects 为空 / 来源为空', t => {
  tempHome(t);
  const status = buildStatus({ profile: 'web', now: new Date('2026-11-07T10:00:00Z') });
  assert.equal(status.ok, true);
  assert.equal(status.configured, false);
  assert.equal(status.initialized, false);
  assert.equal(status.source, '');
  assert.equal(status.mode, 'unknown');
  assert.deepEqual(status.subjects, []);
  assert.deepEqual(status.unreadable, []);
  assert.equal(typeof status.watch.watching, 'boolean');
  assert.deepEqual(status.registration, { ok: true, error: '' });
  assert.equal(status.generated_at, '2026-11-07T10:00:00.000Z');
});

test('状态：配了工作区但还没有科目目录 → initialized=false，其余字段照实说', t => {
  const home = tempHome(t);
  const workspace = path.join(home, '空工作区');
  fs.mkdirSync(workspace, { recursive: true });
  writeConfig(workspace, { installModes: { web: 'native' } });
  const status = buildStatus({ profile: 'web' });
  assert.equal(status.configured, true);
  assert.equal(status.initialized, false);
  assert.equal(status.source, 'installer-config');
  assert.equal(status.mode, 'native');
  assert.equal(status.workspace, workspace);
  assert.deepEqual(status.subjects, []);
});

test('状态：正常工作区只投影状态卡要的字段，不带课件/题库', t => {
  const home = tempHome(t);
  const workspace = path.join(home, '学习资料');
  fs.mkdirSync(workspace, { recursive: true });
  writeSubject(workspace, 'demo');
  writeConfig(workspace, { installModes: { web: 'native' }, root: path.join(home, 'engine') });
  const status = buildStatus({ profile: 'web' });
  assert.equal(status.ok, true);
  assert.equal(status.initialized, true);
  assert.equal(status.subjects.length, 1);
  const subject = status.subjects[0];
  assert.equal(subject.slug, 'demo');
  assert.equal(typeof subject.name, 'string');
  assert.equal(typeof subject.stats, 'object');
  // 夹具两个节点：三档计数之和必须是这两个节点，不多不少。
  assert.equal(Object.values(subject.stats).reduce((sum, n) => sum + n, 0), 2);
  assert.equal('lessons' in subject, false);
  assert.equal('pool' in subject, false);
  assert.equal('records' in subject, false);
});

test('状态：一门坏数据只坏那一门，好的照常列出来', t => {
  const home = tempHome(t);
  const workspace = path.join(home, '学习资料');
  fs.mkdirSync(workspace, { recursive: true });
  writeSubject(workspace, 'good');
  const bad = path.join(workspace, '.learning', 'subjects', 'bad');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'curriculum.yaml'), 'nodes: [\n');
  writeConfig(workspace);
  const status = buildStatus({ profile: 'web' });
  assert.equal(status.subjects.length, 1);
  assert.equal(status.subjects[0].slug, 'good');
  assert.deepEqual(status.unreadable.map(entry => entry.dir), ['bad']);
  assert.ok(status.unreadable[0].error.includes('curriculum.yaml'), status.unreadable[0].error);
});

test('状态：原生 config 的 workspace 优先于安装器 YAML，来源标 plugin-config', t => {
  const home = tempHome(t);
  const installed = path.join(home, '安装器工作区');
  const picked = path.join(home, '插件页选的工作区');
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(picked, { recursive: true });
  writeSubject(picked, 'picked');
  writeConfig(installed);
  setWorkspaceOverride(() => picked);
  t.after(() => setWorkspaceOverride(null));

  assert.equal(resolveWorkspace(), picked);
  assert.equal(resolveWorkspaceSource(), 'plugin-config');
  const status = buildStatus({ profile: 'web' });
  assert.equal(status.workspace, picked);
  assert.equal(status.source, 'plugin-config');
  assert.equal(status.subjects[0].slug, 'picked');
});

test('状态：override 为空时静默退回安装器 YAML', t => {
  const home = tempHome(t);
  const installed = path.join(home, '安装器工作区');
  fs.mkdirSync(installed, { recursive: true });
  writeConfig(installed);
  setWorkspaceOverride(() => '');
  t.after(() => setWorkspaceOverride(null));
  assert.equal(resolveWorkspace(), installed);
  assert.equal(resolveWorkspaceSource(), 'installer-config');
  assert.equal(buildStatus({ profile: 'web' }).source, 'installer-config');
});

test('状态：拆除只清自己接的那一份——晚到的那次不该被先走的那次抹掉', t => {
  const home = tempHome(t);
  const installed = path.join(home, '安装器工作区');
  fs.mkdirSync(installed, { recursive: true });
  writeConfig(installed);

  const first = path.join(home, '第一次接的');
  const second = path.join(home, '第二次接的');
  const disposeFirst = setWorkspaceOverride(() => first);
  const disposeSecond = setWorkspaceOverride(() => second);
  t.after(() => setWorkspaceOverride(null));
  assert.equal(typeof disposeFirst, 'function');

  assert.equal(resolveWorkspace(), second);
  disposeFirst();  // 前一个实例卸载
  assert.equal(resolveWorkspace(), second, '先拆的那份把后接的来源抹掉了');
  disposeSecond();
  assert.equal(resolveWorkspace(), installed);
  assert.equal(resolveWorkspaceSource(), 'installer-config');
});

test('状态：预设注册失败的事实原样透出（#317），状态本身仍是读成功', t => {
  tempHome(t);
  const error = 'cordis.patch.yml:4:1: 流式集合缺少闭合的 "}"';
  const status = buildStatus({ profile: 'web', registration: { ok: false, error } });
  // 注册失败不影响本载荷的 ok：工作区就是没配置，这是事实，不是读盘错误。
  assert.equal(status.ok, true);
  assert.deepEqual(status.registration, { ok: false, error });
});

test('状态路由：启动失败的原因随注册状态一起回给页面', async t => {
  const home = tempHome(t);
  const workspace = path.join(home, '学习资料');
  fs.mkdirSync(workspace, { recursive: true });
  writeSubject(workspace, 'demo');
  writeConfig(workspace);

  const routes = [];
  const ctx = {
    inject(names, handler) {
      handler({
        connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
        effect: (fn) => { const dispose = fn(); return dispose; },
      });
    },
  };
  registerStatusRoute(ctx, {
    profile: 'web',
    registration: { ok: false, error: 'cordis.patch.yml:4:1: 流式集合缺少闭合的 "}"' },
  });
  const response = await routes[0].fetch(new Request('http://localhost/api/studymate/status'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.registration, { ok: false, error: 'cordis.patch.yml:4:1: 流式集合缺少闭合的 "}"' });
  // 状态卡其余字段照常：预设没注册上不代表工作区读不了。
  assert.equal(body.subjects.length, 1);
});

test('状态路由：GET 恒 200，形状与 buildStatus 一致', async t => {
  const home = tempHome(t);
  const workspace = path.join(home, '学习资料');
  fs.mkdirSync(workspace, { recursive: true });
  writeSubject(workspace, 'demo');
  writeConfig(workspace);

  const routes = [];
  const ctx = {
    inject(names, handler) {
      handler({
        connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
        effect: (fn) => { const dispose = fn(); return dispose; },
      });
    },
  };
  registerStatusRoute(ctx, { profile: 'web' });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/studymate/status');
  assert.deepEqual(routes[0].methods, ['GET']);

  const response = await routes[0].fetch(new Request('http://localhost/api/studymate/status'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.subjects.length, 1);
  assert.equal(body.generated_at.length > 0, true);
});
