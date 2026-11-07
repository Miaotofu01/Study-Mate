/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 插件页（配置 + 状态）的客户端契约

   这一页有两个「看起来没问题」的失败形态，所以逐条钉：

     · **subject 自过滤**：`plugins.detail.section` 挂在每个插件页上，`item` 形态没有 `pkg`。
       判错就把状态卡画到别人的插件页上（或直接抛）。这里拿三种 subject 各渲染一次。
     · **i18n**：文案是 locale 字典里的键，不是中文字面量。zh/en 必须键集一致、en 零 CJK、
       每个用到的键都有定义、同一 key 的占位符一致（否则切到英文会露出 `{n}`）。

   还钉注册面：两个槽位的 name/id/order/key/locale 逐字，`locale` 注册的命名空间与字典对得上。
   真正点「选择目录 / 保存」的行为在真宿主上验（`scripts/tests/README.md` 的真宿主一节）。
   ───────────────────────────────────────────────────────────────────────── */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { clientInternals, loadClient, renderWithState, resetHookState, setHookState } from './fixtures/client_harness.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const source = fs.readFileSync(`${ROOT}lib/client.js`, 'utf8');
const internals = clientInternals();
const {
  PAGE_NS, PAGE_ROW_KEY, STATUS_ENDPOINT, DICT_ZH, DICT_EN, PAGE_CSS,
  WorkspaceSection, WorkspaceSectionBody, WorkspaceConfigCard, WorkspaceConfigBody,
  statusView, progressOf, pickDirectoryOnce,
} = internals;

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
const placeholders = text => [...String(text).matchAll(/\{([a-z][a-z0-9_]*)\}/giu)].map(match => match[1]).sort();

function tFor(dict) {
  return (key, params) => {
    let text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    for (const [name, value] of Object.entries(params || {})) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  };
}

const t = tFor(DICT_ZH);

function fakeCtx(services = {}) {
  const registrations = [];
  const injected = [];
  const ctx = {
    get: name => services[name],
    effect: (fn) => {
      const dispose = fn();
      return dispose;
    },
    inject: (names, callback) => {
      injected.push(names);
      callback({ locale: services.locale, effect: ctx.effect });
    },
    slots: {
      inject: (name, callback) => { callback(); },
      register: (entry, component) => {
        registrations.push({ entry, component });
        return () => {};
      },
    },
  };
  return { ctx, registrations, injected };
}

function fakeLocale() {
  const registered = [];
  return {
    registered,
    service: {
      register(namespace, dictionaries) {
        registered.push({ namespace, dictionaries });
        return () => {};
      },
      bind() {
        return t;
      },
    },
  };
}

test('插件页：locale 注册 zh/en 两本基线与两个官方槽位', () => {
  const locale = fakeLocale();
  const { ctx, registrations, injected } = fakeCtx({ locale: locale.service });
  loadClient().plugin.apply(ctx);

  assert.deepEqual(locale.registered.map(item => item.namespace), [PAGE_NS]);
  assert.deepEqual(Object.keys(locale.registered[0].dictionaries).sort(), ['en', 'zh']);
  assert.deepEqual(injected, [['locale'], ['uiWorkspace']]);

  const byName = name => registrations.filter(item => item.entry.name === name);
  assert.deepEqual(byName('plugins.detail.section').map(item => ({
    id: item.entry.id, order: item.entry.order, locale: item.entry.locale,
  })), [{ id: `${PAGE_NS}.workspace`, order: 50, locale: PAGE_NS }]);
  assert.deepEqual(byName('plugins.row.config').map(item => ({
    key: item.entry.key, locale: item.entry.locale,
  })), [{ key: PAGE_ROW_KEY, locale: PAGE_NS }]);
  assert.equal(PAGE_ROW_KEY, '@yunmiao/studymate#studymate');
  assert.equal(STATUS_ENDPOINT, '/api/studymate/status');
});

