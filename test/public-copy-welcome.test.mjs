import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhone} from './helpers/messengerbot-phone.mjs';
import {formatWelcome} from '../src/kakao/welcome.js';

test('a configured room greeting uses the observed room label without a private-room override', () => {
  const roomId = '12345000000000001';
  const botId = '12345000000000002';
  const p = createPhone({allowedRoomIds: [roomId]});
  p.context.WELCOME_ENABLED = true;
  p.context.WELCOME_SEND = true;
  p.context.WELCOME_BOT_ID = botId;
  p.notify({roomId, room: '합성 테스트방', text: '일반 대화'});
  p.context.welcomeReadSnapshot = () => ({version: 1, generation: 'synthetic-run', at: p.time(),
    botId, rooms: [roomId], events: [{roomId, eventId: '101', at: p.time(),
      members: [{id: '12345000000000003', name: '합성회원'}]}], outgoing: []});
  p.context.welcomeConfirm = () => true;
  p.context.pollWelcome();
  assert.deepEqual(p.attempts.map(x => x.text), [formatWelcome('합성회원', '합성 테스트방')]);
});
