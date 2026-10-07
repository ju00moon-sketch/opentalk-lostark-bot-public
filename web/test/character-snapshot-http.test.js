import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWebServer } from '../src/server.js';
import { approvedRequester } from './helpers/access.js';

test('display snapshots survive restart, refresh on search, and remain behind approval', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'character-snapshot-http-'));
  const dbPath = join(directory, 'auth.sqlite');
  const config = { origin: 'https://opentalk.example.invalid', host: '127.0.0.1', port: 0,
    dbPath, providers: {}, automaticApproval: { lostArkApiKey: 'synthetic-key' } };
  let timestamp = 1790000000000, level = 1740, responseStatus = 200, calls = 0, app;
  const now = () => timestamp;
  const fetchImpl = async () => {
    calls++;
    if (responseStatus !== 200) return Response.json({ private: 'never expose' }, { status: responseStatus });
    return Response.json({ CharacterName: '테스트바드', ServerName: '루페온', CharacterClassName: '바드', ItemAvgLevel: String(level) });
  };
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  async function start() {
    app = createWebServer({ config, fetchImpl, now });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    return `http://127.0.0.1:${app.server.address().port}/api/character/spec?name=${encodeURIComponent('테스트바드')}&section=profile`;
  }
  let url = await start();
  const request = approvedRequester(dbPath, timestamp);
  const initial = await request(url + '&refresh=1');
  assert.equal(initial.status, 200);
  const first = await initial.json();
  assert.equal(first.source, 'live');
  assert.equal(first.profile.itemLevel, 1740);
  level = 1750; timestamp += 1000;
  const newer = await (await request(url + '&refresh=1')).json();
  assert.equal(newer.profile.itemLevel, 1750);
  assert.ok(newer.capturedAt > first.capturedAt);
  assert.equal(calls, 2, 'explicit search bypasses fresh memory cache');

  await app.close();
  responseStatus = 503; timestamp += 1000;
  url = await start();
  const beforeDenied = calls;
  const anonymous = await fetch(url);
  assert.equal(anonymous.status, 200, 'character lookup is public');
  assert.equal((await anonymous.json()).source, 'saved');
  assert.equal(calls, beforeDenied + 1, 'a public lookup tries the official API once before falling back to the saved copy');
  const savedResponse = await request(url + '&refresh=1');
  assert.equal(savedResponse.headers.get('cache-control'), 'no-store');
  const saved = await savedResponse.json();
  assert.equal(saved.source, 'saved');
  assert.equal(saved.profile.itemLevel, 1750);
  assert.equal(saved.capturedAt, newer.capturedAt);
  assert.equal(saved.refreshFailed, 'official_unavailable');
  assert.equal(JSON.stringify(saved).includes('never expose'), false);
  for (const suffix of ['&refresh=2', '&refresh=1&refresh=1', '&name=다른캐릭터']) {
    assert.equal((await request(url + suffix)).status, 400);
  }
  responseStatus = 404;
  assert.equal((await request(url + '&refresh=1')).status, 404);
  responseStatus = 503;
  assert.equal((await request(url + '&refresh=1')).status, 502, 'authoritative not-found prevents resurrecting old identities');
});
