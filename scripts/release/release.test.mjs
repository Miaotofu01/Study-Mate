import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { addChangelog, bumpVersion, mergedPullRequests, notesFromChangelog, registryVersion,
  releaseNotes, releasePlan, validatePack, verifyPublished, verifyPublishOrder, publishWaitSeconds,
  publicationPending, waitForPublished, CLIENT_ENTRY, CLIENT_CHUNK, CLIENT_NOTICES,
  buildReleasePlugin, ensureGithubRelease, ensureReleaseAsset, withInstallationNotes } from './release.mjs';

const repository = 'Miaotofu01/Study-Mate';
const name = '@yunmiao/studymate';
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'studymate-release-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name, version: '0.1.1' }));
  git('add', 'package.json');
  git('commit', '-m', '最初版本');
  return { cwd, git, commit(file, message) {
    writeFileSync(join(cwd, file), message);
    git('add', file);
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  } };
}

test('stable patch/minor/major increments and rejects non-release inputs', () => {
  assert.equal(bumpVersion('0.1.1', 'patch'), '0.1.2');
  assert.equal(bumpVersion('0.1.9', 'minor'), '0.2.0');
  assert.equal(bumpVersion('0.9.9', 'major'), '1.0.0');
  for (const [version, bump] of [['1.2.3-beta', 'patch'], ['01.2.3', 'minor'], ['1.2.3', '$(echo danger)']]) {
    assert.throws(() => bumpVersion(version, bump));
  }
});

test('ordinary Chinese commits, full bodies and merged PRs survive changelog generation', () => {
  const notes = releaseNotes({ version: '0.1.2', baseTag: 'v0.1', date: '2026-09-23',
    commits: [{ sha: 'a'.repeat(40), subject: '修复学习模式 <script>', body: '保留详细说明\n第二行\n\n## 嵌入标题' }],
    pulls: [{ number: 4, title: '适配新版本 [DSH]' }] });
  assert.match(notes, /修复学习模式 &lt;script&gt;/);
  assert.match(notes, /第二行/);
  assert.match(notes, /compare\/v0\.1\.\.\.v0\.1\.2/);
  assert.match(notes, /pull\/4/);
  const previous = '# 更新记录\n\n## 手写记录\n\n原有文字\n';
  const changelog = addChangelog(previous, '0.1.2', notes);
  assert.ok(changelog.endsWith(previous.slice('# 更新记录\n\n'.length)));
  assert.equal(notesFromChangelog(changelog, '0.1.2'), notes.trim());
  assert.throws(() => addChangelog(changelog, '0.1.2', notes), /already contains/);
  assert.throws(() => addChangelog('## [0.1.2](url)\n', '0.1.2', notes), /already contains/);
});

test('first release includes history; v0.1 legacy tag bounds later release history', t => {
  const repo = fixture(t);
  const initial = repo.git('rev-parse', 'HEAD');
  assert.equal(releasePlan(repo.cwd, initial, 'patch').commits.length, 1);
  repo.git('tag', 'v0.1');
  const source = repo.commit('feature.txt', '完善中文功能\n\n保留普通提交的多行说明');
  repo.git('tag', 'not-a-release');
  const plan = releasePlan(repo.cwd, source, 'patch');
  assert.equal(plan.version, '0.1.2');
  assert.equal(plan.baseTag, 'v0.1');
  assert.equal(plan.commits.length, 1);
  assert.match(plan.commits[0].body, /多行说明/);
  assert.throws(() => releasePlan(repo.cwd, initial, 'patch'), /No commits/);
});

test('re-running the same source resumes only a matching annotated release tag', t => {
  const repo = fixture(t);
  repo.git('tag', 'v0.1');
  const source = repo.commit('change.txt', '兼容新版');
  const plan = releasePlan(repo.cwd, source, 'patch');
  writeFileSync(join(repo.cwd, 'package.json'), JSON.stringify({ name, version: plan.version }));
  repo.git('add', 'package.json');
  repo.git('commit', '-m', 'chore(release): v0.1.2');
  const { commits, retry, ...metadata } = plan;
  repo.git('tag', '-a', plan.tag, '-m', `StudyMate release metadata\n${JSON.stringify(metadata)}`);
  const resumed = releasePlan(repo.cwd, source, 'patch');
  assert.equal(resumed.retry, true);
  assert.equal(resumed.commit, repo.git('rev-parse', 'HEAD'));
  repo.git('tag', '-d', plan.tag);
  repo.git('tag', plan.tag);
  assert.throws(() => releasePlan(repo.cwd, source, 'patch'), /not created by this workflow/);
});

