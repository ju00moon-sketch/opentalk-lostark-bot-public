import test from 'node:test';
import assert from 'node:assert/strict';
import { createArkgridRosterService } from '../src/arkgrid-roster.js';

const row = (CharacterName, ItemAvgLevel, ServerName = '루페온') => ({ CharacterName, ServerName, ItemAvgLevel });

test('a gear-less expedition character (0.00) is left out instead of failing the roster board', async () => {
  const grids = [];
  const getRoster = createArkgridRosterService({
    readSiblings: async () => [row('본캐', '1,740.83'), row('장비없는캐릭터', '0.00'), row('부캐', '1,600.00')],
    readGrid: async name => { grids.push(name); return { Slots: [{ Index: 0, Grade: '고대', Point: 20 }] }; },
  });
  const board = await getRoster('본캐');
  assert.deepEqual(board.characters.map(character => character.name), ['본캐', '부캐']);
  assert.deepEqual(grids.sort(), ['본캐', '부캐']);
});

test('an unreadable item level still rejects the roster board', async () => {
  const getRoster = createArkgridRosterService({ readSiblings: async () => [row('본캐', '1,740.83'), row('이상한캐릭터', '레벨없음')], readGrid: async () => ({ Slots: [] }) });
  await assert.rejects(getRoster('본캐'), /원정대 목록을 확인할 수 없어요/);
});