test('插件页：subject 自过滤——bundle 与自己的 row 才画，停用/别人的页面都不画', () => {
  const mine = { kind: 'bundle', pkg: { name: PAGE_NS } };
  const myRow = { kind: 'row', pkg: { name: PAGE_NS }, row: { rowId: 'studymate', enabled: true } };
  const other = { kind: 'bundle', pkg: { name: '@example/other' } };
  const otherRow = { kind: 'row', pkg: { name: '@example/other' }, row: { rowId: 'studymate', enabled: true } };
  const disabledBundle = { kind: 'bundle', pkg: { name: PAGE_NS, enabled: false } };
  const disabledRow = { kind: 'row', pkg: { name: PAGE_NS }, row: { rowId: 'studymate', enabled: false } };
  const item = { kind: 'item', id: 'some-official' }; // item 没有 pkg：不能先摸 pkg.name
  assert.equal(WorkspaceSection({ subject: other, t }), null);
  assert.equal(WorkspaceSection({ subject: otherRow, t }), null);
  assert.equal(WorkspaceSection({ subject: disabledBundle, t }), null);
  assert.equal(WorkspaceSection({ subject: disabledRow, t }), null);
  assert.equal(WorkspaceSection({ subject: item, t }), null);
  assert.equal(WorkspaceSection({ subject: null, t }), null);
  assert.notEqual(WorkspaceSection({ subject: mine, t }), null);
  assert.notEqual(WorkspaceSection({ subject: myRow, t }), null);
});

test('插件页：状态投影只带事实与计数，空态/错误态说人话', () => {
  const ready = statusView({
    ok: true,
    configured: true,
    initialized: true,
    workspace: '/data/learning',
    source: 'plugin-config',
    mode: 'native',
    today: '2026-11-07',
    subjects: [
      { slug: 'demo', name: '演示', stats: { 未开始: 1, 学习中: 2, 已学完: 3 }, continue_node: 'n2' },
    ],
    unreadable: [],
    watch: { watching: true, backend: 'node-fs' },
  }, t);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.lead, DICT_ZH.status_lead_ready.replace('{n}', '1'));
  assert.equal(ready.facts.find(fact => fact.key === 'workspace').value, '/data/learning');
  // 状态卡只留「工作区 + 科目」：来源/安装方式/监听/今天这些行不再各占一行。
  assert.deepEqual(ready.facts.map(fact => fact.key), ['workspace', 'subject:demo']);
  assert.ok(ready.facts.some(fact => fact.key === 'subject:demo' && fact.label === '演示'), JSON.stringify(ready.facts));
  assert.ok(ready.facts.find(fact => fact.key === 'subject:demo').value.includes('3'));
  assert.equal(ready.unreadable, null);
  assert.equal(ready.note, '');

  const failed = statusView({ ok: false }, t);
  assert.equal(failed.state, 'error');
  assert.equal(failed.lead, DICT_ZH.status_read_failed);

  const unconfigured = statusView({
    ok: true, configured: false, initialized: false, workspace: '', source: '', mode: 'unknown',
    today: '2026-11-07', subjects: [], unreadable: [], watch: { watching: false, backend: '未起' },
  }, t);
  assert.equal(unconfigured.state, 'ready');
  assert.equal(unconfigured.lead, DICT_ZH.status_lead_unconfigured);
  assert.equal(unconfigured.facts.find(fact => fact.key === 'workspace').value, DICT_ZH.workspace_unset);
  assert.equal(unconfigured.note, DICT_ZH.hint_config);

  const empty = statusView({
    ok: true, configured: true, initialized: false, workspace: '/w', source: 'installer-config', mode: 'native',
    today: '2026-11-07', subjects: [], unreadable: [], watch: { watching: true, backend: 'node-fs' },
  }, t);
  assert.equal(empty.lead, DICT_ZH.status_lead_empty);
  assert.equal(empty.note, DICT_ZH.hint_config);

  const many = statusView({
    ok: true, configured: true, initialized: true, workspace: '/w', source: 'installer-config',
    mode: 'native', today: '2026-11-07', unreadable: [], watch: { watching: true, backend: 'node-fs' },
    subjects: Array.from({ length: 6 }, (_, index) => ({ slug: 's' + index, name: '科目' + index, stats: { 已学完: 1 } })),
  }, t);
  assert.equal(many.facts.length, 5, '工作区 + 最多四门科目');
  assert.equal(many.note, DICT_ZH.subject_more.replace('{n}', '2'));

  const broken = statusView({
    ok: true, configured: true, initialized: true, workspace: '/w', source: 'installer-config',
    mode: 'native', today: '2026-11-07',
    subjects: [], unreadable: [{ dir: 'bad', error: 'curriculum.yaml:1:1: 坏' }],
    watch: { watching: false, backend: '未起' },
  }, t);
  assert.ok(broken.unreadable.includes('1'));
  assert.equal(broken.unreadableTitle, 'bad: curriculum.yaml:1:1: 坏');
});