test('a tagged release cannot smuggle untested source changes into a retry', t => {
  const repo = fixture(t);
  const source = repo.git('rev-parse', 'HEAD');
  const plan = releasePlan(repo.cwd, source, 'patch');
  repo.commit('unexpected.mjs', 'untested source');
  repo.git('tag', '-a', plan.tag, '-m', `StudyMate release metadata\n${JSON.stringify(plan)}`);
  assert.throws(() => releasePlan(repo.cwd, source, 'patch'), /outside release metadata/);
});

test('merged PR lookup paginates and deduplicates, excluding unmerged or other-base PRs', async () => {
  const pr = (number, more = {}) => ({ number, merged_at: '2026-09-23', base: { ref: 'main', repo: { full_name: repository } }, ...more });
  const called = [];
  const pulls = await mergedPullRequests([{ sha: 'a' }, { sha: 'b' }], async path => {
    called.push(path);
    if (path.includes('/a/') && path.endsWith('page=1')) return Array.from({ length: 100 }, () => pr(4));
    return [pr(5), pr(6, { merged_at: null }), pr(7, { base: { ref: 'develop', repo: { full_name: repository } } })];
  });
  assert.deepEqual(pulls.map(pr => pr.number).sort(), [4, 5]);
  assert.ok(called.some(path => path.includes('/a/') && path.endsWith('page=2')));
});

test('npm status distinguishes unpublished from registry failure and immutable content conflicts', async () => {
  assert.equal(await registryVersion('0.1.2', async () => ({ status: 404 })), null);
  await assert.rejects(registryVersion('0.1.2', async () => ({ status: 503, ok: false })), /unknown/);
  const remote = { name, version: '0.1.2', dist: { integrity: 'sha512-matching' } };
  const pack = { version: '0.1.2', integrity: 'sha512-matching' };
  verifyPublished(remote, pack);
  assert.throws(() => verifyPublished(remote, { ...pack, integrity: 'sha512-other' }), /different contents/);
  verifyPublishOrder('0.1.2', { version: '0.1.1' });
  assert.throws(() => verifyPublishOrder('0.1.2', { version: '0.1.3' }), /refusing to replace/);
  assert.throws(() => verifyPublishOrder('0.1.2', { version: '1.0.0-beta' }), /not a stable version/);
});

// npm 对大包是异步入库：CLI 返回成功时 registry 上还查不到。2026-10-15 那次
// 8.1 MB 的包迟到约 55 分钟，旧的「60 次 × 5 秒」窗口把一次成功的发布报成失败，
// 且失败点在 GitHub Release 之前，发布只做了一半（#182）。
test('npm publication waiting tolerates delayed registry visibility and reports the waiting window', async t => {
  t.after(() => { delete process.env.RELEASE_NPM_WAIT_SECONDS; });
  const remote = { name, version: '2.0.2', dist: { integrity: 'sha512-matching' } };
  let clock = 0;
  const sleep = async ms => { clock += ms; };
  const now = () => clock;

  // 迟到 55 分钟的包：窗口够长就能等到，且前几分钟是密轮询。
  const slow = [];
  const found = await waitForPublished('2.0.2', {
    totalMs: 3600_000, sleep, now,
    request: async () => {
      slow.push(clock);
      return clock >= 3300_000 ? { status: 200, ok: true, json: async () => remote } : { status: 404 };
    },
  });
  assert.equal(found.remote, remote);
  assert.equal(found.attempts, slow.length);
  assert.ok(found.elapsed >= 3300_000 && found.elapsed <= 3600_000);
  assert.ok(slow.filter(at => at <= 60_000).length > 10, '前 60 秒应多次查询');

  // 窗口内始终没出现：返回 null 而不是抛错，调用方据此给出可诊断的现场。
  const missing = await waitForPublished('2.0.2', { totalMs: 60_000, sleep, now, request: async () => ({ status: 404 }) });
  assert.equal(missing.remote, null);
  assert.ok(missing.elapsed <= 60_000);
  const message = publicationPending('2.0.2', { ...missing, status: 0 });
  assert.match(message, /registry\.npmjs\.org\/@yunmiao\/studymate\/2\.0\.2/);
  assert.match(message, /队列/);
  assert.match(message, /RELEASE_NPM_WAIT_SECONDS/);

  process.env.RELEASE_NPM_WAIT_SECONDS = '120';
  assert.equal(publishWaitSeconds(), 120);
  process.env.RELEASE_NPM_WAIT_SECONDS = 'soon';
  assert.throws(() => publishWaitSeconds(), /RELEASE_NPM_WAIT_SECONDS/);
});

