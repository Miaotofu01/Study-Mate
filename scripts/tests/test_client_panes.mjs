/* 三栏几何（#88）：ADR-0011 的让位顺序 +「装不下不许静默」的降级。
   ────────────────────────────────────────────────────────────────────────────────
   为什么单开一条：三栏宽度分配那几个函数活在 `lib/client.js` 的工厂闭包里，浏览器里
   只有截图能看，而「任何画布宽度下都有一栏打得开」「并排的栏加起来不挤破中栏保底」
   这类话是**代数**，不是像素——用真浏览器一条条试太慢、也太脆。所以把分配写成纯函数
   （与 `test_client_pure.mjs` 同一套 `window.__STUDYMATE_PURE__` 钩子），在这里按
   ADR-0011 手算的例子钉住行为，再用几条不变量扫一整段画布宽度。

   独立的那份真相是 **ADR-0011**：右栏先拿（上限 640）、左栏先让（上限 460）、中栏保底
   420，两栏各自的 min 是左 200 / 右 280。下面例子里的数字都是照这份手算出来的，不是
   从实现里抠的。

   窄轨宽只有一处定义在 **CSS 的 `--smb-rail`**：脚本侧量渲染出来的窄轨（`rails` 是入参），
   所以这里既断言「CSS 里只有这一处」，也断言「换一个 rails 值，分配跟着变」——两件都成立，
   才叫「脚本里没有第二遍」。
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

/** 把插件源码在 vm 里跑一遍，拿回它挂出来的纯函数（与 test_client_pure.mjs 同一套口径）。 */
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
  const react = {
    createElement: () => null,
    Fragment: Symbol('react.fragment'),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: () => undefined,
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  };
  spec.factory((name) => (name === 'react' ? react : undefined));
  const pure = sandbox.window.__STUDYMATE_PURE__;
  assert.ok(pure, '工厂没有挂 window.__STUDYMATE_PURE__（纯函数外露钩子被删了？）');
  return pure;
}

const PURE = loadPure();
const { planPanes, drawerWidth, PANE_LIMITS, MIN_CENTER, DRAWER_SLIT } = PURE;

const RAILS = 76;                                   // 两条 38px 窄轨（CSS 里 --smb-rail 一处定义）
const STORED = { left: 264, right: 372 };           // 默认记忆值
const OFF = { left: false, right: false };
const BOTH = { left: true, right: true };
const RIGHT = { left: false, right: true };
const LEFT = { left: true, right: false };

/** 并排时中栏剩下的宽。 */
const centerOf = (frame, plan) => frame - RAILS - plan.left - plan.right;
/** 画布不足时哪一栏在降级：返回 'left' / 'right' / null（没降级）。 */
const drawerSide = (plan) => (plan.drawer ? plan.drawer.side : null);

/* ── ADR-0011 的让位顺序，按手算的例子 ─────────────────────────────────── */

test('宽画布：右栏先拿满记忆值，左栏随后也在自己的记忆值上', () => {
  const plan = planPanes(1440, BOTH, STORED, RAILS, 'right');
  assert.deepEqual({ left: plan.left, right: plan.right, drawer: drawerSide(plan) },
    { left: 264, right: 372, drawer: null });
  assert.equal(centerOf(1440, plan), 728, '中栏应当是中栏自己（1440 − 76 − 264 − 372）');
});

test('右栏拿到的是记忆值与画布里小的那个，不是画布剩多少给多少', () => {
  // 记忆值拉到上限 640：宽画布下右栏就是 640，多出来的归中栏
  const plan = planPanes(1440, BOTH, { left: 264, right: 640 }, RAILS, 'right');
  assert.equal(plan.right, 640);
  assert.equal(plan.left, 264);
  assert.equal(centerOf(1440, plan), 460);
});

test('左栏先让：画布刚够两栏时，左栏被压到 min 之上就不收起', () => {
  // avail = 1100 − 76 − 420 = 604；右栏 372；左栏 min(264, 604−372=232) = 232 ≥ 200
  const plan = planPanes(1100, BOTH, STORED, RAILS, 'right');
  assert.equal(plan.right, 372);
  assert.equal(plan.left, 232);
  assert.equal(centerOf(1100, plan), MIN_CENTER, '左栏让到中栏正好贴住保底');
});

test('再窄一点左栏收起（不是把中栏压到保底以下）', () => {
  // avail = 1000 − 76 − 420 = 504；左栏只剩 min(264, 504−372=132) < 200 → 收起
  const plan = planPanes(1000, BOTH, STORED, RAILS, 'right');
  assert.equal(plan.left, 0);
  assert.equal(plan.right, 372);
  assert.ok(centerOf(1000, plan) >= MIN_CENTER, `中栏 ${centerOf(1000, plan)} 低于保底`);
});

/* ── 装不下时不许静默归零：降级成「盖在正文上」的抽屉 ──────────────────── */

