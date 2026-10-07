import { GuildError } from './guild-store.js';

const ORIGIN = 'https://developer-lostark.game.onstove.com';

// Share the web process's allowance across character, market and lounge requests.
// The bot uses the same upstream key; observed remaining capacity keeps a reserve.
export function createOfficialBudget({ fetchImpl = fetch, now = Date.now, perMinute = 70, reserve = 15 } = {}) {
  const starts = [];
  let observed = null;
  let blockedUntil = 0;
  const denied = () => new GuildError(429, 'character_rate_limited');
  return async function budgetedFetch(url, init) {
    if (new URL(url).origin !== ORIGIN) return fetchImpl(url, init);
    const timestamp = now();
    while (starts.length && starts[0] <= timestamp - 60000) starts.shift();
    if (blockedUntil > timestamp || starts.length >= perMinute) throw denied();
    if (observed?.until > timestamp) {
      if (observed.remaining <= reserve) throw denied();
      observed.remaining--;
    }
    starts.push(timestamp);
    const response = await fetchImpl(url, init);
    const completed = now();
    const reset = response.headers.get('x-ratelimit-reset');
    const candidate = /^\d{10}$/.test(reset || '') ? Number(reset) * 1000 : completed + 60000;
    const until = candidate > completed && candidate <= completed + 120000 ? candidate : completed + 60000;
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (/^\d{1,5}$/.test(remaining || '')) {
      if (observed?.until > completed) observed.remaining = Math.min(observed.remaining, Number(remaining));
      else observed = { remaining: Number(remaining), until };
    }
    if (response.status === 429) blockedUntil = until;
    return response;
  };
}
