/* 导出（`lib/export/**`）的测试夹具。
   ────────────────────────────────────────────────────────────────────────
   两样东西，都是**现造在临时目录里、跑完即弃**（ADR-0009：仓库里不存样例数据）：

     · `writeExportWorkspace()` —— 一个最小但**该有的都有**的学习工作区：一门科目、
       一课（标题 / 行内公式 / 块级公式 / 配图 / 代码块 / 一道锚点对得上的题）、
       题库、参考资料、一张真 PNG（浏览器套件要断言 `naturalWidth`，占位文本不行）；
     · `fakeReactRoot()` —— 一份**假的** react / react-dom / scheduler（production CJS 形状），
       让核心套件不必依赖这台机器装没装 React。真渲染由 `--browser` 那一套用**真 React** 验。

   为什么假 React 够用：核心套件断言的是**导出器**的行为（产物清单、脚本顺序、哈希、
   守卫、任务与取消），不是 React 的行为。真跑一遍渲染是浏览器套件的事。

   放在 `fixtures/` 而不是 `scripts/tests/` 根下：`scripts/release/checks.mjs` 的套件覆盖断言
   会遍历 `scripts/tests/**`，而 `fixtures/` 被显式跳过（它是夹具，不是套件）。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

import { writeSubject } from './tools.mjs';

/**
 * 一张 48×24 的真 PNG（浅蓝底 + 中间一条橙色带）。
 * 为什么不用 1×1 的占位图：浏览器套件要断言 `naturalWidth > 0`，而截图里也得**看得出来**
 * 图确实出来了——一张透明小点在截图里与「图没加载」长得一模一样。
 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAYCAIAAAAzn+mLAAAANUlEQVR42mO49OTXoEIMow4addCog0acgz5M0xhUaNRBow4addDIc9BoST3qoFEHjTpogBEAtLeVl/wuf9wAAAAASUVORK5CYII=';

/** 题库里与正文锚点**逐字相同**的那个键（锚点四态里的 resolved 一态）。 */
export const ANCHOR_KEY = '什么是变量';

export function lessonMarkdown(title = '变量') {
  return [
    '---',
    `title: ${title}`,
    'goal: 一句话说清它是什么。',
    '---',
    '',
    '## 一节',
    '',
    '正文一段，行内公式 $a^2 + b^2 = c^2$ 在这里；下面还有一个块级公式。',
    '',
    '$$',
    'E = mc^2',
    '$$',
    '',
    '::: figure ../assets/img/pool/dot.png',
    'alt: 一个小点',
    'caption: 一张示意图',
    ':::',
    '',
    '```js',
    "console.log('代码块里的内容也要能看');",
    '```',
    '',
    `::: quiz 理解 锚点：${ANCHOR_KEY}`,
    ':::',
    '',
  ].join('\n');
}

export function poolJson() {
  return JSON.stringify({
    [ANCHOR_KEY]: [{
      kind: '客观题',
      q: '变量是什么？',
      opts: ['一个名字', '一个数字', '一段内存'],
      ans: 0,
      why: '变量是名字，值可以换。',
    }],
  }, null, 2);
}

/**
 * 造一个能导出的最小工作区。
 * @returns {{workspace: string, subjectDir: string, slug: string, nodes: object[]}}
 */
export function writeExportWorkspace(workspace, options = {}) {
  const slug = options.slug ?? 'demo';
  const nodes = options.nodes ?? [{ id: 'var', title: '变量' }, { id: 'fn', title: '函数' }];
  fs.mkdirSync(path.join(workspace, '.learning', 'subjects'), { recursive: true });
  const { dir } = writeSubject(workspace, slug, {
    nodes,
    lesson: lessonMarkdown(nodes[0].title),
    pool: poolJson(),
    // 第二课只为「节点数」存在（主页上多一行），内容与断言无关
    secondLesson: options.secondLesson !== false,
  });
  const assets = path.join(dir, 'assets', 'img', 'pool');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'dot.png'), Buffer.from(PNG_BASE64, 'base64'));
  fs.mkdirSync(path.join(dir, 'reference'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reference', 'notes.md'),
    '# 参考资料\n\n这是学生自己加的一份资料，导出后应当能离线点开。\n');
  return { workspace, subjectDir: dir, slug, nodes };
}

/** 再加一门科目（验「--subject 只导一门」与主页的多科目列表）。 */
export function addSecondSubject(workspace, slug = 'extra') {
  const nodes = [{ id: 'io', title: '输入输出' }];
  const { dir } = writeSubject(workspace, slug, {
    nodes,
    lesson: lessonMarkdown(nodes[0].title),
    pool: poolJson(),
    secondLesson: false,
  });
  return { workspace, subjectDir: dir, slug, nodes };
}

/* ── 假 React：形状对、能解析，但不真渲染 ───────────────────────────────── */

const FAKE_REACT = `'use strict';
exports.createElement = function () { return null; };
exports.Fragment = 'react.fragment';
exports.useState = function (initial) { return [initial, function () {}]; };
exports.useEffect = function () {};
exports.useMemo = function (compute) { return compute(); };
exports.useRef = function (value) { return { current: value }; };
exports.useCallback = function (fn) { return fn; };
`;

const FAKE_REACT_DOM = `'use strict';
exports.flushSync = function (fn) { if (typeof fn === 'function') fn(); };
`;

const FAKE_REACT_DOM_CLIENT = `'use strict';
var React = require('react');
exports.createRoot = function () { return { render: function () {} }; };
exports.version = React && React.version;
`;

const FAKE_SCHEDULER = `'use strict';
exports.unstable_scheduleCallback = function (fn) { if (typeof fn === 'function') fn(); };
`;

function writeFile(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

/**
 * 一份能通过 `resolveReact()` 的**假** React 根（`STUDYMATE_REACT_DIR` 指到它即可）。
 * 目录形状照 npm：`<root>/node_modules/react/cjs/react.production.js` 等；
 * scheduler 是 react-dom 的**嵌套依赖**（与真实布局一致，`react.ts` 也是这么解析的）。
 */
export function fakeReactRoot(dir, version = '0.0.0-fixture') {
  const root = path.join(dir, 'fake-react');
  const pkg = (name, extra = {}) => `${JSON.stringify({ name, version, main: 'index.js', ...extra }, null, 2)}\n`;
  writeFile(root, 'node_modules/react/package.json', pkg('react'));
  writeFile(root, 'node_modules/react/index.js', "module.exports = require('./cjs/react.production.js');\n");
  writeFile(root, 'node_modules/react/cjs/react.production.js', FAKE_REACT);
  writeFile(root, 'node_modules/react-dom/package.json', pkg('react-dom'));
  writeFile(root, 'node_modules/react-dom/index.js', "module.exports = require('./cjs/react-dom.production.js');\n");
  writeFile(root, 'node_modules/react-dom/cjs/react-dom.production.js', FAKE_REACT_DOM);
  writeFile(root, 'node_modules/react-dom/cjs/react-dom-client.production.js', FAKE_REACT_DOM_CLIENT);
  writeFile(root, 'node_modules/react-dom/node_modules/scheduler/package.json', pkg('scheduler'));
  writeFile(root, 'node_modules/react-dom/node_modules/scheduler/cjs/scheduler.production.js', FAKE_SCHEDULER);
  return root;
}
