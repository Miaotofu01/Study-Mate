/* 安装 · 「学习模式」预设的注册（`lib/preset.ts`）
   ────────────────────────────────────────────────────────────────────────
   这条套件是 原 Python 套件 `test_dsh_presets`（安装助手的验收面）
   的**行为移植**：Python 退场之后，它守的东西一件都没退役——每一台机器上的
   `npx install` 都还要把预设注册进 profile 的 `cordis.patch.yml`，而那份文件是**用户的**
   配置：注释、`!!js` 表达式、单引号写法、CRLF、流式列表都得原样留着。

   钉住四件事：

     · **形状**：返回值与 Python 版 stdout 逐字段一致（`{patchPath, patchChanged, mode}`，
       `mode === 'bundle'` 时多一个 `config`）——安装器读的就是它；
     · **幂等**：装第二次不产生任何字节变化，卸载式切换（回到 legacy）只删自己的托管块；
     · **不越权**：手动声明的 learning 预设、手动插的 StudyMate 入口、越界 profile 名、
       符号链接、坏清单——一律**在写盘之前**失败，一个字节都不落；
     · **真读我们发货的那份预设**：`preset/learning/agent.cordis.yml` 有 `>-` / `|` 块标量与
       `!!js` 标签，解析器要能读（读不了，bundle 模式给 DSH 的 config 就是错的）。

   夹具全部现造现弃（ADR-0009）：临时 HOME、拷一份真预设进去，跑完删。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { installPreset } from '../../lib/preset.ts';
import { parseYaml } from '../../lib/yaml.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN = '@deepseek-ai/dsh-agent-preset';
const BEGIN = '# BEGIN STUDYMATE LEARNING PRESET';
const BUNDLE = '@yunmiao/studymate';

/** 解析一份补丁文件。`!!js` 与 CordisLoader 同口径：读成它的标量原文。 */
function parsed(file) {
  return parseYaml(fs.readFileSync(file, 'utf8'),
    { file, tags: 'scalar', blockScalars: true, documentMarkers: true });
}

/** 展开托管行进 insert/group 的嵌套（与安装器内部的 rows() 同一口径）。 */
function rows(data) {
  const found = [];
  for (const row of Array.isArray(data) ? data : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    found.push(row);
    if (Array.isArray(row.insert)) found.push(...rows(row.insert));
    if (row.group === true && Array.isArray(row.config)) found.push(...rows(row.config));
  }
  return found;
}

/** 在临时 HOME 里摆一份可安装的预设目录（真预设的副本：学习 + 答疑）。 */
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-preset-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "dsh O'Brien 中文");
  const staged = path.join(home, 'staged-learning');
  const stagedQa = path.join(home, 'staged-qa');
  fs.mkdirSync(home, { recursive: true });
  fs.cpSync(path.join(ROOT, 'preset', 'learning'), staged, { recursive: true });
  fs.cpSync(path.join(ROOT, 'preset', 'qa'), stagedQa, { recursive: true });
  const patch = path.join(home, 'profiles', 'web', 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  return { temporary, home, staged, stagedQa, target: path.join(home, '.agent-presets', 'learning'), patch };
}

/** 调一次注册。默认 dsh 版本 0.1.7-alpha.1（声明式那条路）；`qa: true` 才带上第二条预设
    （已有的用例一个都不动它们的环境，见下面那条「两条预设共用一段托管块」）。 */
function invoke(f, options = {}) {
  const { version = '0.1.7-alpha.1', profile, mode, bundle, patchOutput, qa, presetId } = options;
  return installPreset({
    presetDir: f.staged, dshHome: f.home,
    ...(qa ? { extraPresets: [{ id: 'qa', dir: f.stagedQa }] } : {}),
    ...(presetId === undefined ? {} : { presetId }),
    ...(profile === undefined ? {} : { profile }),
    ...(mode === undefined ? {} : { mode }),
    ...(bundle === undefined ? {} : { bundle }),
    ...(patchOutput === undefined ? {} : { patchOutput }),
    ...(version === null ? {} : { dshVersion: version }),
  });
}

