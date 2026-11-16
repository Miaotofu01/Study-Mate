/* 导出（⑤）· 产物内嵌标注 = 只读快照
   ────────────────────────────────────────────────────────────────────────
   这一条钉住「导出页里标注能看、不能改」这件事的可断言部分：

     · `data.js` 的 `library` 快照带只读标记 `offline: true`——离线页没有 Host 半，
       写请求一律 403（见 `host.js` 那段说明）；阅读端据此进入只读模式，不专为导出页开第二条读法；
     · 标注数据（`node.annotations.items`，形状 `{id, note, ranges, created, modified}`）
       原样进 `data.js`：data.js 的唯一生成函数 `dataScript` 是这一步的落点；
     · 真导出的 `studymate-client.js` 与仓库里 `lib/client.js` 逐字节相同（复用同一个阅读端，
       不写第二个渲染器——只读模式因此不需要第二份实现）；
     · 泄漏守卫对这一份真产物干净；
     · 只读模式下客户端界面：高亮/列表照常，编辑 / 删除 / 重指 / 引用提问入口都不出现。

   为什么「标注进 data.js」这条要绕一步：Host 数据层把盘上标注读进 `node.annotations` 是
   并行的那一笔（`lib/library.ts`），本分支只做阅读端。所以这里先跑**真导出**，拿到真产物
   与真快照；再把一条标注塞进那份快照、用**生产用的** `dataScript` 序列化一遍——验证的正是
   「标注数据原样进 data.js、且只读标记还在」。Host 侧的读入由数据层自己的套件守；两边对
   契约的理解一致（`{present, version, items}`）。等 Host 那笔合入后，可以把注入那一步删掉、
   直接断真导出里的 item，断言结构不用改。
   ───────────────────────────────────────────────────────────────────────── */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runExport } from '../../lib/export/run.ts';
import { resolveReact } from '../../lib/export/react.ts';
import { readExportDir, checkExport } from '../../lib/export/guard.ts';
import { dataScript } from '../../lib/export/page.ts';
import { clientSourceFile } from '../../lib/export/plan.ts';
import { readLibrary } from '../../lib/library.ts';
import { tempDir } from './fixtures/tools.mjs';
import { writeExportWorkspace, fakeReactRoot } from './fixtures/export_workspace.mjs';
import { clientInternals, findByProp, viewText } from './fixtures/client_harness.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/* 阅读端工厂闭包里的内部件（只在工厂物化那一下经 TEST_HOOK 交出来，所以进程里取一次就缓存）。 */
const client = clientInternals();

/** 一条标注：契约形状与 Host 侧 Annotation 逐字一致（ranges 里只存锚点，不存原文）。 */
const ANNOTATION = {
  id: 'an-export-fixture',
  note: '这一段的注释：变量是名字，值可以换。',
  ranges: [{ line: 9, kind: 'para', hash: '0123abcd', start: 0, end: 4 }],
  created: '2026-11-16T00:00:00.000Z',
  modified: '2026-11-16T00:10:00.000Z',
};

/** 一份现造的临时工作区（含一条**盘上的**标注）+ 夹具 React（ADR-0009：仓库里不存样例数据）。 */
function fixture(t) {
  const root = tempDir(t, 'studymate-export-annotations-');
  const workspace = path.join(root, '学习资料');
  fs.mkdirSync(workspace, { recursive: true });
  writeExportWorkspace(workspace);
  writeAnnotationFile(workspace);
  const react = resolveReact({
    env: { ...process.env, STUDYMATE_REACT_DIR: fakeReactRoot(root) },
    probeGlobal: false,
  });
  return { root, workspace, react };
}

/**
 * 盘上的标注文件：`.learning/subjects/<slug>/annotations/<NNNN>-<节点id>.json`，顶层中文键
 * （`节点 / 课件 / 幂等键? / 最后写入 / 标`，`标` 是 id → Annotation 的 Record）。
 * 形状与 Host 数据层 `lib/annotations.ts` 逐字一致；没有 `annotations/` 目录也是合法常态
 * （没标过 = payload 里 `present:false`），所以这只是「有标注」那一支的夹具。
 * `课件` 只写文件名（与 `lessons/<NNNN>-<节点id>.md` 的规律一致）。
 */
