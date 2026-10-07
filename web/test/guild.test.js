import { verifyOwnership } from './helpers/access.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createWebServer } from '../src/server.js';
import { createUnlinkInbox } from '../src/inbox.js';
import { assignOwner } from '../src/guild-owner.js';

const origin = 'https://opentalk.example.invalid';
const digest = (s) => createHash('sha256').update(s).digest('hex');
const timestamp = Date.now();

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'guild-test-'));
  const path = join(dir, 'auth.sqlite');
  const store = createStore(path);
  let service;
  let clock = timestamp;
  t.after(async () => { if (service) await service.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const accounts = {};
  for (const [i, name] of ['owner', 'admin', 'member', 'other', 'kakao'].entries()) {
    const token = randomBytes(32).toString('base64url');
    store.createSession({ provider: name === 'kakao' ? 'kakao' : 'discord', providerId: String(1000 + i), displayName: '동일한 이름', tokenHash: digest(token), expiresAt: timestamp + 86400000, epoch: 0 }, timestamp);
    accounts[name] = { ...store.getSession(digest(token), timestamp), token };
    if (name === 'kakao') store.signup.complete(accounts[name].id, '동일한 이름', { characterName: '카카오회원', serverName: '루페온', characterClass: '바드', itemLevel: 1700 }, timestamp);
  }
  async function listen() {
    service = createWebServer({ config: { origin, host: '127.0.0.1', port: 0, dbPath: path, providers: { kakao: { adminKey: 'private-test-key', appId: '12345' } } }, now: () => clock });
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
  }
  const request = async (route, user, body, extras = {}) => {
    const headers = user ? { Cookie: `__Host-web_session=${user.token}`, Origin: origin, 'X-CSRF-Token': createHash('sha256').update(`web-csrf:${user.token}`).digest('base64url') } : {};
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/guild${route}`, {
      method: body === undefined ? 'GET' : 'POST', ...extras,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extras.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { store, path, dir, accounts, listen, request, advance(ms) { clock += ms; } };
}

test('ownership verification and application remain separate from privileged staff approval', async t => {
  const h=await setup(t),a=h.accounts;h.store.guild.bootstrapOwner(a.owner.id,timestamp);await h.listen();
  assert.equal((await h.request('/apply',a.member,{characterName:'포근한바드'})).status,403);
  verifyOwnership(h.store,a.member,'포근한바드',timestamp);
  assert.equal(h.store.guild.state(a.member.id).membership,null);
  const own=h.store.ownership.state(a.member.id,timestamp,digest(a.member.token));assert.equal(own.state,'verified');assert.equal(own.challenge,null);
  assert.equal((await h.request('/apply',a.member,{characterName:'포근한바드'})).status,200);
  const action={userId:a.member.id,status:'approved',revision:1};
  assert.equal((await h.request('/sheet',a.member)).status,403);
  const listing=await h.request('/members',a.owner);assert.equal(JSON.stringify(listing.body).includes('stoveAccountId'),false);
  assert.equal((await h.request('/review',a.owner,{...action,verificationCode:'12345678',verifiedInGame:true})).status,400);
  assert.equal((await h.request('/review',a.member,action)).status,403);
  assert.equal((await h.request('/review',a.owner,action)).status,200);
  assert.equal((await h.request('/review',a.owner,action)).status,409);
  assert.equal((await h.request('/sheet',a.member)).status,200);
});

test('ownership challenges expire, rotate with revisions, and lock after five failed proofs',async t=>{
 const h=await setup(t),a=h.accounts.member,key=digest(a.token),store=h.store;
 const first=store.ownership.select(a.id,key,{characterName:'포근한바드',serverName:'루페온',characterClass:'바드',itemLevel:1740},0,timestamp);
 assert.match(first.challenge.code,/^PG-[A-F0-9]{24}$/);
 let oldProof;
 for(let n=0;n<5;n++){oldProof=store.ownership.beginStove(a.id,key,1,timestamp);assert.throws(()=>store.ownership.finishStove(oldProof,{stoveAccountId:'fixture',characterName:'다른캐릭터'},timestamp),{code:'ownership_state_changed'});}
 assert.throws(()=>store.ownership.beginStove(a.id,key,1,timestamp),{code:'verification_locked'});
 assert.equal(store.ownership.state(a.id,timestamp,key).challenge,null);
 assert.throws(()=>store.ownership.renew(a.id,key,1,timestamp),{code:'verification_cooldown'});
 const next=store.ownership.renew(a.id,key,1,timestamp+60000);assert.equal(next.revision,2);assert.notEqual(next.challenge.code,first.challenge.code);
 assert.throws(()=>store.ownership.finishStove(oldProof,{stoveAccountId:'fixture',characterName:'포근한바드'},timestamp+60000),{code:'ownership_state_changed'});
 assert.throws(()=>store.ownership.beginStove(a.id,key,2,timestamp+1860000),{code:'verification_expired'});
 const renewed=store.ownership.renew(a.id,key,2,timestamp+1860000),proof=store.ownership.beginStove(a.id,key,renewed.revision,timestamp+1860000);
 store.ownership.finishStove(proof,{stoveAccountId:'fixture',characterName:'포근한바드'},timestamp+1860000);assert.equal(store.guild.state(a.id).canViewSheet,false);
});

test('ownership binds an applicant and staff reviews prevent duplicate approved characters',async t=>{
 const h=await setup(t),a=h.accounts;h.store.guild.bootstrapOwner(a.owner.id,timestamp);await h.listen();
 verifyOwnership(h.store,a.member,'TestBard',timestamp);verifyOwnership(h.store,a.other,'testbard',timestamp);
 assert.equal((await h.request('/apply',a.member,{characterName:'OtherBard'})).status,403);
 await h.request('/apply',a.member,{characterName:'TestBard'});await h.request('/apply',a.other,{characterName:'testbard'});
 const action={status:'approved',revision:1};assert.equal((await h.request('/review',a.owner,{...action,userId:a.member.id})).status,200);
 assert.equal((await h.request('/review',a.owner,{...action,userId:a.other.id})).body.error,'character_already_verified');
 assert.equal((await h.request('/sheet',a.other)).status,403);
 assert.equal((await h.request('/verification',a.other,{revision:1,userId:a.member.id})).status,400);
 assert.equal((await h.request('/verification',a.other,{revision:1},{headers:{'X-CSRF-Token':'bad'}})).status,403);
 assert.equal((await h.request('/verification',a.other,{revision:1})).status,410);
 assert.equal((await h.request('/review',a.owner,{userId:a.other.id,status:'rejected',revision:1})).status,200);
});

test('guild migration preserves existing users and sessions and rejects unknown schemas', async (t) => {
  const h = await setup(t);
  const db = new DatabaseSync(h.path);
  db.exec('DROP TABLE guild_verifications; DROP TABLE guild_roles; DROP TABLE guild_memberships; PRAGMA user_version=1;');
  const upgraded = createStore(h.path);
  assert.equal(upgraded.getSession(digest(h.accounts.member.token), timestamp).id, h.accounts.member.id);
  assert.deepEqual(upgraded.guild.state(h.accounts.member.id), { role: 'member', membership: null, canViewSheet: false, verification: null });
  upgraded.close();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
  db.exec('PRAGMA user_version=99;');
  assert.throws(() => createStore(h.path), /Unsupported/);
  db.close();
});

test('version two pending applications require ownership proof and deletion removes pending verification',async t=>{
 const h=await setup(t),a=h.accounts;h.store.guild.bootstrapOwner(a.owner.id,timestamp);
 const db=new DatabaseSync(h.path);db.prepare("INSERT INTO guild_memberships VALUES (?,?,'pending',1,?,NULL,NULL)").run(a.kakao.id,'이전신청',timestamp);
 db.exec('DROP TABLE guild_verifications; DROP INDEX guild_verified_character; PRAGMA user_version=2;');
 const upgraded=createStore(h.path);
 try{assert.equal(upgraded.getSession(digest(a.kakao.token),timestamp).id,a.kakao.id);assert.equal(upgraded.guild.state(a.kakao.id,timestamp).verification,null);
 assert.throws(()=>upgraded.guild.review(a.owner.id,a.kakao.id,'approved',1,timestamp),{code:'ownership_required'});
 const selected=upgraded.ownership.select(a.kakao.id,digest(a.kakao.token),{characterName:'이전신청',serverName:'루페온',characterClass:'바드',itemLevel:1740},0,timestamp);assert.ok(selected.challenge.code);
 upgraded.beginDeletion(upgraded.getAccount(digest(a.kakao.token),timestamp),timestamp);assert.equal(upgraded.ownership.state(a.kakao.id,timestamp,digest(a.kakao.token)).state,'none');
 assert.throws(()=>upgraded.ownership.renew(a.kakao.id,digest(a.kakao.token),1,timestamp+60000),{status:401});upgraded.externalUnlink('1004');
 assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ownership_challenges').get().count,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{upgraded.close();db.close();}
});

test('conflicting legacy approvals abort schema migration without changing accounts or version', async (t) => {
  const h = await setup(t); const a = h.accounts;
  verifyOwnership(h.store,a.member,'SameBard',timestamp);
  h.store.guild.apply(a.member.id, 'SameBard', timestamp);
  verifyOwnership(h.store,a.other,'samebard',timestamp);
  h.store.guild.apply(a.other.id, 'samebard', timestamp);
  const db = new DatabaseSync(h.path);
  db.exec("DROP TABLE guild_verifications; DROP INDEX guild_verified_character; UPDATE guild_memberships SET status='approved'; PRAGMA user_version=2;");
  assert.throws(() => createStore(h.path), /UNIQUE/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='guild_verifications'").get().count, 0);
  db.close();
});

test('ownership challenge and failed proof counts survive reopening the store',async t=>{
 const h=await setup(t),a=h.accounts;h.store.guild.bootstrapOwner(a.owner.id,timestamp);const key=digest(a.member.token);
 const state=h.store.ownership.select(a.member.id,key,{characterName:'재시작확인',serverName:'루페온',characterClass:'바드',itemLevel:1740},0,timestamp);
 const proof=h.store.ownership.beginStove(a.member.id,key,1,timestamp);assert.throws(()=>h.store.ownership.finishStove(proof,{stoveAccountId:'fixture',characterName:'다른캐릭터'},timestamp),{code:'ownership_state_changed'});
 const reopened=createStore(h.path);try{assert.equal(reopened.ownership.state(a.member.id,timestamp,key).challenge.code,state.challenge.code);assert.equal(reopened.ownership.state(a.member.id,timestamp,key).challenge.attemptsRemaining,4);
 const next=reopened.ownership.beginStove(a.member.id,key,1,timestamp);reopened.ownership.finishStove(next,{stoveAccountId:'fixture',characterName:'재시작확인'},timestamp);
 reopened.guild.apply(a.member.id,'재시작확인',timestamp);reopened.guild.review(a.owner.id,a.member.id,'approved',1,timestamp);assert.equal(reopened.guild.state(a.member.id).canViewSheet,true);
 }finally{reopened.close();}
});

test('only one explicit owner exists and duplicate display names never confer privilege', async (t) => {
  const { store, accounts: a } = await setup(t);
  assert.throws(() => store.guild.bootstrapOwner('missing', timestamp));
  store.guild.bootstrapOwner(a.owner.id, timestamp);
  assert.equal(store.guild.state(a.owner.id).role, 'owner');
  assert.equal(store.guild.state(a.member.id).role, 'member');
  assert.throws(() => store.guild.bootstrapOwner(a.other.id, timestamp));
  assert.equal(store.guild.state(a.other.id).canViewSheet, false);
});

test('HTTP membership flow enforces session, approval, owner delegation and stale review protection', async (t) => {
  const h = await setup(t); const a = h.accounts;
  h.store.guild.bootstrapOwner(a.owner.id, timestamp);
  await h.listen();
  assert.equal((await h.request('/sheet')).status, 401);
  assert.equal((await h.request('/sheet', a.member)).status, 403);
  assert.equal((await h.request('/members', a.member)).status, 403);
  assert.equal((await h.request('/role', a.member, { userId: '00000000-0000-0000-0000-000000000000', role: 'admin', revision: 1 })).status, 403);
  verifyOwnership(h.store,a.member,'포근한바드',timestamp);
  assert.equal((await h.request('/apply', a.member, { characterName: '포근한바드' })).body.membership.status, 'pending');
  assert.equal((await h.request('/apply', a.member, { characterName: '다른바드' })).status, 403);
  const review = { userId: a.member.id, status: 'approved', revision: 1 };
  assert.equal((await h.request('/review', a.member, review)).status, 403);
  assert.equal((await h.request('/review', a.owner, review)).status, 200);
  assert.equal((await h.request('/review', a.owner, review)).status, 409);
  const sheet = await h.request('/sheet', a.member);
  assert.equal(sheet.status, 200); assert.equal(sheet.headers.get('cache-control'), 'no-store');
  assert.deepEqual(sheet.body, { title: '길드 일정 조율', tabs: [], sheet: null, entries: {}, canManage: false });
  assert.equal((await h.request('/role', a.member, { userId: a.member.id, role: 'admin', revision: 2 })).status, 403);
  assert.equal((await h.request('/role', a.owner, { userId: a.member.id, role: 'admin', revision: 2 })).status, 200);
  assert.equal((await h.request('', a.member)).body.role, 'admin');
  assert.equal((await h.request('/members', a.member)).status, 200);
  assert.equal((await h.request('/role', a.member, { userId: a.other.id, role: 'admin', revision: 1 })).status, 403);
  assert.equal((await h.request('/role', a.owner, { userId: a.owner.id, role: 'member', revision: 1 })).status, 403);
  assert.equal((await h.request('/review', a.member, { userId: a.owner.id, status: 'revoked', revision: 1 })).status, 403);
  assert.equal((await h.request('/review', a.owner, { userId: a.member.id, status: 'revoked', revision: 3 })).status, 200);
  assert.equal((await h.request('/sheet', a.member)).status, 403);
  assert.equal((await h.request('/members', a.member)).status, 403);
  verifyOwnership(h.store,a.member,'다시신청',timestamp);
  assert.equal((await h.request('/apply', a.member, { characterName: '다시신청' })).body.membership.revision, 5);
});

test('writes reject CSRF, foreign origins, unknown fields, malformed names and methods', async (t) => {
  const h = await setup(t); await h.listen(); const member = h.accounts.member;
  for (const headers of [{ Origin: 'https://evil.example' }, { 'X-CSRF-Token': 'bad' }]) {
    assert.equal((await h.request('/apply', member, { characterName: '포근해용' }, { headers })).status, 403);
  }
  for (const body of [{ characterName: '<script>' }, { characterName: '가' }, { characterName: '포근해용', role: 'owner' }, { characterName: '포근해용', userId: h.accounts.owner.id }, null, []]) {
    assert.equal((await h.request('/apply', member, body)).status, 400);
  }
  assert.equal((await h.request('/apply', member, { characterName: '포근해용' }, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal((await h.request('/sheet', member, undefined, { method: 'POST' })).status, 405);
  assert.equal((await h.request('/apply?x=1', member, { characterName: '포근해용' })).status, 400);
  assert.equal(h.store.guild.state(member.id).membership, null);
});

test('rejected applicants may reapply; only approved members can be administrators', async (t) => {
  const { store, accounts: a } = await setup(t);
  store.guild.bootstrapOwner(a.owner.id, timestamp);
  verifyOwnership(store,a.member,'포근해용',timestamp);
  store.guild.apply(a.member.id, '포근해용', timestamp);
  store.guild.review(a.owner.id, a.member.id, 'rejected', 1, timestamp);
  assert.throws(() => store.guild.setRole(a.owner.id, a.member.id, 'admin', 2, timestamp));
  verifyOwnership(store,a.member,'다시신청',timestamp);
  store.guild.apply(a.member.id, '다시신청', timestamp);
  assert.throws(() => store.guild.review(a.owner.id, a.member.id, 'approved', 1, timestamp));
  store.guild.review(a.owner.id, a.member.id, 'approved', 3, timestamp);
  store.guild.setRole(a.owner.id, a.member.id, 'admin', 4, timestamp);
  store.guild.setRole(a.owner.id, a.member.id, 'member', 5, timestamp);
  assert.equal(store.guild.state(a.member.id).role, 'member');
  assert.equal(store.guild.state(a.member.id).canViewSheet, true);
});

test('deletion intent blocks guild access and account deletion removes roles without blocking owner recovery', async (t) => {
  const h = await setup(t); const a = h.accounts;
  h.store.guild.bootstrapOwner(a.kakao.id, timestamp); await h.listen();
  h.store.beginDeletion(h.store.getAccount(digest(a.kakao.token), timestamp), timestamp);
  for (const route of ['', '/sheet', '/members']) assert.equal((await h.request(route, a.kakao)).status, 401);
  assert.equal((await h.request('/apply', a.kakao, { characterName: '포근해용' })).status, 401);
  h.store.externalUnlink('1004');
  assert.equal(h.store.guild.state(a.kakao.id).role, 'member');
  assert.equal(h.store.guild.state(a.kakao.id).membership, null);
  h.store.guild.bootstrapOwner(a.owner.id, timestamp);
  h.store.deleteLocalAccount(a.owner.id);
  assert.equal((await h.request('/sheet', a.owner)).status, 401);
  h.store.guild.bootstrapOwner(a.other.id, timestamp);
  assert.equal(h.store.guild.state(a.other.id).role, 'owner');
});

test('member listing is bounded, paginated, filtered and excludes accounts awaiting deletion', async (t) => {
  const { store, accounts: a } = await setup(t);
  store.guild.bootstrapOwner(a.owner.id, timestamp);
  for (let i = 0; i < 28; i++) {
    const tokenHash = digest(`many-${i}`);
    store.createSession({ provider: 'discord', providerId: `many-${i}`, displayName: '목록회원', tokenHash, expiresAt: timestamp + 86400000, epoch: 0 }, timestamp);
    const account = { ...store.getSession(tokenHash, timestamp), tokenHash };
    verifyOwnership(store,account,`회원${i}`,timestamp);
    store.guild.apply(account.id, `회원${i}`, timestamp);
  }
  const first = store.guild.members(a.owner.id, { status: 'pending' });
  assert.equal(first.items.length, 25); assert.ok(first.nextCursor);
  const second = store.guild.members(a.owner.id, { status: 'pending', cursor: first.nextCursor });
  assert.equal(second.items.length, 3); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(u => u.userId)).size, 28);
  verifyOwnership(store,a.kakao,'삭제예정',timestamp);
  store.guild.apply(a.kakao.id, '삭제예정', timestamp);
  store.beginDeletion(store.getAccount(digest(a.kakao.token), timestamp), timestamp);
  assert.equal(store.guild.members(a.owner.id).items.some(u => u.userId === a.kakao.id), false);
});

test('durable unlink blocks the actor and review targets before database replay', async (t) => {
  const h = await setup(t); const a = h.accounts;
  h.store.guild.bootstrapOwner(a.owner.id, timestamp);
  verifyOwnership(h.store,a.kakao,'카카오회원',timestamp);
  h.store.guild.apply(a.kakao.id, '카카오회원', timestamp);
  h.store.guild.review(a.owner.id, a.kakao.id, 'approved', 1, timestamp);
  h.store.guild.setRole(a.owner.id, a.kakao.id, 'admin', 2, timestamp);
  await h.listen();
  createUnlinkInbox(`${h.path}.unlink-inbox`).enqueue('1004');
  for (const route of ['', '/sheet', '/members']) assert.equal((await h.request(route, a.kakao)).status, 401);
  assert.equal((await h.request('/role', a.owner, { userId: a.kakao.id, role: 'member', revision: 3 })).status, 409);
  assert.equal((await h.request('/members', a.owner)).body.items.some(u => u.userId === a.kakao.id), false);
});

test('owner assignment verifies immutable identity and provider, refuses existing owner and pending unlink', async (t) => {
  const h = await setup(t); const a = h.accounts;
  assert.throws(() => assignOwner(h.path, a.owner.id, 'kakao'), /do not match/);
  createUnlinkInbox(`${h.path}.unlink-inbox`).enqueue('1004');
  assert.throws(() => assignOwner(h.path, a.owner.id, 'discord'), /unlink recovery/);
  h.store.externalUnlink('1004');
  createUnlinkInbox(`${h.path}.unlink-inbox`).remove('1004');
  assert.equal(assignOwner(h.path, a.owner.id, 'discord').assigned, true);
  assert.throws(() => assignOwner(h.path, a.other.id, 'discord'), /state_changed/);
});