/** 斐波那契式地找一份能用的空 PATH：没有 dsh 的机器（探针要真的探不到）。 */
function withoutDsh(t) {
  const previous = process.env.PATH;
  process.env.PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-nodsh-')), 'no-programs');
  t.after(() => { process.env.PATH = previous; });
}

test('版本边界各自独立：workflow 在 0.1.6、声明式在 0.1.7（每级都要单独验）', (t) => {
  const f = fixture(t);
  const cases = [
    ['0.1.5-rc.2', 'worker-thread', 'legacy'],
    ['0.1.6-alpha.0', 'worker-thread', 'legacy'],
    ['0.1.6-alpha.1', 'ptc', 'legacy'],
    ['0.1.6-alpha.2', 'ptc', 'legacy'],
    ['0.1.7-alpha.0', 'ptc', 'legacy'],
    ['0.1.7-alpha.1', 'ptc', 'declarative'],
    ['0.1.7', 'ptc', 'declarative'],
  ];
  for (const [version, workflow, mode] of cases) {
    const result = invoke(f, { version });
    assert.equal(result.mode, mode, version);
    assert.ok(fs.readFileSync(path.join(f.staged, 'agent.cordis.yml'), 'utf8')
      .includes(`name: '@deepseek-ai/dsh-workflow-${workflow}'`), version);
  }
  invoke(f, { version: '0.1.5-rc.2' });
  assert.ok(!fs.readFileSync(f.patch, 'utf8').includes(BEGIN), 'legacy 不该留托管块');
});

test('已有补丁的形态被保留，且装第二次一个字节都不动', (t) => {
  const f = fixture(t);
  const cases = [
    '',
    '[]\n',
    '[# empty comment\n]\n',
    '[{id: unrelated}]\n',
    '[{id: unrelated}, # trailing comment\n]\n',
    "# retained\n- id: unrelated\n  disabled: !!js process.platform === 'win32'\n",
    '\ufeff# retained\r\n[{id: unrelated, disabled: !!js "process.platform === \'win32\'"}]\r\n',
    '---\n- id: unrelated\n...\n',
  ];
  for (const original of cases) {
    fs.writeFileSync(f.patch, original, 'utf8');
    const expected = parsed(f.patch) ?? [];
    assert.equal(invoke(f).patchChanged, true, `第一次应该写盘：${JSON.stringify(original)}`);
    const first = fs.readFileSync(f.patch);
    assert.deepEqual((parsed(f.patch) ?? []).slice(0, -1), expected, original);
    if (original.includes('!!js')) assert.ok(first.includes('!!js'), '!!js 表达式要原样留着');
    if (original.includes('\r\n')) assert.ok(first.includes('# retained\r\n'), 'CRLF 要原样留着');
    assert.equal(invoke(f).patchChanged, false, `第二次不该改动：${JSON.stringify(original)}`);
    assert.deepEqual(fs.readFileSync(f.patch), first, original);
    invoke(f, { version: '0.1.5-rc.2' });
    assert.deepEqual(parsed(f.patch) ?? [], expected, '回到 legacy 只该删掉托管块');
    assert.ok(!fs.readFileSync(f.patch, 'utf8').includes(BEGIN), original);
  }
});

test('暂存：--patch-output 保留活动补丁，托管行里内联活的插件定义', (t) => {
  const f = fixture(t);
  const original = Buffer.from('# user patch\n[]\n', 'utf8');
  fs.writeFileSync(f.patch, original);
  const output = path.join(f.home, 'staged.patch.yml');
  const result = invoke(f, { patchOutput: output });
  assert.equal(result.patchPath, output);
  assert.deepEqual(fs.readFileSync(f.patch), original, '不带 --patch-output 时绝不碰 profile 那份');
  const registration = parsed(output).at(-1).insert[0];
  assert.equal(registration.name, PLUGIN);
  assert.equal(registration.config.id, 'learning');
  assert.equal(registration.config.plugins[0].name, '@deepseek-ai/dsh-persona');
  assert.ok(!registration.config.plugins.some(row => row.name === 'cordis:include'),
    '内联定义不能换成外部 include（模块解析会跑到预设目录去）');
  const bash = registration.config.plugins.find(row => row.id === 'tool-bash');
  assert.deepEqual(bash.disabled, { __jsExpr: "process.platform === 'win32'" },
    '!!js 要落成 DSH 的原生 JSON 表示');
  const delegation = registration.config.plugins.find(row => row.id === 'delegation');
  assert.ok(delegation.config.some(row => row.name === '@deepseek-ai/dsh-workflow-ptc'));
});

