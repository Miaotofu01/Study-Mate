/* lib/client.js 的纯函数与「CSS 常量」对账：动效四档、首次引导定位几何。
   ────────────────────────────────────────────────────────────────────────────────
   被测的两样都要求在**不碰 DOM** 的前提下可单测（规格 §4.4：动效四档、引导定位几何）。

   怎么拿到工厂里的纯函数：这个文件是零构建的浏览器插件，没有 export，纯函数活在
   `window.__ModuleLoader__.load({factory})` 的工厂闭包里。所以这里用 node:vm 把
   整份源码跑一遍，喂一个假的 window 与 require，拿到 factory 再跑一次——插件自己
   在 window.__STUDYMATE_TEST__ 为真时把纯函数挂出来（见源码里的那段注释）。
   刻意**不**用正则去扒函数源码：那种做法一改写法就悄悄失效。

   `npm test` 里跑，不需要浏览器。
*/
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { extractCss, parseTokenBlock } from './fixtures/client-css.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
const CSS = extractCss(SOURCE);
const TOKENS = parseTokenBlock(CSS);

/** 把插件源码在 vm 里跑一遍，拿回它挂出来的纯函数。 */
function loadPure() {
  let spec = null;
  const sandbox = {
    window: {
      __STUDYMATE_TEST__: true,
      __ModuleLoader__: { load(loaded) { spec = loaded; } },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SOURCE, vm.createContext(sandbox), { filename: 'lib/client.js' });
  assert.ok(spec && typeof spec.factory === 'function', '插件没有调 window.__ModuleLoader__.load({factory})');
  // 工厂只 require 冻结模块表里的 react；这里给一个不碰 DOM 的桩。
  const react = {
    createElement: () => null,
    Fragment: Symbol('react.fragment'),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: () => undefined,
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  };
  const mod = spec.factory((name) => (name === 'react' ? react : undefined));
  const pure = sandbox.window.__STUDYMATE_PURE__;
  assert.ok(pure, '工厂没有挂 window.__STUDYMATE_PURE__（纯函数外露钩子被删了？）');
  assert.ok(mod && typeof mod.apply === 'function', '工厂没有返回 { inject, apply }');
  return pure;
}

const PURE = loadPure();
const { coachPlacement, motionFor, MOTION_LEVELS, MOTION_MS } = PURE;

/* ── 动效四档 ──────────────────────────────────────────────────────────── */

const ms = (text) => Number(text);

test('动效四档：auto / full / reduced / off 一个不少', () => {
  assert.deepEqual([...MOTION_LEVELS].sort(), ['auto', 'full', 'off', 'reduced']);
});

test('motionFor：auto 跟随 prefers-reduced-motion，其余三档直给', () => {
  // 结果对象来自 vm 里的 realm，展开一层再比，免得 deepStrictEqual 拿原型说事
  const pick = (level, reduced) => ({ ...motionFor(level, reduced) });
  assert.deepEqual(pick('auto', false), { level: 'auto', effective: 'full', ms: 140 });
  assert.deepEqual(pick('auto', true), { level: 'auto', effective: 'reduced', ms: 70 });
  assert.equal(motionFor('full', true).ms, 140);     // 显式选了全动效就不跟随系统
  assert.equal(motionFor('reduced', false).ms, 70);
  assert.equal(motionFor('off', false).ms, 0);
  // 坏值（改坏的 localStorage / 旧值）退回 auto，不是崩掉
  assert.deepEqual(pick('半档', true), pick('auto', true));
  assert.deepEqual(pick(undefined, false), pick('auto', false));
});

test('CSS 里的四档与 motionFor 的取值一一对应（不是两份真相）', () => {
  for (const level of ['full', 'reduced', 'off']) {
    const rule = new RegExp('\\.smb-root\\[data-motion="' + level + '"\\]\\s*\\{\\s*--smb-motion:\\s*(\\d+)ms');
    const found = rule.exec(CSS);
    assert.ok(found, `CSS 里没有 .smb-root[data-motion="${level}"] 的 --smb-motion`);
    assert.equal(ms(found[1]), MOTION_MS[level], `${level} 档的 CSS 时长与 motionFor 对不上`);
  }
  // auto 的「系统没要求」那一支走 .smb-root 的默认值
  assert.equal(TOKENS.get('--smb-motion').fallback, MOTION_MS.full + 'ms', '.smb-root 的默认动效时长不是 full 档');
});

test('prefers-reduced-motion 真的生效：auto 档在媒体查询里被改写成 reduced', () => {
  const media = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.smb-root\[data-motion="auto"\]\s*\{\s*--smb-motion:\s*(\d+)ms/.exec(CSS);
  assert.ok(media, 'CSS 里没有 @media (prefers-reduced-motion: reduce) 覆盖 auto 档——系统偏好就不生效了');
  assert.equal(ms(media[1]), MOTION_MS.reduced, 'auto 档在「减少动效」下应当落到 reduced');
  // 显式档位不受系统偏好影响：媒体查询里只许出现 auto
  const inside = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion'), CSS.indexOf('@media (prefers-reduced-motion') + 300);
  assert.ok(!/data-motion="(full|reduced|off)"/.test(inside), '显式档位不该被系统偏好改写');
});

/* ── 首次引导定位几何 ──────────────────────────────────────────────────── */

const rect = (left, top, width, height) => ({ left, top, width, height });
const VIEWPORT = rect(0, 0, 1440, 900);
const BUBBLE = { width: 320, height: 120 };

/** 不越界：左/上永远在内框里；塞得下时右/下也在内框里。 */
function assertInside(result, bounds, margin = 8) {
  const inner = { left: bounds.left + margin, top: bounds.top + margin, right: bounds.left + bounds.width - margin, bottom: bounds.top + bounds.height - margin };
  assert.ok(result.left >= inner.left - 1e-6, `left=${result.left} 越过了左内边 ${inner.left}`);
  assert.ok(result.top >= inner.top - 1e-6, `top=${result.top} 越过了上内边 ${inner.top}`);
  if (result.width <= inner.right - inner.left) {
    assert.ok(result.left + result.width <= inner.right + 1e-6, `右边越界：${result.left + result.width} > ${inner.right}`);
  }
  if (result.height <= inner.bottom - inner.top) {
    assert.ok(result.top + result.height <= inner.bottom + 1e-6, `下边越界：${result.top + result.height} > ${inner.bottom}`);
  }
}

test('优先方位放得下就用优先方位，并且对准目标', () => {
  const target = rect(600, 300, 200, 80);
  const out = coachPlacement({ target, bounds: VIEWPORT, size: BUBBLE });
  assert.equal(out.side, 'bottom');
  assert.equal(out.top, target.top + target.height + 8);        // 目标下方 gap
  assert.equal(out.left, target.left + target.width / 2 - BUBBLE.width / 2);
  assertInside(out, VIEWPORT);

  const right = coachPlacement({ target, bounds: VIEWPORT, size: BUBBLE, preferred: 'right' });
  assert.equal(right.side, 'right');
  assert.equal(right.left, target.left + target.width + 8);
  assertInside(right, VIEWPORT);
});

test('优先方位放不下就按剩余空间换边', () => {
  // 目标贴着视口底部：下面没地方，换到上面
  const bottom = rect(600, 800, 200, 80);
  assert.equal(coachPlacement({ target: bottom, bounds: VIEWPORT, size: BUBBLE, preferred: 'bottom' }).side, 'top');
  // 目标贴着右边缘：右边没地方，换到左边
  const corner = rect(1240, 300, 180, 80);
  assert.equal(coachPlacement({ target: corner, bounds: VIEWPORT, size: BUBBLE, preferred: 'right' }).side, 'left');
  // 目标贴左边缘、优先方位是 left：换到右边
  const left = rect(0, 300, 120, 80);
  assert.equal(coachPlacement({ target: left, bounds: VIEWPORT, size: BUBBLE, preferred: 'left' }).side, 'right');
});

test('窄容器（侧边栏）：停靠底部，横向仍对准目标', () => {
  // 220px 宽的侧栏、气泡 200×90：左右都放不下，上下也不够同时容下目标与气泡
  const bounds = rect(0, 0, 220, 600);
  const target = rect(10, 60, 200, 460);     // 目标几乎占满侧栏
  const out = coachPlacement({ target, bounds, size: { width: 200, height: 90 } });
  assert.equal(out.side, 'docked');
  assert.equal(out.top, bounds.top + bounds.height - 8 - 90);   // 贴底边（留 margin）
  assertInside(out, bounds);
});

test('目标占满容器：退到内角，仍然不越界', () => {
  const bounds = rect(0, 0, 220, 600);
  const target = rect(0, 0, 220, 600);        // 目标铺满
  const big = { width: 260, height: 160 };    // 气泡比容器还大：连塞都塞不下
  const out = coachPlacement({ target, bounds, size: big });
  assert.equal(out.side, 'corner');
  assert.equal(out.width, bounds.width - 16);   // 宽度被夹到内框
  assertInside(out, bounds);
});

test('目标在右上时，内角退到左下（离目标中心最远）', () => {
  const bounds = rect(0, 0, 200, 200);
  const target = rect(120, 0, 80, 80);        // 右上角一小块
  const out = coachPlacement({ target, bounds, size: { width: 260, height: 260 } });
  assert.equal(out.side, 'corner');
  assert.equal(out.left, 8);                  // 左内边
  assert.equal(out.top, 200 - 8 - out.height); // 下内边
  assertInside(out, bounds);
});

test('随机 300 组输入都不越界（窄侧边栏那类极端值也在内）', () => {
  // 用固定种子的线性同余，保证失败可复现——不引随机库
  let seed = 20261005;
  const next = (max) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648) * max;
  };
  for (let i = 0; i < 300; i++) {
    const bounds = rect(0, 0, 40 + next(1400), 60 + next(840));
    const target = rect(next(bounds.width), next(bounds.height), next(bounds.width), next(bounds.height));
    const size = { width: 40 + next(400), height: 30 + next(300) };
    const preferred = ['top', 'bottom', 'left', 'right'][Math.floor(next(4)) % 4];
    const out = coachPlacement({ target, bounds, size, preferred });
    assert.ok(Number.isFinite(out.left) && Number.isFinite(out.top), `第 ${i} 组算出非有限值`);
    assert.ok(['top', 'bottom', 'left', 'right', 'docked', 'corner'].includes(out.side), `第 ${i} 组 side 非法：${out.side}`);
    assertInside(out, bounds);
  }
});

test('纯函数：不改入参、同样的输入给同样的输出', () => {
  const target = rect(600, 300, 200, 80);
  const bounds = rect(0, 0, 1440, 900);
  const size = { width: 320, height: 120 };
  const snapshot = JSON.stringify([target, bounds, size]);
  const first = coachPlacement({ target, bounds, size, preferred: 'right' });
  const second = coachPlacement({ target, bounds, size, preferred: 'right' });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify([target, bounds, size]), snapshot, 'coachPlacement 改了入参');
});

test('margin 与 gap 可调，且 margin 一律是硬内边', () => {
  const bounds = rect(100, 50, 400, 300);
  const target = rect(320, 150, 120, 80);      // 下方留得下气泡
  const out = coachPlacement({ target, bounds, size: { width: 150, height: 60 }, gap: 4, margin: 20 });
  assert.equal(out.side, 'bottom');
  assert.equal(out.top, target.top + target.height + 4);
  assertInside(out, bounds, 20);
  // 换个贴边的目标：换边之后仍然守 margin 20
  const edge = rect(320, 280, 120, 60);
  const up = coachPlacement({ target: edge, bounds, size: { width: 150, height: 60 }, gap: 4, margin: 20 });
  assert.equal(up.side, 'top');
  assertInside(up, bounds, 20);
});
