// 303：资源序列化缓存的行为反证。不是源码正则：真的调用缓存入口，数 serialize/fingerprint 次数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createResourceSerializer } from '../../client/notes/resource-serialization-cache.js';

function countingSerializer() {
  const calls = { serialize: [], fingerprint: [] };
  const serializer = createResourceSerializer({
    serialize(resource) { calls.serialize.push(resource.id); return { id: resource.id, markdown: resource.markdown }; },
    fingerprint(dto) { calls.fingerprint.push(dto.id); return JSON.stringify(dto); },
  });
  return { serializer, calls };
}

test('同一资源对象身份反复提交只序列化/指纹一次', () => {
  const { serializer, calls } = countingSerializer();
  const resource = { id: 'note-a', markdown: '# 正文' };
  const first = serializer.entryOf(resource);
  for (let frame = 0; frame < 250; frame++) {
    assert.equal(serializer.entryOf(resource), first, '每帧应命中同一个 entry 对象');
  }
  assert.deepEqual(calls.serialize, ['note-a']);
  assert.deepEqual(calls.fingerprint, ['note-a']);
  assert.equal(serializer.stats.misses, 1);
  assert.equal(serializer.stats.hits, 250);
});

test('新对象身份（编辑/新建/导入/undo）必须重算，且旧 DTO 不被原地修改', () => {
  const { serializer, calls } = countingSerializer();
  const before = { id: 'note-a', markdown: '旧正文' };
  const originalDto = serializer.entryOf(before).dto;
  const after = { id: 'note-a', markdown: '新正文' };
  const nextDto = serializer.entryOf(after).dto;
  assert.equal(originalDto.markdown, '旧正文');
  assert.equal(nextDto.markdown, '新正文');
  assert.notEqual(originalDto, nextDto);
  assert.deepEqual(calls.serialize, ['note-a', 'note-a']);
});

test('显式失效（load/applyBase/dispose）让旧身份重新序列化', () => {
  const { serializer, calls } = countingSerializer();
  const resource = { id: 'note-a', markdown: '同一正文' };
  serializer.entryOf(resource);
  serializer.invalidate();
  serializer.entryOf(resource);
  assert.deepEqual(calls.serialize, ['note-a', 'note-a']);
  assert.equal(serializer.stats.misses, 2);
});

test('序列化抛错不进缓存；forget 后下一次会重试', () => {
  let fail = true;
  const calls = { serialize: 0 };
  const serializer = createResourceSerializer({
    serialize() { calls.serialize++; if (fail) throw new Error('超限'); return { id: 'note-a' }; },
    fingerprint() { return '{}'; },
  });
  const resource = { id: 'note-a', markdown: 'x'.repeat(1000) };
  assert.throws(() => serializer.entryOf(resource), /超限/);
  fail = false;
  serializer.forget(resource);
  assert.equal(serializer.entryOf(resource).dto.id, 'note-a');
  assert.equal(calls.serialize, 2);
});

test('缓存不强持历史资源对象：失效后旧对象可被 GC（--expose-gc 子进程真跑）', async () => {
  // GC 时序不当判据，但断言本身必须真跑：默认门禁里 spawn 一个 --expose-gc 子进程，
  // 失效并强制回收后，旧资源对象的 WeakRef 必须已死（WeakMap 换新表的设计成效）。
  // 同一个宏任务里新建的对象被 V8 HandleScope 持有、gc() 收不走，所以分配与回收
  // 必须隔开宏任务边界——这是 V8 语义，不是把 GC 时序当判据。
  const moduleUrl = new URL('../../client/notes/resource-serialization-cache.js', import.meta.url).href;
  const probe = `
    import { createResourceSerializer } from ${JSON.stringify(moduleUrl)};
    const serializer = createResourceSerializer({
      serialize(resource) { return { id: resource.id, markdown: resource.markdown }; },
      fingerprint(dto) { return JSON.stringify(dto); },
    });
    let first = null;
    for (let i = 0; i < 50; i++) {
      const resource = { id: 'note-' + i, markdown: 'x' };
      serializer.entryOf(resource);
      if (i === 0) first = new WeakRef(resource);
    }
    serializer.invalidate();
    setTimeout(() => {
      global.gc();
      setTimeout(() => {
        if (first.deref() !== undefined) { console.error('旧资源对象仍被缓存强引用'); process.exit(1); }
        console.log('GC-OK');
      }, 50);
    }, 50);
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `GC 反证没过：\n${result.stdout}\n${result.stderr}`);
});