// 正式包里的客户端产物：exports["./client"] → dist/client.js，旁边是它的第三方许可全文。
const tarballFiles = ['package.json', 'README.md', 'cordis.patch.yml', CLIENT_ENTRY, CLIENT_CHUNK, CLIENT_NOTICES,
  'bin/dsh-plugin.ts', 'bin/studymate.mjs', 'bin/skill-compat.mjs',
  'bin/openai-plugin.mjs', 'bin/openai-skill-compat.mjs', 'bin/openai-interaction.mjs', 'bin/openai-skill-ui.mjs',
  'locale/en.json', 'locale/zh.json', 'docs/images/icon.png',
  'openai/studymate/scripts/interaction_state.mjs', 'openai/studymate/skills/learning-system/references/codex-interaction.md',
  'openai/studymate/.codex-plugin/plugin.json', 'docs/使用/Codex与ChatGPT.md',
  'preset/learning/agent.cordis.yml', 'preset/qa/agent.cordis.yml', 'lib/preset.ts', 'preset/skills/learning-system/SKILL.md',
  'antigravity/studymate/plugin.json', 'antigravity/studymate/rules/AGENTS.md',
  'schemas/subject.json', 'templates/MEMORY.yaml', 'templates/lab/0000-示例/check.sh',
  'templates/lab/干净态.sh', 'templates/lab/作答态.sh', 'templates/lab/自检.sh', 'docs/使用/使用说明.md'];
const tarballPack = () => ({ name, version: '0.1.2', files: tarballFiles.map(path => ({ path })) });

// package.json 的 files 是「打包清单」，validatePack 的白名单是「发放清单」——两张表分开维护，
// 于是真出过事：`antigravity/studymate/**` 进了 files，白名单没跟上，Release 在打包校验这步
// 自己把自己拦下（2026-09-29 的 run #8，Antigravity 落地后每次发布都会中）。
// 这条断言把两张表钉在一起：files 里每个模式都要能通过白名单。
test('every package.json files pattern passes the tarball allowlist', () => {
  const patterns = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).files;
  assert.ok(patterns.length > 0);
  const sample = pattern => {
    if (pattern.endsWith('/**')) return `${pattern.slice(0, -3)}/probe/probe.md`;
    if (pattern.includes('*')) return pattern.replace('*', 'probe');
    return pattern;
  };
  // 基线 = 已知的必需项，加上每个模式的一份样本（同一路径去重）。
  // 不再往夹具上**再拼一份**样本：那样「files 加了白名单没认的目录」不会红，
  // 「必需项真缺了」也会被糊过去。
  const paths = new Set(tarballPack().files.map(file => file.path));
  for (const pattern of patterns) paths.add(sample(pattern));
  validatePack({ ...tarballPack(), files: [...paths].map(path => ({ path })) });
  // 客户端入口、懒分块与许可全文必须在 files 里（少了它们，tarball 缺文件只在发布时才被发现）。
  for (const file of [CLIENT_ENTRY, CLIENT_CHUNK, CLIENT_NOTICES]) {
    assert.ok(patterns.includes(file), `package.json files 漏了 ${file}`);
  }
});

