/* 阅读端的排版阶梯：字号与行高成套、正文只有一档（#89）。
   ────────────────────────────────────────────────────────────────────────────────
   为什么值得一条会失败的测试：这一层的坏法全都「看起来没事」——
     · 同一屏里冒出第二种正文字号（原来是 12.5px 与 13px 并存，差半像素，截图上看不出来）；
     · 行高逐条手写（原来散着六种写法），字号一改行高不跟，字的疏密就成了偶然值；
     · 窄档的覆盖规则写在它要覆盖的基础规则**之前**（同特异度下后写的赢，那几条声明
       从来没生效过，宽窄两档量出来一模一样）；
     · 面包屑的宽度上限按 ch 算（ch 是数字 0 的宽度，中文标题下只剩一半）。
   所以判据写在这里，而不是靠人看截图。

   口径（别顺手放宽）：
     · 阶梯**成对**：一个 --smb-fs-x 必须有一个同名的 --smb-lh-x，且行高必须是**无单位数**。
       写成 px 的话，子元素换了字号还继承父元素那个 px 高度，配对当场断掉。
     · 正文只有一档：字号**字面值**只允许出现在元信息档（≤ 12px 的角标、chip、图注、
       控件文字）。一旦出现 12.5px/13px 这种字面值，同一屏里就又可能有两种正文字号。
     · 正文那一批选择器（正文列 + 右栏题目文本）必须引 --smb-fs-body，行高引它的配对。
     · 窄档（@media）的覆盖必须写在被覆盖的基础规则之后——位置本身就是语义。
*/
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { extractCss, parseTokenBlock } from './fixtures/client-css.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const CSS = extractCss(fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8'));
const TOKENS = parseTokenBlock(CSS);

/** 元信息档的天花板：≤ 这个尺寸的字面值允许出现（角标、chip、图注、控件文字）。 */
const META_CEILING = 12;

/**
 * 把 CSS 拆成一条条规则。`@media` 不是丢掉而是**带着前奏递归进去**——这一层的两个判据
 * （字号字面值、窄档覆盖的先后）都要看媒体块里的规则。
 */
function scanRules(css) {
  const out = [];
  const walk = (text, media, offset) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@')) walk(body, prelude, offset + open + 1);
      else out.push({ selector: prelude, body, media, at: offset + i });
      i = j;
    }
  };
  walk(css, '', 0);
  return out;
}

const RULES = scanRules(CSS);

/** 一条规则里某个属性的值（没有就 null）。简写属性不展开——字号/行高不写简写。 */
function decl(rule, prop) {
  const clean = rule.body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const part of clean.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === prop) return part.slice(at + 1).trim();
  }
  return null;
}

/** 正文（成句的文字）那一批选择器：正文列与右栏题目文本，外加同族的 prose 块。 */
const PROSE_SELECTORS = [
  '.smb-root',                 // 正文那一档就定义在这里，全树继承
  '.smb-doc',                  // 正文列本体
  '.smb-goal',                 // 本节目标
  '.smb-quote',                // 引用块（正文里与问答面板里的引用）
  '.smb-note',                 // 提示块
  '.smb-practice__head',
  '.smb-practice__body',
  '.smb-table',
  '.smb-anchoritem__text',     // 右栏：锚点原文
  '.smb-agroup__text',         // 右栏：组标题
  '.smb-opt',                  // 右栏：选项
  '.smb-why',                  // 右栏：解析
  '.smb-ta',
  '.smb-input',
  '.smb-empty',
  '.smb-askchip',
  '.smb-askbody p',
  '.smb-crumb',                // 顶部面包屑
  '.smb-rtab',                 // 右栏 tab
  '.smb-hit__text',            // 搜索命中正文
];

test('字号与行高成对：每个 --smb-fs-* 都有一个同名的 --smb-lh-*', () => {
  const sizes = [...TOKENS.keys()].filter((name) => name.startsWith('--smb-fs-'));
  const lines = [...TOKENS.keys()].filter((name) => name.startsWith('--smb-lh-'));
  assert.ok(sizes.length >= 4, `阶梯只有 ${sizes.length} 档，是不是被删空了：${sizes.join('、')}`);
  const orphanSizes = sizes.filter((name) => !TOKENS.has(name.replace('--smb-fs-', '--smb-lh-')));
  const orphanLines = lines.filter((name) => !TOKENS.has(name.replace('--smb-lh-', '--smb-fs-')));
  assert.deepEqual(orphanSizes, [], `这些字号没有配对的行高：${orphanSizes.join('、')}`);
  assert.deepEqual(orphanLines, [], `这些行高没有配对的字号：${orphanLines.join('、')}`);
});