test('插件页：三档计数只数数字，值不合法不参与合计', () => {
  const line = progressOf({ stats: { 未开始: 2, 学习中: 'x', 已学完: 1 } }, t);
  assert.ok(line.includes('1') && line.includes('3'), line);
  assert.equal(progressOf({}, t), DICT_ZH.progress_line.replace('{done}', '0').replace('{total}', '0'));
});

test('插件页：配置卡渲染原生表单（输入 + 选择… + 保存/恢复默认）', () => {
  const locale = fakeLocale();
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { workspace: '/old' }, writable: true, revision: 3, base: {}, user: {} }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
  };
  const configForms = { get: id => (id === 'studymate' ? form : undefined) };
  const uiWorkspace = { pickDirectory: async () => '/picked' };
  const { ctx } = fakeCtx({ locale: locale.service, configForms, uiWorkspace });
  loadClient().plugin.apply(ctx);

  const tree = renderWithState(WorkspaceConfigCard, { view: 'page', form: undefined }, []);
  assert.ok(tree.includes(DICT_ZH.config_title), tree);
  assert.ok(tree.includes(DICT_ZH.choose), tree);
  assert.equal(tree.includes('选择目录'), false, '选择按钮文案应当只剩「选择…」');
  assert.ok(tree.includes(DICT_ZH.save), tree);
  assert.ok(tree.includes('/old'), tree);
  assert.ok(tree.includes(DICT_ZH.reset), tree);
});

