import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createWebServer } from '../src/server.js';

const origin = 'https://opentalk.example.invalid';
const hash = value => createHash('sha256').update(value).digest('hex');
const character = { characterName: '포근한바드', serverName: '루페온', characterClass: '바드', itemLevel: 1740, guildName: '다른길드' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'web-ownership-'));
  const path = join(dir, 'auth.sqlite');
  let time = 1790000000000;
  const store = createStore(path);
  const users = {};
  for (const [index, name] of ['owner', 'member', 'other', 'kakao'].entries()) {
    const token = randomBytes(32).toString('base64url');
    store.createSession({ provider: name === 'kakao' ? 'kakao' : 'discord', providerId: String(1000 + index), displayName: name,
      tokenHash: hash(token), expiresAt: time + 86400000, epoch: 0 }, time);
    users[name] = { ...store.getSession(hash(token), time), token, providerId: String(1000 + index) };
  }
  store.guild.bootstrapOwner(users.owner.id, time);
  const control = { calls: [], verificationCalls: [], hook: null, verifyHook: null, failure: null };
  const fetchImpl = async (input, init) => {
    const url = new URL(input); control.calls.push(url.href);
    if (control.fetchHook) { const result = await control.fetchHook(url, init); if (result) return result; }
    if (control.hook) await control.hook(url);
    if (url.pathname.endsWith('/profiles')) return Response.json({ CharacterName: decodeURIComponent(url.pathname.split('/')[3]),
      ServerName: character.serverName, CharacterClassName: character.characterClass, ItemAvgLevel: String(character.itemLevel), GuildName: character.guildName });
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'fixture-token', token_type: 'Bearer', scope: 'identify guilds.members.read' });
    if (url.pathname === '/api/v10/users/@me') return Response.json({ id: users.member.providerId, username: '회원' });
    if (url.pathname.endsWith('/member')) return Response.json({ user: { id: users.member.providerId }, nick: character.characterName, roles: ['12345'] });
    return Response.json([]);
  };
  const verifyStoveImpl = async input => {
    control.verificationCalls.push(input);
    if (control.verifyHook) await control.verifyHook(input);
    if (control.failure) throw control.failure;
    return { stoveAccountId: '123456', characterName: input.characterName };
  };
  const config = { origin, host: '127.0.0.1', port: 0, dbPath: path,
    providers: { discord: { clientId: '12345678', clientSecret: 'fixture-secret' } },
    automaticApproval: { enabled: true, discordGuildId: '123456', discordRoleId: '12345', lostArkApiKey: 'fixture-game-key' } };
  const service = createWebServer({ config, fetchImpl, verifyStoveImpl, now: () => time, ...options });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  async function request(route, user = users.member, body, headers = {}) {
    const response = await fetch(base + route, { redirect: 'manual', method: body === undefined ? 'GET' : 'POST', headers: {
      ...(user ? { Cookie: `__Host-web_session=${user.token}`, Origin: origin, 'X-CSRF-Token': createHash('sha256').update(`web-csrf:${user.token}`).digest('base64url') } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
    return { status: response.status, headers: response.headers, data };
  }
  t.after(async () => { await service.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const select = async (user = users.member, name = character.characterName) => {
    const result = await request('/api/auth/ownership/character', user, { characterName: name }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
  };
  const verify = async (user = users.member, state) => {
    state ||= await select(user); return request('/api/auth/ownership/verify', user, { revision: state.revision, profileUrl: 'https://profile.onstove.com/123456' });
  };
  return { users, store, path, base, request, select, verify, control, now: () => time, advance(ms) { time += ms; } };
}

test('all actual feature APIs require final approval before any external work', async t => {
  const h = await setup(t);
  const routes = ['/api/lounge', '/api/market/options', '/api/market/search?q=겁화', '/api/market/bid?price=1000', '/api/market/items/1/history'];
  for (const route of routes) {
    assert.equal((await h.request(route, null)).status, 401, route);
    assert.equal((await h.request(route)).status, 403, route);
  }
  assert.equal(h.control.calls.length, 0);
  const anonymous = await h.request('/api/auth/session', null);
  assert.deepEqual(anonymous.data.siteAccess, { authenticated: false, approved: false, status: 'anonymous' });
  assert.equal((await h.request('/api/auth/session')).data.siteAccess.status, 'verification_required');
  assert.equal((await h.request('/api/auth/session', h.users.owner)).data.siteAccess.approved, true);
});

test('profile lookup and Kakao profile completion cannot submit an unverified application', async t => {
  const h = await setup(t);
  const state = await h.select();
  assert.equal(state.state, 'pending'); assert.equal(state.character.guildName, '다른길드');
  assert.ok(state.challenge.code.length >= 16);
  assert.equal((await h.request('/api/auth/guild/apply', h.users.member, { characterName: character.characterName })).status, 403);
  assert.equal(h.store.guild.state(h.users.member.id).membership, null);
});

test('STOVE proof persists separately and only a staff review opens actual features', async t => {
  const h = await setup(t); const state = await h.select();
  const verified = await h.verify(h.users.member, state);
  assert.equal(verified.status, 200); assert.equal(verified.data.state, 'verified'); assert.equal(verified.data.method, 'stove');
  assert.equal(verified.data.challenge, null);
  assert.equal(h.control.verificationCalls[0].code, state.challenge.code);
  assert.equal((await h.request('/api/auth/session')).data.siteAccess.status, 'application_required');
  assert.equal((await h.request('/api/lounge')).status, 403);
  const applied = await h.request('/api/auth/guild/apply', h.users.member, { characterName: character.characterName });
  assert.equal(applied.status, 200); assert.equal(applied.data.membership.status, 'pending');
  const members = await h.request('/api/auth/guild/members', h.users.owner);
  const row = members.data.items.find(value => value.userId === h.users.member.id);
  assert.equal(row.ownership.state, 'verified'); assert.equal(row.ownership.character.guildName, '다른길드');
  assert.equal(JSON.stringify(row).includes('stoveAccountId'), false); assert.equal(JSON.stringify(row).includes(state.challenge.code), false);
  assert.equal((await h.request('/api/auth/guild/review', h.users.owner, { userId: h.users.member.id, status: 'approved', revision: row.revision })).status, 200);
  assert.equal((await h.request('/api/auth/session')).data.siteAccess.approved, true);
  assert.equal((await h.request('/api/market/bid?price=1000&partySize=4')).status, 200);
});

test('ownership writes enforce session, CSRF and strict inputs before official or verification requests', async t => {
  const h = await setup(t);
  assert.equal((await h.request('/api/auth/ownership/character', null, { characterName: character.characterName })).status, 401);
  assert.equal((await h.request('/api/auth/ownership/character', h.users.member, { characterName: character.characterName }, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await h.request('/api/auth/ownership/character', h.users.member, { characterName: character.characterName }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await h.request('/api/auth/ownership/character', h.users.member, { characterName: character.characterName, verified: true })).status, 400);
  assert.equal(h.control.calls.length, 0);
  const state = await h.select();
  assert.equal((await h.request('/api/auth/ownership/verify', h.users.other, { revision: state.revision, profileUrl: 'https://profile.onstove.com/123456' })).status, 409);
  assert.equal(h.control.verificationCalls.length, 0);
});

test('renewal and logout while STOVE is in flight cannot complete stale proofs', async t => {
  const h = await setup(t); const state = await h.select();
  const hold = deferred(); const entered = deferred();
  h.control.verifyHook = async () => { entered.resolve(); await hold.promise; };
  const verifying = h.verify(h.users.member, state); await entered.promise;
  h.advance(61000);
  const renewed = await h.request('/api/auth/ownership/renew', h.users.member, { revision: state.revision });
  assert.equal(renewed.status, 200); assert.notEqual(renewed.data.challenge.code, state.challenge.code);
  hold.resolve(); assert.equal((await verifying).status, 409);
  h.control.verifyHook = async () => { h.store.deleteSession(hash(h.users.member.token)); };
  assert.equal((await h.verify(h.users.member, renewed.data)).status, 401);
});

test('Discord role proof verifies ownership but never approves or automatically applies', async t => {
  const h = await setup(t); const state = await h.select();
  const started = await h.request('/api/auth/ownership/discord', h.users.member, { revision: state.revision });
  assert.equal(started.status, 200);
  const url = new URL(started.data.authorizationUrl);
  const binding = started.headers.getSetCookie().find(value => value.startsWith('__Host-web_binding='))?.split(';')[0];
  const response = await fetch(`${h.base}/auth/discord/callback?state=${url.searchParams.get('state')}&code=fixture`, {
    redirect: 'manual', headers: { Cookie: `__Host-web_session=${h.users.member.token}; ${binding}` } });
  assert.equal(response.headers.get('location'), '/account.html?ownership=verified');
  assert.equal((await h.request('/api/auth/ownership')).data.method, 'discord');
  assert.equal(h.store.guild.state(h.users.member.id).membership, null);
  assert.equal((await h.request('/api/auth/session')).data.siteAccess.approved, false);
});

test('v6 migration preserves approved memberships without fabricating ownership proof', async t => {
  const h = await setup(t); const db = new DatabaseSync(h.path);
  db.prepare("INSERT INTO guild_memberships VALUES (?, ?, 'approved', 1, ?, ?, ?)").run(h.users.member.id, character.characterName, h.now(), h.now(), h.users.owner.id);
  db.exec('PRAGMA user_version=6'); db.close();
  const migrated = createStore(h.path);
  try { assert.equal(migrated.guild.state(h.users.member.id).membership.status, 'approved'); assert.equal(migrated.ownership.state(h.users.member.id, h.now()).state, 'none'); }
  finally { migrated.close(); }
  assert.equal((await h.request('/api/auth/session')).data.siteAccess.approved, true);
});

test('fresh lookups cannot bypass code reissue cooldown or reset the attempt budget', async t => {
  const h = await setup(t); const state = await h.select();
  const repeated = await h.request('/api/auth/ownership/character', h.users.member, { characterName: '다른바드' });
  assert.equal(repeated.status, 429);
  assert.equal((await h.request('/api/auth/ownership')).data.challenge.code, state.challenge.code);
  h.control.failure = Object.assign(new Error('no match'), { status: 403, code: 'verification_mismatch' });
  for (let index = 0; index < 5; index++) assert.equal((await h.verify(h.users.member, state)).status, 403);
  assert.equal((await h.verify(h.users.member, state)).status, 429);
  assert.equal(h.control.verificationCalls.length, 5);
  h.advance(1800001);
  assert.equal((await h.verify(h.users.member, state)).status, 409);
});

test('approval revocation during a character query no longer withdraws the public answer, while member routes lock', async t => {
  const h = await setup(t); const verified = await h.verify(); assert.equal(verified.status, 200);
  h.store.guild.apply(h.users.member.id, character.characterName, h.now());
  h.store.guild.review(h.users.owner.id, h.users.member.id, 'approved', 1, h.now());
  assert.equal((await h.request('/api/auth/session')).data.siteAccess.approved, true);
  const hold = deferred(); const entered = deferred();
  h.control.hook = async url => { if (url.pathname.endsWith('/profiles')) { entered.resolve(); await hold.promise; } };
  const pending = h.request('/api/character/spec?name=포근한바드&section=profile'); await entered.promise;
  h.store.guild.review(h.users.owner.id, h.users.member.id, 'revoked', 2, h.now());
  hold.resolve(); assert.equal((await pending).status, 200);
  assert.equal((await h.request('/api/character/spec?name=포근한바드&section=profile')).status, 200);
  assert.equal((await h.request('/api/lounge')).status, 403);
});

test('the complete verification deadline responds even if a verifier ignores abort, without freeing its work slot', async t => {
  const h = await setup(t); const state = await h.select(); const hold = deferred();
  h.control.verifyHook = () => hold.promise;
  const pending = h.verify(h.users.member, state);
  let timer;
  const result = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), 15500); })]);
  clearTimeout(timer);
  try {
    assert.equal(result?.status, 502);
    assert.equal((await h.verify(h.users.member, state)).status, 429);
    assert.equal((await h.request('/api/auth/ownership')).data.state, 'pending');
  } finally { hold.resolve(); await pending; }
});

test('Discord proof and STOVE proof share a single per-account external verification slot', async t => {
  const h = await setup(t); const state = await h.select();
  const started = await h.request('/api/auth/ownership/discord', h.users.member, { revision: state.revision });
  const url = new URL(started.data.authorizationUrl);
  const binding = started.headers.getSetCookie().find(value => value.startsWith('__Host-web_binding='))?.split(';')[0];
  const hold = deferred(); const entered = deferred();
  h.control.hook = async value => { if (value.pathname.endsWith('/token')) { entered.resolve(); await hold.promise; } };
  const callback = fetch(`${h.base}/auth/discord/callback?state=${url.searchParams.get('state')}&code=fixture`, {
    redirect: 'manual', headers: { Cookie: `__Host-web_session=${h.users.member.token}; ${binding}` } });
  await entered.promise;
  try { assert.equal((await h.verify(h.users.member, state)).status, 429); }
  finally { hold.resolve(); await callback; }
});

test('the default production STOVE module validates account linkage and preserves actionable 422 errors', async t => {
  const h = await setup(t, { verifyStoveImpl: undefined }); const state = await h.select();
  const account = '123456'; let introduction = state.challenge.code;
  h.control.fetchHook = async (url, init) => {
    if (url.hostname === 'api.onstove.com') {
      assert.equal(init.headers['X-Lang'], 'KO');
      return Response.json({ code: 0, value: { member_no: Number(account), myhome_visible: true, introduce: introduction } });
    }
    if (url.pathname === '/board/IsCharacterList') return Response.json({ isCharacter: true, encryptMemberNo: 'abcd1234ABCD5678abcd1234ABCD5678abcd1234ABCD5678=' });
    if (url.pathname === '/Profile/Member') return new Response(null, { status: 302, headers: { Location: '/Profile/Character/' + encodeURIComponent(character.characterName) } });
    if (url.pathname.startsWith('/Profile/Character/')) return new Response(`<span class="profile-character-info__name">${character.characterName}</span>
      <div id="expand-character-list"><button onclick="location.href='/Profile/Character/${character.characterName}'">${character.characterName}</button></div>`);
  };
  assert.equal((await h.verify(h.users.member, state)).status, 200);
  const second = await h.select(h.users.other); introduction = '인증코드 없음';
  const missing = await h.verify(h.users.other, second);
  assert.equal(missing.status, 422); assert.equal(missing.data.error, 'stove_code_missing');
  assert.equal((await h.request('/api/auth/ownership', h.users.other)).data.state, 'pending');
});
