import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionReady, distinctVisionModels, visionConnectionStatus } from '../src/modelReadiness.ts';

test('text success never grants vision readiness', () => {
  const connection = { configured: true, tested: true, visionTested: false };
  assert.equal(connectionReady(connection), true);
  assert.equal(connectionReady(connection, 'vision'), false);
  assert.equal(visionConnectionStatus(connection).label, '仅文字测试通过');
  assert.equal(visionConnectionStatus(connection).action, '验证看图');
});

test('missing or expired credentials cannot be made ready by stale test flags', () => {
  assert.equal(connectionReady(undefined, 'vision'), false);
  assert.equal(visionConnectionStatus().label, '连接记录缺失');
  const expired = { configured: false, tested: true, visionTested: true };
  assert.equal(connectionReady(expired), false);
  assert.equal(connectionReady(expired, 'vision'), false);
  assert.equal(visionConnectionStatus(expired).action, '输入 Key');
});

test('valid vision flag is required and provider/model names are not guessed', () => {
  assert.equal(connectionReady({ configured: true, tested: true }, 'vision'), false);
  assert.equal(connectionReady({ configured: true, tested: true, visionTested: true }, 'vision'), true);
  assert.equal(visionConnectionStatus({ configured: true, tested: false }).label, '看图尚未验证');
});

test('different connection names pointing to the same provider/model cannot be paired', () => {
  const first = { id: 'one', name: 'fixture', model: 'model-one', provider: 'fixture-provider', connectionId: 'connection-one', kind: 'external' };
  assert.equal(distinctVisionModels(first, first), false);
  assert.equal(distinctVisionModels(first, { ...first, id: 'alias', name: 'alias', connectionId: 'alias' }), false);
  assert.equal(distinctVisionModels(first, { ...first, id: 'two', model: 'model-two' }), true);
  assert.equal(distinctVisionModels(first, { ...first, id: 'two', provider: 'another-provider' }), true);
  assert.equal(distinctVisionModels(first, undefined), false);
});