test('tarball inspection rejects personal workspace, credentials and incomplete payloads', () => {
  const pack = tarballPack();
  validatePack(pack);
  for (const path of ['workspace/我的科目/private.md', '.npmrc', 'templates/.env', 'scripts/release/release.mjs', '迁移前的 Python 渲染脚本']) {
    assert.throws(() => validatePack({ ...pack, files: [...pack.files, { path }] }), /Unexpected or private/);
  }
  assert.throws(() => validatePack({ ...pack, files: pack.files.filter(file => !file.path.startsWith('schemas/')) }), /missing schemas/);
  // 插件页的标题/简介/详情来自 locale/：整层丢了是**静默**退回包名与 README，所以前缀与基线 en 都要认。
  assert.throws(() => validatePack({ ...pack, files: pack.files.filter(file => !file.path.startsWith('locale/')) }), /missing locale/);
  for (const required of ['locale/en.json', 'locale/zh.json', 'docs/images/icon.png']) {
    assert.throws(() => validatePack({ ...pack, files: pack.files.filter(file => file.path !== required) }),
      error => error.message === `npm tarball is missing ${required}.`);
  }
  // #197：lab 骨架的代表文件丢了要被认出来（前缀检查抓不住「templates/ 里还有别的文件」）
  assert.throws(() => validatePack({ ...pack, files: pack.files.filter(file => file.path !== 'templates/lab/0000-示例/check.sh') }),
    error => error.message === 'npm tarball is missing templates/lab/0000-示例/check.sh.');
  for (const required of ['cordis.patch.yml', 'bin/dsh-plugin.ts']) {
    assert.throws(() => validatePack({ ...pack, files: pack.files.filter(file => file.path !== required) }),
      error => error.message === `npm tarball is missing ${required}.`);
  }
});

// 正式包的 tarball 里多了一样东西是 `dist/`：客户端 bundle（exports["./client"] → dist/client.js）
// 与它的许可全文。两张表分头维护的老毛病在这里更险——白名单写成 `dist/**` 通配，
// 网页验收产物（dist/notes-preview/）、构建报告（dist/client-build-report.json）就会跟着发出去。
test('the client bundle and its notices ship, and nothing else under dist/ does', () => {
  const pack = tarballPack();
  validatePack(pack);
  for (const file of [CLIENT_ENTRY, CLIENT_CHUNK, CLIENT_NOTICES]) {
    assert.throws(() => validatePack({ ...pack, files: pack.files.filter(entry => entry.path !== file) }),
      error => error.message === `npm tarball is missing ${file}.`);
  }
  // 名字接近但不是那三个名字的一律发不出去：`dist/client.js.map` 被整名匹配挡住
  // （`$` 不吃 `.map`）。这几条也是白名单写法本身的反证：
  //   · `dist/client.min.js`、`dist/probe/client.js` —— 「前缀通配」写法；
  //   · `dist/client.txt`、`dist/client-notices.js` —— 把两个名字写成一个可选式
  //     `dist/client(?:-notices)?\.(?:js|txt)` 时意外放行的组合，白名单必须是完整路径；
  //   · `dist/notes.js`、`dist/client.notes.js.map`、`dist/entry.cjs` —— 懒分块的同款反证。
  for (const path of ['dist/client-build-report.json', 'dist/notes-preview/index.html',
    'dist/notes-preview/assets/notes.js', 'dist/notes.cjs', 'dist/notes.css', 'dist/client.min.js',
    'dist/client.js.map', 'dist/probe/client.js', 'dist/client.txt', 'dist/client-notices.js',
    'dist/notes.js', 'dist/client.notes.js.map', 'dist/entry.cjs']) {
    const expected = `Unexpected or private file in npm tarball: ${path}.`;
    assert.throws(() => validatePack({ ...pack, files: [...pack.files, { path }] }),
      { message: expected }, `dist 白名单放行了 ${path}`);
  }
});

