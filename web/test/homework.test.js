import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createStore } from '../src/store.js';
import { CHECK_LIMIT, HOMEWORK_BODY_LIMIT, createHomeworkStore } from '../src/homework-store.js';
import { DatabaseSync } from 'node:sqlite';
import { createWebServer } from '../src/server.js';
import { verifyOwnership } from './helpers/access.js';
import { CHARACTER_LIMIT, DAILY, RAID_CATALOGUE, RAID_LIMIT, WEEKLY, autoRaids, autoSelection, dailyPeriod, fillRaids, nextReset, raidId, sortRaids,
  weeklyPeriod } from '../../src/data/homework.js';

// 숙제표: 표에 올릴 캐릭터와 캐릭터별 주간 레이드를 고르고, 지금 주기의 체크만 보관한다.
const origin = 'https://opentalk.example.invalid';
const hash = value => createHash('sha256').update(value).digest('hex');
const wednesday = Date.parse('2026-09-16T10:00:00+09:00');
const sunday = Date.parse('2026-09-20T14:00:00+09:00');
const nextWednesday = Date.parse('2026-09-23T10:00:00+09:00');
const row = (name, server = '루페온', level = '1,740.00') => ({ CharacterName: name, ServerName: server, CharacterClassName: '바드', ItemAvgLevel: level });
const raid = '벨가르딘|하드';

function member(name, level) {
  return { characterName: name, serverName: '루페온', characterClass: '바드', itemLevel: level };
}

async function directStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'homework-store-'));
  const homework = createHomeworkStore(join(dir, 'auth.sqlite.homework.sqlite'), { now: () => wednesday });
  t.after(async () => { homework.close(); await rm(dir, { recursive: true, force: true }); });
  return { store: { homework }, userId: 'user-1' };
}

test('the board keeps the chosen characters and their raids, and drops what is taken off the table', async (t) => {
  const { store, userId } = await directStore(t);
  const saved = store.homework.saveCharacters(userId, [
    { ...member('본캐', 1770), raids: [raid, '세르카|하드'] },
    { ...member('부캐', 1700), raids: [] },
  ], sunday);
  assert.deepEqual(saved.characters.map(entry => entry.characterName), ['본캐', '부캐']);
  assert.deepEqual(saved.characters[0].raids, [raid, '세르카|하드']);
  // 갈 수 없는 레이드나 세 개를 넘는 선택, 같은 캐릭터 중복은 받지 않는다.
  for (const broken of [
    [{ ...member('부캐', 1700), raids: [raid] }],
    [{ ...member('본캐', 1770), raids: [raid, '세르카|하드', '세르카|노말', '종막: 최후의 날|노말'] }],
    [{ ...member('본캐', 1770), raids: [] }, { ...member('본캐', 1770), raids: [] }],
    [{ ...member('본캐', 1770), raids: ['없는 레이드|하드'] }],
  ]) assert.throws(() => store.homework.saveCharacters(userId, broken, sunday), { code: 'invalid_request' });

  store.homework.applyChecks(userId, [
    { characterName: '본캐', scope: 'daily', itemId: 'chaos', value: 2 },
    { characterName: '본캐', scope: 'weekly', itemId: `${raid}|0`, value: 1 },
    { characterName: '부캐', scope: 'daily', itemId: 'epona', value: 3 },
  ], sunday);
  assert.equal(store.homework.board(userId, sunday).characters[0].daily.chaos, 2);
  // 표에서 뺀 캐릭터의 체크는 남지 않는다.
  const trimmed = store.homework.saveCharacters(userId, [{ ...member('본캐', 1770), raids: [raid] }], sunday);
  assert.equal(trimmed.characters.length, 1);
  assert.equal(trimmed.characters[0].weekly[`${raid}|0`], 1);
  store.homework.saveCharacters(userId, [{ ...member('본캐', 1770), raids: [raid] }, { ...member('부캐', 1700), raids: [] }], sunday);
  assert.deepEqual(store.homework.board(userId, sunday).characters[1].daily, {});
});

