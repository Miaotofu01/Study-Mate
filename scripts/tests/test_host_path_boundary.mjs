/* 特征化测试：Host 半数据层 · 路径越界（lib/assets.ts 与 lib/reference.ts 的取址/读取）
   ────────────────────────────────────────────────────────────────────────
   钉住「哪些路径解得开、哪些一律拒绝」：`..`、绝对路径、科目名里的分隔符、清单会跳过的
   名字段、非文本扩展名、内容其实是二进制。断言只看取址/读取的返回值，不看内部判据写法。
   数据在 fs.mkdtemp 造的临时目录里现造现弃。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { assetFile, contentTypeOf } from '../../lib/assets.ts';
import { listReference, readReference, referenceVersion, writeReference } from '../../lib/reference.ts';

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

/* ── 符号链接：边界按真实路径算 ───────────────────────────────────────── */

test('符号链接解出来的真实路径跑出科目目录：清单不收、读取拒绝', () => {
  const { workspace, demo, outside } = makeWorkspace();
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(demo, 'reference', 'link.txt'));
  fs.symlinkSync(outside, path.join(demo, 'reference', 'linkdir'));
  fs.symlinkSync(path.join(outside, '不存在.txt'), path.join(demo, 'reference', 'broken.txt'));

  const paths = listReference({ subjectDir: demo }).entries.map((entry) => entry.path);
  // 指向目录的符号链接不进（跟着走会成环），指向树外文件的链接同样不收
  assert.equal(paths.includes('linkdir/secret.txt'), false);
  assert.equal(paths.includes('link.txt'), false, '解出来在科目外面的链接不许进清单');
  // 断链跳过，不让整个清单崩掉
  assert.equal(paths.includes('broken.txt'), false);
  assert.deepEqual(paths, ['data.bin.md', 'notes.txt', 'pdf.pdf', 'sub/nested.md', '讲义.md']);

  // 读取一样拒绝：返回 null 就是「读不到」，不让 realpath 的异常冒成 500
  assert.equal(readReference({ workspace, subject: 'demo', relPath: 'link.txt' }), null);
  assert.equal(readReference({ workspace, subject: 'demo', relPath: 'linkdir/secret.txt' }), null);
  // 版本号也只按留下来的条目算，被拒的链接不进栅栏
  assert.equal(referenceVersion({ workspace, subject: 'demo' }),
    listReference({ subjectDir: demo }).version);
});

test('取址同样拒绝经符号链接跑到科目外面的目标', () => {
  const { workspace, demo, outside } = makeWorkspace();
  fs.symlinkSync(outside, path.join(demo, 'assets', 'linkdir'));
  fs.symlinkSync(path.join(outside, 'secret.png'), path.join(demo, 'assets', 'link.png'));

  assert.equal(assetFile({ workspace, subject: 'demo', rel: 'assets/linkdir/secret.png' }), null);
  assert.equal(assetFile({ workspace, subject: 'demo', rel: 'assets/link.png' }), null);
  // 科目自己那份图照旧取得到
  assert.equal(assetFile({ workspace, subject: 'demo', rel: 'assets/img/图.PNG' }),
    path.join(demo, 'assets', 'img', '图.PNG'));
});