function writeAnnotationFile(workspace) {
  const dir = path.join(workspace, '.learning', 'subjects', 'demo', 'annotations');
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    节点: 'var',
    课件: '0001-var.md',
    幂等键: 'op-export-fixture',
    最后写入: ANNOTATION.modified,
    标: { [ANNOTATION.id]: ANNOTATION },
  };
  fs.writeFileSync(path.join(dir, '0001-var.json'), JSON.stringify(record, null, 2) + '\n');
}

/** `data.js` 的唯一形状：`window.__STUDYMATE_EXPORT__ = <JSON>;\n`。切回 JSON 对象。 */
function readDataPayload(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = /window\.__STUDYMATE_EXPORT__ = ([\s\S]*);\n?$/.exec(text);
  assert.ok(match, 'data.js 不是 window.__STUDYMATE_EXPORT__ = <JSON> 的形状');
  return JSON.parse(match[1]);
}

test('真导出：data.js 的 library 快照带只读标记（离线页没有 Host 半）', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const payload = readDataPayload(path.join(outcome.out, 'data.js'));
  assert.equal(payload.library.offline, true, '离线快照必须带 offline: true——阅读端据此进入只读模式');
  assert.equal(payload.library.workspace, '（离线导出副本）', '工作区路径仍然被抹掉，只读标记不能把它带回来');
  assert.ok(Array.isArray(payload.library.subjects) && payload.library.subjects.length >= 1);
  // 写请求在离线宿主里一律回 403：这是「只读」的兜底，不只是界面上藏按钮
  const host = fs.readFileSync(path.join(outcome.out, 'host.js'), 'utf8');
  assert.match(host, /403/, '离线宿主必须对写请求回 403（作答 / 参考资料 / 标注都写不进来）');
});

test('真导出：盘上的标注逐字进 data.js（node.annotations 的 present / version / items）', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const payload = readDataPayload(path.join(outcome.out, 'data.js'));
  const node = payload.library.subjects[0].nodes[0];
  assert.equal(node.id, 'var');

  if (node.annotations !== undefined) {
    /* Host 数据层（lib/library.ts）已经把 annotations 读进 payload：这里就是端到端的严格断言。 */
    assert.equal(node.annotations.present, true);
    assert.match(node.annotations.version, /^[0-9a-f]{16}$/, 'version 是读写两侧按内容算的 16 位 hex');
    const item = node.annotations.items[0];
    assert.equal(node.annotations.items.length, 1);
    assert.equal(item.id, ANNOTATION.id);
    assert.equal(item.note, ANNOTATION.note);
    assert.deepEqual(item.ranges, ANNOTATION.ranges, '锚点（line/kind/hash/start/end）逐字带出');
    assert.equal(item.created, ANNOTATION.created);
    assert.equal(item.modified, ANNOTATION.modified);
    return;
  }

  /* 过渡分支（Host 读入那笔合入前）：本分支只做阅读端，`lib/library.ts` 还不认识 annotations，
    真导出的 payload 里没有这一格。这一支在**真导出拿到的真快照**上塞一条标注，再走**生产用的**
    唯一序列化函数 `dataScript`——验证的正是「标注数据原样进 data.js」。Host 读入合入后自动走
     上面那一支，这条断言不用改。 */
  assert.equal(typeof dataScript, 'function');
  const snapshot = JSON.parse(JSON.stringify(payload.library));
  assert.equal(snapshot.offline, true, '真导出的快照本身已经带只读标记');
  snapshot.subjects[0].nodes[0].annotations = { present: true, version: '0123456789abcdef', items: [ANNOTATION] };
  const embedded = JSON.parse(/window\.__STUDYMATE_EXPORT__ = ([\s\S]*);\n?$/.exec(dataScript({
    library: snapshot, reference: payload.reference, meta: payload.meta,
  }))[1]);
  const roundTripped = embedded.library.subjects[0].nodes[0].annotations;
  assert.equal(roundTripped.present, true);
  assert.equal(roundTripped.version, '0123456789abcdef');
  assert.deepEqual(roundTripped.items, [ANNOTATION], '标注的 items / note / ranges 必须逐字进 data.js');
  assert.equal(embedded.library.offline, true, '注入标注之后只读标记不能丢');
});