test('release CLI refuses local runs before touching repository, building or contacting registries', () => {
  const before = readFileSync(new URL('../../package.json', import.meta.url));
  // 换上会留下痕迹的 npm 垫片：发布路径一旦在拒绝之前就构建客户端，这里就看得到。
  const shims = mkdtempSync(join(tmpdir(), 'studymate-release-shim-'));
  const calls = join(shims, 'calls.txt');
  writeFileSync(join(shims, 'npm'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(shims, 'npm.cmd'), `@echo off\r\necho %*>> "${calls}"\r\nexit /b 0\r\n`);
  const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') || 'PATH';
  const env = { ...process.env, GITHUB_ACTIONS: 'false', [key]: `${shims}${process.platform === 'win32' ? ';' : ':'}${process.env[key]}` };
  try {
    const result = spawnSync(process.execPath, ['scripts/release/release.mjs', 'prepare'], { encoding: 'utf8', env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only allowed/);
    assert.equal(existsSync(calls), false, '本地运行不许触发任何 npm 调用（包括 build:client）');
  } finally {
    rmSync(shims, { recursive: true, force: true });
  }
  assert.deepEqual(readFileSync(new URL('../../package.json', import.meta.url)), before);
});

test('the real npm pack call always builds the client first: build, then pack --ignore-scripts', () => {
  const source = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export function packPackage('));
  const build = body.indexOf('build(execute);');
  const pack = body.indexOf("execute('npm', ['pack', '--json', '--ignore-scripts'");
  assert.ok(build >= 0, 'packPackage 必须自己构建客户端产物');
  assert.ok(pack > build, '构建必须在 npm pack 之前，且同一段里紧挨着');
  // pack 用 --ignore-scripts 是既定口径（prepack 不触发），所以不能靠 prepack 兜底。
  const client = readFileSync(new URL('../../scripts/build-client.mjs', import.meta.url), 'utf8');
  for (const output of ['client.js', 'client-notices.txt']) {
    assert.ok(client.includes(`path.join(destination, '${output}')`), `build-client.mjs 不再产出 ${output}`);
  }
  // 分块文件名经由 CHUNK_FILE 常量写出：常量与写出两处都钉住，防止改名或漏写。
  assert.ok(client.includes("const CHUNK_FILE = 'client.notes.js';"), 'build-client.mjs 丢了分块文件名常量');
  assert.ok(client.includes('path.join(destination, CHUNK_FILE)'), 'build-client.mjs 不再写出分块产物');
  const packageInfo = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(packageInfo.exports['./client'], './dist/client.js');
  for (const file of [CLIENT_ENTRY, CLIENT_CHUNK, CLIENT_NOTICES]) assert.ok(packageInfo.files.includes(file), `files 漏了 ${file}`);
  // 构建期工具必须是 devDependencies：发布 job 装 --include=dev，而 Host 运行时依赖保持为空。
  assert.equal(packageInfo.dependencies, undefined);
  for (const tool of ['esbuild', 'postcss', 'postcss-selector-parser']) {
    assert.ok(packageInfo.devDependencies[tool], `${tool} 应在 devDependencies`);
  }
});

// publish job 是一个全新的 checkout：checks job 装的 node_modules 看不见，构建期工具只能自己装。
// 构建则**由 release.mjs 自己负责**——prepare 在 commit/tag 之前就通过 packPackage 构建并试打包
// （所以构建失败进不了版本 commit 与 tag），publish 打包前再构建一次。workflow 里不另加一次
// 显式 build：那是同一个 fresh job 里的无意义重复，真正保证产物的是 packPackage 那条路径。
test('the release workflow installs devDependencies, and prepare builds inside its pack before the tag', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const jobs = workflow.slice(workflow.indexOf('jobs:'));
  const publish = jobs.slice(jobs.indexOf('\n  publish:'));
  // 只认步骤的 run: 行（注释不算），顺序才是真的执行顺序。
  const steps = [...publish.matchAll(/^\s+run: (.+)$/gm)].map(match => match[1].trim());
  const install = steps.findIndex(step => step.startsWith('npm ci --include=dev'));
  const prepare = steps.indexOf('node scripts/release/release.mjs prepare');
  const pack = steps.indexOf('node scripts/release/release.mjs publish');
  assert.ok(install >= 0, '发布 job 必须装 devDependencies（全新的 checkout 里没有 checks job 的 node_modules）');
  assert.ok(install < prepare, '装依赖必须在 prepare 之前：prepare 里要打包');
  assert.ok(pack > prepare, '顺序必须是：装 devDependencies → prepare → publish');
  assert.equal(steps.filter(step => step === 'npm run build:client').length, 0,
    'workflow 不再重复构建：prepare 与 publish 通过 packPackage 各自紧跟一次真打包地构建');

  // prepare 里的构建必须发生在 commit/tag 之前——顺序在源码里钉死。
  const source = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  const prepareBody = source.slice(source.indexOf('async function prepare()'), source.indexOf('export async function registryVersion('));
  const commit = prepareBody.indexOf("'-m', `chore(release): ${plan.tag}`");
  const tag = prepareBody.indexOf(`'-a', plan.tag`);
  const push = prepareBody.indexOf("['push', '--atomic', 'origin'");
  const guard = prepareBody.indexOf('packPackage(); // Refuse an incomplete or private tarball before creating refs.');
  assert.ok(guard > 0, 'prepare 必须在创建 ref 之前试打包');
  assert.ok(commit > guard && tag > guard && push > guard, '构建/试打包必须发生在版本 commit、tag 与 push 之前');
  // validatePack 必须显式点名这三个文件：通配会让 dist 下别的产物一起放行。
  assert.doesNotMatch(source, /dist\\\/\.\*|dist\\\/\*\*/s);
  // 三个名字只能写成三条完整路径：可选式会把 client.txt / client-notices.js / entry.cjs 也放行。
  assert.ok(source.includes(String.raw`|dist\/client\.js|dist\/client\.notes\.js|dist\/client-notices\.txt|`),
    '白名单必须是三条完整路径的显式 alternation');
  assert.doesNotMatch(source, /client\(\?:[-.]/, '白名单不能把几个名字写成一个可选式');
});

function assetFixture() {
  const bytes = Buffer.from('PK\x03\x04test plugin contents');
  const local = { name: 'studymate-openai.zip', bytes, size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  const release = { id: 12, tag_name: 'v0.2.0', draft: false, prerelease: false,
    upload_url: `https://uploads.github.com/repos/${repository}/releases/12/assets{?name,label}` };
  const remote = { id: 13, name: local.name, size: local.size, digest: local.digest, state: 'uploaded' };
  return { local, release, remote };
}

test('plugin release build checks the prepared version and produces a SHA256 artifact', t => {
  const bytes = Buffer.from('PK\x03\x04mock archive');
  const build = version => (executable, args) => {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args.slice(0, 3), ['bin/studymate.mjs', 'build-plugin', '--output']);
    const directory = args[3];
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, 'studymate', '.codex-plugin'), { recursive: true });
    writeFileSync(join(directory, 'studymate', '.codex-plugin', 'plugin.json'), JSON.stringify({ version }));
    writeFileSync(join(directory, 'studymate-openai.zip'), bytes);
  };
  const artifact = buildReleasePlugin('0.2.0', build('0.2.0'));
  assert.equal(artifact.name, 'studymate-openai.zip');
  assert.deepEqual(artifact.bytes, bytes);
  assert.equal(artifact.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.throws(() => buildReleasePlugin('0.2.0', build('0.1.5')), /version differs/);
});

test('release notes give both exact-version DSH installation and the OpenAI ZIP', () => {
  const body = withInstallationNotes('手工保留的版本说明', '0.2.0');
  assert.match(body, /npx -y @yunmiao\/studymate@0\.2\.0 install/);
  assert.match(body, /Codex \/ ChatGPT Work/);
  assert.match(body, /releases\/download\/v0\.2\.0\/studymate-openai\.zip/);
  assert.equal(withInstallationNotes(body, '0.2.0'), body);
  assert.ok(withInstallationNotes(body, '0.3.0').startsWith('手工保留的版本说明'));
  assert.doesNotMatch(withInstallationNotes(body, '0.3.0'), /studymate@0\.2\.0/);
});

test('GitHub release creation and retry update only missing installation information', async () => {
  const { release } = assetFixture();
  const state = { tag: 'v0.2.0', version: '0.2.0', commit: 'a'.repeat(40) };
  const calls = [];
  const created = await ensureGithubRelease(state, '版本说明', async (path, options) => {
    calls.push([path, options]);
    if (path.includes('/tags/')) return null;
    assert.equal(options.body.target_commitish, state.commit);
    assert.equal(options.body.make_latest, 'legacy');
    return { ...release, body: options.body.body };
  });
  assert.deepEqual(calls.map(([path]) => path), ['/releases/tags/v0.2.0', '/releases']);
  calls.length = 0;
  await ensureGithubRelease(state, '版本说明', async (path, options) => {
    calls.push([path, options]);
    return created;
  });
  assert.equal(calls.length, 1);
  await ensureGithubRelease(state, '版本说明', async (path, options) => {
    if (path.includes('/tags/')) return { ...release, body: '已有的手工说明' };
    assert.equal(path, '/releases/12');
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(Object.keys(options.body), ['body']);
    assert.match(options.body.body, /^已有的手工说明/);
    return { ...release, body: options.body.body };
  });
  await assert.rejects(ensureGithubRelease(state, '版本说明', async () => ({ ...release, draft: true })), /expected stable release/);
});

test('new release assets upload ZIP bytes with the API media type and verified digest', async () => {
  const { local, release, remote } = assetFixture();
  let uploads = 0;
  const result = await ensureReleaseAsset(release, local, {
    request: async path => {
      assert.equal(path, '/releases/12/assets?per_page=100&page=1');
      return [];
    },
    transfer: async (url, options) => {
      uploads += 1;
      assert.equal(url, `https://uploads.github.com/repos/${repository}/releases/12/assets?name=studymate-openai.zip`);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/zip');
      assert.equal(options.headers['Content-Length'], String(local.size));
      assert.equal(options.redirect, 'error');
      assert.deepEqual(options.body, local.bytes);
      return new Response(JSON.stringify(remote), { status: 201 });
    },
  });
  assert.equal(uploads, 1);
  assert.equal(result.skipped, false);
});

test('identical assets are skipped by SHA256, including beyond the first asset page', async () => {
  const { local, release, remote } = assetFixture();
  const pages = [];
  const result = await ensureReleaseAsset(release, local, {
    request: async path => {
      pages.push(path);
      return path.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}` })) : [remote];
    },
    transfer: async () => assert.fail('No upload or download is needed for an identical digest'),
  });
  assert.equal(result.skipped, true);
  assert.equal(pages.length, 2);
});

test('old assets without a digest are downloaded and compared before skipping', async () => {
  const { local, release, remote } = assetFixture();
  const result = await ensureReleaseAsset(release, local, {
    request: async () => [{ ...remote, digest: null }],
    transfer: async (url, options) => {
      assert.equal(url, `https://api.github.com/repos/${repository}/releases/assets/13`);
      assert.equal(options.method, undefined);
      assert.equal(options.headers.Accept, 'application/octet-stream');
      return new Response(local.bytes);
    },
  });
  assert.equal(result.skipped, true);
  await assert.rejects(ensureReleaseAsset(release, local, {
    request: async () => [{ ...remote, digest: null }],
    transfer: async () => new Response(Buffer.from('different archive')),
  }), /different contents \(SHA256\)/);
});

test('conflicting and incomplete existing assets fail without deleting or overwriting', async () => {
  const { local, release, remote } = assetFixture();
  for (const [changes, message] of [
    [{ digest: `sha256:${'0'.repeat(64)}` }, /different contents \(SHA256\)/],
    [{ size: 1 }, /different contents \(size\)/],
    [{ state: 'starter' }, /incomplete state 'starter'/],
  ]) {
    await assert.rejects(ensureReleaseAsset(release, local, {
      request: async (path, options) => {
        assert.equal(options, undefined);
        assert.match(path, /^\/releases\/12\/assets\?/);
        return [{ ...remote, ...changes }];
      },
      transfer: async () => assert.fail('An existing conflicting asset must never be replaced'),
    }), message);
  }
});

test('lost upload responses recover only after verifying identical remote content', async () => {
  const { local, release, remote } = assetFixture();
  let reads = 0;
  let uploads = 0;
  const result = await ensureReleaseAsset(release, local, {
    request: async () => ++reads === 1 ? [] : [remote],
    transfer: async () => {
      uploads += 1;
      throw new Error('connection interrupted');
    },
  });
  assert.equal(result.recovered, true);
  assert.equal(result.skipped, true);
  assert.equal(uploads, 1);
  for (const [afterFailure, message] of [
    [[], /could not be verified: HTTP 502/],
    [[{ ...remote, state: 'starter' }], /incomplete state 'starter'/],
    [[{ ...remote, digest: `sha256:${'0'.repeat(64)}` }], /different contents/],
  ]) {
    let calls = 0;
    await assert.rejects(ensureReleaseAsset(release, local, {
      request: async () => ++calls === 1 ? [] : afterFailure,
      transfer: async () => new Response('upload failed', { status: 502 }),
    }), message);
    assert.equal(calls, 2);
  }
});

test('upload credentials are sent only to the expected upstream release endpoint', async () => {
  const { local, release } = assetFixture();
  for (const upload_url of [
    'https://example.invalid/assets{?name,label}',
    'https://uploads.github.com/repos/other/project/releases/12/assets{?name,label}',
    `https://uploads.github.com/repos/${repository}/releases/99/assets{?name,label}`,
  ]) {
    await assert.rejects(ensureReleaseAsset({ ...release, upload_url }, local, {
      request: async () => [],
      transfer: async () => assert.fail('Credentials must not be forwarded'),
    }), /Unexpected GitHub upload URL/);
  }
});