test('checks belong to one reset period and only to a raid the character actually picked', async (t) => {
  const { store, userId } = await directStore(t);
  store.homework.saveCharacters(userId, [{ ...member('본캐', 1770), raids: [raid] }], wednesday);
  store.homework.applyChecks(userId, [
    { characterName: '본캐', scope: 'daily', itemId: 'guardian', value: 1 },
    { characterName: '본캐', scope: 'weekly', itemId: `${raid}|1`, value: 1 },
    { characterName: '본캐', scope: 'weekly', itemId: `${raid}|1|bonus`, value: 1 },
    { characterName: '본캐', scope: 'weekly', itemId: 'cube', value: 1 },
  ], wednesday);
  const sameWeek = store.homework.board(userId, sunday).characters[0];
  // 같은 주의 일요일: 일일은 이미 지나 비고 주간은 남아 있다.
  assert.deepEqual(sameWeek.daily, {});
  assert.equal(sameWeek.weekly[`${raid}|1`], 1);
  assert.equal(sameWeek.weekly[`${raid}|1|bonus`], 1);
  assert.equal(sameWeek.weekly.cube, 1);
  // 다음 수요일 06시가 지나면 주간도 새로 시작한다.
  assert.deepEqual(store.homework.board(userId, nextWednesday).characters[0].weekly, {});
  assert.equal(dailyPeriod(wednesday), '2026-09-16');
  assert.equal(weeklyPeriod(sunday), '2026-09-16');
  assert.equal(weeklyPeriod(nextWednesday), '2026-09-23');
  assert.equal(nextReset(sunday, 'weekly'), Date.parse('2026-09-23T06:00:00+09:00'));
  // 고르지 않은 레이드, 없는 관문, 최대를 넘는 값, 없는 캐릭터는 받지 않는다.
  for (const broken of [
    [{ characterName: '본캐', scope: 'weekly', itemId: '세르카|하드|0', value: 1 }],
    [{ characterName: '본캐', scope: 'weekly', itemId: `${raid}|5`, value: 1 }],
    [{ characterName: '본캐', scope: 'daily', itemId: 'chaos', value: 3 }],
    [{ characterName: '본캐', scope: 'daily', itemId: '없는항목', value: 1 }],
    [{ characterName: '본캐', scope: 'weekly', itemId: 'cube', value: -1 }],
  ]) assert.throws(() => store.homework.applyChecks(userId, broken, sunday), { code: 'invalid_request' });
  assert.throws(() => store.homework.applyChecks(userId, [{ characterName: '없는캐릭', scope: 'daily', itemId: 'chaos', value: 1 }], sunday),
    { code: 'homework_character_missing' });
});

test('a roster refresh moves item levels and removes raids the character can no longer enter', async (t) => {
  const { store, userId } = await directStore(t);
  store.homework.saveCharacters(userId, [{ ...member('본캐', 1770), raids: [raid, '세르카|하드'] }], sunday);
  const synced = store.homework.syncLevels(userId, [{ ...member('본캐', 1715), characterClass: '기상술사' }], sunday);
  assert.equal(synced.characters[0].itemLevel, 1715);
  assert.equal(synced.characters[0].characterClass, '기상술사');
  assert.deepEqual(synced.characters[0].raids, [], '1715로는 고른 두 레이드 모두 갈 수 없다');
  // 원정대에 없는 캐릭터는 그대로 둔다(조회 실패와 구분할 수 없으므로 지우지 않는다).
  const kept = store.homework.syncLevels(userId, [], sunday);
  assert.equal(kept.characters.length, 1);
});

