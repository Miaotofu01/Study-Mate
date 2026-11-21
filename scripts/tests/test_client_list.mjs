/* 阅读端的正文解析：列表的**从属层级**。
   ────────────────────────────────────────────────────────────────────────────────
   为什么值得一条会失败的测试：从属层级坏了是**静默的**。源文件里写着

       - 一级条目
         - 二级条目

   页面出来是一段正文「- 二级条目」，读者看到的是一串连在一起的短横，看不出「这条属于
   上一条」。这一版之前就是这个状态：`parseBlocks` 的列表分支只吃顶格那几行，缩进的子项
   被下一轮的段落分支收走，喂进 `join(' ')`，于是两级条目挤在同一行里。

   口径（与服务端 `lib/core/format.ts` 的 `parseList` 同一条，别再各定一套）：
     · **缩进 2 格 = 下一层**——`课件内容格式` 的 `list-indent` 判据认的就是这个数，
       缩进 4 格在那边是**报错**，不是「两层」；
     · 子列表挂在它上面那一项上（`item.children`），不是另起一个列表；
     · 条目从字符串变成 `{ text, children, line }`——与服务端 `ListItem` 同构，
       所以阅读端与导出端切出来的层级是同一棵树；
     · 段落合并仍然把连续的行并成一段——正文里没空行就是同一段。

   三件事一起断：层级要建得起来、文本摊平要与 DOM 顺序一致（标注锚点靠它）、
   段落合并不能被顺手改坏。
*/
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

/**
 * 在 vm 里跑一遍插件源码，拿回它挂出来的纯函数。
 *
 * 与 `test_client_pure.mjs` 同一套办法：`lib/client.js` 不导出任何东西，只往
 * `window.__ModuleLoader__` 登记一次工厂；套件伪造这个全局、调用工厂，再从
 * `__studymate_client_internals` 钩子取内部件。React 给一个最小的桩——这一层没有 DOM。
 */
function loadInternals() {
  const requested = [];
  let spec = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(loaded) { spec = loaded; } } },
    console,
  };
  sandbox.globalThis = sandbox;
  let internals = null;
  sandbox.__studymate_client_internals = (value) => { internals = value; };
  vm.runInNewContext(SOURCE, vm.createContext(sandbox), { filename: 'lib/client.js' });
  assert.ok(spec && typeof spec.factory === 'function', '插件没有调 window.__ModuleLoader__.load({factory})');
  /**
   * 渲染层调用过的元素。`createElement` 只记不画（这一层没有 DOM）——「空条目被跳过」
   * 那条判据要靠它数 `<li>` 的个数，否则就只剩一句「没抛」可断。
   */
  const elements = [];
  const react = {
    createElement: (type, props, ...kids) => { elements.push({ type, props, kids }); return null; },
    Fragment: Symbol('react.fragment'),
    // 渲染边界（RenderBoundary）是 `class extends React.Component`，工厂物化时就要这个基类。
    // 这一层没有 DOM、边界一次也跑不到，给一个最小同形物即可。
    Component: class Component {
      constructor(props) { this.props = props; this.state = this.state || {}; }
      setState() {}
    },
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn(),
  };
  spec.factory((name) => {
    requested.push(name);
    if (name === 'react') return react;
    throw new Error(`阅读端多要了一个模块：${name}`);
  });
  assert.deepEqual(requested, ['react'], '宿主只冻结 react 一个模块');
  assert.ok(internals, '工厂没有挂 __studymate_client_internals——parseBlocks 要在那里外露');
  assert.equal(typeof internals.parseBlocks, 'function', 'parseBlocks 没有外露，这一层就没法单测了');
  assert.equal(typeof internals.Block, 'function', 'Block 没有外露，「空条目不炸」那条判据就断不了');
  internals.elements = elements;
  return internals;
}

const client = loadInternals();
const { parseBlocks, blockPlainText, blockFragments, inlinePlainText, Block } = client;

