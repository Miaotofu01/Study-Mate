/* 无界笔记持久化 · `lib/notes/store.ts` 的 Node 回归（#268）
   ────────────────────────────────────────────────────────────────────────
   这一套钉的是**存储层**的外部行为：文件格式、版本栅栏、幂等、跨进程锁、原子发布、
   格式守卫、路径安全。HTTP 那一层在 `test_notes_route.mjs`，不重复。

   工作区在 `fs.mkdtempSync` 造的临时 HOME 里现造现弃（ADR-0009：仓库里不存样例数据），
   绝不碰真实 DSH 目录。

   跨进程互斥的判据是**两个真实 Node 子进程**（不是进程内 mutex）：
     · 子进程 A 拿住 `BEGIN IMMEDIATE` 写锁不放；
     · 子进程 B 在 A 持锁期间尝试写同一资源，必须**失败**（notes-unavailable / version-conflict）；
     · A 退出后 B 再写，必须**成功**——证明锁随进程退出自动释放，不是死 PID 强拆的假锁。

   子进程用 `stdio: 'inherit'`/文件捕获输出（不用 pipe，pipe 在受限模式下会 EPERM）；
   外部短看门狗是失败保护，不 `process.exit` 当修复。
   ──────────────────────────────────────────────────────────────────────── */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readNotesStore,
  writeNotesResource,
  writeNotesLayout,
  upgradeNotesStore,
  notesRoot,
  parseNoteFile,
} from '../../lib/notes/store.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不阻断测试结果。
    }
  }
});

function makeHome() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-notes-store-'));
  TEMPS.push(root);
  return root;
}