test('右栏并排装不下时，点它拿到的是抽屉（宽度仍按记忆值与画布 clamp）', () => {
  // avail = 700 − 76 − 420 = 204 < 右栏 min 280 → 并排给不了
  const plan = planPanes(700, RIGHT, STORED, RAILS, 'right');
  assert.equal(plan.right, 0, '并排列宽是 0——它当不了栏');
  assert.equal(drawerSide(plan), 'right', '但不能什么都不给：降级成抽屉');
  assert.equal(plan.drawer.width, 372, '抽屉宽还是那个记忆值（700 够放）');
  assert.ok(centerOf(700, plan) >= MIN_CENTER);
});

test('右栏并排的阈值是 rails + 中栏保底 + 右栏 min', () => {
  const threshold = RAILS + MIN_CENTER + PANE_LIMITS.right.min;   // 76 + 420 + 280 = 776
  assert.equal(threshold, 776, '这条阈值是 #84 现状与差距里记的那个 776');
  assert.equal(planPanes(threshold, RIGHT, STORED, RAILS, 'right').right, 280);
  const below = planPanes(threshold - 1, RIGHT, STORED, RAILS, 'right');
  assert.equal(below.right, 0);
  assert.equal(drawerSide(below), 'right');
});

test('两栏都要、画布只够一栏：左栏并排、右栏抽屉，中栏仍贴得住保底', () => {
  // avail = 700 − 76 − 420 = 204：右栏装不下（< 280）；左栏 min(264, 204) = 204 ≥ 200 → 并排
  const plan = planPanes(700, BOTH, STORED, RAILS, 'right');
  assert.equal(plan.left, 204);
  assert.equal(plan.right, 0);
  assert.equal(drawerSide(plan), 'right');
  assert.equal(centerOf(700, plan), MIN_CENTER);
  // 抽屉盖在正文上，但不许越过画布：留一条缝看得见正文（左右栏都算上）
  assert.ok(plan.drawer.width <= 700 - RAILS - plan.left - DRAWER_SLIT,
    `抽屉 ${plan.drawer.width} 会把正文盖没：画布 700 减窄轨、左栏、那条缝只剩 ${700 - RAILS - plan.left - DRAWER_SLIT}`);
});

test('抽屉位只给最近要的那一栏，谁也不多占', () => {
  // 650 的画布：avail = 650 − 76 − 420 = 154，两栏都不够 min → 两栏都想降级，但只有一个位
  const both = (asked) => planPanes(650, BOTH, STORED, RAILS, asked);
  assert.equal(drawerSide(both('left')), 'left', '学生刚点的是左栏，抽屉位就给它');
  assert.equal(drawerSide(both('right')), 'right');
  assert.equal(both('left').drawer.width, 264);
  // 没人要过就谁也不盖上来（want* 与 asked 是一起被设上的，这个组合只是防御性的一支）
  assert.equal(drawerSide(both(null)), null);
});

test('学生这次要的是并排得下的那一栏：另一栏收起，但不顺手盖上来', () => {
  // 900 的画布：右栏 372 并排；左栏只剩 min(264, 404−372=32) < 200 → 收起
  const plan = planPanes(900, BOTH, STORED, RAILS, 'right');
  assert.equal(plan.right, 372);
  assert.equal(plan.left, 0);
  assert.equal(drawerSide(plan), null, '学生点的是题目：不该顺手把左栏盖到正文上');
});

test('降级那一栏不吃掉另一栏已经算好的并排宽度', () => {
  // 1000 的画布：右栏 372 并排；左栏只剩 132 → 学生点左栏时它降级成抽屉，右栏仍在
  const plan = planPanes(1000, BOTH, STORED, RAILS, 'left');
  assert.equal(plan.right, 372, '开一栏不该把另一栏关掉');
  assert.equal(drawerSide(plan), 'left');
});

test('抽屉宽：先给记忆值，画布放不下才让画布说话，且绝不越过画布', () => {
  assert.equal(drawerWidth('right', 372, 700, RAILS, 0), 372, '画布够放：还是那个记忆值');
  assert.equal(drawerWidth('right', 372, 420, RAILS, 0), 420 - RAILS - DRAWER_SLIT, '画布很窄：按画布收');
  assert.equal(drawerWidth('right', 372, 700, RAILS, 260), 700 - RAILS - 260 - DRAWER_SLIT, '另一栏也占着：一起算');
  assert.equal(drawerWidth('left', 460, 400, RAILS, 0), 400 - RAILS - DRAWER_SLIT);
  assert.ok(drawerWidth('left', 264, 200, RAILS, 0) >= 0);
});

/* ── 不变量：扫一整段画布宽度 ─────────────────────────────────────────── */

test('任何画布宽度下，最近要的那一栏都看得见（并排，或者抽屉）', () => {
  const missing = [];
  for (let frame = 240; frame <= 2200; frame += 7) {
    for (const side of ['left', 'right']) {
      const plan = planPanes(frame, BOTH, STORED, RAILS, side);
      const column = side === 'left' ? plan.left : plan.right;
      if (column > 0 || drawerSide(plan) === side) continue;
      missing.push(`${frame}px 要 ${side}：并排 ${column}、抽屉 ${drawerSide(plan) || '无'}`);
    }
  }
  assert.deepEqual(missing, [], `这些画布宽度下点了没反应：\n  ${missing.slice(0, 8).join('\n  ')}`);
});