test('行高是无单位数（px 行高会把配对断在继承上）', () => {
  const bad = [];
  for (const name of TOKENS.keys()) {
    if (!name.startsWith('--smb-lh-')) continue;
    const value = TOKENS.get(name).fallback;
    if (!/^\d+(\.\d+)?$/.test(String(value))) bad.push(`${name}: ${value}`);
  }
  assert.deepEqual(bad, [],
    `行高要写成无单位数（乘在字号上），别写 px：\n  ${bad.join('\n  ')}`);
});

test('字号字面值只出现在元信息档：正文那一档必须引 token', () => {
  const bad = [];
  for (const rule of RULES) {
    const value = decl(rule, 'font-size');
    if (!value || value.startsWith('var(--smb-fs-') || /(em|%)$/.test(value)) continue;
    const px = /^([\d.]+)px$/.exec(value);
    if (!px) { bad.push(`${rule.selector} → ${value}（只认 px 或阶梯 token）`); continue; }
    if (Number(px[1]) > META_CEILING) bad.push(`${rule.selector} → ${value}（超过元信息档 ${META_CEILING}px 就得引阶梯）`);
  }
  assert.deepEqual(bad, [],
    `这些字号是字面值、又在正文档以上——同一屏里会冒出第二种正文字号：\n  ${bad.join('\n  ')}`);
});

test('正文那一批选择器引的是 --smb-fs-body 与它配对的行高', () => {
  const bySelector = new Map();
  for (const rule of RULES) {
    if (rule.media) continue;                       // 窄档只调布局，不另立一档字号
    if (!PROSE_SELECTORS.includes(rule.selector)) continue;
    bySelector.set(rule.selector, Object.assign(bySelector.get(rule.selector) || {}, {
      size: decl(rule, 'font-size'),
      line: decl(rule, 'line-height'),
    }));
  }
  const missing = PROSE_SELECTORS.filter((sel) => !bySelector.has(sel));
  assert.deepEqual(missing, [], `这些正文选择器在 CSS 里找不到了（改名了？）：${missing.join('、')}`);

  const bad = [];
  for (const [selector, one] of bySelector) {
    if (one.size && one.size !== 'var(--smb-fs-body)' && !/(em|%)$/.test(one.size)) {
      bad.push(`${selector} 的字号是 ${one.size}`);
    }
    if (one.line && one.line !== 'var(--smb-lh-body)' && !/^\d/.test(one.line)) {
      bad.push(`${selector} 的行高是 ${one.line}`);
    }
    if (one.line && /^\d/.test(one.line) && one.size === 'var(--smb-fs-body)') {
      bad.push(`${selector} 引了正文那一档字号，却自己手写了行高 ${one.line}`);
    }
  }
  assert.deepEqual(bad, [],
    `正文只有一档（13px/1.65），这些地方各写各的：\n  ${bad.join('\n  ')}`);
});

test('窄档（@media）的覆盖写在被覆盖的基础规则之后', () => {
  const lastBase = new Map();
  for (const rule of RULES) {
    if (rule.media) continue;
    lastBase.set(rule.selector, Math.max(lastBase.get(rule.selector) ?? -1, rule.at));
  }
  const dead = [];
  for (const rule of RULES) {
    if (!rule.media) continue;
    const base = lastBase.get(rule.selector);
    if (base !== undefined && base > rule.at) dead.push(`${rule.selector}（基础规则在 ${base}，覆盖在 ${rule.at}）`);
  }
  assert.deepEqual(dead, [],
    `这些窄档声明写在基础规则之前，同特异度下后者赢——它们是死声明：\n  ${dead.join('\n  ')}`);
});

test('面包屑的宽度上限按全角字算（em），不按 ch', () => {
  // `.smb-crumb` 在文件里出现两处（中栏那一处是早先留下的、顶部那一处才是现在生效的），
  // 所以这里不认「第几条」，只认**谁声明了 max-width / text-overflow**。
  const widthRules = RULES.filter((rule) => rule.selector === '.smb-crumb' && decl(rule, 'max-width'));
  assert.ok(widthRules.length >= 2,
    `面包屑应该有一条基础宽度上限 + 一条窄档覆盖，实际 ${widthRules.length} 条`);
  const bad = [];
  for (const rule of widthRules) {
    const value = decl(rule, 'max-width');
    if (/ch$/.test(value)) bad.push(`${rule.media || '宽档'}：${value}——ch 是数字 0 的宽，中文标题下只剩一半`);
    else if (!/em$/.test(value)) bad.push(`${rule.media || '宽档'}：${value}——宽度上限要按全角字算（em）`);
  }
  assert.deepEqual(bad, [], bad.join('\n  '));

  const ellipsis = RULES.find((rule) => rule.selector === '.smb-crumb'
    && decl(rule, 'text-overflow') === 'ellipsis' && decl(rule, 'white-space') === 'nowrap');
  assert.ok(ellipsis, '面包屑的省略要靠 text-overflow: ellipsis + white-space: nowrap，这两条别丢');
});