test('手动声明的 learning 预设不被覆盖，且一个字都不写', (t) => {
  const f = fixture(t);
  const original = `- insert:\n  - id: user-learning\n    name: "${PLUGIN}"\n`
    + '    config: {id: learning, name: Custom, plugins: []}\n';
  fs.writeFileSync(f.patch, original, 'utf8');
  const before = fs.readFileSync(path.join(f.staged, 'agent.cordis.yml'));
  assert.throws(() => invoke(f), /learning/);
  assert.equal(fs.readFileSync(f.patch, 'utf8'), original);
  assert.deepEqual(fs.readFileSync(path.join(f.staged, 'agent.cordis.yml')), before);
});

test('非法或冲突的补丁一律失败且不写盘', (t) => {
  const f = fixture(t);
  const declaration = `- name: "${PLUGIN}"\n  config: {id: learning, plugins: []}\n`;
  const duplicate = declaration.replace('- name:', '- id: first\n  name:');
  const cases = [
    '{}\n', 'null\n', '[]\n---\n[]\n', `${BEGIN}\n- id: incomplete\n`,
    declaration, duplicate + duplicate.replaceAll('first', 'second'),
    '- id: studymate-learning-preset\n  name: user-plugin\n',
  ];
  for (const content of cases) {
    fs.writeFileSync(f.patch, content, 'utf8');
    const before = fs.readFileSync(path.join(f.staged, 'agent.cordis.yml'));
    assert.throws(() => invoke(f), `应当失败：${JSON.stringify(content)}`);
    assert.equal(fs.readFileSync(f.patch, 'utf8'), content);
    assert.deepEqual(fs.readFileSync(path.join(f.staged, 'agent.cordis.yml')), before);
  }
  fs.writeFileSync(f.patch, '[]\n', 'utf8');
  fs.writeFileSync(path.join(f.home, 'cordis.patch.yml'), duplicate, 'utf8');
  assert.throws(() => invoke(f), /全局声明/);
  assert.equal(fs.readFileSync(f.patch, 'utf8'), '[]\n');
});

test('profile 名不能越界，也不能指向保留位置', (t) => {
  const f = fixture(t);
  for (const profile of ['../web', 'a/b', 'a\\b', '.', '..', '', 'node_modules']) {
    assert.throws(() => invoke(f, { profile }), /--profile/, `profile=${JSON.stringify(profile)}`);
    assert.equal(fs.existsSync(f.patch), false, `profile=${JSON.stringify(profile)}`);
  }
  const custom = 'study.local 中文';
  invoke(f, { profile: custom });
  assert.ok(fs.existsSync(path.join(f.home, 'profiles', custom, 'cordis.patch.yml')));
  assert.equal(fs.existsSync(f.patch), false);
});

test('桌面端档位用启动器的拼法（Desktop 会建出没人读的目录）', (t) => {
  const f = fixture(t);
  invoke(f, { profile: 'Desktop' });
  assert.ok(fs.existsSync(path.join(f.home, 'profiles', 'desktop', 'cordis.patch.yml')));
  assert.equal(fs.existsSync(f.patch), false);
  assert.ok(!fs.readdirSync(path.join(f.home, 'profiles')).includes('Desktop'));
});

test('探不到 dsh 的源码安装退回 legacy：不改配置，也不建补丁文件', (t) => {
  const f = fixture(t);
  withoutDsh(t);
  const result = invoke(f, { version: null });
  assert.equal(result.mode, 'legacy');
  assert.equal(result.patchChanged, false);
  assert.equal(fs.existsSync(f.patch), false);
});

test('预设让角色能派一层：maxDepth 显式写 2，fork 保持关闭', (t) => {
  const f = fixture(t);
  invoke(f);
  const rows = [];
  const walk = (value) => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (value && typeof value === 'object') { rows.push(value); for (const item of Object.values(value)) walk(item); }
  };
  walk(parsed(path.join(f.staged, 'agent.cordis.yml')));
  const byId = new Map(rows.filter(row => row.id).map(row => [row.id, row]));
  assert.equal(byId.get('tool-subagent').config.maxDepth, 2,
    'tool-subagent 必须显式写 maxDepth（省略=1，角色派不动）');
  assert.equal(byId.get('tool-subagent-fork').disabled, true, 'fork 必须保持关闭');
});

