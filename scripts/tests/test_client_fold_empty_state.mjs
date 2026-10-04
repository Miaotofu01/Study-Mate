/* 验收 #78 · 四个附件折叠块对空目录给得出「没有」而不是报错
   ────────────────────────────────────────────────────────────────────────
   四个附件折叠块 = 术语表 / 参考资源 / 学习记录 / 误解记录（规格 §4.1 左栏）。
   空目录不是错误，但展开一片空白等于什么都没说——术语表曾是四个块里唯一漏掉空态的
   （其余三块的空文案见 `ReferenceFoldBody` / `RecordsBody` / `MisconceptionBody`）。

   渲染函数在 `lib/client.js` 的工厂闭包里，靠 `client_harness.mjs` 的 React 桩调起来
   （桩不实现渲染，`viewText` 遇到函数组件就地展开）。数据**现造现弃**，
   不依赖 `examples/.learning/`（#83 会删它）也不依赖真工作区。
   ───────────────────────────────────────────────────────────────────────── */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clientInternals, renderWithState } from './fixtures/client_harness.mjs';

const { GlossaryBody, ReferenceFoldBody, RecordsBody, MisconceptionBody } = clientInternals();

/** 一个空科目：四个块的数据源全是空的。 */
const emptySubject = { slug: 'demo', reference: [], resources_md: '', glossary: [], records: [], misconceptions: [] };

/** 折叠块展开后的实际输出（元素树抠成文本，空白压平便于比对文案）。 */
const render = (component, props) => renderWithState(component, props).replace(/\s+/g, ' ').trim();

test('#78 附件折叠块：空目录四个块都给得出「没有」，不是一片空白', () => {
  const outputs = {
    术语表: render(GlossaryBody, { groups: emptySubject.glossary }),
    参考资源: render(ReferenceFoldBody, { subject: emptySubject }),
    学习记录: render(RecordsBody, { records: emptySubject.records }),
    误解记录: render(MisconceptionBody, { items: emptySubject.misconceptions }),
  };
  for (const [name, text] of Object.entries(outputs)) {
    assert.ok(text.length > 0, `${name}展开后是一片空白`);
    assert.ok(/没有|还是空/.test(text), `${name}的空态没有说「没有」：${text}`);
  }
  assert.equal(outputs.术语表, '这个科目的 GLOSSARY.md 里还没有词条。');
  assert.equal(outputs.参考资源, '这个科目的 reference/ 还是空的。');
  assert.equal(outputs.学习记录, '还没有学习记录。');
  assert.equal(outputs.误解记录, '还没有误解记录。');
});

test('#78 附件折叠块：术语表有词条时照常渲染（空态没吃掉正常分支）', () => {
  const text = render(GlossaryBody, {
    groups: [{ title: '待掌握', terms: [{ term: '命令行（command line）', def: '敲命令让计算机干活的那个窗口。', avoid: '控制台、黑窗口' }] }],
  });
  assert.ok(text.includes('待掌握'));
  assert.ok(text.includes('命令行（command line）'));
  assert.ok(text.includes('别叫：控制台、黑窗口'));
});

test('#78 附件折叠块：术语表里只有空分组时也给空态（不渲染光杆标题）', () => {
  const text = render(GlossaryBody, { groups: [{ title: '只有标题没有词条', terms: [] }] });
  assert.equal(text, '这个科目的 GLOSSARY.md 里还没有词条。');
});

test('#78 附件折叠块：字段整个缺失（半份 payload）也不抛错', () => {
  assert.doesNotThrow(() => render(GlossaryBody, {}));
  assert.doesNotThrow(() => render(RecordsBody, {}));
  assert.doesNotThrow(() => render(MisconceptionBody, {}));
  assert.doesNotThrow(() => render(ReferenceFoldBody, { subject: { slug: 'x' } }));
});

test('#78 附件折叠块：参考资源有条目时照常渲染（空态没吃掉正常分支）', () => {
  const text = render(ReferenceFoldBody, {
    subject: {
      slug: 'demo',
      reference: [{ path: 'a.md', title: '一份资料', ext: '.md', source: 'learner', version: 'v1' }],
      resources_md: '',
    },
  });
  assert.ok(text.includes('一份资料'), '有 reference 条目时没渲染出来：' + text);
  assert.equal(text.includes('还是空的'), false, '有条目时不该走空态');
});

test('#78 附件折叠块：误解记录按 #71 的新字段显示，旧字段退回', () => {
  const text = render(MisconceptionBody, {
    items: [{
      topic: '把赋值当成相等', source: '问答面板', evidence: '追问里说 `a = b` 就是判断相等',
      status: '未处理', at: '2026-09-21', legacy: { answer_summary: '画了一次内存格子的对应关系' },
    }],
  });
  assert.ok(text.includes('把赋值当成相等'), '显示不出 topic');
  assert.ok(text.includes('未处理'), '显示不出 status');
  assert.ok(text.includes('问答面板'), '显示不出 source');
  assert.ok(text.includes('追问里说'), '显示不出 evidence');
  assert.ok(text.includes('画了一次内存格子的对应关系'), '显示不出旧字段里的「当时怎么解的」');
});

test('#78 附件折叠块：学习记录有记录时照常渲染（空态没吃掉正常分支）', () => {
  const text = render(RecordsBody, { records: [{ file: '0001-x.md', title: '学习记录 0001 · 分层模型', date: '2026-09-21', markdown: '# x' }] });
  assert.ok(text.includes('2026-09-21'), '显示不出日期');
  assert.ok(text.includes('学习记录 0001 · 分层模型'), '显示不出标题');
});
