import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, lstatSync, existsSync,
  symlinkSync, linkSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWelcomePlatform } from '../src/kakao/welcome-platform.js';

const linux = { skip: process.platform !== 'linux' };
function fixture(t, key = randomBytes(32)) {
  const root = mkdtempSync(join(tmpdir(), 'opentalk-welcome-platform-test-'));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  const credentials = join(root, 'credentials');
  mkdirSync(credentials, { mode: 0o700 });
  const keyPath = join(credentials, 'welcome-key');
  writeFileSync(keyPath, key, { mode: 0o600 });
  const env = { KAKAO_WELCOME_STATE: state, CREDENTIALS_DIRECTORY: credentials };
  return { root, state, credentials, keyPath, env, key,
    open: () => createWelcomePlatform({ platform: 'linux', env }) };
}

test('Linux creates private state, replaces files atomically, and blocks path traversal', linux, (t) => {
  const f = fixture(t);
  const platform = f.open();
  assert.equal(lstatSync(f.state).mode & 0o777, 0o700);
  assert.equal(lstatSync(f.state).uid, process.getuid());
  platform.save('receiver.json', '{"generation":1}');
  platform.save('receiver.json', '{"generation":2}');
  assert.equal(readFileSync(platform.pathFor('receiver.json'), 'utf8'), '{"generation":2}');
  assert.equal(lstatSync(platform.pathFor('receiver.json')).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.state, 'receiver.json.tmp')), false);
  for (const name of ['../outside', '/absolute', 'folder/file', 'folder\\file', '', '..'])
    assert.throws(() => platform.pathFor(name), /STATE_FILENAME_INVALID/);
});

test('Linux refuses shared or wrong-owner state and unsafe existing file permissions', linux, (t) => {
  const f = fixture(t);
  mkdirSync(f.state, { mode: 0o755 });
  chmodSync(f.state, 0o755);
  assert.throws(f.open, /STATE_DIRECTORY_PERMISSIONS/);
  chmodSync(f.state, 0o700);
  assert.throws(() => createWelcomePlatform({ platform: 'linux', env: f.env, uid: process.getuid() + 1 }), /STATE_DIRECTORY_PERMISSIONS/);
  const platform = f.open();
  const file = join(f.state, 'receiver.json');
  writeFileSync(file, '{}', { mode: 0o600 });
  chmodSync(file, 0o640);
  assert.throws(() => platform.pathFor('receiver.json'), /STATE_FILE_PERMISSIONS/);
  assert.throws(() => platform.save('receiver.json', 'replacement'), /STATE_FILE_PERMISSIONS/);
  assert.equal(readFileSync(file, 'utf8'), '{}');
});

test('Linux rejects linked state directories, symlink files and hard-linked files', linux, (t) => {
  const f = fixture(t);
  const real = join(f.root, 'actual-state');
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, f.state, 'dir');
  assert.throws(f.open, /STATE_DIRECTORY_INVALID/);
  unlinkSync(f.state);
  const platform = f.open();
  const outside = join(f.root, 'outside');
  writeFileSync(outside, 'preserve', { mode: 0o600 });
  symlinkSync(outside, join(f.state, 'linked.json'));
  assert.throws(() => platform.pathFor('linked.json'), /STATE_FILE_INVALID/);
  linkSync(outside, join(f.state, 'hard.json'));
  assert.throws(() => platform.pathFor('hard.json'), /STATE_FILE_INVALID/);
  assert.equal(readFileSync(outside, 'utf8'), 'preserve');
});

test('a dangling temporary symlink cannot redirect a state write outside its directory', linux, (t) => {
  const f = fixture(t);
  const platform = f.open();
  platform.save('credential.aes256', 'previous ciphertext');
  const outside = join(f.root, 'must-not-be-created');
  symlinkSync(outside, join(f.state, 'credential.aes256.tmp'));
  assert.throws(() => platform.save('credential.aes256', 'new ciphertext'), /STATE_FILE_INVALID/);
  assert.equal(existsSync(outside), false);
  assert.equal(readFileSync(join(f.state, 'credential.aes256'), 'utf8'), 'previous ciphertext');
  symlinkSync(outside, join(f.state, 'other.json'));
  assert.throws(() => platform.pathFor('other.json'), /STATE_FILE_INVALID/);
});

