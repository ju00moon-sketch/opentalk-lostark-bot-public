// The web adapter shares only this data contract, never the calculation runtime.
export const EFFICIENCY_PATH = '/internal/character-efficiency';
export const EFFICIENCY_MAX_BYTES = 32768;

export function normalizeEfficiencyName(value) {
  if (typeof value !== 'string' || value.length > 48) return null;
  const name = value.normalize('NFC').trim();
  return /^[가-힣A-Za-z0-9]{2,12}$/.test(name) ? name : null;
}

export function efficiencyConnection({ url = '', token = '' } = {}) {
  if (!url && !token) return Object.freeze({ enabled: false, url: '', token: '' });
  if (typeof url !== 'string' || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error('Invalid character efficiency configuration');
  }
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new Error('Invalid character efficiency configuration'); }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      Number(endpoint.port) < 1024 || Number(endpoint.port) > 65535 || endpoint.username || endpoint.password ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash || url !== endpoint.origin) {
    throw new Error('Invalid character efficiency configuration');
  }
  return Object.freeze({ enabled: true, url: endpoint.origin, token });
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000000;
const optional = value => value === null || number(value);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[<>\x00-\x1f\x7f]/.test(value);

export function normalizeEfficiencyResult(raw, expectedName) {
  const name = normalizeEfficiencyName(raw?.characterName);
  if (!record(raw) || !name || name.toLowerCase() !== normalizeEfficiencyName(expectedName)?.toLowerCase() ||
      raw.source !== 'lopec' || !Number.isSafeInteger(raw.calculatedAt) || raw.calculatedAt < 0 ||
      !record(raw.bracelet) || !record(raw.gem)) return null;
  const bracelet = raw.bracelet;
  if (!['ok', 'unavailable'].includes(bracelet.status) ||
      (bracelet.status === 'ok' ? !number(bracelet.efficiency) : bracelet.efficiency !== null)) return null;
  const gem = raw.gem;
  if (!['ok', 'unavailable', 'unsupported'].includes(gem.status) ||
      (gem.status === 'ok' ? !number(gem.efficiency) : gem.efficiency !== null) ||
      !optional(gem.optionEfficiency) || !optional(gem.pointEfficiency) ||
      !Array.isArray(gem.effectEfficiencies) || gem.effectEfficiencies.length > 32) return null;
  if (gem.status !== 'ok' && (gem.optionEfficiency !== null || gem.pointEfficiency !== null || gem.effectEfficiencies.length)) return null;
  const effects = [];
  for (const item of gem.effectEfficiencies) {
    if (!record(item) || !label(item.name) || !Number.isInteger(item.level) || item.level < 0 || item.level > 100 ||
        !number(item.effect) || !number(item.efficiency)) return null;
    effects.push({ name: item.name, level: item.level, effect: item.effect, efficiency: item.efficiency });
  }
  return { characterName: name, source: 'lopec', calculatedAt: raw.calculatedAt,
    bracelet: { status: bracelet.status, efficiency: bracelet.efficiency },
    gem: { status: gem.status, efficiency: gem.efficiency, optionEfficiency: gem.optionEfficiency,
      pointEfficiency: gem.pointEfficiency, effectEfficiencies: effects } };
}
