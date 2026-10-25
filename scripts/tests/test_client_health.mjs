/* PR 2：阅读端健康横幅的特征化测试。
   `/health` 的报告形状由 test_doctor.mjs 钉住；这里只钉阅读端如何把报告压成横幅等级，
   以及 FAIL / WARN / 不可用三种情况分别说什么。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clientInternals, renderWithState } from './fixtures/client_harness.mjs';

const internals = clientInternals();
const { healthVerdict, healthMessage, HealthBanner } = internals;

test('healthVerdict：ok / warn / fail / unavailable 四态', () => {
  assert.equal(healthVerdict({ ok: true, checks: [{ status: 'ok' }] }), 'ok');
  assert.equal(healthVerdict({ ok: true, checks: [{ status: 'warn', message: '没有 sh' }] }), 'warn');
  assert.equal(healthVerdict({ ok: false, checks: [{ status: 'fail', message: '配置坏了' }] }), 'fail');
  assert.equal(healthVerdict(null), 'unavailable');
  assert.equal(healthVerdict({}), 'ok');
});

test('healthMessage：只取第一个同等级检查的原文，不自己改写', () => {
  const body = {
    ok: false,
    checks: [
      { status: 'warn', message: '警告一' },
      { status: 'fail', message: '阻断一' },
      { status: 'fail', message: '阻断二' },
    ],
  };
  assert.equal(healthMessage(body, 'fail'), '阻断一');
  assert.equal(healthMessage(body, 'warn'), '警告一');
  assert.equal(healthMessage(body, 'unavailable'), '');
});

test('HealthBanner：FAIL 显示阻断原文与复制诊断，且不可关闭', () => {
  const text = renderWithState(HealthBanner, {
    health: {
      status: 'fail',
      body: { ok: false, checks: [{ status: 'fail', message: '配置存在，但读不出来' }] },
      error: '',
      reload: () => {},
    },
  }, [false, false]);
  assert.match(text, /学习环境检查未通过/);
  assert.match(text, /配置存在，但读不出来/);
  assert.match(text, /复制诊断/);
  assert.doesNotMatch(text, /关闭/);
});

test('HealthBanner：WARN 显示提示，并可关闭', () => {
  const text = renderWithState(HealthBanner, {
    health: {
      status: 'warn',
      body: { ok: true, checks: [{ status: 'warn', message: '没有找到 sh' }] },
      error: '',
      reload: () => {},
    },
  }, [false, false]);
  assert.match(text, /学习环境有提示/);
  assert.match(text, /没有找到 sh/);
  assert.match(text, /关闭/);
});

test('HealthBanner：请求失败显示可读错误，并保留重试', () => {
  const text = renderWithState(HealthBanner, {
    health: { status: 'unavailable', body: null, error: '连不上 /health', reload: () => {} },
  }, [false, false]);
  assert.match(text, /无法读取健康检查/);
  assert.match(text, /连不上 \/health/);
  assert.match(text, /重试/);
  assert.match(text, /关闭/);
});

test('HealthBanner：loading / ok / 已关闭时不渲染', () => {
  const hidden = renderWithState(HealthBanner, {
    health: { status: 'warn', body: { checks: [{ status: 'warn', message: 'x' }] }, error: '', reload: () => {} },
  }, [true, false]);
  assert.equal(hidden, '');
  assert.equal(renderWithState(HealthBanner, { health: { status: 'ok', body: {}, error: '' } }, [false, false]), '');
  assert.equal(renderWithState(HealthBanner, { health: { status: 'missing', body: null, error: '' } }, [false, false]), '');
  assert.equal(renderWithState(HealthBanner, { health: { status: 'loading', body: null, error: '' } }, [false, false]), '');
});
