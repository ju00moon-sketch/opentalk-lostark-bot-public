import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, QUIP_MODEL_DEFAULT } from '../src/quip.js';

// 짧은 문장 생성은 200토큰을 추론에 쓰지 않도록 none을 받는 모델에만 추론을 끈다.
test('quip requests turn reasoning off only for models that accept none', () => {
  const effort = (model) => buildRequest({ model, topic: '주제' }).reasoning?.effort;
  assert.equal(QUIP_MODEL_DEFAULT, 'gpt-6-luna');
  assert.equal(buildRequest({ topic: '주제' }).model, 'gpt-6-luna');
  for (const model of ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.4-mini']) {
    assert.equal(effort(model), 'none', model);
  }
  for (const model of ['gpt-6-astra', 'gpt-4.1-mini']) assert.equal(effort(model), undefined, model);
  assert.ok(!('reasoning' in buildRequest({ provider: 'anthropic', topic: '주제' })));
});
