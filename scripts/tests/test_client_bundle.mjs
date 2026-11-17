import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { HOST_EXTERNALS, NOTES_NAMESPACE, composeClient, scopeNotesCss } from '../client-build-helpers.mjs';
import { clientInternals, findByProp, viewText } from './fixtures/client_harness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reading = `// window.__ModuleLoader__.load() in a comment is not a second declaration.
window.__ModuleLoader__.load({id:'@yunmiao/studymate',factory(require, options){
const React=require('react');return{inject:['slots'],apply(ctx){ctx.calls.push('reading');ctx.options=options;ctx.react.push(React);return()=>ctx.calls.push('reading-disposed');}};}});`;
const notes = `const React=require('react');module.exports={CHAT_SLOT:'studymate.notes.session',NativeMainPanel(){},PanelIcon(){},createNotesWorkspace(){},LearningNotesTree(){},LearningNotesPanel(){},inject:['slots','sessions'],apply(ctx){ctx.calls.push('notes');ctx.react.push(React);return()=>ctx.calls.push('notes-disposed');}};`;
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
      createElement: () => ({ dataset: {}, textContent: '', remove() { elements.splice(elements.indexOf(this), 1); } }),
      head: { appendChild: element => elements.push(element) },
    },
  };
  new vm.Script(source).runInNewContext(sandbox);
  const react = { shared: true }, requested = [];
  const plugin = registrations[0]?.factory(name => { requested.push(name); assert.equal(name, 'react'); return react; });
  const ctx = { calls: [], react: [], effect(fn) { effects.push(fn()); } };
  return { registrations, loader, sandbox, plugin, ctx, elements, requested, effects };
}

test('单入口只注册正式包，工厂物化前不挂载面板或注入样式', () => {
  const result = materialize(composeClient(reading, notes, '.notes{color:red}'));
  assert.equal(result.registrations.length, 1);
  assert.equal(result.registrations[0].id, '@yunmiao/studymate');
  assert.deepEqual([...result.plugin.inject], ['slots', 'sessions']);
  assert.equal(result.sandbox.window.__ModuleLoader__, result.loader);
  assert.equal(result.elements.length, 0);
  assert.deepEqual(result.ctx.calls, []);
});

test('组合保留阅读端，把笔记子模块的三件套递进去，且不传跨面板导航', () => {
  const source = composeClient(reading, notes, 'PRIVATE-CSS');
  assert.doesNotMatch(source, /notesPanelId|selectPanel/);
  const result = materialize(source);
  result.plugin.apply(result.ctx);
  assert.deepEqual(result.ctx.calls, ['reading', 'notes']);
  assert.deepEqual(Object.keys(result.ctx.options).sort(), ['notes']);
  assert.equal(typeof result.ctx.options.notes.NativeMainPanel, 'function');
  assert.equal(typeof result.ctx.options.notes.PanelIcon, 'function');
  for (const name of ['createNotesWorkspace', 'LearningNotesTree', 'LearningNotesPanel']) assert.equal(typeof result.ctx.options.notes[name], 'function', name);
  assert.equal(result.ctx.options.notes.CHAT_SLOT, 'studymate.notes.session');
  assert.equal(result.ctx.react[0], result.ctx.react[1]);
  assert.deepEqual(result.requested, ['react', 'react']);
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].textContent, 'PRIVATE-CSS');
  assert.equal(result.elements[0].dataset.studymateNotes, 'client');
});

test('笔记子模块形状不对时，组合产物装载即报错（不把死按钮带上线）', () => {
  const broken = `const React=require('react');module.exports={CHAT_SLOT:'studymate.notes.session',inject:[],apply(){return()=>{};}};`;
  assert.throws(() => {
    const result = materialize(composeClient(reading, broken, ''));
    result.plugin.apply(result.ctx);
  }, /Invalid StudyMate notes module/);
});

test('漏掉任一学习笔记共享导出时立即拒绝，不静默隐藏学习入口', () => {
  for (const name of ['createNotesWorkspace', 'LearningNotesTree', 'LearningNotesPanel']) {
    const broken = notes.replace(name + '(){},', '');
    assert.throws(() => materialize(composeClient(reading, broken, '')), /Invalid StudyMate notes module/, name);
  }
});

test('组件与样式均可随宿主生命期清理', () => {
  const result = materialize(composeClient(reading, notes, 'PRIVATE-CSS'));
  const dispose = result.plugin.apply(result.ctx);
  dispose();
  for (const effect of result.effects.reverse()) effect?.();
  assert.deepEqual(result.ctx.calls, ['reading', 'notes', 'notes-disposed', 'reading-disposed']);
  assert.equal(result.elements.length, 0);
});

test('入口声明缺失、重复或包名不符时构建/载入失败，不劫持全局加载器', () => {
  assert.throws(() => composeClient('const x=1;', notes, ''), /exactly one/);
  assert.throws(() => composeClient(reading + '\n' + reading, notes, ''), /exactly one/);
  assert.throws(() => materialize(composeClient(reading.replace("id:'@yunmiao/studymate'", "id:'other'"), notes, '')), /Unexpected reading/);
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

test('正式包只交付一个客户端入口和许可，不引入 Host 运行时依赖', () => {
  const info = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(info.exports['./client'], './dist/client.js');
  assert.deepEqual(Object.keys(info.exports).filter(key => key.startsWith('./client/')), []);
  assert.deepEqual(info.files.filter(item => item.startsWith('dist/')).sort(), ['dist/client-notices.txt', 'dist/client.js']);
  assert.deepEqual(Object.keys(info.dependencies || {}), []);
  assert.deepEqual(Object.keys(info.optionalDependencies || {}), []);
});

test('真实生成产物是单次正式登记的普通脚本，未夹带构建机器路径', () => {
  const source = fs.readFileSync(path.join(root, 'dist/client.js'), 'utf8');
  const registrations = [];
  new vm.Script(source).runInNewContext({ window: { __ModuleLoader__: { load: value => registrations.push(value) } } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, '@yunmiao/studymate');
  assert.equal(typeof registrations[0].factory, 'function');
  assert.ok(!source.includes(root));
  assert.ok(!source.includes(root.replaceAll('\\', '/')));
  const report = JSON.parse(fs.readFileSync(path.join(root, 'dist/client-build-report.json'), 'utf8'));
  assert.equal(report.hostReact, true);
  assert.deepEqual(report.externalModules, [...HOST_EXTERNALS]);
  assert.equal(report.namespace, NOTES_NAMESPACE);
});

test('真实许可声明包含实际依赖及两个按不可变提交补全的原文', () => {
  const text = fs.readFileSync(path.join(root, 'dist/client-notices.txt'), 'utf8');
  for (const identity of ['@xyflow/react@', '@codemirror/view@', '@codemirror/lang-markdown@', '@lezer/highlight@', 'katex@', 'rehype-katex@7.0.1', 'remark-math@6.0.0']) assert.ok(text.includes(identity), identity);
  assert.doesNotMatch(text, /@milkdown\/crepe@|^vue@|^dompurify@/m, '新原稿编辑器不再将旧富文本依赖夹入正式产物');
  assert.match(text, /Copyright \(c\) 2017 Junyoung Choi/);
  assert.match(text, /88a9497e1ede93b958237c85edbf5651faeca7af\/license/);
  assert.match(text, /d5d0660b150810a535bbb07eac6cc96a4510aa24\/license/);
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