test('bundle 模式：不读 dsh、不写 profile，直接给 DSH 一份可用 config', (t) => {
  const f = fixture(t);
  withoutDsh(t);
  const result = invoke(f, { version: null, bundle: true });
  assert.equal(result.mode, 'bundle');
  assert.equal(result.patchChanged, false);
  assert.equal(fs.existsSync(f.patch), false);
  const config = result.config;
  assert.equal(config.id, 'learning');
  assert.equal(config.name, '学习模式');
  const bash = config.plugins.find(row => row.id === 'tool-bash');
  assert.deepEqual(bash.disabled, { __jsExpr: "process.platform === 'win32'" });
  const delegation = config.plugins.find(row => row.id === 'delegation');
  assert.ok(delegation.config.some(row => row.name === '@deepseek-ai/dsh-workflow-ptc'));
  // workflow 行的改写仍然落在预设目录自己那份（安装器随后整目录替换到位）
  assert.ok(fs.readFileSync(path.join(f.staged, 'agent.cordis.yml'), 'utf8').includes('dsh-workflow-ptc'));
});

test('bundle 启动拒绝隐式迁移，且不写任何文件', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.patch, '# retained\n[]\n', 'utf8');
  invoke(f);
  const registered = fs.readFileSync(f.patch);
  const before = fs.readFileSync(path.join(f.staged, 'agent.cordis.yml'));
  const output = path.join(f.home, 'bundle.patch.yml');
  assert.throws(() => invoke(f, { bundle: true, patchOutput: output }), /--mode native/);
  assert.deepEqual(fs.readFileSync(f.patch), registered);
  assert.deepEqual(fs.readFileSync(path.join(f.staged, 'agent.cordis.yml')), before);
  assert.equal(fs.existsSync(output), false);
});

test('显式切到原生只删自己那段托管块，注释与 !!js 原样留', (t) => {
  const f = fixture(t);
  const manifest = path.join(path.dirname(f.patch), 'package.json');
  const manifestText = JSON.stringify({ dsh: { profile: { bundles: [BUNDLE] } } });
  fs.writeFileSync(manifest, manifestText, 'utf8');
  const cases = [
    '# retained\n[]\n',
    '\ufeff# retained\r\n[{id: other, disabled: !!js "false"}]\r\n',
    '# retained\n- id: other\n  disabled: !!js false\n',
  ];
  for (const original of cases) {
    fs.writeFileSync(f.patch, original, 'utf8');
    invoke(f);
    const registered = fs.readFileSync(f.patch);
    const output = path.join(f.home, 'native.patch.yml');
    const result = invoke(f, { mode: 'native', patchOutput: output });
    assert.equal(result.mode, 'bundle');
    assert.equal(result.patchChanged, true);
    assert.deepEqual(fs.readFileSync(f.patch), registered, 'profile 那份要等安装器最后替换');
    const expected = original.trim() === '' || original.startsWith('#') || original.startsWith('\ufeff#')
      ? (parseYaml(original, { tags: 'scalar', documentMarkers: true }) ?? [])
      : (parseYaml(original, { tags: 'scalar', blockScalars: true, documentMarkers: true }) ?? []);
    assert.deepEqual(parsed(output) ?? [], expected);
    assert.ok(!fs.readFileSync(output, 'utf8').includes(BEGIN));
    assert.ok(fs.readFileSync(output).includes('# retained'));
    if (original.includes('\r\n')) assert.ok(fs.readFileSync(output).includes('# retained\r\n'));
    if (original.includes('!!js')) assert.ok(fs.readFileSync(output).includes('!!js'));
    fs.copyFileSync(output, f.patch);
    const settled = fs.readFileSync(f.patch);
    assert.equal(invoke(f, { mode: 'native' }).patchChanged, false);
    assert.deepEqual(fs.readFileSync(f.patch), settled);
    assert.equal(invoke(f, { bundle: true }).patchChanged, false);
    assert.deepEqual(fs.readFileSync(f.patch), settled);
    assert.equal(fs.readFileSync(manifest, 'utf8'), manifestText);
  }
});