/** 方便：把一段 markdown 解析成块。 */
const parse = (markdown) => parseBlocks(markdown.split('\n'));

/** 从 vm 那个 realm 里取出来的数组原型与本 realm 不同，`deepEqual` 会误报，
    所以比较前先摊成这个 realm 的普通数组。 */
const plain = (items) => Array.from(items || [], (item) => String(item));

/** 递归取列表里的全部条目文字（含子项，先序）。 */
function texts(items) {
  const out = [];
  for (const item of items || []) {
    if (typeof item === 'string') { out.push(item); continue; }
    out.push(item.text);
    if (item.children) out.push(...texts(item.children.items));
  }
  return out;
}

test('缩进 2 格的列表项是上一项的子列表，不是另起一段', () => {
  const blocks = parse('- 一级\n  - 二级\n');
  assert.equal(blocks.length, 1, `应该只有一个块，实际 ${blocks.length} 个：${JSON.stringify(blocks)}`);
  const [list] = blocks;
  assert.equal(list.type, 'list');
  assert.equal(list.items.length, 1, '一级只有一项');
  const [first] = list.items;
  assert.equal(first.text, '一级');
  assert.ok(first.children, '一级项上应该挂着子列表——**这正是那一处从属关系**');
  assert.equal(first.children.items[0].text, '二级');
});

test('三级嵌套建得起来，且每一级都比上一级深一层', () => {
  const blocks = parse('- 一\n  - 二\n    - 三\n');
  assert.equal(blocks.length, 1, `应该只有一个块：${JSON.stringify(blocks)}`);
  const first = blocks[0].items[0];
  const second = first.children && first.children.items[0];
  assert.ok(second && second.children, '三级条目挂不到二级项上');
  assert.equal(second.children.items[0].text, '三');
  assert.deepEqual(plain(texts(blocks[0].items)), ['一', '二', '三']);
});

test('同级的多项留在同一层，不因为中间夹着子列表就断了', () => {
  const blocks = parse('- 甲\n  - 甲一\n- 乙\n');
  assert.equal(blocks.length, 1, `应该只有一个列表块：${JSON.stringify(blocks)}`);
  const [list] = blocks;
  assert.deepEqual(plain(list.items.map((item) => item.text)), ['甲', '乙']);
  assert.ok(list.items[0].children, '甲 底下应该有子列表');
  assert.equal(list.items[0].children.items[0].text, '甲一');
  assert.equal(list.items[1].children, null, '乙 底下没有子项');
});

test('有序列表的嵌套也建得起来，且子列表记着自己的序号类型', () => {
  const blocks = parse('1. 第一步\n  1. 子步骤\n2. 第二步\n');
  assert.equal(blocks.length, 1, `应该只有一个块：${JSON.stringify(blocks)}`);
  const [list] = blocks;
  assert.equal(list.ordered, true);
  assert.deepEqual(plain(list.items.map((item) => item.text)), ['第一步', '第二步']);
  assert.equal(list.items[0].children.ordered, true, '子列表也是有序的');
});

test('缩进 4 格不是下一层（这一层只认 2 格）', () => {
  // 4 格是「两层的深度」，但一次只跨一层；跨两层不是合法缩进，服务端那条 `list-indent`
  // 判据也是同一个数（那边直接报错）。这里断的是「不会因为凑得深就悄悄接受」。
  const blocks = parse('- 一\n    - 四格\n');
  const list = blocks.find((block) => block.type === 'list');
  assert.ok(list, '一级列表还在');
  assert.equal(list.items[0].children, null, '4 格不该建成子列表');
  const leaked = blocks.filter((block) => block.type === 'para' && block.text.includes('四格'));
  assert.equal(leaked.length, 1, '4 格那行落回正文（服务端会按 list-indent 报错拦下）');
});

