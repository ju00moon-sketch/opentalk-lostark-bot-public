import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { requireWelcome, WelcomeError } from './welcome.js';

// Linux keeps the wrapping key in a root-owned file supplied by systemd LoadCredential.
// The token and ordinary state files never contain that key or the account password.
export function createWelcomePlatform({ platform = process.platform, env = process.env,
  uid = process.getuid?.() } = {}) {
  requireWelcome(['linux', 'win32'].includes(platform), 'UNSUPPORTED_PLATFORM');
  const linux = platform === 'linux';
  const stateDir = env.KAKAO_WELCOME_STATE || (!linux && env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, 'OpenTalk', 'kakao-welcome-loco') : undefined);
  requireWelcome(stateDir && isAbsolute(stateDir), 'ABSOLUTE_STATE_DIRECTORY_REQUIRED');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(stateDir);
  requireWelcome(directory.isDirectory() && !directory.isSymbolicLink(), 'STATE_DIRECTORY_INVALID');
  if (linux) requireWelcome(directory.uid === uid && (directory.mode & 0o077) === 0, 'STATE_DIRECTORY_PERMISSIONS');
  function pathFor(name) {
    requireWelcome(/^[a-z][a-z0-9.-]*$/.test(name), 'STATE_FILENAME_INVALID');
    const path = join(stateDir, name);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      requireWelcome(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'STATE_FILE_INVALID');
      if (linux) requireWelcome(stat.uid === uid && (stat.mode & 0o077) === 0, 'STATE_FILE_PERMISSIONS');
    }
    return path;
  }
  function save(name, text) {
    const target = pathFor(name), temp = pathFor(`${name}.tmp`);
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, target);
  }
  let key;
  if (linux) {
    requireWelcome(env.CREDENTIALS_DIRECTORY && isAbsolute(env.CREDENTIALS_DIRECTORY), 'SERVICE_CREDENTIAL_DIRECTORY_REQUIRED');
    const keyPath = join(env.CREDENTIALS_DIRECTORY, 'welcome-key');
    const stat = lstatSync(keyPath);
    const parent = lstatSync(env.CREDENTIALS_DIRECTORY);
    // systemd grants only the service UID an ACL; stat reports that ACL mask as
    // group read/search (0550 directory, 0440 file), although group:: is empty.
    const systemdAcl = /^\/run\/credentials\/[^/]+$/.test(env.CREDENTIALS_DIRECTORY)
      && parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && parent.gid === 0
      && (parent.mode & 0o777) === 0o550 && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o777) === 0o440;
    requireWelcome(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && ((stat.mode & 0o077) === 0 || systemdAcl) && [0, uid].includes(stat.uid), 'SERVICE_KEY_PERMISSIONS');
    key = readFileSync(keyPath);
    requireWelcome(key.length === 32, 'SERVICE_KEY_INVALID');
  }
  async function protect(text, decrypt = false) {
    if (!linux) return windowsProtect(text, decrypt);
    try {
      requireWelcome(typeof text === 'string' && text.length <= 65536, 'CREDENTIAL_SIZE_INVALID');
      if (!decrypt) {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        return JSON.stringify({ v: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
          data: ciphertext.toString('base64') });
      }
      const data = JSON.parse(text);
      requireWelcome(data.v === 1 && ['nonce', 'tag', 'data'].every(field => typeof data[field] === 'string'), 'CREDENTIAL_FORMAT_INVALID');
      const nonce = Buffer.from(data.nonce, 'base64'), tag = Buffer.from(data.tag, 'base64');
      requireWelcome(nonce.length === 12 && tag.length === 16, 'CREDENTIAL_FORMAT_INVALID');
      const cipher = createDecipheriv('aes-256-gcm', key, nonce);
      cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(Buffer.from(data.data, 'base64')), cipher.final()]).toString('utf8');
    } catch { throw new WelcomeError('CREDENTIAL_PROTECTION_FAILED'); }
  }
  return { stateDir, pathFor, save, protect,
    credentialFile: linux ? 'credential.aes256' : 'credential.dpapi',
    protection: linux ? 'AES-256-GCM with systemd credential' : 'Windows CurrentUser' };
}

async function windowsProtect(text, decrypt) {
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const command = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = []; let size = 0;
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size <= 32768) chunks.push(chunk); else child.kill(); });
    child.on('error', () => { clearTimeout(timer); reject(new WelcomeError('CREDENTIAL_PROTECTION_FAILED')); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString().trim();
      if (code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(output)) return reject(new WelcomeError('CREDENTIAL_PROTECTION_FAILED'));
      resolve(decrypt ? Buffer.from(output, 'base64').toString('utf8') : output);
    });
    child.stdin.end(decrypt ? text : Buffer.from(text).toString('base64'));
  });
}
