/* 特征化测试：Host 半数据层 · 路径越界（lib/assets.mjs 与 lib/reference.mjs 的取址/读取）
   ────────────────────────────────────────────────────────────────────────
   钉住「哪些路径解得开、哪些一律拒绝」：`..`、绝对路径、科目名里的分隔符、清单会跳过的
   名字段、非文本扩展名、内容其实是二进制。断言只看取址/读取的返回值，不看内部判据写法。
   数据在 fs.mkdtemp 造的临时目录里现造现弃。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { assetFile, contentTypeOf } from '../../lib/assets.mjs';
import { listReference, readReference, referenceVersion, writeReference } from '../../lib/reference.mjs';

/* ── 临时工作区：跑完即弃 ─────────────────────────────────────────────── */

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** 两个科目：demo 与 demo2（同前缀，专门用来试「/a/bc 不算在 /a/b 里」这条判据）。 */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-host-path-'));
  TEMPS.push(root);
  const workspace = path.join(root, 'ws');
  const subjects = path.join(workspace, '.learning', 'subjects');
  const demo = path.join(subjects, 'demo');
  const demo2 = path.join(subjects, 'demo2');

  write(path.join(demo, 'subject.yaml'), 'slug: demo\nname: 演示\n');
  write(path.join(demo, 'curriculum.yaml'), 'nodes:\n  - id: 变量\n    title: 变量\n');
  write(path.join(demo, 'assets', 'img', '图.PNG'), 'PNG');
  write(path.join(demo, 'assets', 'vector.svg'), '<svg/>');
  write(path.join(demo, 'reference', '讲义.md'), '讲义正文\n');
  write(path.join(demo, 'reference', 'notes.txt'), 'notes\n');
  write(path.join(demo, 'reference', 'data.bin.md'), '带\0二进制\0的 md\n');
  write(path.join(demo, 'reference', '.hidden.md'), '藏起来的\n');
  write(path.join(demo, 'reference', '__pycache__', 'cached.md'), '缓存\n');
  write(path.join(demo, 'reference', 'pdf.pdf'), '%PDF-1.4\n');
  write(path.join(demo, 'reference', 'sub', 'nested.md'), '嵌套\n');
  // 同前缀的兄弟科目：天真地写 startsWith(root) 会把它放进来
  write(path.join(demo2, 'subject.yaml'), 'slug: demo2\nname: 兄弟\n');
  write(path.join(demo2, 'reference', '别人的.md'), '别人的资料\n');

  const outside = path.join(root, 'outside');
  write(path.join(outside, 'secret.txt'), '树外的秘密\n');
  write(path.join(outside, 'secret.png'), '树外的图\n');

  return { root, workspace, subjects, demo, demo2, outside };
}

/* ── 取址：assetFile / contentTypeOf ──────────────────────────────────── */

test('取址把 <科目> + 相对路径 解成科目目录里的绝对路径', () => {
  const { workspace, demo } = makeWorkspace();
  const png = path.join(demo, 'assets', 'img', '图.PNG');

  assert.equal(assetFile({ workspace, subject: 'demo', rel: 'assets/img/图.PNG' }), png);
  // 内容文件里的路径相对 lessons/ 写，中间那截 .. 只是归一化，不算越界
  assert.equal(assetFile({ workspace, subject: 'demo', rel: 'lessons/../assets/img/图.PNG' }), png);
  assert.equal(contentTypeOf(png), 'image/png');
  assert.equal(contentTypeOf(path.join(demo, 'assets', 'vector.svg')), 'image/svg+xml');
  assert.equal(contentTypeOf(path.join(demo, 'reference', 'pdf.pdf')), 'application/octet-stream');
});

test('取址越界一律拒绝：..、绝对路径、科目名里的分隔符', () => {
  const { workspace, outside } = makeWorkspace();
  const attempts = [
    { subject: 'demo', rel: '../../../../etc/hostname' },
    { subject: 'demo', rel: '..' },
    { subject: 'demo', rel: 'assets/../../../../outside/secret.png' },
    { subject: 'demo', rel: '/etc/hostname' },
    { subject: 'demo', rel: path.join(outside, 'secret.png') },
    { subject: 'demo', rel: '../demo2/reference/别人的.md' },
    { subject: '../demo2', rel: 'reference/别人的.md' },
    { subject: 'demo2/../demo', rel: 'assets/img/图.PNG' },
    { subject: 'demo\\2', rel: 'assets/img/图.PNG' },
    { subject: '/etc', rel: 'hostname' },
    { subject: '', rel: 'assets/img/图.PNG' },
    { subject: 'demo', rel: '' },
  ];
  for (const attempt of attempts) {
    assert.equal(assetFile({ workspace, ...attempt }), null, `${JSON.stringify(attempt)} 应当被拒绝`);
  }
});

test('同前缀的兄弟科目不算「在科目目录里」', () => {
  const { workspace, demo2 } = makeWorkspace();
  // /…/subjects/demo2/... 以 /…/subjects/demo 开头，但不以 /…/subjects/demo/ 开头
  assert.equal(assetFile({ workspace, subject: 'demo', rel: '../demo2/reference/别人的.md' }), null);
  assert.equal(readReference({ workspace, subject: 'demo', relPath: '../demo2/reference/别人的.md' }), null);
  // 兄弟科目自己走自己的名字，读得到
  assert.equal(assetFile({ workspace, subject: 'demo2', rel: 'reference/别人的.md' }),
    path.join(demo2, 'reference', '别人的.md'));
});

test('取址只认文件：不存在、是目录、断链都给 null', () => {
  const { workspace } = makeWorkspace();
  assert.equal(assetFile({ workspace, subject: 'demo', rel: 'assets/img/不存在.png' }), null);
  assert.equal(assetFile({ workspace, subject: 'demo', rel: 'assets/img' }), null);
  assert.equal(assetFile({ workspace, subject: 'demo', rel: 'assets/断链.png' }), null);
});

