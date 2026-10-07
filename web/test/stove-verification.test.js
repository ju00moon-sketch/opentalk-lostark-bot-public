import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyStoveCharacter } from '../src/stove-verification.js';

const code = 'PG-' + 'ABC123'.repeat(4);
const account = '12345678';
const base = { profileUrl: `https://profile.onstove.com/ko/${account}`, characterName: '합성캐릭터4', code };
const roster = `<span class="profile-character-info__name" title="대표캐릭">대표캐릭</span>
  <div id="expand-character-list" class="profile-character-list"><ul class="profile-character-list__char">
  <li><button onclick="location.href='/Profile/Character/대표캐릭'"><span>대표캐릭</span></button></li>
  <li><button onclick="location.href='/Profile/Character/합성캐릭터4'"><span>합성캐릭터4</span></button></li></ul></div>`;
function fixture(change = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const i = calls.length - 1;
    if (change[i]) return change[i](url, options);
    return [
      () => Response.json({ code: 0, value: { member_no: Number(account), myhome_visible: true, introduce: `안녕하세요.\n${code}` } }),
      () => Response.json({ isCharacter: true, encryptMemberNo: 'abcd1234ABCD5678abcd1234ABCD5678abcd1234ABCD5678=' }),
      () => new Response(null, { status: 302, headers: { Location: '/Profile/Character/' + encodeURIComponent('대표캐릭') } }),
      () => new Response(roster),
    ][i]();
  };
  return { calls, fetchImpl };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('verified introduction and same-account roster are required; legacy URL is canonicalized', async () => {
  for (const profileUrl of [base.profileUrl, `https://timeline.onstove.com/${account}`, `https://profile.onstove.com/${account}/`]) {
    const f = fixture();
    assert.deepEqual(await verifyStoveCharacter({ ...base, profileUrl, fetchImpl: f.fetchImpl }), { stoveAccountId: account, characterName: base.characterName });
    assert.equal(f.calls.length, 4);
    assert.equal(f.calls[0].url, `https://api.onstove.com/myhome/v1.1/members/${account}/profile`);
    assert.equal(f.calls[0].options.headers['X-Lang'], 'KO');
    assert.equal(f.calls[1].options.method, 'POST');
    assert.equal(String(f.calls[1].options.body), `memberNo=${account}`);
    for (const c of f.calls) {
      assert.equal(c.options.redirect, 'manual');
      assert.equal(c.options.credentials, 'omit');
      assert.equal(c.options.headers.Authorization, undefined);
      assert.equal(c.options.headers.Cookie, undefined);
    }
  }
});

test('untrusted profile URLs and invalid inputs never make a request', async () => {
  for (const profileUrl of ['http://profile.onstove.com/12345678', 'https://profile.onstove.com.evil.test/12345678',
    'https://maintainer@example.com/12345678', 'https://profile.onstove.com:444/12345678', 'https://profile.onstove.com/ko/12345678?next=https://evil.test',
    'https://profile.onstove.com/ko/12345678#x', 'https://profile.onstove.com/ko/../12345678', 'https://127.0.0.1/12345678']) {
    const f = fixture();
    await rejects(verifyStoveCharacter({ ...base, profileUrl, fetchImpl: f.fetchImpl }), 'stove_profile_invalid');
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await rejects(verifyStoveCharacter({ ...base, code: 'x', fetchImpl: f.fetchImpl }), 'stove_unavailable');
  assert.equal(f.calls.length, 0);
});

test('exact standalone code, public profile and requested account identity are checked before character requests', async () => {
  for (const [value, error] of [
    [{ member_no: Number(account), myhome_visible: true, introduce: code + 'abc' }, 'stove_code_missing'],
    [{ member_no: Number(account), myhome_visible: true, introduce: 'x' + code }, 'stove_code_missing'],
    [{ member_no: Number(account), myhome_visible: false, introduce: code }, 'stove_private'],
    [{ member_no: 87654321, myhome_visible: true, introduce: code }, 'stove_unavailable'],
    [{ member_no: Number(account), myhome_visible: true, introduce: { code } }, 'stove_unavailable'],
  ]) {
    const f = fixture({ 0: () => Response.json({ code: 0, value }) });
    await rejects(verifyStoveCharacter({ ...base, fetchImpl: f.fetchImpl }), error);
    assert.equal(f.calls.length, 1);
  }
});

test('own introduction does not prove another character, including names in unrelated HTML', async () => {
  const f = fixture({ 3: () => new Response(roster.replaceAll('합성캐릭터4', '다른캐릭') + '<p>합성캐릭터4</p>') });
  await rejects(verifyStoveCharacter({ ...base, fetchImpl: f.fetchImpl }), 'stove_character_mismatch');
  const absent = fixture({ 1: () => Response.json({ isCharacter: false }) });
  await rejects(verifyStoveCharacter({ ...base, fetchImpl: absent.fetchImpl }), 'stove_character_mismatch');
});

test('only the official account redirect into a character page is followed', async () => {
  for (const location of ['https://evil.test/Profile/Character/대표캐릭', '//evil.test/', '/Mypage', '/Profile/Character/대표캐릭?next=x', '/Profile/Character/a%2Fb']) {
    const f = fixture({ 2: () => new Response(null, { status: 302, headers: { Location: location } }) });
    await rejects(verifyStoveCharacter({ ...base, fetchImpl: f.fetchImpl }), 'stove_unavailable');
    assert.equal(f.calls.length, 3);
  }
  const f = fixture({ 3: () => new Response(roster.replaceAll('대표캐릭', '잘못된대표')) });
  await rejects(verifyStoveCharacter({ ...base, fetchImpl: f.fetchImpl }), 'stove_unavailable');
});

test('malformed, oversized and redirecting upstream responses fail closed', async () => {
  for (const response of [new Response('bad json'), new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }),
    new Response('x'.repeat(70000)), Response.json({ code: 0, value: null }), new Response('', { status: 429 })]) {
    const f = fixture({ 0: () => response });
    await rejects(verifyStoveCharacter({ ...base, fetchImpl: f.fetchImpl }), 'stove_unavailable');
    assert.equal(f.calls.length, 1);
  }
  const malformed = Buffer.concat([Buffer.from('{"code":0,"value":{"member_no":12345678,"myhome_visible":true,"introduce":"'), Buffer.from(code + ' '), Buffer.from([0xff]), Buffer.from('"}}')]);
  const f = fixture({ 0: () => new Response(malformed) });
  await rejects(verifyStoveCharacter({ ...base, fetchImpl: f.fetchImpl }), 'stove_unavailable');
});

test('aborted requests and stalled bodies cannot outlive the verifier deadline', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture();
  await rejects(verifyStoveCharacter({ ...base, fetchImpl: f.fetchImpl, signal: controller.signal }), 'stove_unavailable');
  assert.equal(f.calls.length, 0);
  const started = Date.now();
  await rejects(verifyStoveCharacter({ ...base, timeoutMs: 20, fetchImpl: async () => new Promise(() => {}) }), 'stove_unavailable');
  assert.ok(Date.now() - started < 500);
  await rejects(verifyStoveCharacter({ ...base, timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) }), 'stove_unavailable');
});
