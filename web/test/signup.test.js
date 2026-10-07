import { verifyOwnership } from './helpers/access.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createWebServer } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createUnlinkInbox } from '../src/inbox.js';

const origin = 'https://opentalk.example.invalid';
const lookupPath = '/api/auth/signup/character';
const completePath = '/api/auth/signup/complete';
const input = { nickname: '포근한회원', characterName: '포근한바드' };
const character = { characterName: input.characterName, serverName: '루페온', characterClass: '바드', itemLevel: 1740.83 };
const digest = value => createHash('sha256').update(value).digest('hex');
const sessionCookie = response => response.headers.getSetCookie().find(value => value.startsWith('__Host-web_session='))?.split(';')[0];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function setup(t, { gameKey = 'synthetic-game-key' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'web-signup-'));
  const path = join(dir, 'auth.sqlite');
  const config = {
    origin, host: '127.0.0.1', port: 0, dbPath: path,
    providers: {
      discord: { clientId: '123456789', clientSecret: 'synthetic-discord-secret' },
      kakao: { clientId: 'synthetic-kakao-client', clientSecret: 'synthetic-kakao-secret', adminKey: 'synthetic-admin-key', appId: '123456' },
    },
    automaticApproval: { enabled: false, lostArkApiKey: gameKey },
  };
  let clock = 1790000000000;
  let service;
  let base;
  const store = createStore(path);
  const control = { mode: 'normal', profileHook: null, providerId: '3456789012', providerName: '공급자닉네임' };
  const calls = [];
  const challenges = new Map();
  const fetchImpl = async (value, init) => {
    const url = new URL(value);
    calls.push(`${url.origin}${url.pathname}`);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (url.origin === 'https://developer-lostark.game.onstove.com') {
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.Authorization, 'bearer synthetic-game-key');
      assert.match(url.pathname, /^\/armories\/characters\/[^/]+\/profiles$/);
      if (control.profileHook) await control.profileHook();
      if (control.mode === 'null') return Response.json(null);
      if (control.mode.startsWith('http-')) return Response.json({ message: 'private upstream failure' }, { status: Number(control.mode.slice(5)) });
      if (control.mode === 'malformed') return Response.json({ CharacterName: input.characterName, ItemAvgLevel: '1740.83oops' });
      if (control.mode === 'array') return Response.json([]);
      if (control.mode === 'oversize') return new Response('x'.repeat(65537), { headers: { 'Content-Type': 'application/json' } });
      const name = decodeURIComponent(url.pathname.split('/')[3]);
      return Response.json({
        CharacterName: control.mode === 'different-character' ? '다른바드' : name,
        ServerName: character.serverName, CharacterClassName: character.characterClass,
        ItemAvgLevel: '1,740.83', GuildName: '다른길드', CharacterImage: 'https://example.invalid/private-profile.png',
      });
    }
    if (url.pathname.endsWith('/token')) {
      assert.ok(['https://kauth.kakao.com', 'https://discord.com'].includes(url.origin));
      const body = new URLSearchParams(init.body);
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenges.get(body.get('code')));
      return Response.json({ access_token: 'synthetic-access-token', token_type: 'Bearer' });
    }
    if (url.origin === 'https://kapi.kakao.com' && url.pathname === '/v2/user/me') {
      return Response.json({ id: Number(control.providerId), kakao_account: { profile: { nickname: control.providerName } } });
    }
    if (url.origin === 'https://discord.com' && url.pathname === '/api/v10/users/@me') {
      return Response.json({ id: control.providerId, username: control.providerName });
    }
    if (url.origin === 'https://kapi.kakao.com' && url.pathname === '/v1/user/unlink') {
      assert.equal(init.headers.Authorization, 'KakaoAK synthetic-admin-key');
      return Response.json({ id: Number(new URLSearchParams(init.body).get('target_id')) });
    }
    assert.fail(`Unexpected external request: ${url.origin}${url.pathname}`);
  };
  async function open() {
    service = createWebServer({ config, fetchImpl, now: () => clock });
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    base = `http://127.0.0.1:${service.server.address().port}`;
  }
  await open();
  t.after(async () => { await service.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const raw = (route, options = {}) => fetch(base + route, { redirect: 'manual', ...options });
  async function request(route, auth, body, options = {}) {
    const response = await raw(route, {
      method: body === undefined ? 'GET' : 'POST', ...options,
      headers: {
        ...(auth ? { Cookie: auth.cookie, Origin: origin, 'X-CSRF-Token': auth.csrfToken } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
    return { status: response.status, headers: response.headers, data };
  }
  async function login(provider = 'kakao', providerId = '3456789012', oldCookie) {
    control.providerId = providerId;
    const start = await raw(`/auth/${provider}/start`, { headers: oldCookie ? { Cookie: oldCookie } : {} });
    assert.equal(start.status, 302);
    const url = new URL(start.headers.get('location'));
    const state = url.searchParams.get('state');
    challenges.set(state, url.searchParams.get('code_challenge'));
    const binding = start.headers.getSetCookie().find(value => value.startsWith('__Host-web_binding='))?.split(';')[0];
    const callback = await raw(`/auth/${provider}/callback?state=${state}&code=${state}`, { headers: { Cookie: [binding, oldCookie].filter(Boolean).join('; ') } });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/account.html');
    const cookie = sessionCookie(callback);
    assert.ok(cookie);
    const session = await request('/api/auth/session', { cookie });
    assert.equal(session.status, 200);
    return { cookie, ...session.data, id: session.data.user.id, providerId };
  }
  async function preview(auth, fields = input) {
    const result = await request(lookupPath, auth, fields);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.match(result.data.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(result.data.expiresIn, 300);
    return result.data;
  }
  const gameCalls = () => calls.filter(value => value.startsWith('https://developer-lostark.game.onstove.com/')).length;
  return { path, config, store, control, calls, raw, request, login, preview, gameCalls,
    advance(ms) { clock += ms; }, now: () => clock,
    async restart() { await service.close(); await open(); },
  };
}

test('Kakao OAuth starts pending and verified signup records only a profile, without approving the guild', async t => {
  const h = await setup(t);
  const auth = await h.login();
  assert.deepEqual(auth.registration, { state: 'pending', character: null });
  assert.equal(h.gameCalls(), 0);
  const preview = await h.preview(auth);
  assert.deepEqual(preview.character, character);
  assert.deepEqual(h.store.signup.state(auth.id), { state: 'pending', character: null });
  const result = await h.request(completePath, auth, { ...input, ticket: preview.ticket });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.registration, { state: 'complete', character });
  assert.equal(h.gameCalls(), 1, 'confirmation uses the server-verified preview');
  const session = await h.request('/api/auth/session', auth);
  assert.equal(session.data.user.id, auth.id);
  assert.equal(session.data.user.displayName, input.nickname);
  assert.deepEqual(session.data.registration, { state: 'complete', character });
  const guild = await h.request('/api/auth/guild', auth);
  assert.equal(guild.status, 200);
  assert.deepEqual(guild.data, { role: 'member', membership: null, canViewSheet: false, verification: null });
  assert.equal((await h.request('/api/auth/guild/sheet', auth)).status, 403);
  assert.equal((await h.request(completePath, auth, { ...input, ticket: preview.ticket })).status, 409);
  for (const result of [session, guild]) assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('incomplete Kakao signup may inspect membership but cannot bypass ownership, approval or logout checks', async t => {
  const h = await setup(t); const auth = await h.login();
  const own = await h.request('/api/auth/guild', auth);
  assert.equal(own.status, 200); assert.equal(own.data.membership, null); assert.equal(own.data.canViewSheet, false);
  for (const suffix of ['/sheet', '/members']) {
    const result = await h.request(`/api/auth/guild${suffix}`, auth);
    assert.equal(result.status, 403);
    assert.deepEqual(result.data, { error: 'forbidden' });
  }
  const apply = await h.request('/api/auth/guild/apply', auth, { characterName: character.characterName });
  assert.equal(apply.status, 403); assert.deepEqual(apply.data, { error: 'ownership_required' });
  for (const suffix of ['/verification', '/automatic']) {
    const result = await h.request(`/api/auth/guild${suffix}`, auth, { revision: 1 });
    assert.equal(result.status, 410); assert.deepEqual(result.data, { error: 'ownership_required' });
  }
  for (const suffix of ['/review', '/role']) assert.equal((await h.request(`/api/auth/guild${suffix}`, auth, {})).status, 403);
  assert.equal((await h.request('/api/auth/guild/sheet/edit', auth, { sheetId: 'weekly', groupId: 'entry', revision: 1, values: {} })).status, 403);
  assert.equal((await h.request('/api/auth/logout', auth, undefined, { method: 'POST' })).status, 204);
  assert.equal((await h.request(lookupPath, auth, input)).status, 401);
  assert.equal(h.gameCalls(), 0);
});

test('signup endpoints enforce identity, origin, CSRF, strict input and method checks before external calls', async t => {
  const h = await setup(t); const auth = await h.login(); const discord = await h.login('discord', '1234567890');
  assert.equal((await h.request(lookupPath, null, input)).status, 401);
  assert.equal((await h.request(lookupPath, discord, input)).status, 403);
  assert.equal((await h.request(lookupPath, auth, input, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await h.request(lookupPath, auth, input, { headers: { 'X-CSRF-Token': 'forged' } })).status, 403);
  assert.equal((await h.request(lookupPath, auth)).status, 405);
  assert.equal((await h.request(`${lookupPath}?extra=1`, auth, input)).status, 400);
  for (const fields of [null, [], {}, { ...input, verified: true }, { nickname: 'a', characterName: input.characterName },
    { ...input, nickname: 'a'.repeat(21) }, { ...input, nickname: '숨김\u200b문자' }, { ...input, nickname: '제어\n문자' },
    { ...input, characterName: '../profiles' }, { ...input, characterName: '한 글' }]) {
    assert.equal((await h.request(lookupPath, auth, fields)).status, 400, JSON.stringify(fields));
  }
  assert.equal((await h.request(completePath, auth, { ...input, ticket: 'x', itemLevel: 9999 })).status, 400);
  assert.equal(h.gameCalls(), 0);
});

test('preview tickets bind the account, session, nickname and character and expire at five minutes', async t => {
  const h = await setup(t); const auth = await h.login();
  const second = await h.login('kakao', '3456789013');
  const preview = await h.preview(auth);
  for (const [actor, fields] of [[auth, { ...input, ticket: 'x'.repeat(43) }], [second, { ...input, ticket: preview.ticket }],
    [auth, { ...input, nickname: '다른회원', ticket: preview.ticket }], [auth, { ...input, characterName: '다른바드', ticket: preview.ticket }]]) {
    const result = await h.request(completePath, actor, fields);
    assert.equal(result.status, 409);
    assert.equal(result.data.error, 'character_confirmation_expired');
  }
  const anotherSession = await h.login('kakao', auth.providerId);
  assert.equal((await h.request(completePath, anotherSession, { ...input, ticket: preview.ticket })).status, 409);
  h.advance(300000);
  assert.equal((await h.request(completePath, auth, { ...input, ticket: preview.ticket })).status, 409);
  assert.equal(h.store.signup.state(auth.id).state, 'pending');
  assert.equal(h.store.signup.state(second.id).state, 'pending');
});

test('a changed or failed search invalidates the preceding preview and a restart requires another lookup', async t => {
  const h = await setup(t); const auth = await h.login();
  const first = await h.preview(auth);
  const nextInput = { ...input, characterName: '새로운바드' };
  const second = await h.preview(auth, nextInput);
  assert.equal((await h.request(completePath, auth, { ...input, ticket: first.ticket })).status, 409);
  h.control.mode = 'null';
  assert.equal((await h.request(lookupPath, auth, input)).status, 404);
  assert.equal((await h.request(completePath, auth, { ...nextInput, ticket: second.ticket })).status, 409);
  h.control.mode = 'normal';
  const third = await h.preview(auth);
  await h.restart();
  assert.equal((await h.request(completePath, auth, { ...input, ticket: third.ticket })).status, 409);
  assert.equal(h.store.signup.state(auth.id).state, 'pending');
});

test('missing characters are distinguishable from unavailable or malformed external responses', async t => {
  const h = await setup(t); const auth = await h.login();
  for (const [mode, status, error] of [['null', 404, 'character_not_found'], ['http-404', 404, 'character_not_found'],
    ['http-429', 429, 'character_rate_limited'], ['http-500', 502, 'character_unavailable'],
    ['http-401', 502, 'character_unavailable'], ['malformed', 502, 'character_unavailable'],
    ['different-character', 502, 'character_unavailable'], ['array', 502, 'character_unavailable'], ['oversize', 502, 'character_unavailable']]) {
    h.control.mode = mode;
    // Each case examines a separate upstream response, after any shared 429 cooldown.
    h.advance(61000);
    const result = await h.request(lookupPath, auth, input);
    assert.equal(result.status, status, mode);
    assert.deepEqual(result.data, { error }, mode);
    assert.equal(h.store.signup.state(auth.id).state, 'pending');
  }
});

test('missing game credentials fail before a profile request without disabling Kakao login', async t => {
  const h = await setup(t, { gameKey: '' }); const auth = await h.login();
  assert.equal(auth.providers.kakao, true);
  const result = await h.request(lookupPath, auth, input);
  assert.equal(result.status, 503);
  assert.deepEqual(result.data, { error: 'character_unavailable' });
  assert.equal(h.gameCalls(), 0);
});

test('Korean input is normalized before confirmation and the stored nickname uses the normalized value', async t => {
  const h = await setup(t); const auth = await h.login();
  const fields = { nickname: ` ${input.nickname.normalize('NFD')} `, characterName: ` ${input.characterName.normalize('NFD')} ` };
  const preview = await h.preview(auth, fields);
  assert.deepEqual(preview.character, character);
  assert.equal((await h.request(completePath, auth, { ...input, ticket: preview.ticket })).status, 200);
  assert.equal((await h.request('/api/auth/session', auth)).data.user.displayName, input.nickname);
});

test('a failed nickname write rolls back the profile and leaves the confirmation retryable', async t => {
  const h = await setup(t); const auth = await h.login();
  const preview = await h.preview(auth);
  const db = new DatabaseSync(h.path);
  try {
    db.exec("CREATE TRIGGER prevent_signup_name BEFORE UPDATE OF display_name ON users BEGIN SELECT RAISE(FAIL, 'synthetic write failure'); END;");
    const denied = await h.request(completePath, auth, { ...input, ticket: preview.ticket });
    assert.equal(denied.status, 503);
    assert.deepEqual(denied.data, { error: 'storage_unavailable' });
    assert.deepEqual(h.store.signup.state(auth.id), { state: 'pending', character: null });
    assert.equal((await h.request('/api/auth/session', auth)).data.user.displayName, '공급자닉네임');
    db.exec('DROP TRIGGER prevent_signup_name;');
    assert.equal((await h.request(completePath, auth, { ...input, ticket: preview.ticket })).status, 200);
  } finally { db.close(); }
});

test('in-flight profile lookups recheck logout, session expiry and external unlink before issuing tickets', async t => {
  for (const action of ['logout', 'expiry', 'unlink', 'inbox']) {
    await t.test(action, async t => {
      const h = await setup(t); const auth = await h.login();
      const entered = deferred(); const release = deferred();
      h.control.profileHook = async () => { entered.resolve(); await release.promise; };
      const pending = h.request(lookupPath, auth, input);
      await entered.promise;
      try {
        if (action === 'logout') assert.equal((await h.request('/api/auth/logout', auth, undefined, { method: 'POST' })).status, 204);
        if (action === 'expiry') h.advance(7 * 86400000);
        if (action === 'unlink') {
          const response = await h.raw('/api/auth/kakao/unlink', { method: 'POST', headers: {
            Authorization: 'KakaoAK synthetic-admin-key', 'Content-Type': 'application/x-www-form-urlencoded',
          }, body: new URLSearchParams({ app_id: '123456', user_id: auth.providerId }).toString() });
          assert.equal(response.status, 200);
        }
        if (action === 'inbox') createUnlinkInbox(`${h.path}.unlink-inbox`).enqueue(auth.providerId);
      } finally { release.resolve(); }
      const result = await pending;
      assert.equal(result.status, 401);
      assert.deepEqual(result.data, { error: 'login_required' });
      assert.notEqual(h.store.signup.state(auth.id)?.state, 'complete');
    });
  }
});

test('parallel lookups are bounded per account and simultaneous confirmations commit once', async t => {
  const h = await setup(t); const auth = await h.login();
  const entered = deferred(); const release = deferred();
  h.control.profileHook = async () => { entered.resolve(); await release.promise; };
  const pending = h.request(lookupPath, auth, input);
  await entered.promise;
  try {
    const rejected = await h.request(lookupPath, auth, input);
    assert.equal(rejected.status, 429);
    assert.equal(h.gameCalls(), 1);
  } finally { release.resolve(); }
  const preview = (await pending).data;
  const results = await Promise.all([h.request(completePath, auth, { ...input, ticket: preview.ticket }), h.request(completePath, auth, { ...input, ticket: preview.ticket })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(h.store.signup.state(auth.id).state, 'complete');
  assert.equal(h.gameCalls(), 1);
});

test('completed Kakao names survive another OAuth login and restart while Discord names still refresh', async t => {
  const h = await setup(t); const auth = await h.login();
  const preview = await h.preview(auth);
  assert.equal((await h.request(completePath, auth, { ...input, ticket: preview.ticket })).status, 200);
  h.control.providerName = '변경된공급자이름';
  const renewed = await h.login('kakao', auth.providerId, auth.cookie);
  assert.equal(renewed.id, auth.id);
  assert.equal(renewed.user.displayName, input.nickname);
  assert.equal((await h.request('/api/auth/session', auth)).data.authenticated, false);
  await h.restart();
  assert.deepEqual((await h.request('/api/auth/session', renewed)).data.registration, { state: 'complete', character });
  const discord = await h.login('discord', '1234567890');
  assert.equal(discord.registration, undefined);
  h.control.providerName = '새디스코드이름';
  const nextDiscord = await h.login('discord', '1234567890', discord.cookie);
  assert.equal(nextDiscord.id, discord.id);
  assert.equal(nextDiscord.user.displayName, '새디스코드이름');
});

test('withdrawal and unlink cascade completed profiles and pending accounts may withdraw', async t => {
  for (const completed of [false, true]) {
    await t.test(completed ? 'completed' : 'pending', async t => {
      const h = await setup(t); const auth = await h.login();
      if (completed) {
        const preview = await h.preview(auth);
        assert.equal((await h.request(completePath, auth, { ...input, ticket: preview.ticket })).status, 200);
      }
      assert.equal((await h.request('/api/auth/account', auth, undefined, { method: 'DELETE' })).status, 204);
      assert.equal(h.store.signup.state(auth.id), null);
      assert.equal((await h.request('/api/auth/session', auth)).data.authenticated, false);
      const db = new DatabaseSync(h.path, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM kakao_profiles').get().count, 0);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { db.close(); }
    });
  }
});

test('schema five migration preserves identities, sessions and approval roles; legacy users can opt into signup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'web-signup-migration-'));
  const path = join(dir, 'auth.sqlite');
  let store = createStore(path);
  const now = 1790000000000;
  const accounts = [];
  for (const [index, provider] of ['kakao', 'discord'].entries()) {
    const token = randomBytes(32).toString('base64url');
    store.createSession({ provider, providerId: String(5000 + index), displayName: '기존회원', tokenHash: digest(token), expiresAt: now + 86400000, epoch: 0 }, now);
    accounts.push({ ...store.getSession(digest(token), now), token });
  }
  store.guild.bootstrapOwner(accounts[0].id, now);
  verifyOwnership(store, accounts[1], '기존바드', now);
  store.guild.apply(accounts[1].id, '기존바드', now);
  store.close();
  const db = new DatabaseSync(path);
  const tables = ['users', 'sessions', 'guild_memberships', 'guild_roles', 'guild_verifications'];
  const before = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  db.exec('DROP TABLE kakao_profiles; PRAGMA user_version=5;');
  db.close();
  t.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });
  store = createStore(path);
  const migrated = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 8);
    for (const table of tables) assert.deepEqual(migrated.prepare(`SELECT * FROM ${table}`).all(), before[table], table);
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { migrated.close(); }
  assert.deepEqual(store.signup.state(accounts[0].id), { state: 'legacy', character: null });
  assert.equal(store.signup.state(accounts[1].id), null);
  assert.equal(store.getSession(digest(accounts[0].token), now).id, accounts[0].id);
  const guildBefore = store.guild.state(accounts[0].id, now);
  assert.equal(guildBefore.role, 'owner');
  assert.equal(guildBefore.canViewSheet, true);
  assert.deepEqual(store.signup.complete(accounts[0].id, input.nickname, character, now), { state: 'complete', character });
  assert.deepEqual(store.guild.state(accounts[0].id, now), guildBefore);
  store.externalUnlink('5000');
  assert.equal(store.signup.state(accounts[0].id), null);
  assert.equal(store.getSession(digest(accounts[0].token), now), undefined);
});
