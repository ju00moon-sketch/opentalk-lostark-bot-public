import { verifyOwnership } from './helpers/access.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.js';
import { createWebServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const origin = 'https://opentalk.example.invalid';
const digest = s => createHash('sha256').update(s).digest('hex');
const guildId = '111110000000000005';
const roleId = '111110000000000008';
const automaticApproval = { enabled: true, discordGuildId: guildId, discordRoleId: roleId, lostArkApiKey: 'synthetic-game-key' };
async function setup(t, automatic = automaticApproval) {
  const dir = await mkdtemp(join(tmpdir(), 'guild-automatic-'));
  const path = join(dir, 'auth.sqlite');
  const store = createStore(path);
  let clock = 1790000000000;
  const accounts = {};
  for (const [i, name] of ['member', 'other', 'owner', 'kakao'].entries()) {
    const token = randomBytes(32).toString('base64url');
    store.createSession({ provider: name === 'kakao' ? 'kakao' : 'discord', providerId: String(1000 + i), displayName: '길드원', tokenHash: digest(token), expiresAt: clock + 86400000, epoch: 0 }, clock);
    accounts[name] = { ...store.getSession(digest(token), clock), providerId: String(1000 + i), token };
    if (name === 'kakao') store.signup.complete(accounts[name].id, '카카오회원', { characterName: '카카오회원', serverName: '루페온', characterClass: '바드', itemLevel: 1700 }, clock);
  }
  store.guild.bootstrapOwner(accounts.owner.id, clock);
  const calls = [];
  const challenges = new Map();
  const control = { mode: '', hook: null };
  const config = { origin, host: '127.0.0.1', port: 0, dbPath: path,
    providers: { discord: { clientId: '12345678', clientSecret: 'synthetic-client-secret' } }, automaticApproval: automatic };
  const fetchImpl = async (value, init) => {
    const url = new URL(value); calls.push(url.href);
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    if (url.pathname.endsWith('/token')) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('redirect_uri'), `${origin}/auth/discord/callback`);
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenges.get(body.get('code')));
      return Response.json({ access_token: 'ephemeral-test-token', token_type: 'Bearer', scope: control.mode === 'scope' ? 'identify' : 'identify guilds.members.read' });
    }
    if (url.pathname === '/api/v10/users/@me') return Response.json({ id: control.mode === 'identity' ? '1001' : '1000', username: '포근한바드' });
    if (url.hostname === 'discord.com') {
      assert.equal(url.pathname, `/api/v10/users/@me/guilds/${guildId}/member`);
      if (/^http-/.test(control.mode)) return Response.json({ message: 'private upstream detail' }, { status: Number(control.mode.slice(5)) });
      if (control.mode === 'oversize') return new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } });
      if (control.mode === 'array') return Response.json([]);
      if (control.mode === 'redirect') { const response = Response.json({}); Object.defineProperty(response, 'redirected', { value: true }); return response; }
      if (control.mode === 'timeout') return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return Response.json({ user: control.mode === 'member-missing' ? undefined : { id: control.mode === 'member-identity' ? '1001' : '1000' }, nick: control.mode === 'nick' ? null : '포근한바드', roles: control.mode === 'role' ? [] : [roleId], pending: control.mode === 'pending' });
    }
    assert.equal(url.origin, 'https://developer-lostark.game.onstove.com');
    assert.equal(decodeURIComponent(url.pathname), '/armories/characters/포근한바드/profiles');
    assert.equal(init.headers.Authorization, 'bearer synthetic-game-key');
    if (control.hook) await control.hook();
    return Response.json({ CharacterName: control.mode === 'character' ? '다른캐릭터' : '포근한바드', ServerName: control.mode === 'server' ? '카마인' : '루페온', GuildName: control.mode === 'guild' ? '다른길드' : '포근해' });
  };
  const service = createWebServer({ config, fetchImpl, now: () => clock });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = (route, user = accounts.member, body, headers = {}) => fetch(base + route, { redirect: 'manual', method: body === undefined ? 'GET' : 'POST', headers: {
    ...(user ? { Cookie: `__Host-web_session=${user.token}`, Origin: origin, 'X-CSRF-Token': createHash('sha256').update(`web-csrf:${user.token}`).digest('base64url') } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function select(user = accounts.member, name = '포근한바드') { return store.ownership.select(user.id, digest(user.token), { characterName: name, serverName: '루페온', characterClass: '바드', itemLevel: 1740, guildName: '포근해' }, store.ownership.summary(user.id).revision, clock); }
  async function start(user = accounts.member, revision = 1) {
    const response = await request('/api/auth/ownership/discord', user, { revision });
    assert.equal(response.status, 200);
    const data = await response.json(); const url = new URL(data.authorizationUrl);
    const state = url.searchParams.get('state'); challenges.set(state, url.searchParams.get('code_challenge'));
    const binding = response.headers.getSetCookie().find(c => c.startsWith('__Host-web_binding='))?.split(';')[0];
    return { state, url, cookie: `__Host-web_session=${user.token}; ${binding}`, response };
  }
  const callback = (flow, query = `state=${flow.state}&code=${flow.state}`, cookie = flow.cookie) => fetch(`${base}/auth/discord/callback?${query}`, { redirect: 'manual', headers: { Cookie: cookie } });
  t.after(async () => { await service.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, path, dir, accounts, request, select, start, callback, calls, control, advance(ms) { clock += ms; }, now: () => clock };
}

test('Discord ownership uses separate consent and keeps original session without approving membership',async t=>{
 const h=await setup(t),a=h.accounts.member;const login=await h.request('/auth/discord/start');assert.equal(new URL(login.headers.get('location')).searchParams.get('scope'),'identify');
 const state=await h.select();assert.equal(state.state,'pending');const flow=await h.start();assert.equal(flow.url.searchParams.get('scope'),'identify guilds.members.read');
 const result=await h.callback(flow);assert.equal(result.headers.get('location'),'/account.html?ownership=verified');assert.equal(result.headers.getSetCookie().some(c=>c.startsWith('__Host-web_session=')),false);
 const final=await(await h.request('/api/auth/ownership')).json();assert.equal(final.state,'verified');assert.equal(final.method,'discord');assert.equal(final.challenge,null);
 assert.equal(h.store.guild.state(a.id).membership,null);assert.equal((await h.request('/api/auth/guild/sheet')).status,403);assert.equal(h.store.getSession(digest(a.token),h.now()).id,a.id);
 const session=await(await h.request('/api/auth/session')).json();assert.equal(session.siteAccess.status,'application_required');assert.equal(session.siteAccess.approved,false);
 const count=h.calls.length;assert.notEqual((await h.callback(flow)).headers.get('location'),'/account.html?ownership=verified');assert.equal(h.calls.length,count);assert.equal((await readFile(h.path)).includes(Buffer.from('ephemeral-test-token')),false);
});

test('disabled Discord proof and Kakao accounts retain STOVE verification without automatic approval',async t=>{
 const h=await setup(t,{enabled:false});const state=await h.select();assert.match(state.challenge.code,/^PG-[A-F0-9]{24}$/);
 assert.equal((await h.request('/api/auth/ownership/discord',h.accounts.member,{revision:1})).status,503);
 const k=await setup(t);const stateK=await k.select(k.accounts.kakao);assert.equal(stateK.state,'pending');assert.equal((await k.request('/api/auth/ownership/discord',k.accounts.kakao,{revision:1})).status,403);
 assert.equal((await k.request('/api/auth/guild/automatic',k.accounts.member,{revision:1})).status,410);
});

test('ownership consent starts reject missing sessions, forged CSRF, extra fields and stale revisions', async t => {
  const h = await setup(t); await h.select();
  assert.equal((await h.request('/api/auth/ownership/discord', null, { revision: 1 })).status, 401);
  assert.equal((await h.request('/api/auth/ownership/discord', h.accounts.member, { revision: 1 }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  for (const body of [{ revision: 1, userId: h.accounts.other.id }, { revision: '1' }, { revision: 0 }, []]) assert.equal((await h.request('/api/auth/ownership/discord', h.accounts.member, body)).status, 400);
  assert.equal((await h.request('/api/auth/ownership/discord', h.accounts.member, { revision: 2 })).status, 409);
  assert.equal(h.calls.length, 0);
});

test('all external identity, role, nickname and game mismatches stay pending', async t => {
  const h = await setup(t); await h.select();
  for (const mode of ['scope', 'identity', 'member-identity', 'member-missing', 'role', 'nick', 'pending', 'character', 'server', 'http-401', 'http-403', 'http-404', 'http-429', 'http-503', 'oversize', 'array', 'redirect']) {
    h.control.mode = mode; const result = await h.callback(await h.start());
    assert.match(result.headers.get('location'), /\/account\.html\?error=automatic_/, mode);
    assert.equal(h.store.ownership.summary(h.accounts.member.id).state, 'pending', mode);
    assert.equal((await h.request('/api/auth/guild/sheet')).status, 403, mode);
    assert.doesNotMatch(result.headers.get('location'), /private|token|synthetic/);
  }
});

test('cancellation, expired state and incorrect binding cannot authorize or swap sessions', async t => {
  const h = await setup(t); await h.select();
  const flow = await h.start();
  assert.match((await h.callback(flow, `state=${flow.state}&error=access_denied`)).headers.get('location'), /automatic_cancelled/);
  assert.equal(h.calls.length, 0);
  const wrong = await h.start();
  assert.notEqual((await h.callback(wrong, undefined, `__Host-web_session=${h.accounts.other.token}; __Host-web_binding=${randomBytes(32).toString('base64url')}`)).headers.get('location'), '/account.html?ownership=verified');
  const expired = await h.start(); h.advance(300001);
  assert.notEqual((await h.callback(expired)).headers.get('location'), '/account.html?ownership=verified'); assert.equal(h.calls.length, 0);
});

test('external response races recheck logout, deletion, renewals, character changes and completed proof',async t=>{
 for(const action of['logout','delete','blocked','session-expiry','renew','character','verified']){const h=await setup(t);await h.select();const a=h.accounts.member;
 h.control.hook=()=>{if(action==='logout')h.store.deleteSession(digest(a.token));else if(action==='delete')h.store.deleteLocalAccount(a.id);else if(action==='blocked')h.store.beginDeletion({id:a.id,providerId:a.providerId},h.now());else if(action==='session-expiry')h.advance(86400001);else if(action==='renew'){h.advance(60000);h.store.ownership.renew(a.id,digest(a.token),1,h.now());}else if(action==='character')h.store.ownership.select(a.id,digest(a.token),{characterName:'다른바드',serverName:'루페온',characterClass:'바드',itemLevel:1740},1,h.now());else { h.advance(60000); verifyOwnership(h.store,a,'포근한바드',h.now()); }};
 assert.notEqual((await h.callback(await h.start())).headers.get('location'),'/account.html?ownership=verified',action);assert.equal(h.store.guild.state(a.id).membership,null);assert.equal(h.store.guild.state(a.id).canViewSheet,false);
 }
});

test('another in-game guild does not invalidate ownership or grant final membership approval', async t => {
  const h = await setup(t); await h.select(); h.control.mode = 'guild';
  assert.equal((await h.callback(await h.start())).headers.get('location'), '/account.html?ownership=verified');
  assert.equal(h.store.guild.state(h.accounts.member.id).membership, null);
  assert.equal((await h.request('/api/auth/guild/sheet')).status, 403);
});

test('a review during Discord verification is never overwritten by its late callback', async t => {
  for (const status of ['rejected', 'approved']) {
    const h = await setup(t), user = h.accounts.member;
    verifyOwnership(h.store, user, '포근한바드', h.now());
    h.store.guild.apply(user.id, '포근한바드', h.now());
    const selected = await h.select();
    h.control.hook = () => {
      if (status === 'approved') { h.advance(60000); verifyOwnership(h.store, user, '포근한바드', h.now()); }
      h.store.guild.review(h.accounts.owner.id, user.id, status, 1, h.now());
    };
    const callback = await h.callback(await h.start(user, selected.revision));
    if (status === 'approved') assert.notEqual(callback.headers.get('location'), '/account.html?ownership=verified');
    assert.equal(h.store.guild.state(user.id).membership.status, status);
    assert.equal(h.store.guild.state(user.id).canViewSheet, status === 'approved');
    assert.equal((await h.request('/api/auth/guild/sheet')).status, status === 'approved' ? 200 : 403);
  }
});

test('manual rejection and revocation still require fresh staff review after reapplication and restart',async t=>{
 const h=await setup(t),a=h.accounts.member;verifyOwnership(h.store,a,'포근한바드',h.now());h.store.guild.apply(a.id,'포근한바드',h.now());h.store.guild.review(h.accounts.owner.id,a.id,'rejected',1,h.now());
 h.store.guild.apply(a.id,'포근한바드',h.now());assert.equal(h.store.guild.state(a.id).canViewSheet,false);h.store.guild.review(h.accounts.owner.id,a.id,'approved',3,h.now());
 h.store.guild.review(h.accounts.owner.id,a.id,'revoked',4,h.now());h.store.guild.apply(a.id,'포근한바드',h.now());const reopened=createStore(h.path);try{assert.equal(reopened.guild.state(a.id).membership.status,'pending');assert.equal(reopened.guild.state(a.id).canViewSheet,false);}finally{reopened.close();}
 assert.equal((await h.request('/api/auth/guild/automatic',a,{revision:6})).status,410);assert.equal((await h.request('/api/auth/guild/sheet')).status,403);
});

test('Discord ownership cannot bypass the final unique approved-character review guard',async t=>{
 const h=await setup(t);await h.select();verifyOwnership(h.store,h.accounts.other,'포근한바드',h.now());h.store.guild.apply(h.accounts.other.id,'포근한바드',h.now());
 h.control.hook=()=>h.store.guild.review(h.accounts.owner.id,h.accounts.other.id,'approved',1,h.now());
 assert.equal((await h.callback(await h.start())).headers.get('location'),'/account.html?ownership=verified');assert.equal(h.store.guild.state(h.accounts.member.id).membership,null);
 h.store.guild.apply(h.accounts.member.id,'포근한바드',h.now());assert.throws(()=>h.store.guild.review(h.accounts.owner.id,h.accounts.member.id,'approved',1,h.now()),{code:'character_already_verified'});assert.equal((await h.request('/api/auth/guild/sheet')).status,403);
});

test('migration retains pending ownership and cascades proofs on old-style account deletion',async t=>{
 const h=await setup(t);await h.select();h.advance(60000);h.store.ownership.renew(h.accounts.member.id,digest(h.accounts.member.token),1,h.now());await h.start(h.accounts.member,2);
 const db=new DatabaseSync(h.path);db.exec('PRAGMA foreign_keys=ON; PRAGMA user_version=3;');const upgraded=createStore(h.path);upgraded.close();assert.equal(db.prepare('PRAGMA user_version').get().user_version,8);
 assert.equal(h.store.ownership.summary(h.accounts.member.id).state,'pending');assert.equal(h.store.guild.state(h.accounts.member.id).membership,null);
 db.exec('PRAGMA user_version=1;');db.prepare('DELETE FROM users WHERE id=?').run(h.accounts.member.id);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ownership_discord_transactions').get().count,0);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ownership_challenges').get().count,0);
 const restored=createStore(h.path);restored.close();db.close();assert.equal((await h.request('/api/auth/guild')).status,401);
});

test('configuration enables Discord ownership proof only with complete credentials and validates IDs', () => {
  const base = { WEB_ORIGIN: origin, WEB_DB_PATH: join(tmpdir(), 'unused.sqlite'), DISCORD_OAUTH_CLIENT_ID: '1234', DISCORD_OAUTH_CLIENT_SECRET: 'test-secret', GUILD_AUTO_APPROVAL_ENABLED: 'true', GUILD_AUTO_DISCORD_GUILD_ID: guildId, GUILD_AUTO_DISCORD_ROLE_ID: roleId, LOSTARK_API_KEY: 'test-key' };
  assert.equal(loadConfig(base).automaticApproval.enabled, true);
  assert.equal(loadConfig({ ...base, LOSTARK_API_KEY: '' }).automaticApproval.enabled, false);
  assert.equal(loadConfig({ ...base, GUILD_AUTO_APPROVAL_ENABLED: '' }).automaticApproval.enabled, false);
  assert.throws(() => loadConfig({ ...base, GUILD_AUTO_DISCORD_GUILD_ID: 'https://wrong.example' }));
});

test('parallel callbacks consume one proof and an external wait cannot extend its deadline', async t => {
  const h = await setup(t); await h.select(); const flow = await h.start();
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  h.control.hook = async () => { entered(); await waiting; };
  const first = h.callback(flow); await reached;
  const second = await h.callback(flow); assert.notEqual(second.headers.get('location'), '/account.html?ownership=verified');
  release(); assert.equal((await first).headers.get('location'), '/account.html?ownership=verified');
  assert.equal(h.calls.filter(url => url.includes('/profiles')).length, 1);
  const expired = await setup(t); await expired.select(); expired.control.hook = () => expired.advance(300001);
  assert.match((await expired.callback(await expired.start())).headers.get('location'), /ownership_state_changed/);
  assert.equal((await expired.request('/api/auth/guild/sheet')).status, 403);
});

test('Discord member timeout fails closed and keeps the separate STOVE challenge available',async t=>{
 const h=await setup(t),initial=await h.select();h.control.mode='timeout';assert.match((await h.callback(await h.start())).headers.get('location'),/automatic_unavailable/);
 const final=await(await h.request('/api/auth/ownership')).json();assert.equal(final.state,'pending');assert.equal(final.challenge.code,initial.challenge.code);assert.equal(h.store.guild.state(h.accounts.member.id).membership,null);
});