test('the homework file keeps its own provenance and a deleted account leaves nothing behind', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'homework-file-'));
  const path = join(dir, 'auth.sqlite.homework.sqlite');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const first = createHomeworkStore(path, { now: () => sunday });
  first.saveCharacters('user-1', [{ ...member('본캐', 1770), raids: [raid] }], sunday);
  first.applyChecks('user-1', [{ characterName: '본캐', scope: 'daily', itemId: 'chaos', value: 1 }], sunday);
  first.saveCharacters('user-2', [{ ...member('남의캐릭', 1700), raids: [] }], sunday);
  first.close();
  // 다시 열어도 같은 기록이고, 탈퇴한 회원의 줄만 사라진다.
  const reopened = createHomeworkStore(path, { now: () => sunday });
  assert.equal(reopened.board('user-1', sunday).characters[0].daily.chaos, 1);
  reopened.forget('user-1');
  assert.deepEqual(reopened.board('user-1', sunday).characters, []);
  assert.equal(reopened.board('user-2', sunday).characters.length, 1);
  reopened.close();
  // 쉼표로 이어 두었던 예전 줄도 그대로 읽고, 자료에 없는 이름만 버린다.
  const legacy = new DatabaseSync(path);
  legacy.exec("UPDATE homework_characters SET raids='벨가르딘|하드,세르카|하드,없는레이드|하드' WHERE user_id='user-2'");
  legacy.close();
  const migrated = createHomeworkStore(path, { now: () => sunday });
  assert.deepEqual(migrated.board('user-2', sunday).characters[0].raids, ['벨가르딘|하드', '세르카|하드']);
  migrated.close();
  // 다른 곳에서 만든 파일은 열지 않는다.
  const foreign = join(dir, 'foreign.homework.sqlite');
  const db = new DatabaseSync(foreign);
  db.exec("CREATE TABLE private_data(value TEXT); PRAGMA user_version=1;");
  db.close();
  assert.throws(() => createHomeworkStore(foreign, { now: () => sunday }), { code: 'homework_unavailable' });
});

test('an old comma-joined line keeps a raid whose own name contains a comma', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'homework-legacy-'));
  const path = join(dir, 'auth.sqlite.homework.sqlite');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const comma = '3막: 칠흑, 폭풍의 밤|하드';
  const first = createHomeworkStore(path, { now: () => sunday });
  first.saveCharacters('user-1', [{ ...member('본캐', 1770), raids: [comma, '세르카|하드'] }], sunday);
  first.close();
  // 예전 구현이 쓰던 모양 그대로 이어 적는다. 전에는 3막이 내부 쉼표에서 잘려 사라졌다.
  const legacy = new DatabaseSync(path);
  legacy.prepare('UPDATE homework_characters SET raids=?').run(`${comma},세르카|하드,없는레이드|하드`);
  legacy.close();
  const migrated = createHomeworkStore(path, { now: () => sunday });
  assert.deepEqual(migrated.board('user-1', sunday).characters[0].raids, sortRaids([comma, '세르카|하드']));
  migrated.close();
});

// 인증 DB에 계정 하나를 만들고 그 회원의 숙제표를 채운다. 탈퇴 경로 시험이 같이 쓴다.
async function accountWithHomework(t, { provider = 'discord', providerId = '4321' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'homework-account-'));
  const path = join(dir, 'auth.sqlite');
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const auth = createStore(path);
  const open = (kind, id, name) => {
    const token = randomBytes(32).toString('base64url');
    auth.createSession({ provider: kind, providerId: id, displayName: name, tokenHash: hash(token), expiresAt: sunday + 86_400_000, epoch: 0 }, sunday);
    return { ...auth.getSession(hash(token), sunday), token };
  };
  const account = open(provider, providerId, '탈퇴할 회원');
  const staying = open('discord', '9999', '남는 회원');
  auth.close();
  const homework = createHomeworkStore(`${path}.homework.sqlite`, { now: () => sunday });
  homework.saveCharacters(account.id, [{ ...member('본캐', 1770), raids: [raid] }], sunday);
  homework.applyChecks(account.id, [{ characterName: '본캐', scope: 'daily', itemId: 'chaos', value: 2 }], sunday);
  homework.saveCharacters(staying.id, [{ ...member('남의캐릭', 1700), raids: [] }], sunday);
  homework.close();
  // kakao: 카카오 쪽 연결 해제 알림을 받을 수 있게 앱 키까지 넣고 켠다.
  const start = async ({ kakao = false } = {}) => {
    const providers = kakao ? { kakao: { clientId: 'kakao-test-client', clientSecret: 'kakao-test-secret', adminKey: 'kakao-admin-secret', appId: '123456' } } : {};
    const service = createWebServer({ config: { origin, host: '127.0.0.1', port: 0, dbPath: path, providers }, now: () => sunday });
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    return service;
  };
  const leftover = () => {
    const reopened = createHomeworkStore(`${path}.homework.sqlite`, { now: () => sunday });
    try { return { gone: reopened.board(account.id, sunday).characters, kept: reopened.board(staying.id, sunday).characters }; }
    finally { reopened.close(); }
  };
  return { path, account, start, leftover };
}

