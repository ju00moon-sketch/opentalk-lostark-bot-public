const SOURCE_URL = 'https://loatool.taeu.kr/api/crystal-history/ohlc/1d';
const MAX_AGE_MS = 3 * 86400000;
const MAX_BYTES = 256 * 1024;
const KST_OFFSET = 9 * 3600000;
const absent = reason => ({ status: 'unavailable', reason, price95: null, pheonUnitGold: null,
  source: 'loatool', observedAt: null, checkedAt: null });
const clone = value => structuredClone(value);

function parseQuote(data, timestamp) {
  if (!Array.isArray(data) || !data.length || data.length > 4096) throw new Error('shape');
  let previous = -Infinity;
  for (const row of data) {
    if (typeof row?.dt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(row.dt)) throw new Error('date');
    const at = Date.parse(`${row.dt}+09:00`);
    if (!Number.isFinite(at) || new Date(at + KST_OFFSET).toISOString().slice(0, 19) !== row.dt || at <= previous) throw new Error('order');
    previous = at;
  }
  const price95 = data.at(-1).close;
  if (typeof price95 !== 'number' || !Number.isFinite(price95) || price95 < 1000 || price95 > 500000 ||
      !Number.isFinite(timestamp) || previous > timestamp || timestamp - previous > MAX_AGE_MS) throw new Error('quote');
  return { status: 'ok', price95, pheonUnitGold: price95 / 95 * 8.5, source: 'loatool',
    sourceUrl: SOURCE_URL, observedAt: previous, checkedAt: timestamp,
    basis: '95_crystals_100_pheons_850_crystals', basisAssumption: '페온 100개를 850 크리스탈로 구매하는 대량 상품 단가 가정',
    priceBasis: 'daily_candle_close' };
}

/** Public currency quote only; no bot state, account balance, credentials or writes. */
export function createValuationCurrencyService({ fetchImpl = fetch, now = Date.now,
  cacheMs = 3600000, requestTimeoutMs = 5000 } = {}) {
  let closed = false, cached = null, pending = null, controller = null;
  const ttl = Number.isFinite(cacheMs) && cacheMs > 0 ? Math.min(cacheMs, 3600000) : 3600000;
  const timeout = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? Math.min(requestTimeoutMs, 5000) : 5000;
  function get() {
    if (closed) return Promise.resolve(absent('currency_service_closed'));
    const timestamp = now();
    if (cached && cached.until > timestamp && timestamp >= cached.data.observedAt &&
        timestamp - cached.data.observedAt <= MAX_AGE_MS) return Promise.resolve(clone(cached.data));
    cached = null;
    if (pending) return pending.then(clone);
    const local = new AbortController(); controller = local;
    const { signal } = local;
    let onAbort;
    const deadline = new Promise(resolve => {
      onAbort = () => resolve(absent(closed ? 'currency_service_closed' : 'currency_timeout'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => local.abort(), timeout);
    const physical = (async () => {
      let reader, response;
      try {
        response = await fetchImpl(SOURCE_URL, { method: 'GET', redirect: 'error', signal,
          headers: { Accept: 'application/json' } });
        signal.throwIfAborted();
        if (closed || !response.ok || response.redirected || !response.body ||
            !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') ||
            Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('http');
        reader = response.body.getReader(); const parts = []; let bytes = 0;
        while (true) {
          const { done, value } = await reader.read(); signal.throwIfAborted();
          if (done) break;
          bytes += value.byteLength; if (bytes > MAX_BYTES) throw new Error('size');
          parts.push(Buffer.from(value));
        }
        const data = parseQuote(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))), now());
        signal.throwIfAborted(); if (closed) throw new Error('closed');
        cached = { data, until: now() + ttl }; return data;
      } catch {
        return absent(closed ? 'currency_service_closed' : signal.aborted ? 'currency_timeout' : 'currency_quote_unavailable');
      } finally {
        if (reader) void reader.cancel().catch(() => {}); else void response?.body?.cancel().catch(() => {});
      }
    })();
    const logical = Promise.race([physical, deadline]);
    pending = logical;
    // A timed-out non-cooperative transport still owns the only physical slot.
    // Keep the settled timeout result shared until that transport actually ends.
    void physical.finally(() => {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort); local.abort();
      if (controller === local) controller = null;
      if (pending === logical) pending = null;
    });
    return logical.then(clone);
  }
  function close() { closed = true; cached = null; controller?.abort(); }
  return { get, close };
}