test('原生交接后，空的或只有注释的补丁仍是合法列表（DSH 拒绝加载 null 文档）', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(path.dirname(f.patch), 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: [BUNDLE] } } }), 'utf8');
  for (const original of ['', '# keep this comment\n', '\ufeff# keep this comment\r\n', '---\n[]\n...\n']) {
    fs.writeFileSync(f.patch, original, 'utf8');
    invoke(f);
    invoke(f, { mode: 'native' });
    assert.deepEqual(parsed(f.patch), [], JSON.stringify(original));
    assert.ok(Array.isArray(parseYaml(fs.readFileSync(f.patch, 'utf8'),
      { tags: 'scalar', documentMarkers: true })), '顶层必须是列表');
    if (original.includes('# keep this comment')) {
      assert.ok(fs.readFileSync(f.patch, 'utf8').includes('# keep this comment'));
    }
    assert.ok(!fs.readFileSync(f.patch, 'utf8').includes(BEGIN));
  }
});

test('默认 CLI 在 bundle 被选中时保持归属：停用原生入口 + 声明式预设', (t) => {
  const f = fixture(t);
  const manifest = path.join(path.dirname(f.patch), 'package.json');
  const original = '# keep\n- id: unrelated\n  disabled: true\n';
  const manifestText = JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', BUNDLE] } } });
  fs.writeFileSync(manifest, manifestText, 'utf8');
  for (const [version, mode] of [['0.1.7-alpha.1', 'declarative'], ['0.1.5-rc.2', 'legacy']]) {
    fs.writeFileSync(f.patch, original, 'utf8');
    const result = invoke(f, { version });
    assert.equal(result.mode, mode);
    assert.ok(fs.readFileSync(f.patch, 'utf8').includes(BEGIN));
    const flat = parsed(f.patch);
    assert.deepEqual(flat.filter(row => row.id === 'studymate'),
      [{ id: 'studymate', name: BUNDLE, disabled: true }]);
    const learning = rows(parsed(f.patch)).filter(row => row.name === PLUGIN);
    assert.equal(learning.length, mode === 'declarative' ? 1 : 0);
    assert.equal(flat[0].id, 'unrelated', '用户的配置行要留在原处');
    assert.equal('config' in result, false);
    assert.equal(invoke(f, { version }).patchChanged, false);
    assert.equal(fs.readFileSync(manifest, 'utf8'), manifestText);
  }
  // 只是把依赖装上了，不等于启用了这个 bundle
  fs.writeFileSync(manifest, JSON.stringify({ dependencies: { [BUNDLE]: '*' }, dsh: { profile: { bundles: [] } } }), 'utf8');
  assert.equal(invoke(f).mode, 'declarative');
  assert.ok(!parsed(f.patch).some(row => row.id === 'studymate'));
  assert.equal(invoke(f, { version: '0.1.5-rc.2' }).mode, 'legacy');
  assert.ok(!fs.readFileSync(f.patch, 'utf8').includes(BEGIN));
});

test('切原生需要宿主支持且 bundle 已被选中（否则一个字都不写）', (t) => {
  const f = fixture(t);
  invoke(f);
  const before = fs.readFileSync(f.patch);
  assert.throws(() => invoke(f, { mode: 'native' }), new RegExp(BUNDLE.replace('/', '\\/')));
  assert.deepEqual(fs.readFileSync(f.patch), before);
  fs.writeFileSync(path.join(path.dirname(f.patch), 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: [BUNDLE] } } }), 'utf8');
  for (const version of ['0.1.5-rc.2', '0.1.6-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.0']) {
    assert.throws(() => invoke(f, { version, mode: 'native' }), /0\.1\.7-alpha\.1/, version);
    assert.deepEqual(fs.readFileSync(f.patch), before);
  }
  assert.throws(() => invoke(f, { bundle: true, mode: 'native' }));
  assert.deepEqual(fs.readFileSync(f.patch), before);
});

