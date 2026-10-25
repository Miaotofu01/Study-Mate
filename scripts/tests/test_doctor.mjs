/* 诊断与健康检查（PR 1）的特征化测试。
   ─────────────────────────────────────────────────────────────────────────
   这里不启动真 DSH：doctor 的判据都是文件/环境事实，用临时 DSH_HOME 就能覆盖。
   最后一条会走真正的 `registerHealthRoute`，确认它按 `/api/studymate/health` 挂上，
   返回的也是同一份报告，而不是另拼一个形状。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEALTH_PATH,
  collectDoctorReport,
  parseDoctorArgs,
  recordStartupFailure,
  registerHealthRoute,
  resetRuntimeHealthForTests,
} from '../../lib/doctor.ts';

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

function makeHome({ invalidConfig = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-doctor-'));
  TEMPS.push(root);
  const home = path.join(root, 'dsh');
  const workspace = path.join(root, 'ws');
  const profile = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.join(workspace, '.learning', 'subjects'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'studymate-config.yaml'),
    invalidConfig
      ? 'workspace: [unclosed\n'
      : `# installed by studymate\n${JSON.stringify({
        workspace,
        installModes: { web: 'native' },
      }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(profile, 'cordis.patch.yml'),
    [
      '# BEGIN STUDYMATE LEARNING PRESET',
      'studymate-learning-preset',
      'studymate-qa-preset',
      '# END STUDYMATE LEARNING PRESET',
      '',
    ].join('\n'),
  );
  return { root, home, workspace, profile };
}

test('parseDoctorArgs：只接受 doctor 的两个参数，未知参数直接报错', () => {
  assert.deepEqual(parseDoctorArgs(['--json', '--workspace', 'D:/StudyMate', '--profile', 'web']), {
    json: true,
    workspace: 'D:/StudyMate',
    profile: 'web',
  });
  assert.throws(() => parseDoctorArgs(['--nope']), /不支持的参数/);
  assert.throws(() => parseDoctorArgs(['--workspace']), /需要一个值/);
});

test('collectDoctorReport：干净配置 + 工作区 + 预设声明 = 无阻断项', () => {
  resetRuntimeHealthForTests();
  const { home, workspace } = makeHome();
  const report = collectDoctorReport({
    dshHome: home,
    workspace,
    profile: 'web',
    checkDsh: false,
    now: () => new Date('2026-10-25T00:00:00Z'),
  });
  assert.equal(report.config.parse, 'ok');
  assert.equal(report.workspace.ready, true);
  assert.equal(report.workspace.writable, true);
  assert.equal(report.presets.learning, 'declared');
  assert.equal(report.presets.qa, 'declared');
  assert.equal(report.runtime.startup, 'ok');
  assert.equal(report.ok, true);
  assert.equal(report.generated_at, '2026-10-25T00:00:00.000Z');
  assert.equal(report.checks.some((item) => item.status === 'fail'), false);
  assert.equal(report.model, null);
});

test('collectDoctorReport：坏配置给出 fail，不抛异常', () => {
  const { home, workspace } = makeHome({ invalidConfig: true });
  const report = collectDoctorReport({ dshHome: home, workspace, checkDsh: false });
  assert.equal(report.config.parse, 'invalid');
  assert.equal(report.ok, false);
  assert.equal(report.checks.some((item) => item.id === 'config' && item.status === 'fail'), true);
});

test('collectDoctorReport：启动失败记录会进入 runtime 与 checks', () => {
  resetRuntimeHealthForTests();
  recordStartupFailure('preset-registration', new Error('patch parse failed'));
  const { home, workspace } = makeHome();
  const report = collectDoctorReport({ dshHome: home, workspace, checkDsh: false });
  assert.equal(report.runtime.startup, 'failed');
  assert.equal(report.runtime.stage, 'preset-registration');
  assert.match(report.runtime.error, /patch parse failed/);
  assert.equal(report.checks.some((item) => item.id === 'runtime' && item.status === 'fail'), true);
  resetRuntimeHealthForTests();
});

test('registerHealthRoute：挂上精确路径，返回同一份结构化报告', async () => {
  resetRuntimeHealthForTests();
  const { home, workspace } = makeHome();
  const routes = [];
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { name: 'web', home };
      if (name === 'llm') return { listProviders: () => [{ id: 'fake-provider' }] };
      return undefined;
    },
    inject(names, handler) {
      assert.deepEqual(names, ['connection']);
      handler({
        connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
        effect: (fn) => { fn(); return () => {}; },
      });
    },
  };
  registerHealthRoute(ctx);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, HEALTH_PATH);
  assert.deepEqual(routes[0].methods, ['GET']);
  const response = await routes[0].fetch();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.workspace.path, workspace);
  assert.equal(body.config.parse, 'ok');
  assert.equal(body.model.available, true);
  resetRuntimeHealthForTests();
});

test('registerHealthRoute：没有 inject 的宿主不抛，也不假装挂上', () => {
  assert.doesNotThrow(() => registerHealthRoute({}));
});

test('插件入口真的会挂健康路由（不是只在测试里调了一次）', () => {
  const plugin = fs.readFileSync(new URL('../../bin/dsh-plugin.ts', import.meta.url), 'utf8');
  assert.match(plugin, /registerHealthRoute/);
  assert.match(plugin, /recordStartupFailure/);
});
