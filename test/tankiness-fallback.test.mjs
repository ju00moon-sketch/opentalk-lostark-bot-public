import test from 'node:test';
import assert from 'node:assert/strict';
import {execute} from '../src/commands/tankiness.js';

test('the tankiness command remains useful without redistributing a chart image', async () => {
  const replies = [];
  await execute({reply: async value => replies.push(value)});
  assert.equal(replies.length, 1);
  assert.match(replies[0], /직업별 체방/);
  assert.match(replies[0], /워로드\s+2\.50/);
  assert.match(replies[0], /브레이커\s+2\.11/);
  assert.match(replies[0], /수치가 높을수록 단단/);
});