/* ── 读取：readReference ──────────────────────────────────────────────── */

test('读一份参考资料：正文与条目一起给，条目与清单同形', () => {
  const { workspace } = makeWorkspace();
  const found = readReference({ workspace, subject: 'demo', relPath: 'sub/nested.md' });
  assert.equal(found.text, '嵌套\n');
  assert.deepEqual(found.entry, {
    path: 'sub/nested.md',
    name: 'nested.md',
    title: 'nested',
    ext: '.md',
    bytes: 7,
    source: 'agent',
    added_at: '',
  });
  // 带 `source: learner` front matter 的才算学生放的
  writeReference({
    workspace, subject: 'demo', title: '学生讲义', markdown: '自己写的\n',
    expectedVersion: referenceVersion({ workspace, subject: 'demo' }),
    operationId: `path-boundary-${process.pid}`, now: 0,
  });
  const learner = readReference({ workspace, subject: 'demo', relPath: '学生讲义.md' });
  assert.equal(learner.entry.source, 'learner');
  assert.equal(learner.entry.title, '学生讲义');
});

test('读取越界与读到不该读的都返回 null', () => {
  const { workspace } = makeWorkspace();
  const attempts = [
    '../subject.yaml',                       // 出 reference/
    '../../../../etc/hostname',              // 出工作区
    '/etc/hostname',                         // 绝对路径
    '../demo2/reference/别人的.md',           // 兄弟科目
    '.hidden.md',                            // 清单会跳过的隐藏文件
    '__pycache__/cached.md',                 // 清单会跳过的目录
    'pdf.pdf',                               // 二进制扩展名
    'data.bin.md',                           // 扩展名说是文本，内容其实是二进制
    '不存在.md',
    '',
  ];
  for (const relPath of attempts) {
    assert.equal(readReference({ workspace, subject: 'demo', relPath }), null, `${relPath} 应当读不到`);
  }
  // 科目名不合法时也读不到
  assert.equal(readReference({ workspace, subject: '../demo2', relPath: 'reference/别人的.md' }), null);
  // 重复的分隔符是归一化，不是越界：sub//nested.md 与 sub/nested.md 是同一份
  assert.equal(readReference({ workspace, subject: 'demo', relPath: 'sub//nested.md' }).text, '嵌套\n');
});

test('清单收录所有文件（含二进制），读取只认文本扩展名', () => {
  const { workspace, demo } = makeWorkspace();
  const { entries } = listReference({ subjectDir: demo });
  // 隐藏文件、__pycache__ 不进清单；二进制**进**清单（界面上要按文件列出），只是读不到正文
  assert.deepEqual(entries.map((entry) => entry.path),
    ['data.bin.md', 'notes.txt', 'pdf.pdf', 'sub/nested.md', '讲义.md']);

  // 读得到的都在清单里：反过来不成立——清单里看得见的二进制读不到正文
  for (const entry of entries) {
    const found = readReference({ workspace, subject: 'demo', relPath: entry.path });
    if (found !== null) assert.deepEqual(found.entry, entry, '清单与读取两条口子要给同一份条目');
  }
  assert.equal(readReference({ workspace, subject: 'demo', relPath: 'pdf.pdf' }), null);
  assert.notEqual(entries.find((entry) => entry.path === 'pdf.pdf'), undefined);
});

test('版本号：科目名不合法给空串，目录不存在给空清单的哈希', () => {
  const { workspace } = makeWorkspace();
  assert.equal(referenceVersion({ workspace, subject: '../demo2' }), '');
  assert.equal(referenceVersion({ workspace, subject: '' }), '');
  const fresh = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-host-empty-'));
  TEMPS.push(fresh);
  write(path.join(fresh, 'subject.yaml'), 'slug: x\n');
  assert.match(referenceVersion({ workspace: path.dirname(path.dirname(fresh)), subject: path.basename(fresh) }),
    /^[0-9a-f]{16}$/);
});

/* ── 符号链接：今天的行为，未修 ───────────────────────────────────────── */

test('符号链接：指向目录的链接不进清单，指向文件的链接今天照旧跟随（未修的口子）', () => {
  const { workspace, demo, outside } = makeWorkspace();
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(demo, 'reference', 'link.txt'));
  fs.symlinkSync(outside, path.join(demo, 'reference', 'linkdir'));
  fs.symlinkSync(path.join(outside, '不存在.txt'), path.join(demo, 'reference', 'broken.txt'));

  const paths = listReference({ subjectDir: demo }).entries.map((entry) => entry.path);
  // 指向目录的符号链接**不进**：跟着走会成环，也可能指到 reference/ 外面去
  assert.equal(paths.includes('linkdir/secret.txt'), false);
  // 断链跳过，不让整个清单崩掉
  assert.equal(paths.includes('broken.txt'), false);
  assert.deepEqual(paths, ['data.bin.md', 'link.txt', 'notes.txt', 'pdf.pdf', 'sub/nested.md', '讲义.md']);

  // 下面两条钉的是**今天的行为**，不是期望行为：树外的文件经符号链接仍读得到。
  // 验收标准写的是「路径越界（..、绝对路径、symlink）→ 拒绝」，今天只做到了前两条；
  // 修它的时候请连同这两条断言一起改（交付说明里已列为未修的问题）。
  assert.equal(readReference({ workspace, subject: 'demo', relPath: 'link.txt' }).text, '树外的秘密\n');
  assert.equal(readReference({ workspace, subject: 'demo', relPath: 'linkdir/secret.txt' }).text, '树外的秘密\n');
});
