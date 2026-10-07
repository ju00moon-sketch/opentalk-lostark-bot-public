import { requestJson } from './providers.js';
import { GuildError, validCharacter } from './guild-store.js';

export function normalizeNickname(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim();
  if ([...name].length < 2 || [...name].length > 20 ||
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(name) || !name.isWellFormed()) return null;
  return name;
}

export function normalizeCharacter(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim();
  return validCharacter(name) ? name : null;
}

function profileImage(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const allowed = /^https:\/\/cdn-lostark\.game\.onstove\.com\/armory\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:jpg|png|webp)(?:\?v=[A-Za-z0-9_-]{1,64})?$/;
  return allowed.test(value) ? value : null;
}

export async function findCharacterProfile(config, characterName, fetchImpl, { extended = false } = {}) {
  if (!config.automaticApproval.lostArkApiKey) throw new GuildError(503, 'character_unavailable');
  let profile;
  try {
    profile = await requestJson(fetchImpl, `https://developer-lostark.game.onstove.com/armories/characters/${encodeURIComponent(characterName)}/profiles`, {
      method: 'GET', headers: { Authorization: `bearer ${config.automaticApproval.lostArkApiKey}`, Accept: 'application/json' },
    }, false, true);
  } catch (error) {
    if (error.status === 404) throw new GuildError(404, 'character_not_found');
    throw new GuildError(error.status === 429 ? 429 : 502, error.status === 429 ? 'character_rate_limited' : 'character_unavailable');
  }
  const summary = normalizeProfile(profile, characterName);
  if (!extended) return summary;
  const optionalText = value => typeof value === 'string' && value.length <= 100
    ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim() || null : null;
  const numeric = value => {
    if (!['string', 'number'].includes(typeof value) || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(String(value))) return null;
    const number = Number(String(value).replaceAll(',', ''));
    return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : null;
  };
  return { ...summary, combatPower: numeric(profile.CombatPower), title: optionalText(profile.Title),
    guildName: optionalText(profile.GuildName), expeditionLevel: numeric(profile.ExpeditionLevel),
    characterImage: profileImage(profile.CharacterImage) };
}

export function normalizeProfile(profile, characterName) {
  if (profile === null) throw new GuildError(404, 'character_not_found');
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new GuildError(502, 'character_unavailable');
  const name = normalizeCharacter(profile.CharacterName);
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 40 && !/[\u0000-\u001f\u007f]/.test(value);
  const rawLevel = profile.ItemAvgLevel;
  const level = typeof rawLevel === 'string' && /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(rawLevel) ? Number(rawLevel.replaceAll(',', '')) : NaN;
  if (!name || name.toLowerCase() !== characterName.toLowerCase() || !text(profile.ServerName) ||
      !text(profile.CharacterClassName) || !Number.isFinite(level) || level < 0 || level > 10000) {
    throw new GuildError(502, 'character_unavailable');
  }
  return { characterName: name, serverName: profile.ServerName, characterClass: profile.CharacterClassName, itemLevel: level };
}
