/* 路径包含判据（lib/paths.ts）的直接断言。
   ────────────────────────────────────────────────────────────────────────
   这条判据是**安全边界**：reference/ 的读写、assets/ 的取址、导出的落点、实验命令的
   cwd / 可写范围 / 参数路径，四处都靠它。收成一份之前它有三种写法（前后补分隔符、
   `path.relative`、先判 `root` 带不带分隔符），在边上不同解——所以这里直接钉住判据本身，
   而不是只靠四个调用点各自的特征化测试（那些测的是「取址/落盘的结果」，判据换一种写法
   照样可能绿）。

   边界值逐条列在下面：它们是**判据换写法时最先分叉**的地方，不是凑数。
   数据在 fs.mkdtemp 造的临时目录里现造现弃。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { isWithin, isWithinReal, realPathOf } from '../../lib/paths.ts';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

const TEMPS = [];
after(() => {
  for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  TEMPS.push(root);
  return root;
}

/* ── isWithin：纯字符串判据，不需要盘 ─────────────────────────────────── */

test('isWithin：相等与后代算在内', () => {
  assert.equal(isWithin('/a/b', '/a/b'), true);
  assert.equal(isWithin('/a/b', '/a/b/c'), true);
  assert.equal(isWithin('/a/b', '/a/b/c/d.txt'), true);
});

test('isWithin：同前缀的兄弟目录不算在内（/a/bc 不在 /a/b 里）', () => {
  assert.equal(isWithin('/a/b', '/a/bc'), false);
  assert.equal(isWithin('/a/b', '/a/bc/d'), false);
  assert.equal(isWithin('/a/b/c', '/a/b/cd'), false);
});

test('isWithin：父目录、树外、不同根都不算在内', () => {
  assert.equal(isWithin('/a/b', '/a'), false);
  assert.equal(isWithin('/a/b', '/a/b/..'), false);
  assert.equal(isWithin('/a/b', '/a/b/../c'), false);
  assert.equal(isWithin('/a/b', '/etc/hostname'), false);
  assert.equal(isWithin('/a/b', '/a/b/../../x'), false);
});

test('isWithin：root 自己带尾分隔符时，root 本身与它的后代都算在内', () => {
  // 这一条是三种旧写法唯一真正分叉的地方：`startsWith(root + sep)` 那份会把 `/a/b`
  // 判在 `/a/b/` 外面（拼出来是 `/a/b//`）。配置里写 `workspace: /home/x/ws/` 就会踩到。
  assert.equal(isWithin('/a/b/', '/a/b/'), true);
  assert.equal(isWithin('/a/b/', '/a/b'), true);
  assert.equal(isWithin('/a/b/', '/a/b/c'), true);
  assert.equal(isWithin('/a/b/', '/a/bc'), false);
});

test('isWithin：入参不规范化也判得对（判据自己会规范化）', () => {
  assert.equal(isWithin('/a/b/', '/a/b/./c'), true);
  assert.equal(isWithin('/a/b', '/a/./b/../b/c'), true);
  assert.equal(isWithin('/a/b/', '/a/b/../c'), false);
});

/* ── realPathOf / isWithinReal：要真盘 ────────────────────────────────── */

test('realPathOf：存在的路径解成真身，不存在的尾巴拼在最近存在的祖先后面', () => {
  const root = tempDir('studymate-paths-');
  const real = path.join(root, 'real');
  fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
  const link = path.join(root, 'link');
  fs.symlinkSync(real, link);

  assert.equal(realPathOf(real), fs.realpathSync(real));
  // 软链解到真身
  assert.equal(realPathOf(link), fs.realpathSync(real));
  // 还不存在的文件：祖先解链接，尾巴原样接上
  assert.equal(realPathOf(path.join(link, 'sub', '还没有.txt')), path.join(fs.realpathSync(real), 'sub', '还没有.txt'));
});

test('realPathOf：断链解不到真身，按「这个名字还不存在」处理——**不跟出去**', () => {
  const root = tempDir('studymate-paths-');
  const broken = path.join(root, '断链');
  fs.symlinkSync(path.join(root, '根本没有这个目录'), broken);
  // 断链的 realpath 会 ENOENT，于是它退到父目录、把 `断链` 当成一个还不存在的名字接回去。
  // 这不是漏判：调用方（assets / reference / lab）拿到之后都要再 `statSync` 一次证明它真是
  // 文件/目录，断链在那里就被挡下了——那条路径上根本读不到东西，也就没有「跟出去」这回事。
  assert.equal(realPathOf(broken), path.join(fs.realpathSync(root), '断链'));
});

test('isWithinReal：边界解不出来一律判越界（宁可拒绝，也不要漏）', () => {
  const root = tempDir('studymate-paths-');
  assert.equal(isWithinReal(null, path.join(root, 'x')), false);
  assert.equal(isWithinReal('', path.join(root, 'x')), false);
});

test('isWithinReal：软链指到边界之外就判越界，指在边界之内照常放行', () => {
  const root = tempDir('studymate-paths-');
  const inside = path.join(root, '科目');
  const outside = path.join(root, '树外');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, '秘密.txt'), '树外的秘密\n');

  const realInside = realPathOf(inside);
  const escape = path.join(inside, '逃出去');
  fs.symlinkSync(outside, escape);
  const stay = path.join(inside, '留在里面');
  fs.symlinkSync(path.join(inside, '子'), stay);

  assert.equal(isWithinReal(realInside, path.join(inside, '子', '还没建.txt')), true);
  assert.equal(isWithinReal(realInside, path.join(escape, '秘密.txt')), false);
  assert.equal(isWithinReal(realInside, path.join(outside, '秘密.txt')), false);
});

test('判据不空转：四个调用点都真的走这一份，谁也没再长出一份私有副本', () => {
  const callers = ['lib/reference.ts', 'lib/assets.ts', 'lib/export/run.ts', 'lib/lab/sandbox.ts'];
  for (const file of callers) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /from '(?:\.\.\/|\.\/)paths\.ts'/, `${file} 没从 lib/paths.ts 取判据`);
    // 私有副本的三种旧写法都叫这几个名字（`inside` / `insideReal` / `isWithin`）
    assert.doesNotMatch(source, /function (?:inside|insideReal|isWithin)\s*\(/,
      `${file} 又长出了一份私有的路径包含判据`);
  }
  // 判据自己那三种旧写法：补分隔符的 startsWith、先判 root 带不带分隔符、`..` 前缀比较
  const own = fs.readFileSync(path.join(ROOT, 'lib/paths.ts'), 'utf8');
  assert.equal((own.match(/startsWith\(`\.\.\$\{path\.sep\}`\)/g) || []).length, 1,
    'lib/paths.ts 里应当只有一处 `..` 前缀比较');
  assert.doesNotMatch(own, /startsWith\(root \+ path\.sep\)/, '补分隔符那份写法不该回来了');
});