test('插件页：卡片契约——border / radius / 下沉 body / 标题 / facts 与右上小按钮', () => {
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(PAGE_CSS);
    assert.ok(match, `PAGE_CSS 里没有 ${selector} 规则`);
    return match[1];
  };
  const has = (selector, ...declarations) => {
    const body = rule(selector);
    for (const declaration of declarations) {
      assert.ok(body.includes(declaration), `${selector} 缺少声明：${declaration}\n实际：${body}`);
    }
  };

  // 配置卡：与实例里 dsh-ops 0.5.0 的 ops-card / ops-card-body 同一套几何。
  has('.smd-card', 'border:.5px solid var(--dsw-alias-border-l2)', 'border-radius:var(--dsw-radius-lg)', 'padding:14px', 'gap:10px');
  has('.smd-card-body', 'padding:12px', 'border-radius:var(--dsw-radius-md)', 'background:var(--dsw-alias-interactive-bg-hover)');
  has('.smd-group-title', 'font-size:13px', 'font-weight:600', 'line-height:20px', 'color:var(--dsw-alias-label-secondary)');
  has('.smd-field-hint', 'font-size:12px', 'line-height:1.5', 'color:var(--dsw-alias-label-tertiary)');
  has('.smd-card-body > .smd-field', 'padding:10px 0');
  has('.smd-settings-actions', 'gap:8px', 'padding-top:4px');
  has('.smd-primary', 'background:var(--dsw-alias-label-primary)', 'color:var(--dsw-alias-bg-layer-3)', 'font-size:13px');
  has('.smd-reset', 'font-size:12px', 'color:var(--dsw-alias-label-secondary)');
  // 状态卡：与 ops-status-card / ops-detail-head / ops-facts 同一套几何。
  has('.smd-status-card', 'border:.5px solid var(--dsw-alias-border-l2)', 'border-radius:var(--dsw-radius-lg)', 'padding:14px', 'gap:10px');
  has('.smd-detail-title', 'font-size:13px', 'font-weight:600', 'line-height:20px', 'color:var(--dsw-alias-label-primary)');
  has('.smd-detail-metric', 'font-size:12px', 'line-height:18px', 'color:var(--dsw-alias-label-tertiary)');
  has('.smd-small', 'height:28px', 'border:.5px solid var(--dsw-alias-border-l3)', 'border-radius:var(--dsw-radius-sm)');
  has('.smd-status-body', 'padding:12px', 'border-radius:var(--dsw-radius-md)', 'background:var(--dsw-alias-interactive-bg-hover)');
  has('.smd-status-lead', 'font-size:13px', 'line-height:1.6', 'color:var(--dsw-alias-label-secondary)');
  has('.smd-facts > div', 'grid-template-columns:max-content minmax(0,1fr)', 'align-items:baseline', 'column-gap:14px');
  has('.smd-facts dt', 'font-size:13px', 'color:var(--dsw-alias-label-tertiary)');
  has('.smd-facts dd', 'font-size:13px');
  has('.smd-status-note', 'margin:12px 0 0', 'font-size:12px', 'line-height:1.6');

  // 旧的 flat 版式与命名不该再留：它们就是这次要被卡片语言替换掉的那一套。
  for (const flat of ['.smd-sec', '.smd-refresh', '.smd-subjects', '.smd-subj', '.smd-config', '.smd-btn', '.smd-muted', '.smd-warn']) {
    assert.equal(PAGE_CSS.includes(flat), false, `旧的 flat 选择器还在：${flat}`);
  }

  // token 纪律：只引官方 --dsw-*；不写 hex/rgb fallback。
  for (const match of PAGE_CSS.matchAll(/var\(\s*(--[\w-]+)/gu)) {
    assert.match(match[1], /^--dsw-/u, `插件页样式引了非官方 token：${match[1]}`);
  }
  assert.equal(/#[0-9a-f]{3,8}\b/iu.test(PAGE_CSS), false, '插件页样式出现 hex 色值');
  assert.equal(/\brgba?\(/iu.test(PAGE_CSS), false, '插件页样式出现 rgb()/rgba() 色值');
});

/** 把桩渲染出的元素树里的 className 收齐（不依赖 DOM；套件直接用组件函数）。 */
function classNames(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.props && typeof node.props.className === 'string') out.push(node.props.className);
  const kids = Array.isArray(node.children) ? node.children
    : node.children === undefined || node.children === null ? [] : [node.children];
  for (const kid of kids) {
    if (Array.isArray(kid)) classNames({ children: kid }, out);
    else classNames(kid, out);
  }
  return out;
}

function componentTree(component, props, state = []) {
  setHookState(state);
  try {
    return component(props);
  } finally {
    resetHookState();
  }
}

/** 元素树里是否有这个类（className 可能是 `a b` 的组合，按词判断）。 */
const hasClass = (classes, name) => classes.some(value => value.split(/\s+/u).includes(name));

test('插件页：真实组件树里状态卡是 card → head/body → lead/facts/note', () => {
  const data = {
    ok: true, configured: true, initialized: true, workspace: '/data/learning', source: 'plugin-config',
    mode: 'native', today: '2026-11-07',
    subjects: [{ slug: 'demo', name: '演示', stats: { 未开始: 1, 已学完: 2 } }],
    unreadable: [], watch: { watching: true, backend: 'node-fs' },
  };
  const tree = componentTree(WorkspaceSectionBody, { t }, [{ phase: 'ready', data, error: null, at: '12:00:00' }]);
  const classes = classNames(tree);
  for (const name of ['smd-detail', 'smd-status-card', 'smd-detail-head', 'smd-detail-title',
    'smd-detail-metric', 'smd-small', 'smd-detail-action', 'smd-status-body', 'smd-status-lead',
    'smd-facts']) {
    assert.ok(hasClass(classes, name), `状态卡组件树里没有 ${name}：${classes.join(' ')}`);
  }
  // note 只在「还没配置 / 还没有科目 / 还有更多科目」时出现；正常态不占一行。
  assert.equal(hasClass(classes, 'smd-status-note'), false);
  const unconfigured = componentTree(WorkspaceSectionBody, { t }, [{
    phase: 'ready', at: '12:00:00', error: null,
    data: { ok: true, configured: false, initialized: false, workspace: '', subjects: [], unreadable: [], watch: {} },
  }]);
  assert.ok(hasClass(classNames(unconfigured), 'smd-status-note'), '未配置时应当有一句去配置页的 note');
  // facts 是 description list：每行 dt/dd；科目也折成一行事实。
  assert.equal(hasClass(classes, 'smd-facts'), true);
  const text = renderWithState(WorkspaceSectionBody, { t }, [{ phase: 'ready', data, error: null, at: '12:00:00' }]);
  assert.ok(text.includes(DICT_ZH.status_lead_ready.replace('{n}', '1')), text);
  assert.ok(text.includes('演示'), text);
});

test('插件页：真实组件树里保存/重置在卡片之后，卡片内有 head 与下沉 body', () => {
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { workspace: '/old' }, writable: true, revision: 3, base: {}, user: {} }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
  };
  const tree = componentTree(WorkspaceConfigBody, { form, t });
  const classes = classNames(tree);
  for (const name of ['smd-settings', 'smd-group', 'smd-card', 'smd-group-head', 'smd-field-text',
    'smd-group-title', 'smd-field-hint', 'smd-card-body', 'smd-field', 'smd-field-label',
    'smd-inline', 'smd-input', 'smd-small', 'smd-settings-actions', 'smd-primary', 'smd-reset']) {
    assert.ok(hasClass(classes, name), `配置卡组件树里没有 ${name}：${classes.join(' ')}`);
  }
  // 卡片是 form 的第一个孩子；保存/重置在同级的 actions 里，不在卡片里。
  const kids = Array.isArray(tree.children) ? tree.children : [tree.children];
  assert.equal(hasClass([kids[0].props.className], 'smd-card'), true);
  const actions = kids.find(kid => kid && kid.props && kid.props.className === 'smd-settings-actions');
  assert.ok(actions, '没有找到卡片之后的 smd-settings-actions');
  const actionNames = classNames(actions);
  assert.ok(hasClass(actionNames, 'smd-primary') && hasClass(actionNames, 'smd-reset'));
  assert.equal(hasClass(actionNames, 'smd-card'), false);
});

