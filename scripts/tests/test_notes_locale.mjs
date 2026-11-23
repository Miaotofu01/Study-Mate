import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createLocaleScope } from '../../client/notes/host/locale.js';
import { zh, en } from '../../client/notes/locale.js';

test('笔记词典：键与占位符一致，英文无漏译，所有静态调用键存在', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const fields = text => [...text.matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort();
  for (const key of Object.keys(zh)) {
    assert.doesNotMatch(en[key], /[\u3400-\u9fff]/u, key);
    assert.deepEqual(fields(zh[key]), fields(en[key]), key);
  }
  const dir = new URL('../../client/notes/', import.meta.url);
  for (const file of fs.readdirSync(dir).filter(x => /\.(jsx|js)$/.test(x))) {
    const source = fs.readFileSync(new URL(file, dir), 'utf8');
    for (const [, key] of source.matchAll(/\bnt\('([^']+)'/g)) assert.ok(Object.hasOwn(en, key), file + ': ' + key);
  }
});

test('笔记 locale 生命周期：延迟服务、宿主回退、卸载与再加载，不写偏好', () => {
  const scope = createLocaleScope('test-notes', { zh, en });
  let active = 'en', writes = 0, start;
  const listeners = new Set(), dictionaries = new Map();
  const locale = {
    register(ns, values) { assert.equal(dictionaries.has(ns), false); dictionaries.set(ns, values); return () => dictionaries.delete(ns); },
    bind: ns => (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.split('{' + name + '}').join(String(value)), dictionaries.get(ns)[active]?.[key] ?? dictionaries.get(ns).en[key]),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setLocale() { writes++; },
  };
  scope.attach({ inject(names, fn) { assert.deepEqual(names, ['locale']); start = fn; } });
  assert.equal(scope.t('new_folder'), '新建文件夹');
  let notifications = 0;
  const off = scope.subscribe(() => notifications++);
  const mount = () => {
    const cleanups = [];
    start({ locale, effect(fn) { cleanups.push(fn()); } });
    return () => cleanups.reverse().forEach(fn => fn());
  };
  let dispose = mount();
  assert.equal(scope.t('folder', { name: '我的资料' }), '我的资料 folder');
  active = 'zh'; listeners.forEach(fn => fn());
  assert.equal(scope.t('new_folder'), '新建文件夹');
  active = 'fr'; listeners.forEach(fn => fn());
  assert.equal(scope.t('new_folder'), 'New folder');
  dispose(); dispose();
  assert.equal(listeners.size, 0);
  assert.equal(dictionaries.size, 0);
  assert.equal(scope.t('new_folder'), '新建文件夹');
  dispose = mount();
  assert.equal(scope.t('new_folder'), 'New folder');
  dispose(); off();
  assert.ok(notifications >= 6);
  assert.equal(writes, 0);
});

test('笔记 locale 缺失或订阅失败不会阻止挂载、不会遗留字典', () => {
  const scope = createLocaleScope('test-notes', { zh, en });
  scope.attach({ get() {} });
  let removed = 0;
  const warn = console.warn;
  try {
    console.warn = () => {};
    scope.attach({
      locale: { register: () => () => removed++, bind: () => () => 'wrong', subscribe() { throw new Error('fixture'); } },
      effect: fn => fn(),
    });
    assert.equal(scope.t('new_folder'), '新建文件夹');
    assert.equal(removed, 1);
  } finally { console.warn = warn; }
});
