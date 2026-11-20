import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import postcss from 'postcss';
import { HOST_EXTERNALS, NOTES_NAMESPACE, composeClient, composeNotesChunk, scopeNotesCss } from '../client-build-helpers.mjs';
import { clientInternals, findByProp, viewText } from './fixtures/client_harness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reading = `// window.__ModuleLoader__.load() in a comment is not a second declaration.
window.__ModuleLoader__.load({id:'@yunmiao/studymate',factory(require, options){
const React=require('react');return{inject:['slots'],apply(ctx){ctx.calls.push('reading');ctx.options=options;ctx.react.push(React);return()=>ctx.calls.push('reading-disposed');}};}});`;
/** 入口侧懒控制器（与 client/notes/host/lazy-bridge.jsx 同形状的最小夹具）：entry 工厂收到 notes 形状
 * 与 attach；组件本身不在入口——真实产物里它们住在 client.notes.js 分块里。 */
const controller = `module.exports={createNotesEntry({require}){
return{options:{CHAT_SLOT:'studymate.notes.session',NativeMainPanel(){},PanelIcon(){},createNotesWorkspace(){},LearningNotesTree(){},LearningNotesPanel(){}},injectServices:['slots','sessions'],attach(ctx){ctx.calls.push('notes-attach');return()=>ctx.calls.push('notes-detach');}};}};`;
/** 分块侧最小夹具（esbuild CJS 产物形状：module.exports 赋值）。 */
const chunkModule = `const React=require('react');module.exports={NativeMainPanel(){},LearningNotesTree(){},LearningNotesPanel(){},CHAT_SLOT:'studymate.notes.session',apply(ctx){ctx.calls.push('notes');ctx.react.push(React);return()=>ctx.calls.push('notes-disposed');}};`;
/** 顶栏套件用的笔记子模块：形状与正式 bridge 对齐（组件只用于断言「换的是哪一颗」）。 */
const notesOption = {
  CHAT_SLOT: 'studymate.notes.session',
  NativeMainPanel() { return null; },
  PanelIcon: function NotesPanelIcon() { return null; },
};

/** 元素树里数某个组件类型出现了几次（断言「左图标换成了笔记的 PanelIcon」）。 */
function countType(node, type, found = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) return node.reduce((sum, item) => countType(item, type, sum), found);
  if (node.type === type) found += 1;
  if ('children' in node) found = countType(node.children, type, found);
  if (node.props && node.props.children !== undefined) found = countType(node.props.children, type, found);
  return found;
}

function materialize(source) {
  const registrations = [], elements = [], effects = [];
  const loader = { load: value => registrations.push(value) };
  const sandbox = {
    window: { __ModuleLoader__: loader },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '', remove() { elements.splice(elements.indexOf(this), 1); } }),
      head: { appendChild: element => elements.push(element) },
    },
  };
  new vm.Script(source).runInNewContext(sandbox);
  const react = { shared: true, Component: class {}, createElement: (type, props, ...children) => ({ type, props, children }) }, requested = [];
  const require = name => { requested.push(name); return react; };
  const plugin = registrations[0]?.chunk
    ? registrations[0].factory(Object.assign(require, { async: () => Promise.resolve(react) }))
    : registrations[0]?.factory(require);
  const ctx = { calls: [], react: [], effect(fn) { effects.push(fn()); } };
  return { registrations, loader, sandbox, plugin, ctx, elements, requested, effects };
}

test('单入口只注册正式包，工厂物化前不挂载面板或注入样式', () => {
  const result = materialize(composeClient(reading, controller));
  assert.equal(result.registrations.length, 1);
  assert.equal(result.registrations[0].id, '@yunmiao/studymate');
  assert.equal(result.registrations[0].chunk, undefined, '入口登记不许带 chunk 字段');
  assert.deepEqual([...result.plugin.inject], ['slots', 'sessions']);
  assert.equal(result.sandbox.window.__ModuleLoader__, result.loader);
  assert.equal(result.elements.length, 0);
  assert.deepEqual(result.ctx.calls, []);
});

test('组合保留阅读端，把懒控制器的 notes 形状递进去，apply 只挂 attach、不注样式', () => {
  const source = composeClient(reading, controller);
  assert.doesNotMatch(source, /notesPanelId|selectPanel/);
  const result = materialize(source);
  result.plugin.apply(result.ctx);
  assert.deepEqual(result.ctx.calls, ['reading', 'notes-attach']);
  assert.deepEqual(Object.keys(result.ctx.options), ['notes']);
  assert.deepEqual(Object.keys(result.ctx.options.notes).sort(), ['CHAT_SLOT', 'LearningNotesPanel', 'LearningNotesTree', 'NativeMainPanel', 'PanelIcon', 'createNotesWorkspace']);
  for (const name of ['NativeMainPanel', 'PanelIcon', 'createNotesWorkspace', 'LearningNotesTree', 'LearningNotesPanel']) assert.equal(typeof result.ctx.options.notes[name], 'function', name);
  assert.equal(result.ctx.options.notes.CHAT_SLOT, 'studymate.notes.session');
  assert.deepEqual(result.requested, ['react']);
  // 样式与真组件都搬到分块：入口 apply 期不再创建任何 style 元素（首屏零笔记字节）。
  assert.equal(result.elements.length, 0);
});

test('懒控制器缺 createNotesEntry / attach / injectServices 时，工厂物化即报错', () => {
  assert.throws(() => materialize(composeClient(reading, 'module.exports={};')), /Invalid StudyMate notes lazy controller/);
  assert.throws(() => materialize(composeClient(reading, 'module.exports={createNotesEntry(){return{options:{},attach(){}};}};')), /Invalid StudyMate notes lazy controller/);
});

test('入口声明缺失、重复或包名不符时构建/载入失败，不劫持全局加载器', () => {
  assert.throws(() => composeClient('const x=1;', controller), /exactly one/);
  assert.throws(() => composeClient(reading + '\n' + reading, controller), /exactly one/);
  assert.throws(() => materialize(composeClient(reading.replace("id:'@yunmiao/studymate'", "id:'other'"), controller)), /Unexpected reading/);
});

test('组件随宿主生命期清理：attach 的清理链与阅读端的反向执行', () => {
  const result = materialize(composeClient(reading, controller));
  const dispose = result.plugin.apply(result.ctx);
  dispose();
  assert.deepEqual(result.ctx.calls, ['reading', 'notes-attach', 'notes-detach', 'reading-disposed']);
});

test('分块以 chunk 名登记，apply 先注限域样式再跑笔记模块', () => {
  const result = materialize(composeNotesChunk(chunkModule, '.notes{color:red}'));
  assert.equal(result.registrations.length, 1);
  assert.equal(result.registrations[0].id, '@yunmiao/studymate');
  assert.equal(result.registrations[0].chunk, 'client.notes.js');
  assert.equal(typeof result.plugin.NativeMainPanel, 'function');
  assert.equal(result.plugin.CHAT_SLOT, 'studymate.notes.session');
  result.plugin.apply(result.ctx);
  assert.deepEqual(result.ctx.calls, ['notes']);
  assert.deepEqual(result.requested, ['react']);
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].textContent, '.notes{color:red}');
  assert.equal(result.elements[0].dataset.studymateNotes, 'client');
});

test('分块形状不对时物化即报错（不把死组件带上线）', () => {
  const broken = chunkModule.replace('LearningNotesTree(){},', '');
  assert.throws(() => materialize(composeNotesChunk(broken, '')), /Invalid StudyMate notes chunk/);
  const drifted = chunkModule.replace("'studymate.notes.session'", "'studymate.notes.other'");
  assert.throws(() => materialize(composeNotesChunk(drifted, '')), /Invalid StudyMate notes chunk/);
});

test('样式随宿主清理；空样式也走同一注册路径', () => {
  const result = materialize(composeNotesChunk(chunkModule, 'PRIVATE-CSS'));
  const dispose = result.plugin.apply(result.ctx);
  dispose();
  for (const effect of result.effects.reverse()) effect?.();
  assert.deepEqual(result.ctx.calls, ['notes', 'notes-disposed']);
  assert.equal(result.elements.length, 0);
});

test('CSS 根选择器、普通选择器与媒体查询都被约束到笔记容器', () => {
  const css = scopeNotesCss(':root{--x:1}body{margin:0}.card,.foo:hover{color:red}@media(max-width:500px){#root{width:100%}.card{display:none}}');
  const parsed = postcss.parse(css);
  parsed.walkRules(rule => {
    for (const selector of rule.selectors) assert.ok(selector.startsWith('.' + NOTES_NAMESPACE), selector);
  });
  assert.doesNotMatch(css, /(?:^|[{},])\s*(?:body|html|:root|#root)\b/);
});

test('关键帧和 KaTeX 字体名称私有化，但关键帧内部不能加容器前缀', () => {
  const css = scopeNotesCss('@keyframes toast-in{from{opacity:0}to{opacity:1}}.card{animation:toast-in 1s linear;font-family:KaTeX_Main}@font-face{font-family:KaTeX_Main;src:url(a.woff) format("woff"),url(b.woff2) format("woff2")}');
  assert.match(css, /@keyframes StudyMateNotes_toast-in/);
  assert.match(css, /animation:StudyMateNotes_toast-in 1s linear/);
  assert.match(css, /font-family:StudyMateNotes_KaTeX_Main/);
  assert.doesNotMatch(css, /\.studymate-notes (?:from|to)\{/);
  assert.doesNotMatch(css, /a\.woff/);
  assert.match(css, /b\.woff2/);
});

test('正式包只交付一个客户端入口、懒分块和许可，不引入 Host 运行时依赖', () => {
  const info = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(info.exports['./client'], './dist/client.js');
  assert.deepEqual(Object.keys(info.exports).filter(key => key.startsWith('./client/')), []);
  assert.deepEqual(info.files.filter(item => item.startsWith('dist/')).sort(), ['dist/client-notices.txt', 'dist/client.js', 'dist/client.notes.js']);
  assert.deepEqual(Object.keys(info.dependencies || {}), []);
  assert.deepEqual(Object.keys(info.optionalDependencies || {}), []);
});

test('真实入口产物是单次正式登记的普通脚本，未夹带构建机器路径', () => {
  const source = fs.readFileSync(path.join(root, 'dist/client.js'), 'utf8');
  const registrations = [];
  new vm.Script(source).runInNewContext({ window: { __ModuleLoader__: { load: value => registrations.push(value) } } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, '@yunmiao/studymate');
  assert.equal(registrations[0].chunk, undefined);
  assert.equal(typeof registrations[0].factory, 'function');
  assert.ok(!source.includes(root));
  assert.ok(!source.includes(root.replaceAll('\\', '/')));
});

test('正式构建仅在右栏服务可用时注册原生开始项，与旧全宽入口共用阅读端', () => {
  const source = fs.readFileSync(path.join(root, 'dist/client.js'), 'utf8');
  const { plugin, ctx, effects } = materialize(source);
  const slots = new Map();
  const childOwners = new Map();
  const pending = [];
  const dictionaries = new Map();
  const kinds = new Map();
  let lang = 'zh';
  const services = {
    slots: {
      inject(name, task) { return task(); },
      register(spec, component) {
        const key = spec.key || spec.id;
        const seat = `${spec.name}:${key}`;
        assert.ok(!slots.has(seat), seat);
        for (const [child, shape] of Object.entries(spec.children ?? {})) {
          assert.ok(!childOwners.has(child), `${child} has two owners`);
          assert.equal(shape.kind, 'single');
          assert.equal(shape.scope, 'session');
          childOwners.set(child, seat);
        }
        slots.set(seat, { spec, component });
        return () => { slots.delete(seat); for (const child of Object.keys(spec.children ?? {})) childOwners.delete(child); };
      },
    },
    locale: {
      register(ns, copy) { dictionaries.set(ns, copy); return () => dictionaries.delete(ns); },
      bind(ns) { return key => dictionaries.get(ns)[lang][key]; },
    },
    sidebarRightTabs: {
      register(tab) { kinds.set(tab.kind, tab); return () => kinds.delete(tab.kind); },
    },
  };
  Object.assign(ctx, {
    get: name => services[name],
    slots: services.slots,
    inject: (names, start) => pending.push({ names, start }),
  });
  assert.ok(!plugin.inject.includes('sidebarRightTabs'), '旧宿主不能被挡在 apply 外');
  const cleanup = plugin.apply(ctx);
  assert.deepEqual([...slots.keys()], ['main:studymate', 'sidebar.panellist:studymate']);
  assert.equal(kinds.size, 0, '未注入右栏服务时不注册');

  const rightbar = pending.find(({ names }) => names.includes('sidebarRightTabs'));
  assert.deepEqual([...rightbar.names].sort(), ['locale', 'sidebarRightTabs']);
  rightbar.start(ctx);
  assert.equal(kinds.size, 1);
  const tab = kinds.get('studymate');
  const main = slots.get('main:studymate');
  const body = slots.get(`sidebar.right.pane.tab:${tab.id}`);
  assert.equal(body.component({}).children[0].type, main.component, '右栏不能重做一份阅读端');
  assert.equal(body.component({}).children[0].props.inRightbar, true);
  assert.deepEqual(Object.keys(body.spec.children), ['studymate.ask.session.rightbar', 'studymate.notes.session.rightbar']);
  assert.deepEqual([...slots.keys()], ['main:studymate', 'sidebar.panellist:studymate', `sidebar.right.pane.tab:${tab.id}`]);
  assert.equal(tab.guide.length, 1);
  assert.equal(tab.guide[0].title(), '学习');
  assert.match(tab.guide[0].description(), /学习工作区/);
  lang = 'en';
  assert.equal(tab.guide[0].title(), 'Study');
  assert.equal(tab.title(), 'Study');
  cleanup?.();
  for (const dispose of effects.reverse()) dispose?.();
  assert.equal(kinds.size, 0);
  assert.ok(!slots.has(`sidebar.right.pane.tab:${tab.id}`));
  assert.equal(dictionaries.size, 0);
});

test('真实懒控制器可物化：CJS 出口交出 createNotesEntry，工厂返回完整 notes 形状', async () => {
  // build-client.mjs 的 controllerStdin 必须显式再导出 createNotesEntry：裸副作用 import
  // 会让 esbuild 的 CJS 入口 exports 为空（真实浏览器启动已证）。这里用同一 stdin 重建
  // 控制器产物，在 vm 里走完整工厂——两个真实踩过的坑都钉在这：出口缺失、attach 简写
  // 引到未定义变量。
  const built = await esbuild.build({
    absWorkingDir: root,
    stdin: { contents: "export { createNotesEntry } from './client/notes/host/lazy-bridge.jsx';", resolveDir: root, sourcefile: 'studymate-client-entry.jsx', loader: 'jsx' },
    bundle: true, write: false, platform: 'browser', format: 'cjs', target: 'es2022', minify: true,
    jsx: 'automatic', external: [...HOST_EXTERNALS],
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  });
  const source = built.outputFiles[0].text;
  const sandbox = { window: {}, module: { exports: {} }, require: () => ({}) };
  new vm.Script(source).runInNewContext(sandbox);
  const { createNotesEntry } = sandbox.module.exports;
  assert.equal(typeof createNotesEntry, 'function', 'controllerStdin 必须显式再导出 createNotesEntry');
  const notesEntry = createNotesEntry({ require: () => ({}) });
  assert.deepEqual(Object.keys(notesEntry.options).sort(), ['CHAT_SLOT', 'LearningNotesPanel', 'LearningNotesTree', 'NativeMainPanel', 'PanelIcon', 'createNotesWorkspace']);
  for (const name of ['NativeMainPanel', 'PanelIcon', 'createNotesWorkspace', 'LearningNotesTree', 'LearningNotesPanel']) {
    assert.equal(typeof notesEntry.options[name], 'function', name);
  }
  assert.equal(notesEntry.options.CHAT_SLOT, 'studymate.notes.session');
  assert.deepEqual([...notesEntry.injectServices], ['slots', 'sessions', 'inputTriggers', 'conversation']);
  assert.equal(typeof notesEntry.attach, 'function', 'attach 必须真的绑到 loader.attach');
  assert.ok(!source.includes(root));
});

test('真实懒分块产物按 chunk 名登记且不夹带机器路径，报告分别计量入口与分块', () => {
  const source = fs.readFileSync(path.join(root, 'dist/client.notes.js'), 'utf8');
  const registrations = [];
  new vm.Script(source).runInNewContext({ window: { __ModuleLoader__: { load: value => registrations.push(value) } } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].chunk, 'client.notes.js');
  assert.equal(typeof registrations[0].factory, 'function');
  assert.ok(!source.includes(root));
  assert.ok(!source.includes(root.replaceAll('\\', '/')));
  const report = JSON.parse(fs.readFileSync(path.join(root, 'dist/client-build-report.json'), 'utf8'));
  assert.equal(report.hostReact, true);
  assert.deepEqual(report.externalModules, [...HOST_EXTERNALS]);
  assert.equal(report.namespace, NOTES_NAMESPACE);
  assert.equal(report.entry.file, 'dist/client.js');
  assert.equal(report.chunk.file, 'dist/client.notes.js');
  for (const part of [report.entry, report.chunk]) {
    assert.ok(part.bytes > 0 && part.gzipBytes > 0 && part.gzipBytes < part.bytes, '入口与分块都要分开计量 raw/gzip');
  }
  assert.equal(report.totalBytesAll, report.entry.bytes + report.chunk.bytes);
  assert.equal(report.totalGzipBytes, report.entry.gzipBytes + report.chunk.gzipBytes);
});

test('真实许可声明包含实际依赖及两个按不可变提交补全的原文', () => {
  const text = fs.readFileSync(path.join(root, 'dist/client-notices.txt'), 'utf8');
  for (const identity of ['@xyflow/react@', '@codemirror/view@', '@codemirror/lang-markdown@', '@lezer/highlight@', 'katex@', 'rehype-katex@7.0.1', 'remark-math@6.0.0']) assert.ok(text.includes(identity), identity);
  assert.doesNotMatch(text, /@milkdown\/crepe@|^vue@|^dompurify@/m, '新原稿编辑器不再将旧富文本依赖夹入正式产物');
  assert.match(text, /Copyright \(c\) 2017 Junyoung Choi/);
  assert.match(text, /88a9497e1ede93b958237c85edbf5651faeca7af\/license/);
  assert.match(text, /d5d0660b150810a535bbb07eac6cc96a4510aa24\/license/);
});

test('懒加载控制器的 CHAT_SLOT 与分块桥逐字一致（静态钉住两处字面量）', () => {
  const lazy = fs.readFileSync(path.join(root, 'client/notes/host/lazy-bridge.jsx'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'client/notes/host/bridge.jsx'), 'utf8');
  const literal = /['"]studymate\.notes\.session['"]/;
  assert.match(lazy, literal, 'lazy-bridge.jsx 缺 CHAT_SLOT 字面量');
  assert.match(bridge, literal, 'bridge.jsx 缺 CHAT_SLOT 字面量');
  // 分块文件名也钉住：控制器请求的 ./client.notes.js 与宿主 CLIENT_CHUNK 正则允许的名字。
  assert.match(lazy, /['"]client\.notes\.js['"]/);
});

test('隐藏面的 inert 走原生 DOM 属性，兼容宿主 React 18 的未知属性丢弃与 React 19', () => {
  const { setNativeInert } = clientInternals({ notes: notesOption });
  const modern = { inert: false };
  setNativeInert(modern, true);
  assert.equal(modern.inert, true);
  setNativeInert(modern, false);
  assert.equal(modern.inert, false);
  // 老 DOM 没有 inert property：退回 attribute，且清得掉。
  const legacy = { attrs: new Set(), setAttribute(name) { this.attrs.add(name); }, removeAttribute(name) { this.attrs.delete(name); } };
  setNativeInert(legacy, true);
  assert.equal(legacy.attrs.has('inert'), true);
  setNativeInert(legacy, false);
  assert.equal(legacy.attrs.has('inert'), false);
  // 宿主 React 18 会把布尔 inert 当未知 prop 丢掉；这两个面都不能再出现 prop 写法。
  const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
  assert.doesNotMatch(source, /inert:\s*surface/);
});

test('学习状态：品牌切换「StudyMate ⇄ 无界笔记」，第一项面包屑是学习工作台，且不再有「主页」按钮', () => {
  const { TopBar } = clientInternals({ notes: notesOption });
  const calls = [];
  const tree = TopBar({
    view: 'home', subject: null, node: null, surface: 'learning',
    onToggleSurface: () => calls.push('toggle'),
    onWorkspace: () => calls.push('workspace'),
  });
  const brand = findByProp(tree, 'data-proto', 'brand-switch');
  assert.equal(brand.length, 1);
  const text = viewText(brand[0]);
  assert.ok(text.indexOf('StudyMate') >= 0 && text.indexOf('StudyMate') < text.indexOf('无界笔记'), text);
  assert.equal(brand[0].props['aria-pressed'], 'false');
  assert.equal(brand[0].props['data-surface'], 'learning');
  assert.match(viewText(brand[0]), /学/);
  brand[0].props.onClick();
  assert.deepEqual(calls, ['toggle']);
  const crumb = findByProp(tree, 'data-proto', 'workspace-home');
  assert.equal(crumb.length, 1);
  assert.equal(viewText(crumb[0]), '学习工作台');
  crumb[0].props.onClick();
  assert.deepEqual(calls, ['toggle', 'workspace']);
  assert.doesNotMatch(viewText(tree), /主页/);
  assert.equal(findByProp(tree, 'aria-label', '打开无界笔记').length, 0);
});

test('笔记状态：名字顺序互换、左图标换成笔记自己的 PanelIcon，学习/搜索不再占顶栏', () => {
  const { TopBar } = clientInternals({ notes: notesOption });
  const calls = [];
  const tree = TopBar({
    view: 'home', subject: null, node: null, surface: 'notes',
    onToggleSurface: () => calls.push('toggle'),
    onWorkspace: () => calls.push('workspace'),
  });
  const brand = findByProp(tree, 'data-proto', 'brand-switch');
  const text = viewText(brand[0]);
  assert.ok(text.indexOf('无界笔记') >= 0 && text.indexOf('无界笔记') < text.indexOf('StudyMate'), text);
  assert.equal(brand[0].props['aria-pressed'], 'true');
  assert.equal(brand[0].props['data-surface'], 'notes');
  assert.doesNotMatch(viewText(brand[0]), /学/);
  // 左图标必须是递进来的 PanelIcon，不是那枚「学」字。
  assert.equal(countType(brand[0], notesOption.PanelIcon), 1);
  assert.doesNotMatch(viewText(tree), /学习工作台/);
  assert.equal(findByProp(tree, 'data-proto', 'workspace-home').length, 0);
  assert.equal(findByProp(tree, 'aria-label', '打开无界笔记').length, 0);
  assert.doesNotMatch(viewText(tree), /搜索/);
  brand[0].props.onClick();
  assert.deepEqual(calls, ['toggle']);
});

test('没有笔记子模块时（纯 lib/client.js / 离线导出）品牌仍回主页，不显示死切换按钮', () => {
  const old = clientInternals({});
  const calls = [];
  const tree = old.TopBar({ view: 'home', subject: null, node: null, onHome: () => calls.push('home') });
  assert.equal(findByProp(tree, 'data-proto', 'brand-switch').length, 0);
  assert.equal(findByProp(tree, 'data-proto', 'brand-home').length, 1);
  assert.equal(findByProp(tree, 'aria-label', '打开无界笔记').length, 0);
  assert.match(viewText(tree), /学习工作台/);
  findByProp(tree, 'data-proto', 'brand-home')[0].props.onClick();
  assert.deepEqual(calls, ['home']);
});
