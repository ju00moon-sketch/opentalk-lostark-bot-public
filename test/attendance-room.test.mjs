import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildAttendanceIdentityMigration, buildAttendanceRoomMigration, checkIn, getAttendanceStatus,
  normalizeAttendanceStore, validateAttendanceRoomIdentity,
} from '../src/attendance.js';

const SOURCE = 'android-conversation-shortcut-v1';
const roomIdentity = { source: SOURCE, roomId: 'opaque-room-one' };
const anotherIdentity = { source: SOURCE, roomId: 'opaque-room-two' };
const userId = 'kakao:oc:회원';
const today = () => Date.parse('2026-09-16T00:00:01+09:00');
const options = { roomName: '포', roomIdentity, now: today, random: () => 0.99 };
const oldStore = () => ({
  version: 2,
  rooms: { 포근은행: { [userId]: { name: '회원', points: 31, count: 12, last: '2026-09-15' } } },
  legacy: { original: { points: 5, count: 3, last: '2026-08-01' } },
});
const migratedStore = () => buildAttendanceRoomMigration(oldStore(), { ...roomIdentity, storageRoom: '포근은행' });

function fixture(t, data = migratedStore()) {
  const directory = mkdtempSync(join(tmpdir(), 'attendance-room-'));
  const storePath = join(directory, 'attendance.json');
  writeFileSync(storePath, JSON.stringify(data));
  t.after(() => {
    for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
    rmdirSync(directory);
  });
  return {
    storePath,
    options: { ...options, storePath },
    read: () => JSON.parse(readFileSync(storePath, 'utf8')),
    raw: () => readFileSync(storePath, 'utf8'),
  };
}

test('explicit room migration preserves every existing room, member and legacy field without mutating input', () => {
  const original = oldStore();
  const before = structuredClone(original);
  const migrated = buildAttendanceRoomMigration(original, { ...roomIdentity, storageRoom: '포근은행' });
  assert.deepEqual(original, before);
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.rooms, before.rooms);
  assert.deepEqual(migrated.legacy, before.legacy);
  assert.deepEqual(migrated.roomBindings, { [JSON.stringify([SOURCE, roomIdentity.roomId])]: '포근은행' });
});

test('renaming a bound room keeps monthly totals and duplicate-day protection', (t) => {
  const f = fixture(t);
  assert.equal(getAttendanceStatus('포', f.options).members[0].points, 31);
  assert.deepEqual(checkIn(userId, f.options), { status: 'done', gained: 3, total: 34, count: 13, date: '2026-09-16' });
  const saved = f.raw();
  assert.deepEqual(checkIn(userId, { ...f.options, roomName: '다시 바뀐 이름' }),
    { status: 'already', total: 34, count: 13, date: '2026-09-16' });
  assert.equal(f.raw(), saved);
  assert.equal(getAttendanceStatus('다시 바뀐 이름', f.options).members[0].points, 34);
  assert.deepEqual(Object.keys(f.read().rooms), ['포근은행']);
});

test('a month change still resets only the attending member monthly total', (t) => {
  const f = fixture(t);
  const nextMonth = { ...f.options, now: () => Date.parse('2026-10-01T00:00:01+09:00') };
  assert.equal(getAttendanceStatus('포', nextMonth).members.length, 0);
  assert.equal(f.read().rooms.포근은행[userId].points, 31);
  assert.deepEqual(checkIn(userId, nextMonth), { status: 'done', gained: 3, total: 3, count: 1, date: '2026-10-01' });
});

test('nickname member keys remain separate while room identity survives title changes', (t) => {
  const f = fixture(t);
  const result = checkIn('kakao:oc:새 이름', { ...f.options, name: '새 이름' });
  assert.equal(result.total, 3);
  const members = getAttendanceStatus('포', f.options).members;
  assert.equal(members.length, 2);
  assert.equal(members.find((member) => member.userId === userId).points, 31);
});

test('unknown identities never auto-link to a same-name existing room', (t) => {
  const f = fixture(t);
  const before = f.raw();
  const unknown = { ...f.options, roomName: '포근은행', roomIdentity: anotherIdentity };
  assert.throws(() => checkIn(userId, unknown), { code: 'ROOM_LINK_REQUIRED' });
  assert.throws(() => getAttendanceStatus('포근은행', unknown), { code: 'ROOM_LINK_REQUIRED' });
  assert.equal(f.raw(), before);
});

test('a new room uses its stable key and cannot share another room totals through equal display names', (t) => {
  const f = fixture(t);
  const separate = { ...f.options, roomIdentity: anotherIdentity };
  const before = f.raw();
  assert.equal(getAttendanceStatus('포', separate).members.length, 0);
  assert.equal(f.raw(), before);
  assert.equal(checkIn(userId, separate).total, 3);
  assert.equal(getAttendanceStatus('포', f.options).members[0].points, 31);
  assert.equal(getAttendanceStatus('또 바뀐 제목', separate).members[0].points, 3);
  const key = JSON.stringify([SOURCE, anotherIdentity.roomId]);
  assert.equal(f.read().roomBindings[key], key);
});

