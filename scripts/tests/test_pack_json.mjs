// #250：npm 12 起 `npm pack --json` 从数组改成「以包名为键的对象」，两处按数组取下标的地方
// （`scripts/tests/test_bundle.mjs` 与 `scripts/release/release.mjs` 的 `packPackage()`）
// 都会拿到 `undefined`。这份套件只钉 `packEntry` 这一件事：两种形状都认、认不出来就报错；
// 真正的端到端（打包 → 装进 node_modules → 起 CLI）仍归 `test_bundle.mjs`。
import assert from 'node:assert/strict';
import test from 'node:test';
import { packEntry } from '../release/release.mjs';

const ENTRY = {
  id: '@yunmiao/studymate@2.0.4',
  name: '@yunmiao/studymate',
  version: '2.0.4',
  filename: 'yunmiao-studymate-2.0.4.tgz',
};

test('npm 11 的数组形状：取出唯一那一项', () => {
  assert.deepEqual(packEntry(JSON.stringify([ENTRY])), ENTRY);
});

test('npm 12 的对象形状：键是包名，值就是原来数组里的那一项', () => {
  assert.deepEqual(packEntry(JSON.stringify({ '@yunmiao/studymate': ENTRY })), ENTRY);
});

test('两种形状给出同一个对象，校验判断不跟着形状变', () => {
  const fromArray = packEntry(JSON.stringify([ENTRY]));
  const fromObject = packEntry(JSON.stringify({ '@yunmiao/studymate': ENTRY }));
  assert.deepEqual(fromArray, fromObject);
  assert.equal(fromObject.filename, ENTRY.filename);
});

test('认不出来的形状报错，而不是拿 undefined 往下走', () => {
  // 空数组 / 空对象 / 多包：都不是「这一次打的那一个包」
  assert.throws(() => packEntry('[]'), /形状认不出来/);
  assert.throws(() => packEntry('{}'), /形状认不出来/);
  assert.throws(() => packEntry(JSON.stringify([ENTRY, ENTRY])), /形状认不出来/);
  // 不是 JSON：报错信息要指明是解析失败，而不是形状不对
  assert.throws(() => packEntry('not json'), /不是 JSON/);
  // null 也是合法 JSON，但它不是「一个包」
  assert.throws(() => packEntry('null'), /形状认不出来/);
});
