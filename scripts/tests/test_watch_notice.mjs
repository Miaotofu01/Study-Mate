// 监听域（#74 `lib/watch/**`）的纯逻辑：变更通知的形状、路径→域映射、SSE 帧。
//
// 这里**不碰文件系统、不起 HTTP**：那两件事各有一份套件（test_watch_tree.mjs /
// test_watch_push.mjs），真 DSH 里的端到端在 test_dsh_runtime.mjs 的监听探针里。
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const domains = await import(pathToFileURL(path.join(ROOT, 'lib/watch/domains.ts')).href);
const notice = await import(pathToFileURL(path.join(ROOT, 'lib/watch/notice.ts')).href);

test('路径 → 域：课件、题库、作答、记忆与「新建科目」各归各片', () => {
  const table = [
    // 科目内部
    ['/.learning/subjects/demo/lessons/0001-var.md', ['lesson']],
    ['/.learning/subjects/demo/lessons/0001-var.quiz.json', ['pool']],
    // 只有目录名（宿主 ctx.fs.watch 给的粒度就是这样）：按课件报，见 domains.ts 的注释
    ['/.learning/subjects/demo/lessons', ['lesson']],
    ['.learning/subjects/demo/attempts/0001-var.json', ['attempts']],
    ['.learning/subjects/demo/learning-records/2026-05-06.md', ['records']],
    ['.learning/subjects/demo/reference/tcp.md', ['reference']],
    ['.learning/subjects/demo/lab/lab01/README.md', ['lab']],
    ['.learning/subjects/demo/progress.yaml', ['progress']],
    ['.learning/subjects/demo/curriculum.yaml', ['curriculum']],
    ['.learning/subjects/demo/subject.yaml', ['subject']],
    ['.learning/subjects/demo/misconceptions.yaml', ['misconceptions']],
    ['.learning/subjects/demo/MISSION.md', ['mission']],
    ['.learning/subjects/demo/GLOSSARY.md', ['glossary']],
    ['.learning/subjects/demo/RESOURCES.md', ['resources']],
    // 科目这一层：新建/删除/改名一个科目
    ['.learning/subjects/demo', ['subjects']],
    ['.learning/subjects', ['subjects']],
    ['.learning/MEMORY.md', ['memory']],
    ['.learning', ['learning']],
    // 认不出来的：保守落 workspace（页面整份重取，绝不漏报）
    ['something-else/notes.txt', ['workspace']],
    ['', ['workspace']],
    ['.learning/unknown.md', ['workspace']],
  ];
  for (const [input, expected] of table) {
    assert.deepEqual(domains.domainsOfPath(input), expected, `${JSON.stringify(input)} 的域不对`);
  }
  // Windows 上 fs.watch 给的是反斜杠
  assert.deepEqual(domains.domainsOfPath('.learning\\subjects\\demo\\lessons\\0001-var.md'), ['lesson']);
});

test('一批路径 → 通知里的 domains：升序、去重、空集兜底', () => {
  assert.deepEqual(domains.mergeDomains(['.learning/subjects/demo/lessons/0001.md', '.learning/subjects/demo/lessons/0001.quiz.json']),
    ['lesson', 'pool']);
  assert.deepEqual(domains.mergeDomains(['.learning/subjects/demo/progress.yaml', '.learning/subjects/demo/progress.yaml']),
    ['progress']);
  assert.deepEqual(domains.mergeDomains([]), ['workspace']);
});

test('变更通知的形状是契约：kind / domains / at / seq', () => {
  notice.resetNoticeBusForTests();
  const received = [];
  const off = notice.subscribeNotices((one) => received.push(one));
  try {
    const published = notice.publishChange(['pool', 'lesson', 'lesson'], new Date('2026-05-06T10:00:00Z'));
    assert.deepEqual(published, {
      kind: 'changed',
      domains: ['lesson', 'pool'],
      at: '2026-05-06T10:00:00.000Z',
      seq: 1,
    });
    assert.deepEqual(received, [published], '订阅端拿到的就是发出去的那一条');
    assert.equal(notice.publishChange(['memory'], new Date('2026-05-06T10:00:01Z')).seq, 2, 'seq 单调递增');

    // SSE 帧：EventSource 只认 data: 行，帧尾必须有空行
    assert.equal(notice.sseFrame(published),
      'data: {"kind":"changed","domains":["lesson","pool"],"at":"2026-05-06T10:00:00.000Z","seq":1}\n\n');
    assert.match(notice.sseGreeting(), /^: studymate connected backend=.*seq=\d+\n\n$/);
  } finally {
    off();
  }
  const before = received.length;
  notice.publishChange(['lesson']);
  assert.equal(received.length, before, '退订之后不再收');
});

test('一个订阅端抛异常不影响别的订阅端，也不把异常扔回监听回调', () => {
  notice.resetNoticeBusForTests();
  const seen = [];
  const offBad = notice.subscribeNotices(() => { throw new Error('这条连接坏了'); });
  const offGood = notice.subscribeNotices((one) => seen.push(one));
  try {
    assert.doesNotThrow(() => notice.publishChange(['lesson']));
    assert.equal(seen.length, 1);
  } finally {
    offBad();
    offGood();
  }
});