test('missing or invalid room identities fail reads and writes without changing stored data', (t) => {
  const f = fixture(t);
  const before = f.raw();
  for (const invalid of [undefined, null, {}, { source: SOURCE, roomId: ' ' },
    { source: SOURCE, roomId: 'line\nfeed' }, { source: SOURCE, roomId: 'x'.repeat(513) },
    { source: 'android-person-key-v1', roomId: 'opaque-room-one', userId: 'member' }]) {
    const invalidOptions = { ...f.options, roomIdentity: invalid };
    assert.throws(() => checkIn(userId, invalidOptions), { code: 'ROOM_IDENTITY_REQUIRED' });
    assert.throws(() => getAttendanceStatus('포', invalidOptions), { code: 'ROOM_IDENTITY_REQUIRED' });
  }
  assert.equal(f.raw(), before);
});

test('opaque room identifiers retain whitespace and accept the same 512-character boundary as person identifiers', () => {
  const opaque = ` ${'x'.repeat(510)} `;
  assert.equal(validateAttendanceRoomIdentity({ source: SOURCE, roomId: opaque }).roomKey, JSON.stringify([SOURCE, opaque]));
  assert.throws(() => validateAttendanceRoomIdentity({ source: SOURCE, roomId: 'x'.repeat(513) }), { code: 'ROOM_IDENTITY_REQUIRED' });
});

test('malformed, dangling or duplicate room bindings are rejected', () => {
  const original = migratedStore();
  const key = JSON.stringify([SOURCE, roomIdentity.roomId]);
  const otherKey = JSON.stringify([SOURCE, anotherIdentity.roomId]);
  for (const roomBindings of [null, [], { bad: '포근은행' }, { [key]: 'missing' }, { [key]: null },
    { [key]: '포근은행', [otherKey]: '포근은행' }]) {
    assert.throws(() => normalizeAttendanceStore({ ...original, roomBindings }), { name: 'CorruptStoreError' });
  }
});

test('room migration rejects reassignments and cannot replace a person-identity store', () => {
  const original = migratedStore();
  original.rooms['다른 방'] = {};
  const before = structuredClone(original);
  for (const mapping of [{ ...roomIdentity, storageRoom: '다른 방' },
    { ...anotherIdentity, storageRoom: '포근은행' }, { ...anotherIdentity, storageRoom: '없는 방' }]) {
    assert.throws(() => buildAttendanceRoomMigration(original, mapping), { code: 'IDENTITY_CONFLICT' });
  }
  assert.deepEqual(original, before);
  assert.throws(() => buildAttendanceRoomMigration({ version: 3, rooms: {}, legacy: {}, stableRooms: {} },
    { ...roomIdentity, storageRoom: '포근은행' }), { code: 'IDENTITY_CONFLICT' });
  assert.throws(() => buildAttendanceIdentityMigration(original, {
    source: 'android-person-key-v1', roomId: 'room', roomName: '포근은행', legacyRoom: '포근은행', links: [], enroll: [],
  }), { code: 'IDENTITY_CONFLICT' });
});

test('v2 preserves existing title-based behavior until an explicit migration', (t) => {
  const f = fixture(t, oldStore());
  assert.equal(checkIn(userId, { ...f.options, roomName: '포근은행', roomIdentity: null }).total, 34);
  assert.equal(f.read().version, 2);
  assert.equal(getAttendanceStatus('포', { ...f.options, roomIdentity: null }).members.length, 0);
});

test('v3 retains the existing stable person identity contract', (t) => {
  const identity = { source: 'android-person-key-v1', roomId: 'old-stable-room', userId: 'old-stable-user' };
  const roomKey = JSON.stringify([identity.source, identity.roomId]);
  const memberKey = JSON.stringify([identity.source, identity.userId]);
  const f = fixture(t, { version: 3, rooms: {}, legacy: {}, stableRooms: {
    [roomKey]: { name: '기존 방', legacyRoom: null, links: {}, members: {
      [memberKey]: { name: '회원', points: 31, count: 12, last: '2026-09-15' },
    } },
  } });
  assert.equal(checkIn(userId, { ...f.options, identity, roomIdentity: null }).total, 34);
  assert.equal(getAttendanceStatus('다른 제목', { ...f.options, identity, roomIdentity: null }).members[0].points, 34);
  assert.equal(f.read().version, 3);
});

test('room-bound writes retain the shared migration lock', (t) => {
  const f = fixture(t);
  const before = f.raw();
  writeFileSync(`${f.storePath}.identity-lock`, '');
  assert.throws(() => checkIn(userId, f.options), { code: 'MIGRATION_IN_PROGRESS' });
  assert.equal(f.raw(), before);
  assert.equal(getAttendanceStatus('포', f.options).members[0].points, 31);
});