test('leaving the website with a Discord account also clears the homework board', async (t) => {
  const { account, start, leftover } = await accountWithHomework(t);
  const service = await start();
  try {
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/account`, { method: 'DELETE', headers: {
      Cookie: `__Host-web_session=${account.token}`, Origin: origin,
      'X-CSRF-Token': createHash('sha256').update(`web-csrf:${account.token}`).digest('base64url') } });
    assert.equal(response.status, 204);
  } finally { await service.close(); }
  const { gone, kept } = leftover();
  assert.deepEqual(gone, [], '탈퇴한 회원의 캐릭터와 체크가 남지 않는다');
  assert.equal(kept.length, 1, '다른 회원의 숙제표는 그대로다');
});

const deleteAccount = (service, account) => fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/account`, { method: 'DELETE', headers: {
  Cookie: `__Host-web_session=${account.token}`, Origin: origin,
  'X-CSRF-Token': createHash('sha256').update(`web-csrf:${account.token}`).digest('base64url') } });
const kakaoUnlink = (service, providerId) => fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/kakao/unlink`, { method: 'POST',
  headers: { Authorization: 'KakaoAK kakao-admin-secret', 'Content-Type': 'application/x-www-form-urlencoded' }, body: `app_id=123456&user_id=${providerId}` });
const kakaoAccounts = (path, providerId) => { const auth = createStore(path); try { return auth.kakaoAccountIds(providerId); } finally { auth.close(); } };

test('an auth file that went missing and was created again erases nobody\'s homework', async (t) => {
  // 인증 파일만 없어져 서버가 새로 만든 경우다. 탈퇴 요청이 없었으므로 숙제표는 그대로여야 한다 — 계정 행이 없다는
  // 사실만으로 지우면 파일 사고 하나로 모든 회원의 숙제표가 사라진다(2026-09-23 교차 검토 B-R1).
  const { path, start, leftover } = await accountWithHomework(t);
  await rm(path);
  const service = await start();
  await service.close();
  const { gone, kept } = leftover();
  assert.equal(gone.length, 1, '인증 파일 사고는 탈퇴가 아니다');
  assert.equal(kept.length, 1);
});

test('an unlink sent from Kakao clears that member\'s homework board before the account', async (t) => {
  const { path, start, leftover } = await accountWithHomework(t, { provider: 'kakao', providerId: '777' });
  const service = await start({ kakao: true });
  try { assert.equal((await kakaoUnlink(service, '777')).status, 200); }
  finally { await service.close(); }
  const { gone, kept } = leftover();
  assert.deepEqual(gone, []);
  assert.equal(kept.length, 1, '다른 회원의 숙제표는 그대로다');
  assert.deepEqual(kakaoAccounts(path, '777'), []);
});

test('a homework board that cannot be cleared keeps the Discord account until leaving is tried again', async (t) => {
  const { path, account, start, leftover } = await accountWithHomework(t);
  const service = await start();
  const lock = new DatabaseSync(`${path}.homework.sqlite`);
  try {
    lock.exec('BEGIN EXCLUSIVE');
    assert.equal((await deleteAccount(service, account)).status, 503, '숙제표를 지우지 못하면 계정도 지우지 않는다');
    lock.exec('ROLLBACK');
    assert.equal(leftover().gone.length, 1);
    assert.equal((await deleteAccount(service, account)).status, 204, '같은 세션으로 다시 탈퇴할 수 있다');
  } finally { lock.close(); await service.close(); }
  const { gone, kept } = leftover();
  assert.deepEqual(gone, []);
  assert.equal(kept.length, 1);
});

test('a Kakao unlink whose homework cannot be cleared stays queued and finishes on the next pass', async (t) => {
  const { path, start, leftover } = await accountWithHomework(t, { provider: 'kakao', providerId: '777' });
  let service = await start({ kakao: true });
  const lock = new DatabaseSync(`${path}.homework.sqlite`);
  try {
    lock.exec('BEGIN EXCLUSIVE');
    assert.equal((await kakaoUnlink(service, '777')).status, 200, '요청은 저장했으므로 카카오에는 받았다고 답한다');
    lock.exec('ROLLBACK');
    assert.equal(kakaoAccounts(path, '777').length, 1, '숙제표를 지우기 전에는 계정을 남긴다');
    assert.equal(leftover().gone.length, 1);
  } finally { lock.close(); await service.close(); }
  service = await start({ kakao: true }); // 저장된 요청은 서버가 켜질 때와 그 뒤 1분마다 다시 처리한다.
  await service.close();
  const { gone, kept } = leftover();
  assert.deepEqual(gone, []);
  assert.equal(kept.length, 1);
  assert.deepEqual(kakaoAccounts(path, '777'), []);
});

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'homework-http-'));
  const path = join(dir, 'auth.sqlite');
  const store = createStore(path);
  const accounts = {};
  for (const [index, name] of ['owner', 'member', 'outsider'].entries()) {
    const token = randomBytes(32).toString('base64url');
    store.createSession({ provider: 'discord', providerId: String(9200 + index), displayName: `회원 ${name}`, tokenHash: hash(token), expiresAt: sunday + 86_400_000, epoch: 0 }, sunday);
    accounts[name] = { ...store.getSession(hash(token), sunday), token };
  }
  store.guild.bootstrapOwner(accounts.owner.id, sunday);
  verifyOwnership(store, accounts.member, '인증한바드', sunday);
  store.guild.apply(accounts.member.id, '인증한바드', sunday);
  store.guild.review(accounts.owner.id, accounts.member.id, 'approved', 1, sunday);
  store.close();
  const roster = [
    row('인증한바드', '루페온', '1,770.00'), row('둘째바드', '루페온', '1,755.00'), row('셋째바드', '루페온', '1,740.00'),
    row('넷째바드', '루페온', '1,725.00'), row('다섯바드', '루페온', '1,715.00'), row('여섯바드', '루페온', '1,705.00'),
    row('부캐바드', '루페온', '1,700.00'), row('일곱바드', '루페온', '1,690.00'),
  ];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/siblings')) return Response.json(roster);
    throw new Error(`Unexpected external request ${url.pathname}`);
  };
  const service = createWebServer({ config: { origin, host: '127.0.0.1', port: 0, dbPath: path,
    providers: { kakao: { adminKey: 'private-test-key', appId: '12345' } },
    automaticApproval: { enabled: false, lostArkApiKey: 'synthetic-key' } }, now: () => sunday, fetchImpl });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (account, path = '/api/auth/homework', payload) => fetch(`http://127.0.0.1:${service.server.address().port}${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      ...(account ? { Cookie: `__Host-web_session=${account.token}` } : {}),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': createHash('sha256').update(`web-csrf:${account.token}`).digest('base64url') }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { accounts, request };
}

test('an approved member builds the board from their own roster and nobody else can touch it', async (t) => {
  const { accounts, request } = await setup(t);
  assert.equal((await request(null)).status, 401);
  assert.equal((await request(accounts.outsider)).status, 403);

  const first = await request(accounts.member);
  assert.equal(first.status, 200);
  const empty = await first.json();
  assert.deepEqual(empty.characters, []);
  assert.equal(empty.roster.length, 8);
  assert.equal(empty.roster[0].characterName, '인증한바드');
  assert.equal(empty.limits.auto, 6);
  assert.deepEqual(empty.daily.map(item => item.id), ['chaos', 'guardian', 'epona']);
  assert.ok(empty.raids.some(entry => entry.id === raid && entry.gates.length === 2));
  assert.equal(empty.resets.weekly, Date.parse('2026-09-23T06:00:00+09:00'));

  const saved = await request(accounts.member, '/api/auth/homework/characters',
    { characters: [{ characterName: '인증한바드', raids: [raid] }, { characterName: '부캐바드', raids: [] }] });
  assert.equal(saved.status, 200);
  const board = await saved.json();
  assert.deepEqual(board.characters.map(entry => entry.characterName), ['인증한바드', '부캐바드']);
  assert.equal(board.characters[0].itemLevel, 1770);

  const checked = await request(accounts.member, '/api/auth/homework/check',
    { changes: [{ characterName: '인증한바드', scope: 'weekly', itemId: `${raid}|0`, value: 1 }, { characterName: '인증한바드', scope: 'daily', itemId: 'chaos', value: 1 }] });
  assert.equal(checked.status, 200);
  const after = await checked.json();
  assert.equal(after.characters[0].weekly[`${raid}|0`], 1);
  assert.equal(after.characters[0].daily.chaos, 1);

  // 원정대에 없는 캐릭터, 어긋난 본문, 다른 사람의 표는 받지 않는다.
  assert.equal((await request(accounts.member, '/api/auth/homework/characters', { characters: [{ characterName: '남의캐릭터', raids: [] }] })).status, 422);
  assert.equal((await request(accounts.member, '/api/auth/homework/check', { changes: [{ characterName: '인증한바드', scope: 'weekly', itemId: 'cube', value: 9 }] })).status, 400);
  assert.equal((await request(accounts.member, '/api/auth/homework/check', { wrong: [] })).status, 400);
  assert.equal((await request(accounts.outsider, '/api/auth/homework/check', { changes: [] })).status, 403);
  const withQuery = await request(accounts.member, '/api/auth/homework?all=1');
  assert.equal(withQuery.status, 400);
});

test('the automatic pick takes the best three raids a character can enter, one difficulty per raid', () => {
  // 같은 레이드의 다른 난이도는 함께 고르지 않고, 클리어 골드가 큰 순서로 세 개만 고른다.
  assert.deepEqual(autoRaids(1770), ['벨가르딘|하드', '세르카|나이트메어', '지평의 성당|3단계']);
  assert.deepEqual(autoRaids(1750), ['세르카|나이트메어', '벨가르딘|노말', '지평의 성당|3단계']);
  assert.deepEqual(autoRaids(1600), []);
  assert.equal(autoRaids(1770, 1).length, 1);
  const roster = [['본캐', 1770], ['둘째', 1750], ['셋째', 1740], ['넷째', 1730], ['다섯', 1720], ['여섯', 1710], ['일곱', 1700]]
    .map(([characterName, itemLevel]) => ({ characterName, itemLevel, serverName: '루페온', characterClass: '바드' }));
  // 빈 표는 레벨 높은 여섯 명까지, 각자 레이드 세 개.
  const fresh = autoSelection(roster);
  assert.deepEqual(fresh.map(entry => entry.characterName), ['본캐', '둘째', '셋째', '넷째', '다섯', '여섯']);
  assert.ok(fresh.every(entry => entry.raids.length === 3));
  // 직접 고른 레이드는 그대로 두고 세 개까지 채운다. 같은 레이드의 다른 난이도는 더하지 않는다.
  // 돌려주는 목록은 고른 순서가 아니라 클리어 골드가 큰 순서다(세르카 하드 44,000 < 벨가르딘 노말 50,000).
  assert.deepEqual(fillRaids(1750, ['세르카|하드']), ['벨가르딘|노말', '지평의 성당|3단계', '세르카|하드']);
  assert.deepEqual(sortRaids(['지평의 성당|3단계', '세르카|나이트메어', '벨가르딘|하드']),
    ['벨가르딘|하드', '세르카|나이트메어', '지평의 성당|3단계']);
  assert.deepEqual(sortRaids(['없는 레이드|하드', '세르카|노말']), ['세르카|노말']);
  // 고르는 목록도 골드가 큰 순서로 내려간다.
  assert.deepEqual(RAID_CATALOGUE.slice(0, 3).map(raid => `${raid.name} ${raid.diff}`),
    ['벨가르딘 나이트메어', '벨가르딘 하드', '세르카 나이트메어']);
  // 그 레벨로 못 가는 레이드는 빠지고 대신 채워진다.
  assert.deepEqual(fillRaids(1750, ['벨가르딘|하드']), autoRaids(1750));
  // 이미 올린 캐릭터는 그대로 두고 레이드를 세 개까지 채우며, 여섯 캐릭터가 되도록 레벨 높은 순으로 더 올린다.
  const filled = autoSelection(roster, [{ characterName: '일곱', raids: [] }, { characterName: '둘째', raids: ['세르카|하드'] }]);
  assert.deepEqual(filled.map(entry => entry.characterName), ['일곱', '둘째', '본캐', '셋째', '넷째', '다섯']);
  assert.ok(filled.every(entry => entry.raids.length === 3));
  assert.deepEqual(filled[1].raids, ['벨가르딘|노말', '지평의 성당|3단계', '세르카|하드']);
  // 원정대에 없는 이름은 빠진다.
  assert.deepEqual(autoSelection(roster, [{ characterName: '사라진캐릭', raids: [] }]).map(entry => entry.characterName),
    ['본캐', '둘째', '셋째', '넷째', '다섯', '여섯']);
  // 이미 여섯 명보다 많으면 더 올리지 않는다.
  assert.equal(autoSelection(roster, roster.map(entry => ({ characterName: entry.characterName, raids: [] }))).length, 7);
});

test('the website builds a board automatically and later tops up the raids that are missing', async (t) => {
  const { accounts, request } = await setup(t);
  const built = await request(accounts.member, '/api/auth/homework/auto', {});
  assert.equal(built.status, 200);
  const board = await built.json();
  assert.deepEqual(board.characters.map(entry => entry.characterName),
    ['인증한바드', '둘째바드', '셋째바드', '넷째바드', '다섯바드', '여섯바드']);
  assert.deepEqual(board.characters[0].raids, ['벨가르딘|하드', '세르카|나이트메어', '지평의 성당|3단계']);
  assert.ok(board.characters.every(entry => entry.raids.length === 3));
  // 이름에 쉼표가 든 레이드도 한 덩어리로 저장되고 그대로 돌아온다.
  assert.deepEqual(board.characters[5].raids, ['지평의 성당|1단계', '3막: 칠흑, 폭풍의 밤|하드', '4막: 파멸의 성채|노말']);

  // 한 캐릭터는 비우고 다른 캐릭터는 하나만 남긴 뒤 다시 부르면 둘 다 세 개로 채우고 명단은 그대로다.
  const trimmed = board.characters.map(entry => ({ characterName: entry.characterName, raids: entry.raids }));
  trimmed[2].raids = [];
  trimmed[3].raids = trimmed[3].raids.slice(0, 1);
  const cleared = await (await request(accounts.member, '/api/auth/homework/characters', { characters: trimmed })).json();
  assert.equal(cleared.characters[2].raids.length, 0);
  assert.equal(cleared.characters[3].raids.length, 1);
  const refilled = await (await request(accounts.member, '/api/auth/homework/auto', {})).json();
  assert.deepEqual(refilled.characters.map(entry => entry.characterName),
    ['인증한바드', '둘째바드', '셋째바드', '넷째바드', '다섯바드', '여섯바드']);
  assert.ok(refilled.characters.every(entry => entry.raids.length === 3));
  assert.ok(refilled.characters[3].raids.includes(trimmed[3].raids[0]));
  assert.deepEqual(refilled.characters[0].raids, board.characters[0].raids);

  // 표에서 캐릭터를 지워 다섯 명이 되면 여섯 명으로 다시 채운다.
  const short = await (await request(accounts.member, '/api/auth/homework/characters',
    { characters: refilled.characters.slice(0, 5).map(entry => ({ characterName: entry.characterName, raids: entry.raids })) })).json();
  assert.equal(short.characters.length, 5);
  const topped = await (await request(accounts.member, '/api/auth/homework/auto', {})).json();
  assert.deepEqual(topped.characters.map(entry => entry.characterName),
    ['인증한바드', '둘째바드', '셋째바드', '넷째바드', '다섯바드', '여섯바드']);

  // 본문에 다른 값을 넣거나 다른 회원이 부르면 받지 않는다.
  assert.equal((await request(accounts.member, '/api/auth/homework/auto', { characters: [] })).status, 400);
  assert.equal((await request(accounts.outsider, '/api/auth/homework/auto', {})).status, 403);
});

test('the largest request the homework screen can send fits the homework body limit', () => {
  // 가장 긴 캐릭터 이름(한글 12자)과 가장 긴 항목으로 채운 체크 60칸, 가장 긴 레이드 3개씩 고른 캐릭터 24명.
  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  const name = '가'.repeat(12);
  const items = [...DAILY, ...WEEKLY].map(item => item.id);
  for (const entry of RAID_CATALOGUE) entry.gates.forEach((gate, index) => items.push(`${raidId(entry)}|${index}|bonus`));
  const itemId = items.reduce((a, b) => (Buffer.byteLength(a) >= Buffer.byteLength(b) ? a : b));
  const checks = { changes: Array.from({ length: CHECK_LIMIT }, () => ({ characterName: name, scope: 'weekly', itemId, value: 99 })) };
  const raids = RAID_CATALOGUE.map(raidId).sort((a, b) => Buffer.byteLength(b) - Buffer.byteLength(a)).slice(0, RAID_LIMIT);
  const characters = { characters: Array.from({ length: CHARACTER_LIMIT }, () => ({ characterName: name, raids })) };
  assert.ok(bytes(checks) <= HOMEWORK_BODY_LIMIT, `체크 ${bytes(checks)}바이트`);
  assert.ok(bytes(characters) <= HOMEWORK_BODY_LIMIT, `캐릭터 ${bytes(characters)}바이트`);
});

test('a batch of checks the screen collects is saved, while other routes keep the 1 KiB body limit', async (t) => {
  // 화면은 누른 체크를 모아 한 번에 보낸다. 전에는 웹 입구의 1 KiB 상한 때문에 18칸(1,408바이트)부터 413이었다(교차 검토 F-P2-3).
  const { accounts, request } = await setup(t);
  const auto = await request(accounts.member, '/api/auth/homework/auto', {});
  assert.equal(auto.status, 200);
  const board = await auto.json();
  const changes = board.characters.flatMap(entry => board.daily.map(item => ({ characterName: entry.characterName, scope: 'daily', itemId: item.id, value: 1 })));
  assert.equal(changes.length, 18);
  assert.ok(Buffer.byteLength(JSON.stringify({ changes })) > 1024);
  const saved = await request(accounts.member, '/api/auth/homework/check', { changes });
  assert.equal(saved.status, 200);
  assert.ok((await saved.json()).characters.every(entry => board.daily.every(item => entry.daily[item.id] === 1)));
  assert.equal((await request(accounts.member, '/api/auth/homework/check', { changes: [], pad: 'x'.repeat(HOMEWORK_BODY_LIMIT) })).status, 413);
  assert.equal((await request(accounts.member, '/api/auth/characters/representative', { pad: 'x'.repeat(1100) })).status, 413);
});