test('越界的是「跑出科目目录」：科目目录自己挂成符号链接不算越界', () => {
  const { workspace, subjects, root } = makeWorkspace();
  const target = path.join(root, '别的盘', 'linked');
  write(path.join(target, 'subject.yaml'), 'slug: linked\nname: 挂过来的科目\n');
  write(path.join(target, 'curriculum.yaml'), 'nodes:\n  - id: 变量\n    title: 变量\n');
  write(path.join(target, 'reference', '带过来的.md'), '带过来的正文\n');
  write(path.join(target, 'assets', '带过来的.png'), 'PNG');
  fs.symlinkSync(target, path.join(subjects, 'linked'));

  const linked = path.join(subjects, 'linked');
  assert.equal(assetFile({ workspace, subject: 'linked', rel: 'assets/带过来的.png' }),
    path.join(linked, 'assets', '带过来的.png'));
  assert.equal(readReference({ workspace, subject: 'linked', relPath: '带过来的.md' }).text, '带过来的正文\n');
  assert.deepEqual(listReference({ subjectDir: linked }).entries.map((entry) => entry.path), ['带过来的.md']);

  // 写入也照常落在链接指向的那个目录里（学生自己的布置，不是越界）
  const result = writeReference({
    workspace, subject: 'linked', title: '写进来的', markdown: '正文\n',
    expectedVersion: referenceVersion({ workspace, subject: 'linked' }),
    operationId: `linked-subject-${process.pid}`, now: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(target, 'reference', '写进来的.md'), 'utf8').endsWith('正文\n'), true);
});

test('reference/ 里的链接指向本科目内的资料：解出来还在科目里，照旧可列可读', () => {
  const { workspace, demo } = makeWorkspace();
  fs.symlinkSync(path.join(demo, 'reference', '讲义.md'), path.join(demo, 'reference', '别名.md'));

  const paths = listReference({ subjectDir: demo }).entries.map((entry) => entry.path);
  assert.equal(paths.includes('别名.md'), true);
  assert.equal(readReference({ workspace, subject: 'demo', relPath: '别名.md' }).text, '讲义正文\n');
});

test('断链与成环的符号链接：读不到就是读不到，不把请求打成 500', () => {
  const { workspace, demo } = makeWorkspace();
  const ref = path.join(demo, 'reference');
  fs.symlinkSync(path.join(ref, 'b.txt'), path.join(ref, 'a.txt'));
  fs.symlinkSync(path.join(ref, 'a.txt'), path.join(ref, 'b.txt')); // a ↔ b 成环
  fs.symlinkSync(path.join(ref, '不存在.txt'), path.join(ref, 'broken.txt'));
  fs.symlinkSync(path.join(demo, 'assets', 'self.png'), path.join(demo, 'assets', 'self.png')); // 自指

  // 解不出真实路径的，一律按「读不到」处理，不让 realpath 的异常冒出去
  assert.equal(readReference({ workspace, subject: 'demo', relPath: 'a.txt' }), null);
  assert.equal(readReference({ workspace, subject: 'demo', relPath: 'broken.txt' }), null);
  assert.equal(assetFile({ workspace, subject: 'demo', rel: 'assets/self.png' }), null);
  assert.deepEqual(listReference({ subjectDir: demo }).entries.map((entry) => entry.path),
    ['data.bin.md', 'notes.txt', 'pdf.pdf', 'sub/nested.md', '讲义.md']);

  // 这些坏链接也不该挡住正常的写入
  const result = writeReference({
    workspace, subject: 'demo', title: '照常写', markdown: '正文\n',
    expectedVersion: referenceVersion({ workspace, subject: 'demo' }),
    operationId: `loop-${process.pid}`, now: 0,
  });
  assert.equal(result.ok, true);
});

test('reference/ 自己指向科目外面的符号链接：写入被拒，外面一个文件都不许多', () => {
  const { workspace, demo, outside } = makeWorkspace();
  fs.rmSync(path.join(demo, 'reference'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(demo, 'reference'));
  const before = fs.readdirSync(outside).sort();

  const result = writeReference({
    workspace, subject: 'demo', title: '越界写入', markdown: '正文\n',
    expectedVersion: referenceVersion({ workspace, subject: 'demo' }),
    operationId: `escape-write-${process.pid}`, now: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, 'path-invalid');
  assert.deepEqual(fs.readdirSync(outside).sort(), before, '科目外面的目录一个文件都不许多');

  // 同一处口子的另外两面：清单不列外面那些，读也读不到
  assert.deepEqual(listReference({ subjectDir: demo }).entries, []);
  assert.equal(readReference({ workspace, subject: 'demo', relPath: 'secret.txt' }), null);
});