// 轮询等 outfile 里出现一条满足 pred 的 JSON 行（子进程 stdout 直接写文件，不走 pipe）。
async function waitForLine(outFile, pred, timeoutMs) {
  const start = Date.now();
  for (;;) {
    if (fs.existsSync(outFile)) {
      const text = fs.readFileSync(outFile, 'utf8');
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let obj = null;
        try { obj = JSON.parse(t); } catch { /* 未写完整，继续等 */ }
        if (obj && pred(obj)) return obj;
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待子进程输出超时（${timeoutMs}ms）：${outFile}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function noteResource(id, overrides = {}) {
  return {
    id,
    type: 'note',
    title: '示例笔记',
    parent: 'notes',
    owner: '我',
    markdown: '# 你好\n\n正文，含 --- 分隔符与 Unicode：中文 ✓ émoji 🎯\n',
    ...overrides,
  };
}

/* ── 首次创建空域 ─────────────────────────────────────────────────────────── */

test('首次读取/写入只创建空数据域，不 seed 演示内容', () => {
  const home = makeHome();
  const read = readNotesStore({ home });
  assert.equal(read.ok, true);
  assert.deepEqual(read.value.resources, {});
  assert.equal(read.value.layout, null);
  assert.equal(read.value.layoutVersion, null);
  // 此时数据域可能还没落盘（readNotesStore 对不存在的根视作空域）；写一次之后再核对目录内容。
  const wrote = writeNotesResource({ home, resource: noteResource('first'), expectedVersion: null });
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  const root = notesRoot(home);
  assert.equal(fs.existsSync(path.join(root, '_format.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'resources')), true);
  const entries = fs.readdirSync(path.join(root, 'resources'));
  assert.deepEqual(entries, ['r-first.md'], '只应有刚写入的那份资源（文件名 r-<id>.md），没有 seed 演示文件');
  const format = JSON.parse(fs.readFileSync(path.join(root, '_format.json'), 'utf8'));
  assert.deepEqual(format, { format: 'studymate-notes', version: 2 });
  assert.equal(read.value.schemaVersion, 2);
  assert.equal(read.value.requiresUpgrade, false);
});

/* ── Markdown 往返：`---`/Unicode 不被误切，只解析开头 3 行 ───────────────── */

test('Markdown 往返：正文里的 --- 不会被误切，Unicode 完整保留', () => {
  const home = makeHome();
  const markdown = '# 标题\n\n---\n\n正文中间的分隔线\n\n中文 ✓ émoji 🎯\n\n---\n\n结尾再来一条\n';
  const wrote = writeNotesResource({ home, resource: noteResource('round', { markdown }), expectedVersion: null });
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  assert.equal(wrote.value.resource.markdown, markdown);

  const file = path.join(notesRoot(home), 'resources', 'r-round.md');
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseNoteFile(text);
  assert.equal(parsed.markdown, markdown);
  assert.equal(parsed.meta.type, 'note');
  assert.equal(parsed.meta.title, '示例笔记');

  const read = readNotesStore({ home });
  assert.equal(read.ok, true);
  assert.equal(read.value.resources['round'].markdown, markdown);
});

/* ── 版本栅栏：旧 baseVersion 不等 409 携当前值，不静默覆盖 ────────────────── */

test('版本栅栏：旧 expectedVersion 被 409 拒绝并带回当前内容与版本', () => {
  const home = makeHome();
  const first = writeNotesResource({ home, resource: noteResource('conflict', { markdown: 'v1' }), expectedVersion: null });
  assert.equal(first.ok, true);
  const v1 = first.value.version;

  // 另一个写入者把内容改成 v2。
  const second = writeNotesResource({ home, resource: noteResource('conflict', { markdown: 'v2' }), expectedVersion: v1 });
  assert.equal(second.ok, true);

  // 旧版本的写入者不知道 v2，仍带 v1：必须 409，不覆盖。
  const stale = writeNotesResource({ home, resource: noteResource('conflict', { markdown: 'v3' }), expectedVersion: v1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'version-conflict');
  assert.equal(stale.extra.version, second.value.version);
  assert.equal(stale.extra.resource.markdown, 'v2');

  // 盘上仍是 v2，没被 v3 覆盖。
  const read = readNotesStore({ home });
  assert.equal(read.value.resources['conflict'].markdown, 'v2');
});

/* ── 同值重放幂等 ─────────────────────────────────────────────────────────── */

test('相同目标 bytes 幂等：重放同一份内容不产生第二次变更', () => {
  const home = makeHome();
  const resource = noteResource('idem', { markdown: '内容不变' });
  const first = writeNotesResource({ home, resource, expectedVersion: null });
  assert.equal(first.ok, true);
  const file = path.join(notesRoot(home), 'resources', 'r-idem.md');
  const before = fs.statSync(file).mtimeMs;

  // 稍等一下，确保如果真的重写，mtime 会变。
  const replay = writeNotesResource({ home, resource, expectedVersion: first.value.version });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.value.version, first.value.version);
  const after = fs.statSync(file).mtimeMs;
  assert.equal(after, before, '幂等重放不应重写文件（mtime 不变）');
});

/* ── 布局保存不改 Markdown 文件的 hash/mtime ──────────────────────────────── */

test('布局保存只改 layout.json，不动正文文件', () => {
  const home = makeHome();
  const wrote = writeNotesResource({ home, resource: noteResource('keep'), expectedVersion: null });
  assert.equal(wrote.ok, true);
  const mdFile = path.join(notesRoot(home), 'resources', 'r-keep.md');
  const beforeBuffer = fs.readFileSync(mdFile);
  const beforeMtime = fs.statSync(mdFile).mtimeMs;

  const layout = {
    folders: [{ id: 'notes', parent: null, name: '概念', kind: 'folder' }],
    nodes: [{ id: 'node-1', type: 'knowledge', position: { x: 1, y: 2 }, style: { width: 300, height: 200 }, data: { contentId: 'keep' } }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const wroteLayout = writeNotesLayout({ home, layout, expectedVersion: null });
  assert.equal(wroteLayout.ok, true, JSON.stringify(wroteLayout));

  const afterBuffer = fs.readFileSync(mdFile);
  assert.deepEqual(afterBuffer, beforeBuffer, '正文文件的 bytes 必须一字不变');
  assert.equal(fs.statSync(mdFile).mtimeMs, beforeMtime, '正文文件的 mtime 必须不变');
});

/* ── 布局校验：剥掉 selection/measurement/未知字段，非法几何拒绝 ───────────── */

test('布局校验：剥掉 selection/measurement/任意 CSS 字段，非法几何拒绝', () => {
  const home = makeHome();
  const withJunk = {
    folders: [{ id: 'notes', parent: null, name: '概念', kind: 'folder', selected: true }],
    nodes: [{
      id: 'node-1', type: 'knowledge', position: { x: 1, y: 2 },
      style: { width: 300, height: 200, background: 'red', transform: 'rotate(3deg)' },
      data: { contentId: 'x', selected: true, dragging: true, measured: { width: 1, height: 2 } },
    }],
    edges: [{ id: 'edge-1', source: 'node-1', target: 'node-1', type: 'relation', data: { label: '自连' } }],
    selection: [{ id: 'node-1' }],
    measurements: { node: 1 },
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  // 自连边先拒。
  const badEdge = writeNotesLayout({ home, layout: withJunk, expectedVersion: null });
  assert.equal(badEdge.ok, false);
  assert.equal(badEdge.status, 400);
  assert.equal(badEdge.code, 'body-invalid');

  // 修掉自连边、去掉 selection/measurements 字段后应通过，且被剥干净。
  const clean = {
    folders: [{ id: 'notes', parent: null, name: '概念', kind: 'folder', selected: true }],
    nodes: [{
      id: 'node-1', type: 'knowledge', position: { x: 1, y: 2 },
      style: { width: 300, height: 200, background: 'red', transform: 'rotate(3deg)' },
      data: { contentId: 'x', selected: true, dragging: true, measured: { width: 1, height: 2 } },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const wrote = writeNotesLayout({ home, layout: clean, expectedVersion: null });
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  const saved = wrote.value.layout;
  assert.deepEqual(Object.keys(saved).sort(), ['edges', 'folders', 'nodes', 'viewport']);
  assert.deepEqual(Object.keys(saved.nodes[0].style).sort(), ['height', 'width'], 'CSS 字段要被剥掉');
  assert.deepEqual(Object.keys(saved.nodes[0].data).sort(), ['contentId'], 'data 里只留 contentId');
  assert.equal('selection' in saved, false);
  assert.equal('measurements' in saved, false);
});

/* ── 资源校验：引用 body/handle 拒绝，ID/类型/URL 校验 ─────────────────────── */

test('资源校验：refBody/canReopen/句柄拒绝，非法 ID/URL/类型拒绝', () => {
  const home = makeHome();
  for (const bad of [
    { ...noteResource('bad'), refBody: '不许带正文' },
    { ...noteResource('bad'), canReopen: true },
    { ...noteResource('bad'), fileHandle: { kind: 'file' } },
    { ...noteResource('bad'), sourceFile: { name: 'x' } },
  ]) {
    const result = writeNotesResource({ home, resource: bad, expectedVersion: null });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.status, 400);
    assert.equal(result.code, 'body-invalid');
  }
  // 非法 ID（大写/超长/空）。
  for (const id of ['R-Bad', '', 'x'.repeat(97), 'bad_id']) {
    const result = writeNotesResource({ home, resource: noteResource(id), expectedVersion: null });
    assert.equal(result.ok, false, `id=${id} 不该通过`);
    assert.equal(result.status, 400);
  }
  // 非法 URL。
  const badUrl = writeNotesResource({
    home,
    resource: { id: 'link1', type: 'link', title: 'x', url: 'javascript:alert(1)' },
    expectedVersion: null,
  });
  assert.equal(badUrl.ok, false);
  assert.equal(badUrl.status, 400);
  // 非法 type。
  const badType = writeNotesResource({ home, resource: { id: 'x', type: 'unknown-type' }, expectedVersion: null });
  assert.equal(badType.ok, false);
  assert.equal(badType.status, 400);
});

/* ── 跨物理类型变更拒绝（旧 md → json）────────────────────────────────────── */

test('资源不允许跨物理类型变更（note 的 .md 不能改存成 .json）', () => {
  const home = makeHome();
  const wrote = writeNotesResource({ home, resource: noteResource('switch'), expectedVersion: null });
  assert.equal(wrote.ok, true);
  const change = writeNotesResource({
    home,
    resource: { id: 'switch', type: 'link', title: 'x', url: 'https://example.com' },
    expectedVersion: wrote.value.version,
  });
  assert.equal(change.ok, false);
  assert.equal(change.status, 400);
  assert.equal(change.code, 'body-invalid');
  assert.match(change.message, /跨类型/);
  // 原文件未受影响。
  const read = readNotesStore({ home });
  assert.equal(read.value.resources['switch'].type, 'note');
});

/* ── 未知/损坏 _format.json 拒写 ─────────────────────────────────────────── */

test('未知/损坏的 _format.json 拒绝写入，不静默初始化覆盖', () => {
  const home = makeHome();
  const root = notesRoot(home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '_format.json'), '{"format":"something-else","version":99}');

  const result = writeNotesResource({ home, resource: noteResource('guard'), expectedVersion: null });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, 'file-shape-unknown');

  // 损坏的 JSON 也拒。
  fs.writeFileSync(path.join(root, '_format.json'), '{oops');
  const broken = writeNotesResource({ home, resource: noteResource('guard2'), expectedVersion: null });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'file-shape-unknown');
});

/* ── symlink 越域拒绝 ─────────────────────────────────────────────────────── */

test('symlink 越域的读写被拒绝', () => {
  const home = makeHome();
  const root = notesRoot(home);
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
  // 造一个指向域外的 symlink 冒充资源文件。
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-notes-outside-'));
  TEMPS.push(outside);
  const outsideFile = path.join(outside, 'secret.md');
  fs.writeFileSync(outsideFile, '越域内容');
  const link = path.join(root, 'resources', 'r-sneaky.md');
  fs.symlinkSync(outsideFile, link);

  const read = readNotesStore({ home });
  // 读到 symlink 资源必须拒绝，不能返回越域内容。路径安全（symlink → path-invalid）
  // 或数据域损坏（非普通文件 → file-shape-unknown）都算「拒绝读取」，不能放行内容。
  assert.equal(read.ok, false, 'symlink 资源不该被读出内容');
  assert.ok(
    read.code === 'path-invalid' || read.code === 'file-shape-unknown',
    `symlink 资源应被拒绝，实际 code=${read.code}`,
  );
});

/* ── fault 注入：rename 真失败时旧文件不被损坏 ────────────────────────────── */

test('fault 注入：rename 真失败时旧文件保留、临时文件被清理', () => {
  const home = makeHome();
  const wrote = writeNotesResource({ home, resource: noteResource('fault', { markdown: '原始内容' }), expectedVersion: null });
  assert.equal(wrote.ok, true);
  const file = path.join(notesRoot(home), 'resources', 'r-fault.md');
  const before = fs.readFileSync(file);

  // fault 注入：**只在 rename 这一步**失败（生产代码里没有任何测试钩子，
  // 这里只在本测试进程内临时替换 fs.renameSync）。
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('注入的 rename 故障'), { code: 'EIO' }); };
  try {
    const failed = writeNotesResource({ home, resource: noteResource('fault', { markdown: '改坏了' }), expectedVersion: wrote.value.version });
    assert.equal(failed.ok, false, 'rename 失败应该报错而不是成功');
    assert.equal(failed.code, 'write-failed', `实际 code=${failed.code}`);
  } finally {
    fs.renameSync = originalRename;
  }
  // 旧文件一字不变。
  assert.deepEqual(fs.readFileSync(file), before, 'rename 失败后旧文件必须原样保留');
  // 没有残留的临时文件。
  const leftovers = fs.readdirSync(path.join(notesRoot(home), 'resources')).filter((n) => n.startsWith('.tmp-'));
  assert.deepEqual(leftovers, [], '失败的写入不应留下临时文件');

  // 故障恢复后应能再写。
  const recovered = writeNotesResource({ home, resource: noteResource('fault', { markdown: '改坏了' }), expectedVersion: wrote.value.version });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
});

/* ── 首次写入：数据域目录从无到有 ─────────────────────────────────────────── */

test('首次写入会建出数据域目录（此前 400 path-invalid 的回归钉子）', () => {
  const home = makeHome();
  const root = notesRoot(home);
  assert.equal(fs.existsSync(root), false, '前提：数据域目录还不存在');
  const wrote = writeNotesResource({ home, resource: noteResource('boot'), expectedVersion: null });
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  assert.equal(fs.existsSync(root), true);
  assert.equal(fs.existsSync(path.join(root, '_format.json')), true);
});

/* ── 非空但无 marker 的外来目录：拒绝认领，且不能先落 lock.db ──────────────── */

test('非空且无 _format.json 的外来目录被拒绝认领，且不留下锁库', () => {
  const home = makeHome();
  const root = notesRoot(home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '别人的文件.txt'), '不是笔记数据域');

  const result = writeNotesResource({ home, resource: noteResource('claim'), expectedVersion: null });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, 'file-shape-unknown');
  // 关键：不能因为要开锁就把这个陌生目录标记成数据域。
  assert.equal(fs.existsSync(path.join(root, 'notes.lock.db')), false, '被拒绝时不应创建锁库');
  assert.equal(fs.existsSync(path.join(root, '_format.json')), false, '被拒绝时不应写格式标记');
  assert.equal(fs.existsSync(path.join(root, 'resources')), false, '被拒绝时不应建 resources/');
});

test('只认确切的锁产物名：同前缀的外来文件不算锁产物', () => {
  const home = makeHome();
  const root = notesRoot(home);
  fs.mkdirSync(root, { recursive: true });
  // notes.lock.db-mybackup 不是锁产物 → 根非空 → 必须拒绝认领。
  fs.writeFileSync(path.join(root, 'notes.lock.db-mybackup'), 'backup');

  const result = writeNotesResource({ home, resource: noteResource('prefix'), expectedVersion: null });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, 'file-shape-unknown');
  assert.equal(fs.existsSync(path.join(root, 'notes.lock.db-mybackup')), true, '外来文件不许被删');
});

/* ── 同 id 双物理文件：读与写都 fail closed ────────────────────────────────── */

test('同 id 同时有 .md 与 .json：读 503、写也 503（不当成 500）', () => {
  const home = makeHome();
  const wrote = writeNotesResource({ home, resource: noteResource('twin'), expectedVersion: null });
  assert.equal(wrote.ok, true);
  const dir = path.join(notesRoot(home), 'resources');
  fs.writeFileSync(path.join(dir, 'r-twin.json'), JSON.stringify({ id: 'twin', type: 'link', url: 'https://example.com' }));

  const read = readNotesStore({ home });
  assert.equal(read.ok, false);
  assert.equal(read.status, 503);
  assert.equal(read.code, 'file-shape-unknown');

  const write = writeNotesResource({ home, resource: noteResource('twin', { markdown: 'x' }), expectedVersion: wrote.value.version });
  assert.equal(write.ok, false);
  assert.equal(write.status, 503, `双文件是数据损坏，不该报 500（实际 ${write.status}/${write.code}）`);
  assert.equal(write.code, 'file-shape-unknown');
});

/* ── expectedVersion 必须显式给出 ──────────────────────────────────────────── */

test('expectedVersion 缺失/非法一律 400 expected-version-required', () => {
  const home = makeHome();
  for (const value of [undefined, '', 'abc', 'A'.repeat(64), 'z'.repeat(64)]) {
    const result = writeNotesResource({ home, resource: noteResource('ver'), expectedVersion: value });
    assert.equal(result.ok, false, `expectedVersion=${String(value)} 不该通过`);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'expected-version-required');
  }
});

/* ── 大图片 dataURL：合法 4 MiB PNG 存的 JSON 不能被读成坏库 ───────────────── */

test('接近 6 MiB 的媒体 JSON 资源可写可读（不因读取上限误判坏库）', () => {
  const home = makeHome();
  // 造一张接近 4 MiB 的合法 PNG dataURL（base64 头合法、字节数在媒体上限内）。
  const pngBytes = Buffer.alloc(4 * 1024 * 1024 - 16, 0x41);
  const src = `data:image/png;base64,${pngBytes.toString('base64')}`;
  const resource = { id: 'bigimg', type: 'image', title: '大图', src };
  const wrote = writeNotesResource({ home, resource, expectedVersion: null });
  assert.equal(wrote.ok, true, JSON.stringify({ code: wrote.code, message: wrote.message }));
  const read = readNotesStore({ home });
  assert.equal(read.ok, true, `读取不应失败：${read.code ?? ''} ${read.message ?? ''}`);
  assert.equal(read.value.resources['bigimg'].src.length, src.length);
});

/* ── 4 MiB 边界：恰好 4 MiB 的合法 PNG 必须放行，多 1 字节必须拒 ────────────── */

test('图片大小边界：恰好 4 MiB 放行，超过 1 字节拒绝', () => {
  const home = makeHome();
  const exactly = Buffer.alloc(4 * 1024 * 1024, 0x41);
  const over = Buffer.alloc(4 * 1024 * 1024 + 1, 0x41);
  // 反证前提：这两个 base64 长度都是 4 的倍数、padding 合法（4096 KiB 是 3 的倍数 +1）。
  assert.equal(exactly.toString('base64').length % 4, 0);
  assert.equal(over.toString('base64').length % 4, 0);

  const okExactly = writeNotesResource({
    home,
    resource: { id: 'edge-ok', type: 'image', title: '恰好 4 MiB', src: `data:image/png;base64,${exactly.toString('base64')}` },
    expectedVersion: null,
  });
  assert.equal(okExactly.ok, true, `恰好 4 MiB 的合法 PNG 不该被拒：${okExactly.message ?? ''}`);

  const tooBig = writeNotesResource({
    home,
    resource: { id: 'edge-over', type: 'image', title: '超 1 字节', src: `data:image/png;base64,${over.toString('base64')}` },
    expectedVersion: null,
  });
  assert.equal(tooBig.ok, false, '超过 4 MiB 1 字节必须拒绝');
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.code, 'body-invalid');
});

/* ── 媒体类外部文件引用：只存元信息（与 type 无关）─────────────────────────── */

test('媒体类外部文件引用只存元信息：往返后没有 payload', () => {
  const home = makeHome();
  const origin = { kind: 'file', mode: 'reference', name: 'photo.png', lastModified: 1700000000000 };
  for (const [id, type, extra] of [
    ['ref-img', 'image', { mime: 'image/png', bytes: 1024 }],
    ['ref-svg', 'svg', { mime: 'image/svg+xml' }],
    ['ref-html', 'html', { mime: 'text/html' }],
  ]) {
    const wrote = writeNotesResource({ home, resource: { id, type, title: '外部文件', origin, ...extra }, expectedVersion: null });
    assert.equal(wrote.ok, true, JSON.stringify(wrote));
    // 物理文件是 .json（引用不占 .md）。
    const file = path.join(notesRoot(home), 'resources', `r-${id}.json`);
    assert.equal(fs.existsSync(file), true, `${type} 引用应落 .json`);
    assert.equal(fs.existsSync(path.join(notesRoot(home), 'resources', `r-${id}.md`)), false);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal('src' in stored, false, '引用不该带 src');
    assert.equal('html' in stored, false, '引用不该带 html');
    assert.equal(stored.origin.kind, 'file');
    assert.equal(stored.origin.mode, 'reference');
  }
  const read = readNotesStore({ home });
  assert.equal(read.ok, true);
  assert.equal(read.value.resources['ref-img'].type, 'image');
  assert.equal('src' in read.value.resources['ref-img'], false, '读回也不该凭空长出 payload');
});

test('媒体类外部文件引用带 payload/句柄一律 400', () => {
  const home = makeHome();
  const origin = { kind: 'file', mode: 'reference', name: 'photo.png' };
  const cases = [
    { id: 'bad-img', type: 'image', title: 'x', origin, src: 'data:image/png;base64,AAAA' },
    { id: 'bad-svg', type: 'svg', title: 'x', origin, html: '<svg/>' },
    { id: 'bad-html', type: 'html', title: 'x', origin, html: '<p>x</p>' },
    { id: 'bad-note', type: 'note', title: 'x', origin, markdown: '正文' },
    { id: 'bad-handle', type: 'image', title: 'x', origin, fileHandle: { kind: 'file' } },
    { id: 'bad-refbody', type: 'image', title: 'x', origin, refBody: '原文件正文' },
    { id: 'bad-canreopen', type: 'image', title: 'x', origin: { ...origin, canReopen: false } },
  ];
  for (const resource of cases) {
    const result = writeNotesResource({ home, resource, expectedVersion: null });
    assert.equal(result.ok, false, `${resource.id} 不该通过：${JSON.stringify(resource)}`);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'body-invalid');
  }
});