test('只读标记由 dataScript 一处打上：不依赖 Host 侧先塞好', async (t) => {
  const plain = { workspace: '（离线导出副本）', subjects: [] };
  const embedded = JSON.parse(/window\.__STUDYMATE_EXPORT__ = ([\s\S]*);\n?$/.exec(dataScript({
    library: plain, reference: {}, meta: { generatedAt: 'x', subjects: [], react: '0.0.0', client: 'abc' },
  }))[1]);
  assert.equal(embedded.library.offline, true, 'data.js 的生成函数负责打只读标记');
  assert.equal(plain.offline, undefined, '别改调用方那份快照');
});

test('阅读端本体逐字节相同 + 泄漏守卫干净（只读模式不需要第二份渲染器）', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const copied = fs.readFileSync(path.join(outcome.out, 'studymate-client.js'));
  assert.equal(sha256(copied), sha256(fs.readFileSync(clientSourceFile())),
    '产物里的阅读端必须是仓库里那份 lib/client.js 的逐字节拷贝');
  const { files: onDisk, manifest } = readExportDir(outcome.out);
  const report = checkExport(onDisk, manifest, { machinePaths: [workspace, outcome.out] });
  assert.deepEqual(report.violations, [], '带只读标记的产物照样要对泄漏守卫干净');
  assert.deepEqual(report.manifestProblems, []);
});

test('只读模式下的标注界面：列表/高亮照旧，编辑 / 删除 / 重指 / 引用提问入口不出现', () => {
  const lesson = client.parseLesson(['## 一节', '', '正文一段。', ''].join('\n'));
  const para = lesson.blocks.find((block) => block.type === 'para');
  const range = client.annotationRangeOf(para);
  const items = [{
    id: 'a', note: '只读标注',
    ranges: [Object.assign({}, range, { start: 0, end: 2 })],
    created: 'c', modified: 'm',
  }];
  const noop = () => {};
  const tree = client.AnnotationPanel({
    annotations: { items, version: 'v1', present: true },
    lesson, readOnly: true, open: true, selected: new Set(), error: '',
    onToggleOpen: noop, onToggleSelect: noop, onJump: noop, onReassign: noop, onEdit: noop, onAsk: noop,
  });
  assert.ok(tree, '只读模式下列表照样渲染（不是整块消失）');
  const text = viewText(tree);
  assert.ok(text.includes('本页标注 1 条'), text.slice(0, 80));
  assert.ok(text.includes('只读标注'), '注释照常显示');
  assert.equal(findByProp(tree, 'data-proto', 'annotation-edit').length, 0, '只读时不该有编辑入口');
  assert.equal(findByProp(tree, 'data-proto', 'annotation-pick').length, 0, '只读时不该有多选 checkbox');
  assert.equal(findByProp(tree, 'data-proto', 'annotations-ask').length, 0, '只读时不该有「带着标注提问」');
  // 失效标注也不给「重新指定」：离线页改不了锚点
  const stale = client.AnnotationPanel({
    annotations: { items: [{ id: 'b', note: '旧', ranges: [{ line: 3, kind: 'para', hash: 'deadbeef', start: 0, end: 1 }] }] },
    lesson, readOnly: true, open: true, selected: new Set(), error: '',
    onToggleOpen: noop, onToggleSelect: noop, onJump: noop, onReassign: noop, onEdit: noop, onAsk: noop,
  });
  assert.equal(findByProp(stale, 'data-proto', 'annotation-reassign').length, 0);
  assert.ok(viewText(stale).includes('这条标注的原文已变'), '失效状态仍如实标出');
});

test('只读模式的弹层：注释可读，编辑/删除按钮不出现', () => {
  const item = { id: 'a', note: '只读标注' };
  const tree = client.AnnotationPopover({
    item, top: 10, left: 10, readOnly: true, onEdit: () => {}, onDelete: () => {}, onClose: () => {},
  });
  const text = viewText(tree);
  assert.ok(text.includes('只读标注'));
  assert.ok(text.includes('只读快照'), '说明为什么不能改');
  assert.equal(findByProp(tree, 'data-proto', 'annotation-edit').length, 0);
  assert.equal(findByProp(tree, 'data-proto', 'annotation-delete').length, 0);
});
