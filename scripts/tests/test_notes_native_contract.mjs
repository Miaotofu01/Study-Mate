/* 无界笔记 · 宿主契约（`client/notes/host/bridge.jsx`）· Node 里跑，不起浏览器、不连真 DSH
   ────────────────────────────────────────────────────────────────────────────────
   这一套是原型 `prototypes/unbounded-notes/test_native_contract.mjs` 的行为移植：22 条断言逐条
   保留（一条都没放宽），包装从「手写数组 + 最后写一份报告 JSON」换成 `node:test` + `node:assert`。

   怎么跑起来的：桥接是 `.jsx`，Node 读不懂，所以这里用 esbuild 现造**一份临时 bundle**——
   入口就是 `client/notes/host/bridge.jsx`，输出到 `os.tmpdir()` 下的临时目录，`finally` 里连
   目录一起删（源码树里不留任何产物，原型那份会往原型根写 `native-test-bundle.mjs`）。
   `react` / `react-dom` / `react/jsx-runtime` 一律保持 external，由本文件从**仓库根**的
   `node_modules` 解析（`createRequire(根 package.json)`），bundled 的 import 用的就是这个
   require——所以 React 由测试依赖提供，不需要宿主侧那份。`.css` 载成空模块（桥接只 import 组件，
   样式对契约没有影响）。

   依赖：`esbuild`（与 `react` 一起由主 agent 放进根 devDependencies）。缺依赖、缺桥接源文件、
   桥接打包失败都**直接红灯**（测试级 fail），不 skip——这些正是构建链该被发现断掉的地方。

   钉的是「桥接只说外部行为」的那几面：正文取哪一段（note / course / link / 媒体元信息）、
   @ 候选与 codec 用同一份缓存、codec 在读文件期间被取消或缓存换了代都要 fail closed、
   detect 坐标与 appendSpan 的夹取、显式插入的去重与一次重试、以及注册原生槽位时**绝不**
   建会话 / 保留会话 / 发消息。
*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BRIDGE = path.join(ROOT, 'client', 'notes', 'host', 'bridge.jsx');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));

/** 外部模块一律从**仓库根**解析（bundled 的 import 用的就是这份 require）：React 由测试依赖提供。 */
const EXTERNALS = Object.fromEntries(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']
  .map((name) => [name, requireFromRoot.resolve(name)]));

let loadError = null;
for (const name of ['esbuild', ...Object.keys(EXTERNALS)]) {
  try { requireFromRoot.resolve(name); } catch (error) { loadError = `${name} 解析不到（${error.code || error.message}）`; break; }
}
if (!loadError && !fs.existsSync(BRIDGE)) loadError = `没有 client/notes/host/bridge.jsx（${BRIDGE}）`;

const REQUIRE_SHIM = [
  "import { createRequire as createHostRequire } from 'node:module';",
  `const HOST_MODULES = ${JSON.stringify(EXTERNALS)};`,
  'const hostRequire = createHostRequire(import.meta.url);',
  'const require = Object.assign((specifier) => hostRequire(HOST_MODULES[specifier] ?? specifier), { resolve: hostRequire.resolve });',
].join('\n');

/**
 * 把产物里每一条 react 系列的**裸说明符**换成从仓库根解析出来的 `file:` URL。
 *
 * 为什么需要这一步：bundle 落在 `os.tmpdir()` 里，往上找不到仓库的 `node_modules`，而 esbuild
 * 给外部模块留的是裸说明符（`import ReactExports from "react"` 走静态导入，`__require("react")`
 * 走它自己的 CJS 垫片）。换成 file URL 之后两边都落到测试依赖里那一份 React——与宿主里
 * 「共用同一份 React」是同一种装载方式。banner 里的 `createRequire` 也一并接上，`__require`
 * 的兜底路径同样指向仓库。
 */
function relinkExternals(source) {
  let text = source;
  for (const [name, file] of Object.entries(EXTERNALS)) {
    text = text.replaceAll(`"${name}"`, JSON.stringify(pathToFileURL(file).href));
  }
  return text;
}

