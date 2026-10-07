import { GuildError } from './guild-store.js';
import { normalizeCharacter } from './character-profile.js';

const LOSTARK = 'https://lostark.game.onstove.com';
const unavailable = () => new GuildError(502, 'stove_unavailable');
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

function profileAccount(value) {
  if (typeof value !== 'string' || value.length > 200) throw new GuildError(400, 'stove_profile_invalid');
  // Match the original input before URL normalization can erase a traversal or credential component.
  const match = /^https:\/\/(?:profile\.onstove\.com\/(?:ko\/|en\/)?|timeline\.onstove\.com\/)([1-9]\d{0,19})\/?$/.exec(value.trim());
  if (!match) throw new GuildError(400, 'stove_profile_invalid');
  return match[1];
}

function accountNumber(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : null;
}

function redirectedCharacter(location) {
  if (typeof location !== 'string' || location.length > 400) throw unavailable();
  const relative = location.startsWith(LOSTARK + '/') ? location.slice(LOSTARK.length) : location;
  if (!/^\/Profile\/Character\/[^/?#]+$/.test(relative)) throw unavailable();
  let name;
  try { name = normalizeCharacter(decodeURIComponent(relative.slice('/Profile/Character/'.length))); } catch { throw unavailable(); }
  if (!name) throw unavailable();
  return name;
}

function ownsCharacter(html, representative, characterName) {
  // Only the server-rendered character selector is evidence. Do not execute scripts or accept
  // matching names elsewhere (profile prose, navigation, comments, or embedded script strings).
  const page = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const header = /<span\b[^>]*class=["']profile-character-info__name["'][^>]*>([^<]+)<\/span\s*>/i.exec(page);
  const displayed = normalizeCharacter(header?.[1]);
  if (!displayed || !sameName(displayed, representative)) throw unavailable();
  const block = /<div\b[^>]*\bid=["']expand-character-list["'][^>]*>([\s\S]*?)<\/div\s*>/i.exec(page)?.[1];
  if (!block || /<div\b/i.test(block)) throw unavailable();
  const names = [];
  for (const button of block.matchAll(/<button\b[^>]*\bonclick="location\.href='\/Profile\/Character\/([^'"<>]+)'"[^>]*>/g)) {
    let name;
    try { name = normalizeCharacter(decodeURIComponent(button[1])); } catch { throw unavailable(); }
    if (!name || names.length >= 300) throw unavailable();
    names.push(name);
  }
  if (!names.length || !names.some(name => sameName(name, representative))) throw unavailable();
  return names.some(name => sameName(name, characterName));
}

export async function verifyStoveCharacter({ profileUrl, characterName, code, fetchImpl = fetch, signal, timeoutMs = 14000 }) {
  const account = profileAccount(profileUrl);
  const character = normalizeCharacter(characterName);
  if (!character || typeof code !== 'string' || !/^PG-[A-Fa-f0-9]{24}$/.test(code)) throw unavailable();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, Math.min(14000, Math.max(1, timeoutMs)));
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  const rejectAbort = () => rejectAborted(unavailable());
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  // A rejection can precede the first request; attach a handler immediately.
  aborted.catch(() => {});
  const bounded = promise => Promise.race([promise, aborted]);
  const headers = { Accept: 'application/json', 'X-Lang': 'KO', 'X-Nation': 'KR', 'X-Device-Type': 'P01' };

  async function request(url, options = {}, { redirect = false, limit = 65536, json = true } = {}) {
    if (controller.signal.aborted) throw unavailable();
    const response = await bounded(Promise.resolve().then(() => fetchImpl(url, {
      ...options, headers: { ...headers, ...options.headers }, signal: controller.signal,
      redirect: 'manual', credentials: 'omit', cache: 'no-store',
    })));
    if (redirect && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      response.body?.cancel().catch(() => {});
      return location;
    }
    if (redirect || !response.ok || Number(response.headers.get('content-length')) > limit) {
      response.body?.cancel().catch(() => {});
      throw unavailable();
    }
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await bounded(reader.read());
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw unavailable();
        chunks.push(Buffer.from(value));
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
      return json ? JSON.parse(text) : text;
    } finally { reader.cancel().catch(() => {}); }
  }

  try {
    if (controller.signal.aborted) throw unavailable();
    const result = await request(`https://api.onstove.com/myhome/v1.1/members/${account}/profile`);
    const profile = result?.value;
    if (result?.code !== 0 || !profile || accountNumber(profile.member_no) !== account) throw unavailable();
    if (profile.myhome_visible === false) throw new GuildError(422, 'stove_private');
    if (profile.myhome_visible !== true || typeof profile.introduce !== 'string') throw unavailable();
    if (!new RegExp(`(?<![\\p{L}\\p{N}_-])${code}(?![\\p{L}\\p{N}_-])`, 'u').test(profile.introduce)) {
      throw new GuildError(422, 'stove_code_missing');
    }
    // These are the public profile lookups used by the official community's character button.
    // IsCharacterList uses POST for a read; it does not change the user's representative character.
    const link = await request(`${LOSTARK}/board/IsCharacterList`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({ memberNo: account }),
    });
    if (link?.isCharacter === false) throw new GuildError(422, 'stove_character_mismatch');
    if (link?.isCharacter !== true || typeof link.encryptMemberNo !== 'string' || !/^[A-Za-z0-9+/]{20,256}={0,2}$/.test(link.encryptMemberNo)) throw unavailable();
    const location = await request(`${LOSTARK}/Profile/Member?id=${encodeURIComponent(link.encryptMemberNo)}`, {}, { redirect: true });
    const representative = redirectedCharacter(location);
    const html = await request(`${LOSTARK}/Profile/Character/${encodeURIComponent(representative)}`, {
      headers: { Accept: 'text/html' },
    }, { json: false, limit: 2 * 1024 * 1024 });
    if (!ownsCharacter(html, representative, character)) throw new GuildError(422, 'stove_character_mismatch');
    if (controller.signal.aborted) throw unavailable();
    return { stoveAccountId: account, characterName: character };
  } catch (error) {
    if (error instanceof GuildError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
    controller.abort();
  }
}
