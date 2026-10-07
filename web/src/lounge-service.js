import { GuildError } from './guild-store.js';

const ORIGIN = 'https://developer-lostark.game.onstove.com';
const PATHS = { notices: '/news/notices', events: '/news/events', calendar: '/gamecontents/calendar' };
export const loungeSections = new Set(Object.keys(PATHS));
const fail = () => new GuildError(502, 'lounge_unavailable');
const clean = (value, max = 180) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
function officialUrl(value, image = false) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const hosts = image ? ['cdn-lostark.game.onstove.com', 'img.lostark.co.kr', 'cdn-lostark.game.onstove.com'] : ['lostark.game.onstove.com'];
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname) ? url.href : null;
  } catch { return null; }
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value);
  const number = valid ? Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : value + '+09:00') : NaN;
  return Number.isFinite(number) ? number : null;
}
function normalize(section, rows) {
  if (!Array.isArray(rows) || rows.length > 3000) throw fail();
  const records = rows.filter(row => row && typeof row === 'object' && !Array.isArray(row));
  if (section === 'notices') return records.slice(0, 100).map(row => ({ title: clean(row.Title), date: timestamp(row.Date), url: officialUrl(row.Link), type: clean(row.Type, 20) })).filter(row => row.title && row.url && row.date !== null).slice(0, 20);
  if (section === 'events') return records.slice(0, 100).map(row => ({ title: clean(row.Title), image: officialUrl(row.Thumbnail, true), url: officialUrl(row.Link), startAt: timestamp(row.StartDate), endAt: timestamp(row.EndDate) })).filter(row => row.title && row.url).slice(0, 24);
  return records.map(row => ({ name: clean(row.ContentsName, 100), category: clean(row.CategoryName, 40), icon: officialUrl(row.ContentsIcon, true),
    minItemLevel: Number.isSafeInteger(row.MinItemLevel) && row.MinItemLevel >= 0 ? row.MinItemLevel : null,
    starts: Array.isArray(row.StartTimes) ? row.StartTimes.slice(0, 1000).map(timestamp).filter(value => value !== null) : [] }))
    .filter(row => row.name && row.starts.length).slice(0, 500);
}

export function createLoungeService({ config, fetchImpl = fetch, now = Date.now, timeoutMs = 8000, cacheMs = 300000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  const attempts = new Map();
  const controllers = new Set();
  let closed = false;
  function allow(ip) {
    const time = now();
    for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key);
    if (!attempts.has(ip)) { if (attempts.size >= 10000) return false; attempts.set(ip, { count: 0, until: time + 60000 }); }
    return ++attempts.get(ip).count <= 30;
  }
  async function request(section) {
    if (!config.automaticApproval.lostArkApiKey) throw new GuildError(503, 'lounge_unavailable');
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader;
    try {
      const response = await fetchImpl(ORIGIN + PATHS[section], { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Authorization: `bearer ${config.automaticApproval.lostArkApiKey}`, Accept: 'application/json' } });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new GuildError(response.status === 429 ? 429 : 502, response.status === 429 ? 'lounge_rate_limited' : 'lounge_unavailable'); }
      if (response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') || !response.body || Number(response.headers.get('content-length')) > 4 * 1024 * 1024) { void response.body?.cancel().catch(() => {}); throw fail(); }
      reader = response.body.getReader(); const chunks = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4 * 1024 * 1024) throw fail(); chunks.push(Buffer.from(value)); }
      controller.signal.throwIfAborted();
      const items = normalize(section, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      return { items, updatedAt: now() };
    } catch (error) {
      if (error?.status === 429) throw new GuildError(429, 'lounge_rate_limited');
      if (error instanceof GuildError) throw error;
      throw fail();
    } finally { clearTimeout(timer); controller.abort(); controllers.delete(controller); if (reader) void reader.cancel().catch(() => {}); }
  }
  function get(section) {
    if (!loungeSections.has(section)) return Promise.reject(new GuildError(400, 'invalid_request'));
    if (closed) return Promise.reject(fail());
    const entry = cache.get(section);
    if (entry?.until > now()) return Promise.resolve(entry.data);
    if (pending.has(section)) return pending.get(section);
    const promise = request(section).then(data => { if (!closed) cache.set(section, { until: now() + cacheMs, data }); return data; }).finally(() => pending.delete(section));
    pending.set(section, promise); return promise;
  }
  return { get, allow, close() { closed = true; for (const controller of controllers) controller.abort(); cache.clear(); attempts.clear(); } };
}