test('切原生尊重 profile 或 home 补丁里的手动停用', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(path.dirname(f.patch), 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: [BUNDLE] } } }), 'utf8');
  const homePatch = path.join(f.home, 'cordis.patch.yml');
  for (const location of [f.patch, homePatch]) {
    for (const disabled of ['true', "!!js process.platform === 'win32'"]) {
      fs.writeFileSync(f.patch, '[]\n', 'utf8');
      fs.writeFileSync(homePatch, '[]\n', 'utf8');
      const manual = `- id: studymate\n  disabled: ${disabled}\n`;
      fs.writeFileSync(location, manual, 'utf8');
      assert.throws(() => invoke(f, { mode: 'native' }), `${location} / ${disabled}`);
      assert.equal(fs.readFileSync(location, 'utf8'), manual);
    }
  }
});

test('studyMate 的 group 行不被当成可停用的插件', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(path.dirname(f.patch), 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: [BUNDLE] } } }), 'utf8');
  const homePatch = path.join(f.home, 'cordis.patch.yml');
  for (const location of [f.patch, homePatch]) {
    for (const options of [{}, { mode: 'native' }, { bundle: true }]) {
      fs.writeFileSync(f.patch, '[]\n', 'utf8');
      fs.writeFileSync(homePatch, '[]\n', 'utf8');
      const manual = '- id: studymate\n  group: true\n  config: []\n';
      fs.writeFileSync(location, manual, 'utf8');
      const before = fs.readFileSync(path.join(f.staged, 'agent.cordis.yml'));
      const output = path.join(f.home, 'blocked-group.patch.yml');
      assert.throws(() => invoke(f, { ...options, patchOutput: output }), `${location}`);
      assert.equal(fs.readFileSync(location, 'utf8'), manual);
      assert.deepEqual(fs.readFileSync(path.join(f.staged, 'agent.cordis.yml')), before);
      assert.equal(fs.existsSync(output), false);
    }
  }
});

test('声明式守卫在导入之前停用缺包的宿主（表达式要真跑一遍）', (t) => {
  const f = fixture(t);
  invoke(f);
  const registration = rows(parsed(f.patch)).find(row => row.name === PLUGIN);
  const expression = registration.disabled.__jsExpr;
  const evaluate = ctx => new Function('ctx', `return (${expression});`)(ctx);
  assert.equal(evaluate({}), true);
  assert.equal(evaluate({ get: () => undefined }), true);
  assert.equal(evaluate({ get: () => ({ packageOf: () => undefined }) }), true);
  assert.equal(evaluate({ get: () => ({ packageOf: () => { throw new Error('missing package'); } }) }), true);
  const baseUrl = 'file:///dsh/profiles/web/';
  assert.equal(evaluate({
    baseUrl,
    get: (name) => {
      assert.equal(name, 'pluginPackages');
      return {
        packageOf: (plugin, base) => {
          assert.equal(plugin, PLUGIN);
          assert.equal(base, baseUrl);
          return { name: plugin };
        },
      };
    },
  }), false);
});

test('bundle 拒绝手动声明（profile 或全局），且不写盘', (t) => {
  const f = fixture(t);
  const declaration = `- insert:\n  - id: user-learning\n    name: "${PLUGIN}"\n`
    + '    config: {id: learning, name: Custom, plugins: []}\n';
  for (const globalPatch of [false, true]) {
    for (const native of [false, true]) {
      fs.writeFileSync(f.patch, '[]\n', 'utf8');
      const homePatch = path.join(f.home, 'cordis.patch.yml');
      fs.writeFileSync(homePatch, '[]\n', 'utf8');
      const conflict = globalPatch ? homePatch : f.patch;
      fs.writeFileSync(conflict, declaration, 'utf8');
      fs.writeFileSync(path.join(path.dirname(f.patch), 'package.json'),
        JSON.stringify({ dsh: { profile: { bundles: [BUNDLE] } } }), 'utf8');
      const before = fs.readFileSync(path.join(f.staged, 'agent.cordis.yml'));
      const output = path.join(f.home, 'blocked.patch.yml');
      assert.throws(() => invoke(f, { ...(native ? { bundle: true } : {}), patchOutput: output }), /learning/);
      assert.equal(fs.readFileSync(conflict, 'utf8'), declaration);
      assert.deepEqual(fs.readFileSync(path.join(f.staged, 'agent.cordis.yml')), before);
      assert.equal(fs.existsSync(output), false);
    }
  }
});

