import test from 'node:test';
import assert from 'node:assert/strict';
import { clientInternals } from './fixtures/client_harness.mjs';
const { codeTermRanges, codeReferenceFor } = clientInternals();

test('代码解释只匹配完整名称，保留多次出现的位置', () => {
  assert.deepEqual(codeTermRanges('models models2 my_models models', 'models'), [[0, 6], [25, 31]]);
  assert.deepEqual(codeTermRanges('模型 模型库', '模型'), [[0, 2]]);
  assert.deepEqual(codeTermRanges('anything', ''), []);
});
test('支持带括号的方法名、点号路径与带符号的参数', () => {
  assert.deepEqual(codeTermRanges('client.query_points(q)', 'query_points()'), [[7, 19]]);
  assert.deepEqual(codeTermRanges('result.points[0]', 'result.points'), [[0, 13]]);
  assert.deepEqual(codeTermRanges('limit=2, limit=20', 'limit=2'), [[0, 7]]);
});
test('从同小节的已有示例中选最近的匹配，跳过终端输出', () => {
  const old = { type: 'code', line: 2, lang: 'py', code: 'models.VectorParams()' };
  const near = { type: 'code', line: 8, lang: 'py', code: 'models.PointStruct()\nmodels.PointStruct()' };
  const output = { type: 'code', line: 12, lang: 'term', code: 'models output' };
  const found = codeReferenceFor([old, near, output], 'models');
  assert.equal(found.block, near);
  assert.deepEqual(found.hits, [0, 1]);
  assert.equal(codeReferenceFor([old], 'model'), null);
  assert.equal(codeReferenceFor([], 'models'), null);
});
