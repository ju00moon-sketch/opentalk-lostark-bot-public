import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getBanglePercent, getArkgridEfficiency, getLopecEfficiencyRole, getEfficiencyCalculatedAt } from './lopec-sim.js';
import { EFFICIENCY_PATH, EFFICIENCY_MAX_BYTES, efficiencyConnection, normalizeEfficiencyName, normalizeEfficiencyResult } from './character-efficiency-contract.js';

const unavailableGem = status => ({ status, efficiency: null, optionEfficiency: null, pointEfficiency: null, effectEfficiencies: [] });
const error = (status, code) => Object.assign(new Error(code), { status, code });
const expired = () => error(502, 'efficiency_unavailable');
const limited = () => error(429, 'efficiency_rate_limited');
const hash = value => createHash('sha256').update(value).digest();

async function calculate(name, { signal, now }) {
  const [bracelet, gem, role] = await Promise.all([
    getBanglePercent(name, { signal }), getArkgridEfficiency(name, { signal }), getLopecEfficiencyRole(name, { signal }).catch(() => null),
  ]);
  signal.throwIfAborted();
  const result = { characterName: name, source: 'lopec', calculatedAt: getEfficiencyCalculatedAt(name) ?? now(),
    bracelet: { status: Number.isFinite(bracelet) ? 'ok' : 'unavailable', efficiency: Number.isFinite(bracelet) ? bracelet : null },
    gem: gem ? { status: 'ok', ...gem, effectEfficiencies: gem.effectEfficiencies ?? [] } : unavailableGem(role === 'support' ? 'unsupported' : 'unavailable') };
  if (normalizeEfficiencyResult(result, name)) return result;
  // A malformed gem breakdown must not hide a valid bracelet result.
  result.gem = unavailableGem(role === 'support' ? 'unsupported' : 'unavailable');
  if (!normalizeEfficiencyResult(result, name)) result.bracelet = { status: 'unavailable', efficiency: null };
  return result;
}

export function createCharacterEfficiencyServer({ config, calculateImpl = calculate, now = Date.now,
  deadlineMs = 32000, cacheMs = 300000, maxEntries = 64, perMinute = 20, maxWaiting = 2 } = {}) {
  const connection = efficiencyConnection(config);
  if (!connection.enabled) throw new Error('Character efficiency is not configured');
  const secret = hash(`Bearer ${connection.token}`);
  const pending = new Map(), cache = new Map(), starts = [], queue = [], controllers = new Set();
  let active = 0, closed = false;
  function drain() {
    while (!closed && active < 1 && queue.length) {
      const entry = queue.shift();
      entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted) continue;
      active++;
      entry.resolve(() => { active--; drain(); });
    }
  }
  async function get(name) {
    const key = name.toLowerCase(), timestamp = now();
    if (closed) throw expired();
    for (const [key, entry] of cache) if (entry.until <= timestamp) cache.delete(key);
    const hit = cache.get(key);
    if (hit) return hit.value;
    if (pending.has(key)) return pending.get(key);
    while (starts.length && starts[0] <= timestamp - 60000) starts.shift();
    if (starts.length >= perMinute || pending.size >= 1 + maxWaiting) throw limited();
    starts.push(timestamp);
    const controller = new AbortController(); controllers.add(controller);
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const job = (async () => {
      let release;
      try {
        release = await new Promise((resolve, reject) => {
          const entry = { resolve, signal, abort: null };
          entry.abort = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(expired()); };
          signal.addEventListener('abort', entry.abort, { once: true }); queue.push(entry); drain();
        });
        signal.throwIfAborted();
        const value = normalizeEfficiencyResult(await calculateImpl(name, { signal, now }), name);
        signal.throwIfAborted();
        if (!value || Buffer.byteLength(JSON.stringify(value)) > EFFICIENCY_MAX_BYTES) throw expired();
        if (!closed && (value.bracelet.status === 'ok' || value.gem.status === 'ok')) {
          cache.set(key, { value, until: Math.min(now() + cacheMs, value.calculatedAt + cacheMs) });
          while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        }
        return value;
      } finally { clearTimeout(timer); controllers.delete(controller); release?.(); }
    })().catch(() => { throw expired(); }).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }
  function json(response, status, body) {
    if (response.destroyed || response.writableEnded) return;
    if (status === 429) response.setHeader('Retry-After', '60');
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(body));
  }
  const server = createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (request, response) => {
    const authorization = request.headers.authorization;
    if (request.socket.remoteAddress !== '127.0.0.1' || typeof authorization !== 'string' ||
        authorization.length > 200 || !timingSafeEqual(hash(authorization), secret)) {
      request.resume(); return json(response, 403, { error: 'forbidden' });
    }
    if (request.method !== 'GET') { request.resume(); response.setHeader('Allow', 'GET'); return json(response, 405, { error: 'method_not_allowed' }); }
    if (!request.url || request.url.length > 1024 || !request.url.startsWith('/') || request.url.startsWith('//') ||
        request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) !== 0) {
      request.resume(); return json(response, 400, { error: 'invalid_request' });
    }
    const url = new URL(request.url, connection.url);
    if (url.pathname !== EFFICIENCY_PATH) return json(response, 404, { error: 'not_found' });
    const name = normalizeEfficiencyName(url.searchParams.get('name'));
    if (!name || [...url.searchParams.keys()].length !== 1 || !url.searchParams.has('name')) return json(response, 400, { error: 'invalid_request' });
    const timer = setTimeout(() => json(response, 502, { error: 'efficiency_unavailable' }), deadlineMs);
    response.once('close', () => clearTimeout(timer));
    get(name).then(value => json(response, 200, value), failure => json(response, failure.status || 502, { error: failure.code || 'efficiency_unavailable' })).finally(() => clearTimeout(timer));
  });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.maxConnections = 64;
  return { server, get, async close() {
    closed = true; cache.clear();
    for (const controller of controllers) controller.abort();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}

export function startCharacterEfficiencyServer(env = process.env) {
  let config;
  try { config = efficiencyConnection({ url: env.CHARACTER_EFFICIENCY_URL, token: env.CHARACTER_EFFICIENCY_TOKEN }); }
  catch { console.error('캐릭터 효율 연결 설정을 확인해 주세요'); return null; }
  if (!config.enabled) return null;
  const service = createCharacterEfficiencyServer({ config });
  service.server.on('error', () => { console.error('캐릭터 효율 연결을 시작하지 못했습니다'); void service.close(); });
  service.server.listen(Number(new URL(config.url).port), '127.0.0.1', () => console.log('캐릭터 효율 연결 준비 완료'));
  return service;
}