test('坏的 bundle 清单或坏补丁失败且不写盘', (t) => {
  const f = fixture(t);
  const manifest = path.join(path.dirname(f.patch), 'package.json');
  fs.writeFileSync(f.patch, '[]\n', 'utf8');
  for (const value of ['{broken', '[]', '{"dsh": null}',
    '{"dsh":{"profile":{"bundles":"@yunmiao/studymate"}}}', '{"dsh":{"profile":{"bundles":[null]}}}']) {
    fs.writeFileSync(manifest, value, 'utf8');
    const before = fs.readFileSync(path.join(f.staged, 'agent.cordis.yml'));
    assert.throws(() => invoke(f), /package\.json/, value);
    assert.equal(fs.readFileSync(f.patch, 'utf8'), '[]\n');
    assert.deepEqual(fs.readFileSync(path.join(f.staged, 'agent.cordis.yml')), before);
  }
  fs.rmSync(manifest);
  fs.writeFileSync(f.patch, `${BEGIN}\n- id: incomplete\n`, 'utf8');
  assert.throws(() => invoke(f, { bundle: true }), /标记/);
});

test('符号链接一律不覆盖（预设或补丁）', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const link = path.join(f.home, 'linked.patch.yml');
  fs.writeFileSync(path.join(f.home, 'real.patch.yml'), '[]\n', 'utf8');
  fs.symlinkSync(path.join(f.home, 'real.patch.yml'), link);
  assert.throws(() => invoke(f, { patchOutput: link }), /符号链接/);
  fs.rmSync(link);
  const presetLink = path.join(f.home, 'linked-preset');
  fs.mkdirSync(presetLink);
  fs.symlinkSync(path.join(f.staged, 'agent.cordis.yml'), path.join(presetLink, 'agent.cordis.yml'));
  fs.copyFileSync(path.join(f.staged, 'preset.yml'), path.join(presetLink, 'preset.yml'));
  const before = fs.readFileSync(path.join(f.home, 'real.patch.yml'));
  assert.throws(() => installPreset({
    presetDir: presetLink, dshHome: f.home, dshVersion: '0.1.7',
  }), /符号链接/);
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'real.patch.yml')), before);
});

/* ── #104：第二条预设「答疑模式」与学习模式共用一段托管块 ─────────────────
   已有的用例一个都没放宽：它们仍按「只注册学习模式」跑（`invoke` 不带 `qa`）。这里补的是
   **新事实**——同一次调用带两条预设时，托管块仍是**一个** BEGIN/END 块，里面两行 insert。 */

test('答疑模式与学习模式共用一段托管块：一个 BEGIN/END，两行 insert（各占一行）', (t) => {
  const f = fixture(t);
  const original = '# user patch\n[]\n';
  fs.writeFileSync(f.patch, original, 'utf8');
  const result = invoke(f, { qa: true });
  assert.equal(result.mode, 'declarative');
  assert.equal(result.patchChanged, true);
  const text = fs.readFileSync(f.patch, 'utf8');
  assert.equal(text.split(BEGIN).length - 1, 1, '托管块只能有一个 BEGIN');
  assert.equal(text.split('# END STUDYMATE LEARNING PRESET').length - 1, 1);
  assert.ok(text.includes('# user patch'), '用户的配置原样留着');
  const declarations = rows(parsed(f.patch)).filter(row => row.name === PLUGIN);
  assert.deepEqual(declarations.map(row => row.id),
    ['studymate-learning-preset', 'studymate-qa-preset'], '两条预设各一行，顺序固定');
  assert.deepEqual(declarations.map(row => row.config.id), ['learning', 'qa']);
  // 学习那一条逐字段没变：还是那份真预设的元数据与插件行
  assert.equal(declarations[0].config.name, '学习模式');
  assert.equal(declarations[0].config.plugins[0].name, '@deepseek-ai/dsh-persona');
  // 答疑那一条：名字/顺序与学习并列但不同；技能目录只指 local-qa（占位符还在——替换是安装器的活）
  assert.equal(declarations[1].config.name, '答疑模式');
  assert.equal(declarations[1].config.order, 20);
  assert.notEqual(declarations[1].config.order, declarations[0].config.order);
  const skillRow = declarations[1].config.plugins.find(row => row.id === 'skill-filesystem');
  assert.deepEqual(skillRow.config.customSkillDirs, ['__STUDYMATE_SKILLS__/local-qa']);
  assert.equal(skillRow.config.includeDefaultRoots, false);
  assert.ok(declarations[1].config.plugins.some(row => row.id === 'studymate-qa-tools'
    && row.name === '@yunmiao/studymate/qa-preset'));
  // 幂等：再来一次一个字节都不动
  assert.equal(invoke(f, { qa: true }).patchChanged, false);
  assert.equal(fs.readFileSync(f.patch, 'utf8'), text);
  // 回到 legacy：两块托管行一起删，用户那行原样留
  invoke(f, { version: '0.1.5-rc.2', qa: true });
  assert.ok(!fs.readFileSync(f.patch, 'utf8').includes(BEGIN));
  assert.ok(fs.readFileSync(f.patch, 'utf8').includes('# user patch'));
});