/* ── 布局：text 节点可无 contentId；超限不静默截断 ─────────────────────────── */

test('纯文本节点可以没有 contentId（null 被剥掉）；内容卡必须挂内容 id', () => {
  const home = makeHome();
  const layout = {
    folders: [],
    nodes: [
      { id: 'text-1', type: 'text', position: { x: 0, y: 0 }, data: { text: '随手写的一句', contentId: null } },
      { id: 'know-1', type: 'knowledge', position: { x: 10, y: 10 }, data: { contentId: 'note-1' } },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const wrote = writeNotesLayout({ home, layout, expectedVersion: null });
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  const textNode = wrote.value.layout.nodes.find((n) => n.id === 'text-1');
  assert.equal('contentId' in textNode.data, false, 'text 节点的 null contentId 应被剥掉');

  // 内容卡缺 contentId → 拒绝。
  const bad = writeNotesLayout({
    home,
    layout: { ...layout, nodes: [{ id: 'know-2', type: 'knowledge', position: { x: 0, y: 0 }, data: {} }] },
    expectedVersion: null,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(bad.code, 'body-invalid');
});

test('节点文字/连线标签超限：整条拒绝，不静默截断（不谎报保存成功）', () => {
  const home = makeHome();
  const longText = '字'.repeat(20001);
  const tooLongText = writeNotesLayout({
    home,
    layout: { folders: [], nodes: [{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { text: longText } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    expectedVersion: null,
  });
  assert.equal(tooLongText.ok, false, '超限的节点文字不该被截断后保存成功');
  assert.equal(tooLongText.status, 400);

  const longLabel = '签'.repeat(501);
  const tooLongLabel = writeNotesLayout({
    home,
    layout: {
      folders: [],
      nodes: [
        { id: 'n1', type: 'knowledge', position: { x: 0, y: 0 }, data: { contentId: 'a' } },
        { id: 'n2', type: 'knowledge', position: { x: 1, y: 1 }, data: { contentId: 'b' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'relation', data: { label: longLabel } }],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    expectedVersion: null,
  });
  assert.equal(tooLongLabel.ok, false, '超限的连线标签不该被截断后保存成功');
  assert.equal(tooLongLabel.status, 400);

  // 超限的那次没有落盘。
  assert.equal(fs.existsSync(path.join(notesRoot(home), 'layout.json')), false);
});

test('节点类型是封闭集合：不认识的类型拒绝', () => {
  const home = makeHome();
  const result = writeNotesLayout({
    home,
    layout: { folders: [], nodes: [{ id: 'n1', type: 'mystery', position: { x: 0, y: 0 }, data: {} }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    expectedVersion: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

/* ── 数据根必须是绝对路径 ─────────────────────────────────────────────────── */

test('数据根不是绝对路径时拒绝，绝不在 cwd 下建目录', () => {
  for (const home of ['relative/studymate', '', '   ']) {
    const read = readNotesStore({ home });
    assert.equal(read.ok, false, `home=${JSON.stringify(home)} 不该通过`);
    assert.equal(read.status, 400);
    assert.equal(read.code, 'path-invalid');
    const write = writeNotesResource({ home, resource: noteResource('rel'), expectedVersion: null });
    assert.equal(write.ok, false);
    assert.equal(write.status, 400);
    const layoutWrite = writeNotesLayout({ home, layout: { folders: [], nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, expectedVersion: null });
    assert.equal(layoutWrite.ok, false);
    assert.equal(layoutWrite.status, 400);
  }
  // 前提：相对路径不该在仓库里留下 studymate-notes 目录。
  assert.equal(fs.existsSync(path.join(ROOT, 'studymate-notes')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'relative')), false);
});

/* ── 跨进程锁互斥：两个真实 Node 子进程并行抢同一把锁 ────────────────────── */

test('两个真实 Node 子进程抢同一把写锁，BEGIN IMMEDIATE 只有一个能立刻进入（跨进程锁互斥）', async () => {
  const home = makeHome();
  const root = notesRoot(home);
  const lockDbPath = path.join(root, 'notes.lock.db');
  // holder 子进程直接 open SQLite，必须先建好数据域目录（DatabaseSync 不会自动建目录）。
  fs.mkdirSync(root, { recursive: true });

  // 子进程 A：先 BEGIN IMMEDIATE 拿写锁，打时间戳后 hold 住不放，模拟「正在写的进程」。
  const holderScript = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(lockDbPath)}, { timeout: 5000 });
    db.exec('CREATE TABLE IF NOT EXISTS lock_anchor (id INTEGER PRIMARY KEY, held INTEGER NOT NULL DEFAULT 0)');
    db.exec('INSERT OR IGNORE INTO lock_anchor (id, held) VALUES (1, 0)');
    db.exec('BEGIN IMMEDIATE');
    db.exec('UPDATE lock_anchor SET held = held + 1 WHERE id = 1');
    process.stdout.write(JSON.stringify({ phase: 'locked', at: Date.now() }) + '\\n');
    // 保持写锁一段时间，等待 B 争抢。
    await new Promise((r) => setTimeout(r, ${'__HOLD_MS__'}));
    db.exec('COMMIT');
    db.close();
    process.stdout.write(JSON.stringify({ phase: 'released', at: Date.now() }) + '\\n');
  `;
  const holderFile = path.join(home, 'holder.mjs');
  fs.writeFileSync(holderFile, holderScript.replace('__HOLD_MS__', '4000'));

  const holderOut = path.join(home, 'holder.out');
  const holderFd = fs.openSync(holderOut, 'w');
  const holder = spawn(process.execPath, [holderFile], { stdio: ['ignore', holderFd, 'inherit'] });

  // 等到 A 真的拿到写锁（读到 locked 行）。
  const locked = await waitForLine(holderOut, (obj) => obj.phase === 'locked', 8000);

  // B：在 A 持锁期间尝试 BEGIN IMMEDIATE，busy_timeout 只给 200ms，必须拿不到写锁。
  const contesterScript = `
    import { DatabaseSync } from 'node:sqlite';
    const started = Date.now();
    try {
      const db = new DatabaseSync(${JSON.stringify(lockDbPath)}, { timeout: 200 });
      db.exec('BEGIN IMMEDIATE');
      db.exec('UPDATE lock_anchor SET held = held + 1 WHERE id = 1');
      db.exec('COMMIT');
      db.close();
      process.stdout.write(JSON.stringify({ ok: true, waitedMs: Date.now() - started }) + '\\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({ ok: false, code: err?.code ?? null, message: String(err?.message ?? err), waitedMs: Date.now() - started }) + '\\n');
    }
    process.exit(0);
  `;
  const contesterFile = path.join(home, 'contester.mjs');
  fs.writeFileSync(contesterFile, contesterScript);
  const bOut = path.join(home, 'contester.out');
  const bFd = fs.openSync(bOut, 'w');
  const contester = spawn(process.execPath, [contesterFile], { stdio: ['ignore', bFd, 'inherit'] });

  await new Promise((resolve) => contester.on('exit', resolve));
  fs.closeSync(bFd);
  const bResult = JSON.parse(fs.readFileSync(bOut, 'utf8').trim());
  // A 还没释放锁时，B 必须拿不到写锁（fail 取锁超时）。
  assert.equal(bResult.ok, false, `A 持锁期间 B 不该拿到写锁：${JSON.stringify(bResult)}`);

  // A 释放后再抢一次，应立即成功。
  await new Promise((resolve) => holder.on('exit', resolve));
  fs.closeSync(holderFd);
  const afterScript = `
    import { DatabaseSync } from 'node:sqlite';
    const started = Date.now();
    const db = new DatabaseSync(${JSON.stringify(lockDbPath)}, { timeout: 5000 });
    db.exec('BEGIN IMMEDIATE');
    db.exec('UPDATE lock_anchor SET held = held + 1 WHERE id = 1');
    db.exec('COMMIT');
    db.close();
    process.stdout.write(JSON.stringify({ ok: true, waitedMs: Date.now() - started }) + '\\n');
  `;
  const afterFile = path.join(home, 'after.mjs');
  fs.writeFileSync(afterFile, afterScript);
  const aOut = path.join(home, 'after.out');
  const aFd = fs.openSync(aOut, 'w');
  const after = spawnSync(process.execPath, [afterFile], { stdio: ['ignore', aFd, 'inherit'], timeout: 10000 });
  fs.closeSync(aFd);
  assert.equal(after.status, 0);
  const afterResult = JSON.parse(fs.readFileSync(aOut, 'utf8').trim());
  assert.equal(afterResult.ok, true, 'A 释放后应能立刻拿到锁');
});

/* ── 进程崩溃后锁自然释放 ─────────────────────────────────────────────────── */

test('持 BEGIN 的进程死后可自然保存（锁随进程退出释放）', () => {
  const home = makeHome();
  const root = notesRoot(home);
  fs.mkdirSync(root, { recursive: true });
  // 先初始化好数据域（_format.json 标记），让崩溃后的写入不必再面对「非空无标记」目录。
  const init = writeNotesResource({ home, resource: noteResource('crash-init', { markdown: '初始化' }), expectedVersion: null });
  assert.equal(init.ok, true, JSON.stringify(init));

  const modulePath = path.join(ROOT, 'lib', 'notes', 'store.ts');
  // 子进程：拿到 BEGIN IMMEDIATE 写锁后**不 COMMIT**，直接硬退出（模拟崩溃）。
  const crashScript = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(path.join(root, 'notes.lock.db'))}, { timeout: 200 });
    db.exec('CREATE TABLE IF NOT EXISTS lock_anchor (id INTEGER PRIMARY KEY, held INTEGER NOT NULL DEFAULT 0)');
    db.exec('INSERT OR IGNORE INTO lock_anchor (id, held) VALUES (1, 0)');
    db.exec('BEGIN IMMEDIATE');
    db.exec('UPDATE lock_anchor SET held = held + 1 WHERE id = 1');
    process.stdout.write('locked\\n');
    process.exit(9); // 崩溃退出，不 COMMIT。
  `;
  const crashFile = path.join(home, 'crash.mjs');
  fs.writeFileSync(crashFile, crashScript);
  const crashOut = path.join(home, 'crash.out');
  const crashFd = fs.openSync(crashOut, 'w');
  const crashed = spawnSync(process.execPath, [crashFile], { stdio: ['ignore', crashFd, 'inherit'], timeout: 15000 });
  fs.closeSync(crashFd);
  assert.equal(crashed.status, 9, '崩溃子进程应以 9 退出');

  // 崩溃后立刻写：锁应已自动释放，写入成功。
  const wrote = writeNotesResource({ home, resource: noteResource('after-crash', { markdown: '崩溃后能写' }), expectedVersion: null });
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
});

/* ── #270：课程关联 / 笔记本绑定 / 节点视图归属 ───────────────────────────── */

const BACKUP_DIR_RE = /^backup-v1-[0-9a-f-]{36}$/;
const FIXED_UUID = '11111111-1111-1111-1111-111111111111';

function noteFileBytes(id, markdown = '旧正文\n') {
  const { markdown: body, ...meta } = noteResource(id, { markdown });
  return Buffer.from(`---\nstudymate_notes: ${JSON.stringify(meta)}\n---\n${body}`, 'utf8');
}

function makeRawV1Store(home, { badLayout = false, resourceId = 'legacy' } = {}) {
  const root = notesRoot(home);
  const resources = path.join(root, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  const markerFile = path.join(root, '_format.json');
  const layoutFile = path.join(root, 'layout.json');
  const resourceFile = path.join(resources, `r-${resourceId}.md`);
  fs.writeFileSync(markerFile, JSON.stringify({ format: 'studymate-notes', version: 1 }) + '\n');
  const layoutBytes = badLayout
    ? Buffer.from('{not json', 'utf8')
    : Buffer.from(JSON.stringify({ folders: [], nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }) + '\n', 'utf8');
  fs.writeFileSync(layoutFile, layoutBytes);
  const bytes = noteFileBytes(resourceId);
  fs.writeFileSync(resourceFile, bytes);
  return { root, markerFile, layoutFile, resourceFile, bytes };
}

function backupDirs(root) {
  return fs.readdirSync(root).filter((name) => BACKUP_DIR_RE.test(name));
}

function withFixedUuid(fn) {
  const original = crypto.randomUUID;
  crypto.randomUUID = () => FIXED_UUID;
  try {
    return fn();
  } finally {
    crypto.randomUUID = original;
  }
}

function scoped(ref = {}) {
  return { workspace: 'ws', subject: 'math', node: 'node-1', ...ref };
}

function subjectRef(ref = {}) {
  return { workspace: 'ws', subject: 'math', ...ref };
}

function curriculumLayout() {
  return {
    folders: [
      {
        id: 'book', parent: null, name: '本', kind: 'notebook',
        bindings: [subjectRef({ title: '数学' }), subjectRef({ subject: 'physics', title: '物理' })],
        defaultForSubjects: [subjectRef()],
        viewport: { x: 12, y: -3, zoom: 1.5 },
      },
      { id: 'plain', parent: 'book', name: '普通目录', kind: 'folder' },
    ],
    nodes: [
      { id: 'node-1', type: 'knowledge', position: { x: 1, y: 2 }, style: {}, data: { contentId: 'legacy', notebookId: 'book' } },
      { id: 'old-node', type: 'text', position: { x: 3, y: 4 }, style: {}, data: { text: '旧布局节点' } },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

test('资源课程引用/关联/软删除：合法字段落盘，闭口与限长拒绝不截断', () => {
  const home = makeHome();
  const course = {
    id: 'course-1', type: 'course', title: '课程卡',
    courseRef: scoped({ title: '课程标题' }), trashed: false,
  };
  const wroteCourse = writeNotesResource({ home, resource: course, expectedVersion: null });
  assert.equal(wroteCourse.ok, true, JSON.stringify(wroteCourse));
  assert.deepEqual(wroteCourse.value.resource.courseRef, course.courseRef);
  assert.equal(wroteCourse.value.resource.trashed, false);

  const note = noteResource('note-1', {
    associations: [scoped(), scoped({ subject: 'physics', node: 'node-2' })],
    trashed: true,
  });
  const wroteNote = writeNotesResource({ home, resource: note, expectedVersion: null });
  assert.equal(wroteNote.ok, true, JSON.stringify(wroteNote));
  assert.equal(wroteNote.value.resource.associations.length, 2);
  assert.equal(wroteNote.value.resource.trashed, true);

  const badResources = [
    noteResource('bad-course-ref', { courseRef: scoped() }),
    { id: 'bad-assoc', type: 'course', title: 'x', associations: [scoped()] },
    noteResource('bad-assoc-dup', { associations: [scoped(), scoped({ node: 'node-2' })] }),
    noteResource('bad-assoc-cap', { associations: Array.from({ length: 33 }, (_, i) => scoped({ subject: `s${i}` })) }),
    noteResource('bad-assoc-extra', { associations: [scoped({ extra: true })] }),
    noteResource('bad-assoc-long', { associations: [scoped({ subject: 'x'.repeat(201) })] }),
    noteResource('bad-assoc-workspace', { associations: [scoped({ workspace: 'x'.repeat(2001) })] }),
    noteResource('bad-assoc-title', { associations: [scoped({ title: 'x'.repeat(2001) })] }),
    noteResource('bad-trashed', { trashed: 'yes' }),
    { id: 'bad-course', type: 'course', title: 'x', courseRef: scoped({ subject: '' }) },
    { id: 'bad-course-node', type: 'course', title: 'x', courseRef: scoped({ node: 'x'.repeat(201) }) },
    {
      id: 'bad-file-note', type: 'note', title: 'x', associations: [scoped()],
      origin: { kind: 'file', mode: 'reference', name: 'outside.md' },
    },
  ];
  for (const bad of badResources) {
    const result = writeNotesResource({ home, resource: bad, expectedVersion: null });
    assert.equal(result.ok, false, `不应通过：${JSON.stringify(bad)}`);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'body-invalid');
  }
});

test('布局多科目绑定/默认/独立视口/notebookId：旧节点保留，非法字段拒绝', () => {
  const home = makeHome();
  const layout = curriculumLayout();
  const wrote = writeNotesLayout({ home, layout, expectedVersion: null });
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  const saved = wrote.value.layout;
  assert.equal(saved.folders[0].bindings.length, 2);
  assert.equal(saved.folders[0].defaultForSubjects.length, 1);
  assert.deepEqual(saved.folders[0].viewport, { x: 12, y: -3, zoom: 1.5 });
  assert.equal(saved.nodes[0].data.notebookId, 'book');
  assert.equal('notebookId' in saved.nodes[1].data, false, '旧节点不能强转或丢弃');

  const badLayouts = [
    (l) => { l.folders[0].binding = subjectRef(); },
    (l) => { l.folders[0].defaultForSubject = subjectRef(); },
    (l) => { l.folders[0].bindings.push(subjectRef()); },
    (l) => { l.folders[0].defaultForSubjects = [subjectRef({ subject: 'physics' })]; l.folders[0].bindings = [subjectRef()]; },
    (l) => {
      l.folders.push({ id: 'book2', parent: null, name: '本2', kind: 'notebook', bindings: [subjectRef()], defaultForSubjects: [subjectRef()] });
    },
    (l) => { l.folders[0].bindings = Array.from({ length: 33 }, (_, i) => subjectRef({ subject: `s${i}` })); },
    (l) => { l.folders[0].viewport.extra = 1; },
    (l) => { l.folders[0].viewport.zoom = Infinity; },
    (l) => { l.folders[0].viewport.x = 1e6 + 1; },
    (l) => { l.nodes[0].data.notebookId = 'plain'; },
    (l) => { l.nodes[0].data.notebookId = 'missing'; },
    (l) => { l.nodes[0].data.notebookId = 'BAD_ID'; },
    (l) => { l.folders[1].bindings = [subjectRef()]; },
  ];
  for (const mutate of badLayouts) {
    const bad = curriculumLayout();
    mutate(bad);
    const result = writeNotesLayout({ home, layout: bad, expectedVersion: wrote.value.version });
    assert.equal(result.ok, false, `不应通过：${JSON.stringify(bad)}`);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'body-invalid');
  }
});

/* ── format2：v1 只读 + 显式升级 + 备份安全 ─────────────────────────────── */

test('v1 GET 标记 requiresUpgrade，普通资源/布局写入被拒且不落锁库', () => {
  const home = makeHome();
  const seeded = makeRawV1Store(home);
  const before = {
    marker: fs.readFileSync(seeded.markerFile),
    layout: fs.readFileSync(seeded.layoutFile),
    resource: fs.readFileSync(seeded.resourceFile),
  };
  const read = readNotesStore({ home });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.value.schemaVersion, 1);
  assert.equal(read.value.requiresUpgrade, true);
  assert.equal(read.value.resources.legacy.markdown, '旧正文\n');

  for (const result of [
    writeNotesResource({ home, resource: noteResource('new'), expectedVersion: null }),
    writeNotesLayout({ home, layout: curriculumLayout(), expectedVersion: null }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.code, 'notes-format-invalid');
  }
  assert.deepEqual(fs.readFileSync(seeded.markerFile), before.marker);
  assert.deepEqual(fs.readFileSync(seeded.layoutFile), before.layout);
  assert.deepEqual(fs.readFileSync(seeded.resourceFile), before.resource);
  assert.equal(fs.existsSync(path.join(seeded.root, 'notes.lock.db')), false, 'v1 拒写不该先建锁库');
});

test('显式升级 v1：备份原始 bytes，仅替换 marker，正文/布局不动且备份不进预算', () => {
  const home = makeHome();
  const seeded = makeRawV1Store(home);
  const before = {
    marker: fs.readFileSync(seeded.markerFile),
    layout: fs.readFileSync(seeded.layoutFile),
    resource: fs.readFileSync(seeded.resourceFile),
  };
  const upgraded = upgradeNotesStore({ home });
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded));
  assert.equal(upgraded.value.schemaVersion, 2);
  assert.equal(upgraded.value.requiresUpgrade, false);
  assert.match(upgraded.value.backupId, BACKUP_DIR_RE);
  assert.equal(upgraded.value.backup, upgraded.value.backupId);
  assert.equal(upgraded.value.backupId.includes(home), false, 'backupId 不泄露绝对路径');
  assert.equal(/[\\/]/.test(upgraded.value.backupId), false);

  const backupDir = path.join(seeded.root, upgraded.value.backupId);
  assert.equal(fs.statSync(backupDir).isDirectory(), true);
  assert.deepEqual(fs.readFileSync(path.join(backupDir, '_format.json')), before.marker);
  assert.deepEqual(fs.readFileSync(path.join(backupDir, 'layout.json')), before.layout);
  assert.deepEqual(fs.readFileSync(path.join(backupDir, 'resources', 'r-legacy.md')), before.resource);
  assert.deepEqual(JSON.parse(fs.readFileSync(seeded.markerFile, 'utf8')), { format: 'studymate-notes', version: 2 });
  assert.deepEqual(fs.readFileSync(seeded.layoutFile), before.layout, '升级不改布局原始 bytes');
  assert.deepEqual(fs.readFileSync(seeded.resourceFile), before.resource, '升级不改正文原始 bytes');

  const afterRead = readNotesStore({ home });
  assert.equal(afterRead.ok, true);
  assert.equal(afterRead.value.schemaVersion, 2);
  assert.equal(afterRead.value.requiresUpgrade, false);
  const wroteAfter = writeNotesResource({ home, resource: noteResource('after'), expectedVersion: null });
  assert.equal(wroteAfter.ok, true, JSON.stringify(wroteAfter));
  const withAfter = readNotesStore({ home });
  assert.deepEqual(Object.keys(withAfter.value.resources).sort(), ['after', 'legacy'], 'root 内备份目录不进载入/预算');

  const dirsBeforeRepeat = backupDirs(seeded.root);
  const repeat = upgradeNotesStore({ home });
  assert.equal(repeat.ok, true, JSON.stringify(repeat));
  assert.equal(repeat.value.backup, 'already-v2');
  assert.equal(repeat.value.backupId, 'already-v2');
  assert.deepEqual(backupDirs(seeded.root), dirsBeforeRepeat, '重复升级不创建新备份');
});

test('坏 v1 layout 拒绝升级，marker 不动、不落锁库/备份', () => {
  const home = makeHome();
  const seeded = makeRawV1Store(home, { badLayout: true });
  const before = fs.readFileSync(seeded.markerFile);
  const result = upgradeNotesStore({ home });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, 'file-shape-unknown');
  assert.deepEqual(fs.readFileSync(seeded.markerFile), before);
  assert.equal(fs.existsSync(path.join(seeded.root, 'notes.lock.db')), false, '坏库不该先建锁库');
  assert.deepEqual(backupDirs(seeded.root), []);
});

test('root 内备份目录在无 marker 时阻止认领（fail closed）', () => {
  const home = makeHome();
  const root = notesRoot(home);
  const dir = path.join(root, 'backup-v1-simulation');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sentinel.txt'), 'keep');
  const result = writeNotesResource({ home, resource: noteResource('claim'), expectedVersion: null });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, 'file-shape-unknown');
  assert.equal(fs.existsSync(path.join(root, '_format.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'notes.lock.db')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'sentinel.txt'), 'utf8'), 'keep');
});

test('升级备份目录冲突/symlink/hardlink 拒绝覆盖或跟随，原库不动', () => {
  // 1) 固定 UUID 撞上已有目录：必须拒绝覆盖。
  {
    const home = makeHome();
    const seeded = makeRawV1Store(home);
    const before = fs.readFileSync(seeded.markerFile);
    const backupDir = path.join(seeded.root, `backup-v1-${FIXED_UUID}`);
    fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(backupDir, 'sentinel.txt'), 'keep');
    const result = withFixedUuid(() => upgradeNotesStore({ home }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'path-invalid');
    assert.deepEqual(fs.readFileSync(seeded.markerFile), before);
    assert.equal(fs.readFileSync(path.join(backupDir, 'sentinel.txt'), 'utf8'), 'keep');
    assert.deepEqual(backupDirs(seeded.root), [`backup-v1-${FIXED_UUID}`]);
  }

  // 2) symlink 占用备份目录：lstat 先拒，不跟随域外目录。
  {
    const home = makeHome();
    const seeded = makeRawV1Store(home);
    const before = fs.readFileSync(seeded.markerFile);
    const outside = makeHome();
    const outsideDir = path.join(outside, 'outside-dir');
    fs.mkdirSync(outsideDir);
    const backupDir = path.join(seeded.root, `backup-v1-${FIXED_UUID}`);
    let symlinked = true;
    try {
      fs.symlinkSync(outsideDir, backupDir, 'dir');
    } catch {
      symlinked = false; // Windows 无 symlink 权限时跳过这一支，其他两支仍验安全边界。
    }
    if (symlinked) {
      const result = withFixedUuid(() => upgradeNotesStore({ home }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.equal(result.code, 'path-invalid');
      assert.deepEqual(fs.readFileSync(seeded.markerFile), before);
      assert.equal(fs.statSync(outsideDir).isDirectory(), true);
      assert.deepEqual(fs.readdirSync(outsideDir), [], '没有跟随 symlink 往域外写备份');
    }
  }

  // 3) 资源是硬链接：备份源拒绝 nlink>1，不复制域外 inode。
  {
    const home = makeHome();
    const seeded = makeRawV1Store(home);
    const before = fs.readFileSync(seeded.markerFile);
    const outsideFile = path.join(makeHome(), 'outside.md');
    fs.writeFileSync(outsideFile, seeded.bytes);
    fs.rmSync(seeded.resourceFile);
    fs.linkSync(outsideFile, seeded.resourceFile);
    const result = withFixedUuid(() => upgradeNotesStore({ home }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'path-invalid');
    assert.deepEqual(fs.readFileSync(seeded.markerFile), before);
    assert.deepEqual(backupDirs(seeded.root), [], '硬链接源不应产生备份目录');
  }
});


/* ── #304 显式 onCorrupt=skip：只降级坏资源，不降级 layout/权限/整库预算 ───── */

test('#304 onCorrupt=skip 返回坏资源清单，普通 GET 仍 fail closed', () => {
  const home = makeHome();
  const good = writeNotesResource({ home, resource: noteResource('ok', { title: '好笔记' }), expectedVersion: null });
  assert.equal(good.ok, true);
  const bad = writeNotesResource({
    home,
    resource: noteResource('bad', {
      title: '坏笔记',
      associations: [{ workspace: 'ws', subject: 'math', node: 'n-1', title: '数学' }],
    }),
    expectedVersion: null,
  });
  assert.equal(bad.ok, true);
  const layout = {
    folders: [
      { id: 'notes', parent: null, name: '概念', kind: 'folder' },
      { id: 'nb', parent: 'notes', name: '笔记本甲', kind: 'notebook' },
    ],
    nodes: [{
      id: 'node-bad', type: 'knowledge', position: { x: 1, y: 2 },
      style: { width: 300, height: 200 },
      data: { contentId: 'bad', notebookId: 'nb' },
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  assert.equal(writeNotesLayout({ home, layout, expectedVersion: null }).ok, true);
  // 让正文出现非法 UTF-8：头三行仍可提取 title/associations，整篇 normalize 必须失败。
  fs.appendFileSync(path.join(notesRoot(home), 'resources', 'r-bad.md'), Buffer.from([0xff, 0xfe]));

  const strict = readNotesStore({ home });
  assert.equal(strict.ok, false);
  assert.equal(strict.status, 503);
  assert.equal(strict.code, 'file-shape-unknown');

  const invalid = readNotesStore({ home, onCorrupt: 'nope' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.code, 'body-invalid');

  const skipped = readNotesStore({ home, onCorrupt: 'skip' });
  assert.equal(skipped.ok, true, JSON.stringify(skipped));
  assert.deepEqual(Object.keys(skipped.value.resources), ['ok']);
  assert.equal(skipped.value.corrupt.length, 1);
  const entry = skipped.value.corrupt[0];
  assert.equal(entry.id, 'bad');
  assert.equal(entry.kind, 'md');
  assert.equal(entry.title, '坏笔记');
  assert.equal(entry.notebook, '笔记本甲');
  assert.equal(entry.message, '资源文件已损坏，暂时无法载入。');
  assert.equal(entry.associations.length, 1);
  assert.equal(entry.associations[0].node, 'n-1');
  // 通用文案不含路径 / 异常。
  assert.equal(JSON.stringify(entry).includes(home), false);
});

test('#304 onCorrupt=skip 遇坏 layout 仍整库失败，不把 layout 当空', () => {
  const home = makeHome();
  assert.equal(writeNotesResource({ home, resource: noteResource('ok'), expectedVersion: null }).ok, true);
  fs.writeFileSync(path.join(notesRoot(home), 'layout.json'), '{ not json');
  const skipped = readNotesStore({ home, onCorrupt: 'skip' });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.status, 503);
  assert.equal(skipped.code, 'file-shape-unknown');
});

test('#304 onCorrupt=skip 也把单文件超限的字节计入 48 MiB 实际总量', () => {
  const home = makeHome();
  assert.equal(writeNotesResource({ home, resource: noteResource('good'), expectedVersion: null }).ok, true);
  const resources = path.join(notesRoot(home), 'resources');
  // 稀疏文件即可：stat.size 计入预算，读取上限会在 readFile 之前拒绝。
  const oversize = 6 * 1024 * 1024 + 1;
  for (let i = 0; i < 9; i += 1) {
    const file = path.join(resources, `r-oversize-${i}.json`);
    fs.writeFileSync(file, '');
    fs.truncateSync(file, oversize);
  }
  const skipped = readNotesStore({ home, onCorrupt: 'skip' });
  assert.equal(skipped.ok, false, '9 个超限文件合计超过 48 MiB 时不能再 skip');
  assert.equal(skipped.status, 503);
  assert.equal(skipped.code, 'file-shape-unknown');
  assert.match(skipped.message, /48 MiB/);

  // 单个超限文件（总量未越界）仍按坏资源降级，预算不应把 skip 整体禁掉。
  for (let i = 1; i < 9; i += 1) fs.rmSync(path.join(resources, `r-oversize-${i}.json`));
  const one = readNotesStore({ home, onCorrupt: 'skip' });
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.deepEqual(Object.keys(one.value.resources), ['good']);
  assert.equal(one.value.corrupt.length, 1);
  assert.equal(one.value.corrupt[0].id, 'oversize-0');
});
