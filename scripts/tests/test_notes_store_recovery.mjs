/* #304：崩溃与故障路径用真实临时数据域验证，不碰用户笔记。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { removeTree } from './fixtures/fs-rm.mjs';
import { notesRoot, readNotesStore, writeNotesResource, writeNotesLayout, upgradeNotesStore } from '../../lib/notes/store.ts';
import { handleNotes } from '../../lib/notes/route.ts';

const moduleUrl = new URL('../../lib/notes/store.ts', import.meta.url).href;
const note = (id, markdown = '正文') => ({ id, type: 'note', title: '笔记', markdown });
const layout = { folders: [], nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
function homeFor(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'studymate-recovery-'));
  t.after(() => removeTree(home));
  return home;
}
function seed(t, id = 'note') {
  const home = homeFor(t);
  const result = writeNotesResource({ home, resource: note(id), expectedVersion: null });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { home, root: notesRoot(home), result };
}

// 等子进程的就绪文件是进程间 barrier，不用挂钟猜两个写者是否同时取到了同一基线。
async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('子进程 barrier 超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('首次初始化在 marker rename 前真崩溃：GET 不写盘，下一次保存可恢复并清理孤儿 temp', t => {
  const home = homeFor(t);
  const script = path.join(home, 'crash.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; import path from 'node:path';
    import { writeNotesResource } from ${JSON.stringify(moduleUrl)};
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (path.basename(to) === '_format.json') process.exit(17); return rename(from, to); };
    writeNotesResource({home:${JSON.stringify(home)},resource:${JSON.stringify(note('crash'))},expectedVersion:null});`);
  const child = spawnSync(process.execPath, [script], { stdio: 'ignore', timeout: 15000 });
  assert.equal(child.status, 17);
  const root = notesRoot(home);
  const temps = fs.readdirSync(root).filter(name => /^\.tmp-[0-9a-f]{16}$/.test(name));
  assert.equal(temps.length, 1, '真实 writer 留下的 marker 临时文件');
  const before = fs.readdirSync(root).sort();
  const read = readNotesStore({ home });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.deepEqual(read.value.resources, {});
  assert.deepEqual(fs.readdirSync(root).sort(), before, '读取不清理、不建 marker');
  const saved = writeNotesResource({ home, resource: note('recovered'), expectedVersion: null });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(readNotesStore({ home }).value.resources.recovered.markdown, '正文');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.tmp-')), []);
});

test('只认精确临时文件保留名，不认任意 .tmp-*，不删除目录/硬链接/外来文件', t => {
  for (const kind of ['short-name', 'directory', 'hardlink', 'unknown']) {
    const home = path.join(homeFor(t), kind), root = notesRoot(home);
    fs.mkdirSync(root, { recursive: true });
    const name = kind === 'short-name' ? '.tmp-deadbeef' : '.tmp-0123456789abcdef';
    const target = path.join(root, name);
    if (kind === 'directory') fs.mkdirSync(target);
    else if (kind === 'hardlink') {
      const outside = path.join(home, 'outside'); fs.writeFileSync(outside, '不能删除'); fs.linkSync(outside, target);
    } else fs.writeFileSync(target, '不能删除');
    if (kind === 'unknown') fs.writeFileSync(path.join(root, 'my-notes.txt'), '用户内容');
    const read = readNotesStore({ home });
    assert.equal(read.ok, false, kind);
    const saved = writeNotesResource({ home, resource: note('x'), expectedVersion: null });
    assert.equal(saved.ok, false, kind);
    assert.equal(fs.existsSync(target), true, kind);
    assert.equal(fs.existsSync(path.join(root, '_format.json')), false, kind);
    assert.equal(fs.existsSync(path.join(root, 'notes.lock.db')), false, kind);
  }
});

test('已有库孤儿 temp 只在拿锁保存时清理，资源目录副文件原样保留', t => {
  const { home, root, result } = seed(t);
  for (const dir of [root, path.join(root, 'resources')]) {
    fs.writeFileSync(path.join(dir, '.tmp-0123456789abcdef'), '中断的写入');
    fs.writeFileSync(path.join(dir, '.tmp-my-backup'), '不是本程序的文件');
  }
  assert.equal(readNotesStore({ home }).ok, true);
  assert.equal(fs.existsSync(path.join(root, '.tmp-0123456789abcdef')), true);
  const saved = writeNotesResource({ home, resource: note('note', '新正文'), expectedVersion: result.value.version });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  for (const dir of [root, path.join(root, 'resources')]) {
    assert.equal(fs.existsSync(path.join(dir, '.tmp-0123456789abcdef')), false);
    assert.equal(fs.readFileSync(path.join(dir, '.tmp-my-backup'), 'utf8'), '不是本程序的文件');
  }
});

test('坏 JSON / UTF8 / MD header / id 与物理类型：稳定报 file-shape-unknown，GET 不改坏文件', async t => {
  const bads = [
    ['r-bad.json', Buffer.from('{bad json')],
    ['r-bad.json', Buffer.from([0xff])],
    ['_format.json', Buffer.from([0xff])],
    ['layout.json', Buffer.from([0xff])],
    ['r-bad.md', Buffer.from('无元信息头')],
    ['r-bad.json', Buffer.from(JSON.stringify({ id: 'other', type: 'link', url: 'https://example.com' }))],
    ['r-bad.json', Buffer.from(JSON.stringify(note('bad')))],
  ];
  for (const [name, bytes] of bads) {
    const { home, root } = seed(t);
    const file = ['_format.json', 'layout.json'].includes(name) ? path.join(root, name) : path.join(root, 'resources', name);
    fs.writeFileSync(file, bytes);
    const response = await handleNotes(new Request('http://localhost/api/studymate/notes'), home);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'file-shape-unknown', JSON.stringify(body));
    assert.doesNotMatch(body.error.message, /稍后重试/);
    assert.equal(JSON.stringify(body).includes(JSON.stringify(home).slice(1, -1)), false);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
});

test('权限和未知 IO 错误不泄漏绝对路径；详细错误留在诊断中', async t => {
  const { home, root, result } = seed(t);
  const leaked = `EACCES: permission denied '${root}/.tmp-secret'`;
  const warnings = [];
  const originalWarn = console.warn, originalRead = fs.readFileSync, originalRename = fs.renameSync;
  console.warn = (...args) => warnings.push(args);
  try {
    fs.readFileSync = (file, ...args) => {
      if (String(file).endsWith('r-note.md')) throw Object.assign(new Error(leaked), { code: 'EACCES' });
      return originalRead(file, ...args);
    };
    const response = await handleNotes(new Request('http://localhost/api/studymate/notes'), home);
    const body = await response.json();
    assert.equal(body.error.code, 'notes-unavailable');
    assert.equal(JSON.stringify(body).includes(JSON.stringify(home).slice(1, -1)), false);
    fs.readFileSync = originalRead;
    fs.renameSync = () => { throw Object.assign(new Error(leaked), { code: 'EACCES' }); };
    const write = writeNotesResource({ home, resource: note('note', '改动'), expectedVersion: result.value.version });
    assert.equal(write.code, 'write-failed');
    assert.equal(JSON.stringify(write).includes(JSON.stringify(home).slice(1, -1)), false);
    assert.ok(warnings.some(args => args.some(arg => arg instanceof Error && arg.message === leaked)));
  } finally { fs.readFileSync = originalRead; fs.renameSync = originalRename; console.warn = originalWarn; }
});

test('origin 字段恰好上限往返，超过上限拒绝且不建数据域，不静默截断', t => {
  const home = homeFor(t), root = notesRoot(home);
  const resource = { id: 'ref', type: 'note', title: '外部文件', origin: { kind: 'file', mode: 'reference', name: '字'.repeat(2001) } };
  const bad = writeNotesResource({ home, resource, expectedVersion: null });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400); assert.equal(bad.code, 'body-invalid');
  assert.equal(fs.existsSync(root), false);
  resource.origin.name = '字'.repeat(2000);
  const good = writeNotesResource({ home, resource, expectedVersion: null });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(readNotesStore({ home }).value.resources.ref.origin.name, resource.origin.name);
});

test('250 篇边界与替换预算：第 251 篇 413、已有资源仍可改，拒绝不落文件', t => {
  const home = homeFor(t);
  for (let i = 0; i < 250; i++) {
    const result = writeNotesResource({ home, resource: note(`n-${i}`), expectedVersion: null });
    assert.equal(result.ok, true, `${i}: ${JSON.stringify(result)}`);
  }
  const rejected = writeNotesResource({ home, resource: note('over'), expectedVersion: null });
  assert.equal(rejected.status, 413); assert.equal(rejected.code, 'body-invalid');
  assert.equal(fs.existsSync(path.join(notesRoot(home), 'resources', 'r-over.md')), false);
  const current = readNotesStore({ home });
  assert.equal(Object.keys(current.value.resources).length, 250);
  assert.equal(writeNotesResource({ home, resource: note('n-0', '替换'), expectedVersion: current.value.resourceVersions['n-0'] }).ok, true);
});

test('48 MiB 是实际文件预算：合法媒体累加越界 413，旧文件和总量不变', t => {
  const home = homeFor(t);
  const src = 'data:image/png;base64,' + Buffer.alloc(4 * 1024 * 1024).toString('base64');
  for (let i = 0; i < 8; i++) {
    const result = writeNotesResource({ home, resource: { id: `img-${i}`, type: 'image', title: '图', src }, expectedVersion: null });
    assert.equal(result.ok, true, JSON.stringify({ ok: result.ok, code: result.code }));
  }
  const dir = path.join(notesRoot(home), 'resources');
  const total = () => fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  const before = total();
  assert.ok(before < 48 * 1024 * 1024);
  const result = writeNotesResource({ home, resource: { id: 'img-over', type: 'image', title: '图', src }, expectedVersion: null });
  assert.equal(result.status, 413); assert.equal(result.code, 'body-invalid');
  assert.equal(total(), before);
});

test('中文与非 ASCII 数据根可往返和删除（不使用 Windows 原生递归 rmSync）', t => {
  const home = path.join(homeFor(t), '中文 用户-é-🎯'); fs.mkdirSync(home);
  const resource = writeNotesResource({ home, resource: note('unicode', '中文-é-🎯'), expectedVersion: null });
  const savedLayout = writeNotesLayout({ home, layout, expectedVersion: null });
  assert.equal(resource.ok, true, JSON.stringify(resource)); assert.equal(savedLayout.ok, true, JSON.stringify(savedLayout));
  const read = readNotesStore({ home });
  assert.equal(read.value.resources.unicode.markdown, '中文-é-🎯');
  assert.equal(read.value.layoutVersion, savedLayout.value.version);
});

test('同一 expectedVersion 的两个真实并发保存：恰好一个 200，一个 409，胜者内容不丢', async t => {
  const { home, result } = seed(t, 'race');
  const gate = path.join(home, 'go'), children = [], handles = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); for (const fd of handles) fs.closeSync(fd); });
  const outcomes = [];
  for (const label of ['a', 'b']) {
    const ready = path.join(home, `${label}.ready`), out = path.join(home, `${label}.json`), script = path.join(home, `${label}.mjs`);
    fs.writeFileSync(script, `import fs from 'node:fs'; import { writeNotesResource } from ${JSON.stringify(moduleUrl)};
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      const deadline=Date.now()+10000; while (!fs.existsSync(${JSON.stringify(gate)})) { if(Date.now()>deadline) process.exit(2); await new Promise(r=>setTimeout(r,10)); }
      const result=writeNotesResource({home:${JSON.stringify(home)},resource:${JSON.stringify(note('race', label))},expectedVersion:${JSON.stringify(result.value.version)}});
      fs.writeFileSync(${JSON.stringify(out)},JSON.stringify(result));`);
    children.push(spawn(process.execPath, [script], { stdio: 'ignore' })); outcomes.push({ ready, out });
  }
  await until(() => outcomes.every(item => fs.existsSync(item.ready)));
  const exited = children.map(child => once(child, 'exit'));
  fs.writeFileSync(gate, 'go');
  const exits = await Promise.all(exited); assert.ok(exits.every(([code]) => code === 0), JSON.stringify(exits));
  const answers = outcomes.map(item => JSON.parse(fs.readFileSync(item.out, 'utf8')));
  assert.deepEqual(answers.map(item => item.status).sort(), [200, 409]);
  const winner = answers.find(item => item.ok), loser = answers.find(item => !item.ok);
  assert.equal(loser.code, 'version-conflict');
  const read = readNotesStore({ home });
  assert.equal(read.value.resourceVersions.race, winner.value.version);
  assert.equal(read.value.resources.race.markdown, winner.value.resource.markdown);
  assert.equal(loser.extra.version, winner.value.version);
});

test('rename 后同步父目录；目录同步失败不能回成功，同值显式重试会再次同步', t => {
  const { home, result } = seed(t);
  const originalOpen = fs.openSync, originalFsync = fs.fsyncSync, originalClose = fs.closeSync, originalRename = fs.renameSync;
  const directories = new Set(), events = [];
  const directoryToken = path.join(home, 'directory-fsync-token');
  let inject = false;
  fs.openSync = (file, ...args) => {
    // 在所有平台模拟可同步的目录句柄，以免 Windows 的降级分支让断言空跑。
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      const fd = originalOpen(directoryToken, 'a+'); directories.add(fd); return fd;
    }
    return originalOpen(file, ...args);
  };
  fs.fsyncSync = fd => {
    if (directories.has(fd)) { events.push('directory-sync'); if (inject) throw Object.assign(new Error('fault directory sync'), { code: 'EIO' }); }
    else events.push('file-sync');
    return originalFsync(fd);
  };
  fs.closeSync = fd => { directories.delete(fd); return originalClose(fd); };
  fs.renameSync = (...args) => { events.push('rename'); return originalRename(...args); };
  try {
    const changed = writeNotesResource({ home, resource: note('note', '已改'), expectedVersion: result.value.version });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    const renameAt = events.indexOf('rename'); assert.ok(renameAt >= 0);
    assert.ok(events.indexOf('directory-sync', renameAt) > renameAt);
    inject = true;
    const failure = writeNotesResource({ home, resource: note('note', '新稿'), expectedVersion: changed.value.version });
    assert.equal(failure.code, 'write-failed');
    const current = readNotesStore({ home });
    assert.equal(current.value.resources.note.markdown, '新稿', 'rename 已发生，不能谎称回滚了');
    inject = false; events.length = 0;
    const retried = writeNotesResource({ home, resource: note('note', '新稿'), expectedVersion: current.value.resourceVersions.note });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.ok(events.includes('directory-sync'), '同值重试也补目录同步');
  } finally { fs.openSync = originalOpen; fs.fsyncSync = originalFsync; fs.closeSync = originalClose; fs.renameSync = originalRename; }
});

test('升级 marker 已发布后目录 fsync 失败：失败回执仍保留逐字节旧库备份，幂等重试补同步', t => {
  const { home, root } = seed(t);
  const marker = path.join(root, '_format.json');
  const legacyBytes = Buffer.from(JSON.stringify({ format: 'studymate-notes', version: 1 }) + '\n');
  fs.writeFileSync(marker, legacyBytes);
  const resourceBytes = fs.readFileSync(path.join(root, 'resources', 'r-note.md'));
  const originalOpen = fs.openSync, originalFsync = fs.fsyncSync, originalClose = fs.closeSync, originalRename = fs.renameSync;
  const directories = new Set();
  let published = false, failSync = true, directorySyncs = 0;
  fs.openSync = (file, ...args) => {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      const fd = originalOpen(path.join(home, 'upgrade-directory-token'), 'a+'); directories.add(fd); return fd;
    }
    return originalOpen(file, ...args);
  };
  fs.fsyncSync = fd => {
    if (directories.has(fd)) {
      directorySyncs++;
      if (published && failSync) throw Object.assign(new Error('fault after marker rename'), { code: 'EIO' });
    }
    return originalFsync(fd);
  };
  fs.closeSync = fd => { directories.delete(fd); return originalClose(fd); };
  fs.renameSync = (from, to) => { const result = originalRename(from, to); if (to === marker) published = true; return result; };
  try {
    const failed = upgradeNotesStore({ home });
    assert.equal(failed.ok, false); assert.equal(failed.code, 'write-failed');
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).version, 2);
    const backups = fs.readdirSync(root).filter(name => /^backup-v1-[0-9a-f-]{36}$/.test(name));
    assert.equal(backups.length, 1, '失败可能已升级，不能删除唯一旧库备份');
    const backup = path.join(root, backups[0]);
    assert.deepEqual(fs.readFileSync(path.join(backup, '_format.json')), legacyBytes);
    assert.deepEqual(fs.readFileSync(path.join(backup, 'resources', 'r-note.md')), resourceBytes);
    failSync = false; const before = directorySyncs;
    const retry = upgradeNotesStore({ home });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.ok(directorySyncs > before, '已为 v2 的幂等路径仍补目录同步');
    assert.equal(fs.existsSync(backup), true);
  } finally { fs.openSync = originalOpen; fs.fsyncSync = originalFsync; fs.closeSync = originalClose; fs.renameSync = originalRename; }
});