test('Linux requires a private 32-byte systemd key and rejects linked key files', linux, (t) => {
  const f = fixture(t);
  assert.throws(() => createWelcomePlatform({ platform: 'linux', env: { KAKAO_WELCOME_STATE: f.state } }), /SERVICE_CREDENTIAL_DIRECTORY_REQUIRED/);
  chmodSync(f.keyPath, 0o640);
  assert.throws(f.open, /SERVICE_KEY_PERMISSIONS/);
  chmodSync(f.keyPath, 0o600);
  writeFileSync(f.keyPath, randomBytes(31));
  assert.throws(f.open, /SERVICE_KEY_INVALID/);
  unlinkSync(f.keyPath);
  const alternate = join(f.root, 'alternate-key');
  writeFileSync(alternate, randomBytes(32), { mode: 0o600 });
  symlinkSync(alternate, f.keyPath);
  assert.throws(f.open, /SERVICE_KEY_PERMISSIONS/);
  unlinkSync(f.keyPath);
  linkSync(alternate, f.keyPath);
  assert.throws(f.open, /SERVICE_KEY_PERMISSIONS/);
});

test('tokens are randomized authenticated ciphertext and survive reopening with the same key', linux, async (t) => {
  const f = fixture(t);
  const platform = f.open();
  const plaintext = JSON.stringify({ accessToken: 'synthetic-private-token', userId: '500' });
  const encrypted = await platform.protect(plaintext);
  assert.notEqual(encrypted, await platform.protect(plaintext));
  assert.ok(!encrypted.includes('synthetic-private-token'));
  assert.ok(!encrypted.includes(f.key.toString('base64')));
  assert.equal(platform.credentialFile, 'credential.aes256');
  platform.save(platform.credentialFile, encrypted);
  const reopened = f.open();
  assert.equal(await reopened.protect(readFileSync(reopened.pathFor(reopened.credentialFile), 'utf8'), true), plaintext);
  assert.equal(lstatSync(reopened.pathFor(reopened.credentialFile)).mode & 0o777, 0o600);
});

test('wrong keys and ciphertext, nonce or tag modifications fail without exposing plaintext', linux, async (t) => {
  const f = fixture(t);
  const platform = f.open();
  const encrypted = await platform.protect('synthetic-private-token');
  const wrong = fixture(t).open();
  await assert.rejects(wrong.protect(encrypted, true), { message: 'CREDENTIAL_PROTECTION_FAILED' });
  for (const field of ['nonce', 'tag', 'data']) {
    const changed = JSON.parse(encrypted);
    const bytes = Buffer.from(changed[field], 'base64'); bytes[0] ^= 1;
    changed[field] = bytes.toString('base64');
    await assert.rejects(platform.protect(JSON.stringify(changed), true), { message: 'CREDENTIAL_PROTECTION_FAILED' });
  }
  for (const invalid of ['{', 'null', '{"v":2}', '{"v":1,"nonce":"","tag":"","data":""}'])
    await assert.rejects(platform.protect(invalid, true), { message: 'CREDENTIAL_PROTECTION_FAILED' });
});

test('unsupported platforms and relative paths fail before accessing account data', linux, () => {
  assert.throws(() => createWelcomePlatform({ platform: 'darwin' }), /UNSUPPORTED_PLATFORM/);
  assert.throws(() => createWelcomePlatform({ platform: 'linux', env: { KAKAO_WELCOME_STATE: './relative' } }), /ABSOLUTE_STATE_DIRECTORY_REQUIRED/);
});