test('任何画布宽度下：并排的栏加起来不挤破中栏保底，抽屉不越过画布', () => {
  const bad = [];
  for (let frame = 240; frame <= 2200; frame += 7) {
    for (const asked of ['left', 'right', null]) {
      for (const want of [BOTH, LEFT, RIGHT]) {
        const plan = planPanes(frame, want, STORED, RAILS, asked);
        const room = frame - RAILS;
        if (plan.left + plan.right > Math.max(0, room - MIN_CENTER)) {
          bad.push(`${frame}px ${JSON.stringify(want)} ${asked}：并排 ${plan.left}+${plan.right} 挤破保底`);
        }
        if (plan.left > 0 && plan.left < PANE_LIMITS.left.min) bad.push(`${frame}px 左栏 ${plan.left} 比 min 还窄`);
        if (plan.right > 0 && plan.right < PANE_LIMITS.right.min) bad.push(`${frame}px 右栏 ${plan.right} 比 min 还窄`);
        if (plan.drawer) {
          const others = plan.drawer.side === 'left' ? plan.right : plan.left;
          if (plan.drawer.width > Math.max(0, room - others)) {
            bad.push(`${frame}px 抽屉 ${plan.drawer.width} 越过画布（窄轨 ${RAILS} + 另一栏 ${others}）`);
          }
        }
      }
    }
  }
  assert.deepEqual(bad, [], `这些画布宽度下几何不成立：\n  ${bad.slice(0, 8).join('\n  ')}`);
});

test('记忆值只读不写：画布变窄变宽，stored 一个字节都不动', () => {
  const stored = { left: 264, right: 372 };
  const snapshot = JSON.stringify(stored);
  for (let frame = 240; frame <= 2200; frame += 13) {
    planPanes(frame, BOTH, stored, RAILS, 'right');
    drawerWidth('right', stored.right, frame, RAILS, 0);
  }
  assert.equal(JSON.stringify(stored), snapshot);
});

test('变宽自动恢复：同一份记忆值，画布长回去栏宽就长回去', () => {
  const widths = [650, 800, 1000, 1100, 1300, 1440].map((frame) => planPanes(frame, LEFT, STORED, RAILS, 'left'));
  // 650：连并排都没有，只有抽屉；此后一路恢复到记忆值 264
  assert.equal(widths[0].left, 0);
  assert.equal(widths[0].drawer.width, 264);
  const columns = widths.map((plan) => plan.left);
  assert.deepEqual(columns, [0, 264, 264, 264, 264, 264]);
  for (let i = 1; i < columns.length; i++) {
    assert.ok(columns[i] >= columns[i - 1], `画布变宽了栏反而变窄：${columns}`);
  }
});

/* ── 窄轨宽：CSS 一处定义，脚本量它 ───────────────────────────────────── */

test('窄轨宽只有一处定义在 CSS 的 --smb-rail，窄轨宽度引它', () => {
  const tokens = parseTokenBlock(CSS);
  assert.ok(tokens.has('--smb-rail'), 'token 块里没有 --smb-rail —— 窄轨宽又成了散落的字面量');
  const bar = /\.smb-railbar\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(bar, 'CSS 里找不到 .smb-railbar 的规则');
  assert.match(bar[1], /width:\s*var\(--smb-rail\)/, '窄轨宽度没引 --smb-rail，两处会各写一遍');
});

test('脚本侧不再写第二遍：rails 是入参，换一个值分配跟着变', () => {
  // 1000 的画布上，右栏拿到的就是「中栏保底之外剩下的」——窄轨写死 76 还是量出来的 44，
  // 结果必须不一样，否则说明脚本自己算了一份窄轨宽，没用量出来的那个
  const stored = { left: 264, right: 640 };
  const thin = planPanes(1000, RIGHT, stored, 44, 'right');
  const thick = planPanes(1000, RIGHT, stored, 76, 'right');
  assert.equal(thin.right, 1000 - 44 - MIN_CENTER);
  assert.equal(thick.right, 1000 - 76 - MIN_CENTER);
  assert.ok(thin.right > thick.right, '窄轨变窄，中栏保底之外应当多出一栏的宽度');

  // 把手偏移同理：它由 rails 与栏宽算出来，脚本里不许再出现那个数（注释不算——
  // 注释里会引用 ADR 的原文；这里扫的是代码本身）
  const rail = Number(/--smb-rail:\s*([\d.]+)px/.exec(CSS)[1]);
  const script = SOURCE.slice(SOURCE.indexOf('const CSS = `'));
  const afterCss = script.slice(script.indexOf('`;\n') + 3);
  const code = afterCss.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const hits = [...code.matchAll(new RegExp(`\\b${rail}\\b`, 'g'))];
  assert.deepEqual(hits.map((one) => code.slice(Math.max(0, one.index - 24), one.index + 24)), [],
    `脚本里又写了一遍窄轨宽 ${rail}（把手偏移、几何常量都该从量出来的 rails 走）`);
});