test('插件页：选择… 优先用 Desktop 的系统目录桥', async () => {
  const previous = globalThis.__DSH_DIRECTORY_PICKER__;
  try {
    globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => '/picked/system' };
    assert.equal(await pickDirectoryOnce(), '/picked/system');
    delete globalThis.__DSH_DIRECTORY_PICKER__;
    // 把 pageHost 切到一个没有 uiWorkspace 的组合：两样都没有时必须明确拒绝，不能假装选到。
    loadClient().plugin.apply(fakeCtx({ locale: fakeLocale().service }).ctx);
    await assert.rejects(pickDirectoryOnce(), /no-directory-picker/);
  } finally {
    if (previous === undefined) delete globalThis.__DSH_DIRECTORY_PICKER__;
    else globalThis.__DSH_DIRECTORY_PICKER__ = previous;
  }
});

test('插件页 i18n：两本字典键集一致、en 零 CJK、占位符一致，每个 t(key) 都有定义', () => {
  const zhKeys = Object.keys(DICT_ZH).sort();
  const enKeys = Object.keys(DICT_EN).sort();
  assert.deepEqual(enKeys, zhKeys, 'zh/en 字典的键集必须一致');
  for (const key of enKeys) {
    assert.equal(CJK.test(DICT_EN[key]), false, `en 字典的 ${key} 里有 CJK：${DICT_EN[key]}`);
    assert.deepEqual(placeholders(DICT_EN[key]), placeholders(DICT_ZH[key]),
      `${key} 两边的占位符不一致：zh=${DICT_ZH[key]} / en=${DICT_EN[key]}`);
  }
  const used = new Set([...source.matchAll(/\bt\(\s*'([^']+)'/gu)].map(match => match[1]));
  assert.ok(used.size > 10, `没扫到几个文案 key（${used.size}），门可能失效了`);
  for (const key of used) {
    assert.equal(Object.prototype.hasOwnProperty.call(DICT_ZH, key), true, `用到的 key 没有定义：${key}`);
  }
});
