import { GuildError } from './guild-store.js';

// Server identifiers and units published by Gamebit's Lost Ark server selector.
export const goldServers = Object.freeze([
  { id: 'lupeon', name: '루페온', sid: '1844' },
  { id: 'silian', name: '실리안', sid: '1845' },
  { id: 'aman', name: '아만', sid: '1846' },
  { id: 'abrelshud', name: '아브렐슈드', sid: '1847' },
  { id: 'karmine', name: '카마인', sid: '1848' },
  { id: 'kazeros', name: '카제로스', sid: '1849' },
  { id: 'kadan', name: '카단', sid: '1850' },
  { id: 'ninav', name: '니나브', sid: '2072' },
].map(Object.freeze));
const fail = () => new GuildError(502, 'gold_history_unavailable');
const day = value => new Date(value + 9 * 3600000).toISOString().slice(0, 10);
const price = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e8;

export function normalizeGoldHistory(value, server, timestamp) {
  if (!Array.isArray(value) || !value.length || value.length > 400) throw fail();
  const seen = new Set();
  const rows = value.map(row => {
    if (!row || !Number.isSafeInteger(row.time) || row.time < 1577804400 || row.time * 1000 > timestamp ||
        (row.time + 9 * 3600) % 86400 !== 0 || !['open', 'high', 'low', 'close'].every(key => price(row[key])) ||
        row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) ||
        typeof row.volume !== 'number' || !Number.isFinite(row.volume) || row.volume < 0 || seen.has(row.time)) throw fail();
    seen.add(row.time);
    return { date: day(row.time * 1000), time: row.time * 1000, price: row.close };
  }).sort((a, b) => a.time - b.time).slice(-14);
  const latest = rows.at(-1), previous = rows.at(-2);
  const consecutive = previous && latest.time - previous.time === 86400000;
  return {
    server: { id: server.id, name: server.name }, servers: goldServers.map(({ id, name }) => ({ id, name })),
    source: { name: '게임비트', url: `https://gamebit.co.kr/${server.id}` },
    unit: { gold: 10000, currency: 'KRW' }, history: rows,
    currentPrice: latest.price, priceDate: latest.date, isToday: latest.date === day(timestamp),
    changePercent: consecutive ? (latest.price / previous.price - 1) * 100 : null,
    comparison: 'previous-day-close', updatedAt: timestamp,
  };
}

export function createGoldHistoryService({ fetchImpl = fetch, now = Date.now, cacheMs = 180000, timeoutMs = 6000 } = {}) {
  const cache = new Map(), pending = new Map(), attempts = new Map(), controllers = new Set(), failures = new Map();
  let closed = false;
  function allow(ip) {
    const timestamp = now();
    for (const [key, row] of attempts) if (row.until <= timestamp) attempts.delete(key);
    let row = attempts.get(ip);
    if (!row) {
      if (attempts.size >= 10000) return false;
      row = { until: timestamp + 60000, count: 0 }; attempts.set(ip, row);
    }
    return ++row.count <= 30;
  }
  async function request(server) {
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://gamebit.co.kr/v3_get_chart_data.php?game=lostark&sid=${server.sid}&type=day`, {
        headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal,
      });
      if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > 262144) throw fail();
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length; if (bytes > 262144) { await reader.cancel(); throw fail(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      controller.signal.throwIfAborted();
      if (closed) throw fail();
      const result = normalizeGoldHistory(JSON.parse(Buffer.concat(chunks).toString('utf8')), server, now());
      cache.set(server.id, { until: now() + cacheMs, result }); failures.delete(server.id); return result;
    } catch {
      failures.set(server.id, now() + 30000); throw fail();
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  async function get(id = 'lupeon') {
    const server = goldServers.find(row => row.id === id);
    if (!server) throw new GuildError(400, 'invalid_request');
    if (closed) throw new GuildError(503, 'gold_history_unavailable');
    const hit = cache.get(id); if (hit?.until > now()) return hit.result;
    if (pending.has(id)) return pending.get(id);
    if (failures.get(id) > now()) throw fail();
    const task = request(server).finally(() => pending.delete(id)); pending.set(id, task); return task;
  }
  return { get, allow, close() { closed = true; for (const controller of controllers) controller.abort(); cache.clear(); attempts.clear(); failures.clear(); } };
}
