const MINUTE = 60 * 1000;
const CONDITIONS = new Map([
  [0, '맑음'], [1, '대체로 맑음'], [2, '구름 조금'], [3, '흐림'],
  [45, '안개'], [48, '착빙 안개'],
  [51, '이슬비'], [53, '이슬비'], [55, '이슬비'], [56, '어는 이슬비'], [57, '어는 이슬비'],
  [61, '비'], [63, '비'], [65, '강한 비'], [66, '어는 비'], [67, '어는 비'],
  [71, '눈'], [73, '눈'], [75, '강한 눈'], [77, '싸락눈'],
  [80, '소나기'], [81, '소나기'], [82, '강한 소나기'], [85, '눈 소나기'], [86, '강한 눈 소나기'],
  [95, '뇌우'], [96, '우박을 동반한 뇌우'], [99, '우박을 동반한 뇌우'],
]);

function coordinate(value, limit) {
  if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

function positiveMs(value, fallback) {
  return Number.isFinite(value) && value > 0 && value <= 2 ** 31 - 1 ? value : fallback;
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024) throw new Error('날씨 응답 크기 초과');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseWeather(data, label, currentTime) {
  const current = data?.current;
  const units = data?.current_units;
  if (!current || units?.temperature_2m !== '°C' || units?.precipitation !== 'mm' || units?.time !== 'unixtime') return null;
  const temperatureC = current.temperature_2m;
  const precipitationMm = current.precipitation;
  const timestamp = current.time * 1000;
  if (typeof temperatureC !== 'number' || !Number.isFinite(temperatureC) || temperatureC < -100 || temperatureC > 70
    || typeof precipitationMm !== 'number' || !Number.isFinite(precipitationMm) || precipitationMm < 0 || precipitationMm > 1000
    || !Number.isInteger(current.weather_code) || !CONDITIONS.has(current.weather_code)
    || !Number.isSafeInteger(current.time) || current.time <= 0
    || !Number.isFinite(currentTime) || timestamp < currentTime - 60 * MINUTE || timestamp > currentTime + 15 * MINUTE) return null;
  return { timestamp, value: Object.freeze({ label, temperatureC, precipitationMm, condition: CONDITIONS.get(current.weather_code) }) };
}

export function createMealWeather({ latitude, longitude, label, fetchImpl = fetch, now = Date.now,
  timeoutMs = 2000, ttlMs = 15 * MINUTE, retryMs = MINUTE } = {}) {
  const lat = coordinate(latitude, 90);
  const lon = coordinate(longitude, 180);
  const place = typeof label === 'string' && /^[\p{L}\p{N} .·-]{1,40}$/u.test(label.trim()) ? label.trim() : '설정 지역';
  if (lat === null || lon === null) return async () => null;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: String(lat), longitude: String(lon),
    current: 'temperature_2m,precipitation,weather_code', temperature_unit: 'celsius',
    precipitation_unit: 'mm', timeformat: 'unixtime', timezone: 'GMT', forecast_days: '1' }).toString();
  const timeout = positiveMs(timeoutMs, 2000);
  const ttl = positiveMs(ttlMs, 15 * MINUTE);
  const retry = positiveMs(retryMs, MINUTE);
  let cached = null;
  let expiresAt = 0;
  let retryAt = 0;
  let inFlight = null;

  return function getWeather() {
    const currentTime = now();
    if (!Number.isFinite(currentTime)) return Promise.resolve(null);
    if (cached && currentTime < expiresAt && cached.timestamp >= currentTime - 60 * MINUTE
      && cached.timestamp <= currentTime + 15 * MINUTE) return Promise.resolve(cached.value);
    if (inFlight) return inFlight;
    if (currentTime < retryAt) return Promise.resolve(null);
    inFlight = (async () => {
      const controller = new AbortController();
      let timer;
      try {
        const deadline = new Promise((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(null); }, timeout);
        });
        const request = (async () => {
          const response = await fetchImpl(url.toString(), { signal: controller.signal, redirect: 'error' });
          if (!response.ok) { controller.abort(); return null; }
          return parseWeather(await readJson(response), place, now());
        })();
        const result = await Promise.race([request, deadline]);
        const completedAt = now();
        if (result && Number.isFinite(completedAt)) {
          cached = result;
          expiresAt = completedAt + ttl;
          retryAt = 0;
          return result.value;
        }
      } catch { /* 날씨 없이 추천을 계속한다. */ }
      finally { clearTimeout(timer); }
      cached = null;
      retryAt = now() + retry;
      return null;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
}