test('每一条都带着自己的行号，子项的行号也是绝对行号', () => {
  // 行号给标注锚点用（③）：子项漏掉 baseLine 就会报回片段的第一行，
  // 标注会贴到别的段上——那种错看着像「标注自己跑掉了」，其实是行号算错。
  const blocks = parse('- 一\n  - 二\n    - 三\n');
  assert.equal(blocks[0].items[0].line, 1);
  assert.equal(blocks[0].items[0].children.items[0].line, 2);
  assert.equal(blocks[0].items[0].children.items[0].children.items[0].line, 3);
});

test('嵌在指令块里的列表，行号跟着 baseLine 偏移（不是片段内的第 1 行）', () => {
  const lines = ['::: tip 提示', '- 一', '  - 二', ':::'];
  const blocks = parseBlocks(lines, 10);
  const note = blocks[0];
  assert.equal(note.type, 'callout', `应该切成 callout：${JSON.stringify(note)}`);
  const list = note.blocks[0];
  assert.equal(list.type, 'list');
  // body 从第 1 行开始（0-based），baseLine = 10 → 首项在第 12 行（1-based）
  assert.equal(list.items[0].line, 12);
  assert.equal(list.items[0].children.items[0].line, 13);
});

test('纯文本按 DOM 顺序摊平：先这一条的字，再它下面的子项', () => {
  // 这条是标注锚点的前提：`blockPlainText` 必须与 `blockDomText` 逐字一致，
  // 而 DOM 里是 <li>文字<ul>子项</ul></li>，所以子项跟在它那一项后面。
  const blocks = parse('- 甲\n  - 甲一\n- 乙\n');
  assert.equal(blockPlainText(blocks[0]), '甲甲一乙');
});

test('纯文本兼容裸字符串条目（老路径与外部喂进来的块）', () => {
  // `::: resources` / `::: related` 的条目一直是字符串；渲染层与纯文本都要认得两种形态，
  // 不能因为解析器换了形状就把那两条路弄崩。
  assert.equal(blockPlainText({ type: 'list', items: ['甲', '乙'] }), '甲乙');
  assert.equal(blockPlainText({ type: 'list', items: [{ text: '甲', children: null }, '乙'] }), '甲乙');
});

test('检索串里两级条目都搜得到，命中的仍是这一块', () => {
  const blocks = parse('- 甲关键词\n  - 乙关键词\n');
  const fragments = blockFragments(blocks[0], '正文');
  const flat = Array.from(fragments, (one) => one.text);
  assert.deepEqual(flat, ['甲关键词', '乙关键词'],
    `子项也要进检索串：${JSON.stringify(flat)}`);
  assert.ok(Array.from(fragments).every((one) => one.label === '正文'), '命中的都还是这一块');
});

test('同一层换了标记就另起一个列表（与服务端 parseList 的首项锁定同口径）', () => {
  // 服务端 `parseList` 用 `marker = ordered ? ORDERED_RE : UL_RE` 锁住本层的标记，
  // 层内出现另一种标记就收手、由外层再切一个块。阅读端不锁的话，`- 甲` 紧跟 `1. 乙`
  // （中间没有空行）会并成一个无序列表——同一份课件，两端的块边界与标注锚点都不一样。
  const blocks = parse('- 无序一\n1. 有序一\n');
  assert.equal(blocks.length, 2, `应该切成两个列表块：${JSON.stringify(blocks)}`);
  assert.equal(blocks[0].type, 'list');
  assert.equal(blocks[0].ordered, false);
  assert.deepEqual(plain(blocks[0].items.map((item) => item.text)), ['无序一']);
  assert.equal(blocks[1].type, 'list');
  assert.equal(blocks[1].ordered, true);
  assert.deepEqual(plain(blocks[1].items.map((item) => item.text)), ['有序一']);
});

test('同一层一种标记连着写，仍然是一个列表（锁定不许把正常情况切断）', () => {
  const blocks = parse('- 甲\n- 乙\n- 丙\n');
  assert.equal(blocks.length, 1, `同一种标记不该被切碎：${JSON.stringify(blocks)}`);
  assert.deepEqual(plain(blocks[0].items.map((item) => item.text)), ['甲', '乙', '丙']);
});