test('答疑模式单独被手动声明时也拦下（两条预设的 id 都认）', (t) => {
  const f = fixture(t);
  const declaration = `- insert:\n  - id: user-qa\n    name: "${PLUGIN}"\n`
    + '    config: {id: qa, name: Custom, plugins: []}\n';
  fs.writeFileSync(f.patch, declaration, 'utf8');
  const before = fs.readFileSync(path.join(f.stagedQa, 'agent.cordis.yml'));
  assert.throws(() => invoke(f, { qa: true }), /qa/);
  assert.equal(fs.readFileSync(f.patch, 'utf8'), declaration);
  assert.deepEqual(fs.readFileSync(path.join(f.stagedQa, 'agent.cordis.yml')), before);
});

test('主预设 id 可参数化（默认仍是 learning）：托管行与 config.id 都跟着它', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.patch, '[]\n', 'utf8');
  invoke(f, { presetId: 'other' });
  const declaration = rows(parsed(f.patch)).find(row => row.name === PLUGIN);
  assert.equal(declaration.id, 'studymate-other-preset');
  assert.equal(declaration.config.id, 'other');
  // 默认那一侧没变：不带 presetId 时还是 learning 的三样
  const defaults = fixture(t);
  fs.writeFileSync(defaults.patch, '[]\n', 'utf8');
  invoke(defaults);
  const learning = rows(parsed(defaults.patch)).find(row => row.name === PLUGIN);
  assert.equal(learning.id, 'studymate-learning-preset');
  assert.equal(learning.config.id, 'learning');
  // bundle 那条路也认这个参数
  const bundled = invoke(fixture(t), { version: null, bundle: true, presetId: 'other' });
  assert.equal(bundled.config.id, 'other');
});

test('bundle 模式给两条 config：学习的字段名一字不改，答疑的另给 qaConfig', (t) => {
  const f = fixture(t);
  withoutDsh(t);
  const result = invoke(f, { version: null, bundle: true, qa: true });
  assert.equal(result.mode, 'bundle');
  assert.equal(result.patchChanged, false);
  assert.equal(fs.existsSync(f.patch), false);
  assert.equal(result.config.id, 'learning');
  assert.equal(result.config.name, '学习模式');
  assert.equal(result.qaConfig.id, 'qa');
  assert.equal(result.qaConfig.name, '答疑模式');
  assert.equal(result.qaConfig.description.includes('答疑'), true);
  assert.deepEqual(result.qaConfig.plugins.find(row => row.id === 'skill-filesystem')
    .config.customSkillDirs, ['__STUDYMATE_SKILLS__/local-qa']);
  // 最小面：那条插件行只有四行，没有 shell / 文件 / 子 agent / workflow
  assert.deepEqual(result.qaConfig.plugins.map(row => row.id),
    ['persona', 'skill-filesystem', 'tool-skill', 'studymate-qa-tools']);
  // 不带 qa 时旧形状仍然只有 config、没有 qaConfig
  const alone = invoke(f, { version: null, bundle: true });
  assert.equal('qaConfig' in alone, false);
});