/** 造一份临时 bundle 并 import 回来。产物与目录都在 os.tmpdir() 里，调用方负责删。 */
async function loadBridge() {
  const { build } = await import(pathToFileURL(requireFromRoot.resolve('esbuild')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-notes-contract-'));
  const outfile = path.join(dir, 'bridge.bundle.mjs');
  try {
    // 产物旁边放一份 package.json，让 ESM 侧认出这一份是模块。
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
    await build({
      absWorkingDir: ROOT,
      entryPoints: [BRIDGE],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      jsx: 'automatic',
      // 包里那些 .css 只影响外观；契约只看行为，载成空模块。
      loader: { '.css': 'empty' },
      external: Object.keys(EXTERNALS),
      banner: { js: REQUIRE_SHIM },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    fs.writeFileSync(outfile, relinkExternals(fs.readFileSync(outfile, 'utf8')));
    return await import(pathToFileURL(outfile).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const bridge = loadError ? null : await loadBridge().catch((error) => { loadError = String(error?.message || error); return null; });
if (loadError) throw new Error(`无界笔记宿主契约加载失败：${loadError}`);
const suite = {};

const note = { id: 'n1', type: 'note', title: 'First "note"', markdown: '# Actual body' };
const note2 = { id: 'n2', type: 'note', title: 'Second note', markdown: 'Second body' };
// 下面这组断言之间共享同一份 source / 输入门面（原套件就是按调用次序铺开的），所以串成一组。
let source;
let state = { clipboardText: '', draft: '', draftRev: 0, occurrences: [] };
const calls = [];
const sessionContext = {};
let rejects = 0;
let focusCount = 0;
const input = {
  state: { getSnapshot: () => state },
  insertReference(ref, span) {
    calls.push({ ref, span });
    assert.ok(span.end <= bridge.detectLengthOf(state));
    if (rejects-- > 0) { state = { ...state, draftRev: state.draftRev + 1 }; return false; }
    state = {
      clipboardText: state.clipboardText + ref.clipboardText,
      draftRev: state.draftRev + 1,
      occurrences: [...state.occurrences, { source: ref.source, ref: ref.ref, length: ref.clipboardText.length }],
    };
    return true;
  },
  focus() { focusCount += 1; },
};
const options = () => ({
  hostKit: { conversation: { input: { for(ctx) { assert.equal(ctx, sessionContext); return input; } } } },
  reference: { sessionId: 'owned-contract-fixture', binding: { ctx: sessionContext } },
  id: 'n1',
  resource: note,
});

test('槽位与引用来源是稳定的唯一标识，且名字对得上', suite, () => {
  assert.equal(bridge.CHAT_SLOT, 'studymate.notes.session');
  assert.equal(bridge.REFERENCE_SOURCE, 'studymate-notes-resource');
  assert.equal(bridge.resourceReferenceSource().name, bridge.REFERENCE_SOURCE);
  // 组合入口要递给学习主面板的三件套：组件两枚 + 会话座位名。
  assert.equal(typeof bridge.NativeMainPanel, 'function');
  assert.equal(typeof bridge.PanelIcon, 'function');
});

test('笔记的正文就是原文 markdown', suite, () => {
  assert.equal(bridge.resourceText(note), '# Actual body');
});

test('课程只用已存的摘要', suite, () => {
  assert.equal(bridge.resourceText({ type: 'course', summary: 'Course evidence' }), 'Course evidence');
});

test('链接用 URL 加已存摘要，javascript: 一律拒', suite, () => {
  assert.match(bridge.resourceText({ type: 'link', url: 'https://example.invalid/', summary: 'Saved only' }), /https:\/\/example.invalid/);
  assert.equal(bridge.resourceText({ type: 'link', url: 'javascript:alert(1)', summary: 'Bad' }), undefined);
});

test('媒体永远不序列化标记或像素，只给安全元信息', suite, () => {
  for (const type of ['image', 'html', 'svg']) {
    const body = bridge.resourceText({ type, title: 'Safe metadata', markup: '<script>SECRET_RAW</script>', src: 'data:image/png;SECRET_PIXELS', bytes: 200, width: 10, height: 20 });
    assert.match(body, /Safe metadata/);
    assert.doesNotMatch(body, /SECRET_RAW|SECRET_PIXELS|<script>/);
  }
});

test('原生 @ 候选与选中用的是同一个来源', suite, async () => {
  bridge.updateResourceCache([note, note2]);
  source = bridge.resourceReferenceSource();
  const candidates = await source.candidates({}, { query: 'First' });
  assert.equal(candidates.length, 1);
  const picked = source.onPick({ candidate: candidates[0] });
  assert.equal(picked.insert.source, source.name);
  assert.equal(picked.insert.ref, 'n1');
});

test('codec 解析的是当前正文，不是旧副本', suite, async () => {
  assert.match(await source.codec.serialize('n1'), /Actual body/);
  bridge.updateResourceCache([{ ...note, markdown: 'Updated original' }, note2]);
  const serialized = await source.codec.serialize('n1');
  assert.match(serialized, /Updated original/);
  assert.doesNotMatch(serialized, /Actual body/);
});

test('引用被移除或已取消时 codec fail closed', suite, async () => {
  await assert.rejects(source.codec.serialize('missing'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.codec.serialize('n1', controller.signal));
});

test('detect 坐标把每个已有 chip 折成一个字符', suite, () => {
  assert.equal(bridge.detectLengthOf({ clipboardText: '@Alpha@Beta tail', occurrences: [{ length: 6 }, { length: 5 }] }), 7);
  assert.equal(bridge.appendSpan({ clipboardText: '@Alpha@Beta tail', occurrences: [{ length: 6 }, { length: 5 }], draftRev: 8 }).start, 7);
});

test('选区与光标都用 detect 坐标，带夹取与修订号', suite, () => {
  assert.deepEqual(bridge.appendSpan({ clipboardText: 'abc', selection: { end: 1 }, caret: 2, draftRev: 7 }), { start: 1, end: 1, draftRev: 7 });
  assert.equal(bridge.appendSpan({ draft: 'abc', caret: 99, draftRev: 2 }).start, 3);
  assert.equal(bridge.appendSpan({ draft: 'abc', caret: -5, draftRev: 2 }).start, 0);
});

test('显式插入走 binding.ctx 并聚焦，不提交', suite, () => {
  assert.equal(bridge.insertResourceReference(options()), true);
  assert.equal(calls.length, 1);
  assert.equal(focusCount, 1);
});

test('第二份不同 chip 插在 detect 空间里', suite, () => {
  assert.equal(bridge.insertResourceReference({ ...options(), id: 'n2', resource: note2 }), true);
  assert.equal(calls.at(-1).span.start, 1);
  assert.equal(state.occurrences.length, 2);
});

test('已在草稿里的引用会被去重', suite, () => {
  const before = calls.length;
  assert.equal(bridge.insertResourceReference(options()), true);
  assert.equal(calls.length, before);
});

test('删掉 chip 之后同一个文件还能再引用', suite, () => {
  state = { clipboardText: '', draftRev: 9, occurrences: [] };
  assert.equal(bridge.insertResourceReference(options()), true);
  assert.equal(state.occurrences.length, 1);
});

test('修订号过期时用新状态重试一次', suite, () => {
  state = { clipboardText: 'x', draftRev: 20, occurrences: [] };
  rejects = 1;
  const before = calls.length;
  assert.equal(bridge.insertResourceReference(options()), true);
  assert.equal(calls.length - before, 2);
  assert.equal(calls.at(-1).span.draftRev, 21);
});

test('两次写入都被拒就返回 false，不无限重试', suite, () => {
  state = { clipboardText: '', draftRev: 30, occurrences: [] };
  rejects = 9;
  const before = calls.length;
  assert.equal(bridge.insertResourceReference(options()), false);
  assert.equal(calls.length - before, 2);
});

test('没有绑定会话就不能插入、更不能提交', suite, () => {
  const before = calls.length;
  assert.equal(bridge.insertResourceReference({ ...options(), reference: null }), false);
  assert.equal(calls.length, before);
});

test('注册原生槽位时不选择、不新建、不发送任何会话，且不登记独立 main / 侧栏入口', suite, () => {
  const registrations = [];
  const cleanups = [];
  const fail = () => { throw new Error('Unexpected session or model mutation'); };
  const services = {
    slots: {
      inject(name, task) { task(); return () => {}; },
      register(spec, component) { registrations.push({ spec, component }); return () => {}; },
    },
    sessions: { create: fail, retain: fail, prompt: fail, cancel: fail },
    inputTriggers: { registerSource(value) { assert.equal(value.name, bridge.REFERENCE_SOURCE); return () => {}; } },
    conversation: { input: { for: fail } },
  };
  const ctx = { get(name) { assert.ok(services[name]); return services[name]; }, effect(task) { cleanups.push(task()); } };
  const module = bridge.createClientModule();
  module.apply(ctx);
  // 笔记只是学习里的第二个面：两处宿主入口各声明一个会话内容子槽。
  assert.deepEqual(registrations.map((entry) => entry.spec), [
    { name: bridge.CHAT_SLOT }, { name: `${bridge.CHAT_SLOT}.rightbar` },
  ]);
  assert.equal(registrations[0].component, registrations[1].component);
  for (const dispose of cleanups.reverse()) dispose?.();
});

test('文件引用在显式序列化那一刻重读原件', suite, async () => {
  let body = 'First file version';
  const fileRef = {
    id: 'external-file', type: 'note', title: 'Live file.md', markdown: 'Stale cached body',
    origin: { kind: 'file', mode: 'reference', canReopen: true },
    fileHandle: { async getFile() { return new File([body], 'file.md'); } },
  };
  bridge.updateResourceCache([fileRef]);
  assert.match(await source.codec.serialize(fileRef.id), /First file version/);
  body = 'Current file version';
  const text = await source.codec.serialize(fileRef.id);
  assert.match(text, /Current file version/);
  assert.doesNotMatch(text, /Stale cached body|First file version/);
});

test('权限被撤回时 fail closed，不提交缓存正文', suite, async () => {
  const fileRef = {
    id: 'revoked', type: 'note', markdown: 'Must not be submitted',
    origin: { kind: 'file', mode: 'reference' },
    fileHandle: { async getFile() { throw Error('permission revoked'); } },
  };
  bridge.updateResourceCache([fileRef]);
  await assert.rejects(source.codec.serialize(fileRef.id), /原文件引用不可用.*permission revoked/);
});

test('读文件途中取消，迟到的结果不会再被序列化', suite, async () => {
  let release;
  const fileRef = {
    id: 'cancel-reading', type: 'note',
    origin: { kind: 'file', mode: 'reference' },
    fileHandle: { getFile() { return new Promise((resolve) => { release = resolve; }); } },
  };
  bridge.updateResourceCache([fileRef]);
  const controller = new AbortController();
  const pending = source.codec.serialize(fileRef.id, controller.signal);
  controller.abort();
  release(new File(['Never submit this'], 'cancelled.md'));
  await assert.rejects(pending, /abort/i);
});

test('读文件途中资源换代，旧的一代被拒', suite, async () => {
  let release;
  const fileRef = {
    id: 'changed-reading', type: 'note',
    origin: { kind: 'file', mode: 'reference' },
    fileHandle: { getFile() { return new Promise((resolve) => { release = resolve; }); } },
  };
  bridge.updateResourceCache([fileRef]);
  const pending = source.codec.serialize(fileRef.id);
  bridge.updateResourceCache([{ ...fileRef, title: 'Changed identity generation' }]);
  release(new File(['Outdated generation'], 'old.md'));
  await assert.rejects(pending, /changed while reading/);
});