test('条目里夹着空值：渲染跳过去不抛，检索串里也不留 null', () => {
  // `::: resources` 的老数据与外部喂进来的块可能缺项（null / undefined）。这一版之前
  // `renderItems` 先读 `item.text`、后判空，null 会在渲染里抛 TypeError，整页白屏。
  const block = { type: 'list', ordered: false, items: [null, { text: '甲', children: null }, '乙', undefined] };
  assert.doesNotThrow(() => Block({ block }), '渲染层遇到空条目不该抛');
  const lis = client.elements.filter((element) => element.type === 'li');
  assert.equal(lis.length, 2, `两个真条目照样渲染，空的那两条跳过：${JSON.stringify(lis.map((one) => one.kids))}`);
  const flat = Array.from(blockFragments(block, ''), (one) => one.text);
  assert.deepEqual(flat, ['甲', '乙'], `检索串里不留空值：${JSON.stringify(flat)}`);
});

test('连续的行仍然合并成一个段落（这条不许被顺手改坏）', () => {
  const blocks = parse('第一行\n第二行\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'para');
  assert.equal(blocks[0].text, '第一行 第二行');
});

test('段落里单独的短横不是列表（列表要顶格才认）', () => {
  const blocks = parse('这里有一句 a-b 的话\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'para');
});

test('注入反证：把「缩进 2 格就是下一层」这条判据关掉，层级必然塌掉', () => {
  // 判据本身也要证明它会红。这里不跑变异工具，直接对着**同一份源码**做一次定点改写：
  // 把挂子列表那个条件改成恒假——层级就没地方挂了，缩进的那几行会落回段落分支
  // （正是这一版之前的样子）。若这条断言仍然通过，说明上面那几条其实没在断层级。
  const mutated = SOURCE.replace(
    'if (childLead === indent + 2 && listStart.test(lines[at].slice(childLead))) {',
    'if (false) {',
  );
  assert.notEqual(mutated, SOURCE, '定点改写没命中——判据的锚点变了，这条反证要跟着改');
  const sandbox = {
    window: { __ModuleLoader__: { load(loaded) { sandbox.__spec = loaded; } } },
    console,
  };
  sandbox.globalThis = sandbox;
  let internals = null;
  sandbox.__studymate_client_internals = (value) => { internals = value; };
  vm.runInNewContext(mutated, vm.createContext(sandbox), { filename: 'lib/client.js.mutated' });
  const react = {
    createElement: () => null, Fragment: Symbol('f'),
    Component: class Component { constructor(props) { this.props = props; this.state = {}; } setState() {} },
    useState: () => [undefined, () => {}], useEffect: () => {},
    useMemo: (fn) => fn(), useRef: () => ({ current: null }), useCallback: (fn) => fn(),
  };
  sandbox.__spec.factory(() => react);
  const blocks = internals.parseBlocks('- 一级\n  - 二级\n'.split('\n'));
  const first = blocks.find((block) => block.type === 'list');
  assert.ok(first, '一级列表还在（这一条不该被变异影响）');
  assert.equal(first.items[0].children, null,
    `层级关掉之后不该有子列表——实际是 ${JSON.stringify(first.items[0].children)}`);
  const leaked = blocks.filter((block) => block.type === 'para' && block.text.includes('二级'));
  assert.equal(leaked.length, 1,
    `缩进那行应该落回正文段落（这一版之前的老症状）：${JSON.stringify(blocks)}`);
});

test('inlinePlainText 对列表条目仍然只是去标记（没被这一版改坏）', () => {
  // 这条守着「只摊平、不改写字」：条目文字里的是行内标记，摊平的是层级不是语法。
  assert.equal(inlinePlainText('**粗**与`码`'), '粗与码');
});
