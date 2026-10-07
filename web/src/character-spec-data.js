import { parseTooltip, getQuality, parseBracelet, findStoneEngravings } from '../../src/tooltip.js';
import { accessoryRefinementOptions } from '../../src/refinement-options.js';
import { parseArkgridGemTarget } from '../../src/arkgrid-gem-target.js';

const LIMIT = { items: 32, sections: 16, entries: 32, text: 1200, tooltip: 131072 };
const ACCESSORY_TYPES = new Set(['목걸이', '귀걸이', '반지']);
const ICON_HOST = 'cdn-lostark.game.onstove.com';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function rows(value, limit = LIMIT.items) {
  if (!Array.isArray(value)) return null;
  const result = value.slice(0, limit).filter(object);
  return value.length && !result.length ? null : result;
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()];
    const code = Number.parseInt(entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1), entity[1]?.toLowerCase() === 'x' ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

function plain(value, limit = LIMIT.text) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let source = decodeEntities(String(value).slice(0, 16384));
  source = source.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>|<\/(?:p|div|li)\s*>/gi, '\n');
  // Walk tags once so malformed repeated '<' input cannot cause quadratic tag removal.
  let text = '';
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '<' || !/[a-z/!]/i.test(source[index + 1] ?? '')) { text += source[index]; continue; }
    const end = source.indexOf('>', index + 1);
    if (end === -1) break;
    index = end;
  }
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t\u00a0]+/g, ' ').trim();
  return text ? text.slice(0, limit) : null;
}

function number(value, min = 0, max = 1e9) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  const result = Number(text.replaceAll(',', ''));
  return Number.isFinite(result) && result >= min && result <= max ? result : null;
}

function icon(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === ICON_HOST && !url.username && !url.password && !url.port
      && /\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

function entry(value) {
  const full = plain(value, 16384);
  if (!full) return null;
  const text = full.slice(0, LIMIT.text);
  const values = [];
  for (const match of text.matchAll(/[+-]?\d[\d,]*(?:\.\d+)?\s*(%|초(?=\s|$|[,.])|회(?=\s|$|[,.]))?/g)) {
    const unit = match[1] ?? null;
    const value = number(unit ? match[0].slice(0, -unit.length).trim() : match[0].trim(), -1e9);
    if (value !== null) values.push({ value, unit });
    if (values.length === 12) break;
  }
  return { text, values, truncated: full.length > LIMIT.text };
}

function entries(raw, limit = LIMIT.entries) {
  const source = Array.isArray(raw) ? raw.slice(0, limit) : [raw];
  return source.flatMap((value) => (plain(value, 16384) ?? '').split('\n'))
    .slice(0, limit).map(entry).filter(Boolean);
}

function tooltip(raw) {
  if (typeof raw !== 'string' || raw.length > LIMIT.tooltip) return {};
  const parsed = parseTooltip(raw);
  if (!object(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).slice(0, 64).filter(([, value]) => object(value)));
}

function textLeaves(raw) {
  const output = [];
  const stack = [{ value: raw, depth: 0 }];
  let visits = 0;
  while (stack.length && visits++ < 256 && output.length < LIMIT.entries) {
    const { value, depth } = stack.pop();
    if (typeof value === 'string') {
      if (!/^https?:\/\//i.test(value)) output.push(value);
    } else if (value && typeof value === 'object' && depth < 6) {
      for (const child of Object.values(value).slice(0, 32).reverse()) stack.push({ value: child, depth: depth + 1 });
    }
  }
  return output;
}

function sections(tip) {
  const result = [];
  for (const element of Object.values(tip)) {
    if (result.length === LIMIT.sections) break;
    if (element.type === 'ItemPartBox') {
      const list = entries(element.value?.Element_001);
      if (list.length) result.push({ title: plain(element.value?.Element_000, 120), entries: list });
    } else if (element.type === 'IndentStringGroup') {
      for (const group of Object.values(object(element.value) ? element.value : {}).slice(0, 8)) {
        const list = entries(textLeaves(group?.contentStr));
        if (list.length && result.length < LIMIT.sections) result.push({ title: plain(group?.topStr, 120), entries: list });
      }
    }
  }
  return result;
}

function equipmentItem(raw) {
  const type = plain(raw.Type, 60);
  const name = plain(raw.Name, 180);
  if (!type && !name) return null;
  const tip = tooltip(raw.Tooltip);
  const titleText = Object.values(tip).filter((element) => element.type === 'ItemTitle')
    .flatMap((element) => textLeaves(element.value)).map((value) => plain(value)).filter(Boolean).join(' ');
  const itemLevel = /아이템\s*레벨\s*([\d,]+(?:\.\d+)?)/.exec(titleText)?.[1];
  const refinement = /^\+(\d+)\s/.exec(name ?? '')?.[1];
  const quality = number(getQuality(tip), 0, 100);
  // Equipment prints "아이템 레벨 1700 (티어 4)", accessories and bracelets only "아이템 티어 4".
  const tierText = /아이템\s*레벨\s*[\d,]+(?:\.\d+)?\s*\(티어\s*(\d+)\)|아이템\s*티어\s*(\d+)/.exec(titleText);
  const item = { type, name, grade: plain(raw.Grade, 40), icon: icon(raw.Icon), quality,
    itemLevel: number(itemLevel), tier: number(tierText?.[1] ?? tierText?.[2], 1, 4),
    refinement: number(refinement, 0, 100), sections: sections(tip) };
  if (ACCESSORY_TYPES.has(type)) item.refinementOptions = accessoryRefinementOptions(type, item.sections);
  // These sections remain source text; missing enhancement data is not a zero level.
  const elixir = item.sections.filter(section => /엘릭서/.test(section.title ?? ''));
  const transcendence = item.sections.filter(section => /초월/.test(section.title ?? ''));
  item.enhancements = { elixir: elixir.length ? elixir : null, transcendence: transcendence.length ? transcendence : null };
  if (type === '팔찌') {
    const parsed = parseBracelet(tip);
    item.stats = parsed.stats.slice(0, LIMIT.entries).map((stat) => ({
      name: plain(stat.name, 80), value: number(stat.value), text: plain(`${stat.name}${stat.value ? ` +${stat.value}` : ''}`),
    }));
    item.effects = entries(parsed.effects);
  }
  if (type === '어빌리티 스톤') {
    item.engravings = findStoneEngravings(tip).slice(0, 8).map((engraving) => ({
      name: plain(engraving.name, 80), level: number(engraving.level, 0, 100), negative: engraving.negative === true,
    }));
  }
  return item;
}

function mapEquipment(raw) {
  const list = rows(raw);
  if (list === null) return { equipment: null, accessories: null, bracelet: null, stone: null };
  const items = list.map(equipmentItem).filter(Boolean);
  if (list.length && !items.length) return { equipment: null, accessories: null, bracelet: null, stone: null };
  return {
    equipment: items.filter((item) => !ACCESSORY_TYPES.has(item.type) && !['팔찌', '어빌리티 스톤'].includes(item.type)),
    accessories: items.filter((item) => ACCESSORY_TYPES.has(item.type)),
    bracelet: items.find((item) => item.type === '팔찌') ?? null,
    stone: items.find((item) => item.type === '어빌리티 스톤') ?? null,
  };
}

function mapGems(raw) {
  if (!object(raw) || !Array.isArray(raw.Gems)) return null;
  const gems = rows(raw.Gems, 16);
  if (gems === null) return null;
  const skills = (rows(raw.Effects?.Skills, 48) ?? []).map((skill) => ({
    slot: number(skill.GemSlot, 0, 100), name: plain(skill.Name, 120), icon: icon(skill.Icon), effects: entries(skill.Description),
  }));
  const items = gems.map((gem) => {
    const slot = number(gem.Slot, 0, 100);
    return { slot, name: plain(gem.Name, 160), level: number(gem.Level, 0, 100), grade: plain(gem.Grade, 40), icon: icon(gem.Icon),
      skills: skills.filter((skill) => slot !== null && skill.slot === slot).map(({ slot: ignored, ...skill }) => skill) };
  });
  const slots = new Set(items.map((gem) => gem.slot).filter((slot) => slot !== null));
  const unmatched = skills.filter((skill) => skill.slot === null || !slots.has(skill.slot))
    .flatMap((skill) => skill.effects.map((effect) => `${skill.name ? `${skill.name}: ` : ''}${effect.text}`));
  return { items, effects: [...entries(raw.Effects?.Description), ...entries(unmatched)].slice(0, LIMIT.entries) };
}

function mapEngravings(raw) {
  if (!object(raw)) return null;
  const ark = rows(raw.ArkPassiveEffects, 16);
  const legacy = rows(raw.Effects, 16);
  const selected = ark?.length ? ark : legacy ?? ark;
  if (selected === null) return null;
  return { mode: selected === ark ? 'arkpassive' : 'legacy', items: selected.map((effect) => {
    const name = plain(effect.Name ?? effect.EngravingName, 120);
    return { name, level: number(effect.Level ?? /Lv\.\s*(\d+)/i.exec(name ?? '')?.[1], 0, 100),
      grade: plain(effect.Grade, 40), icon: icon(effect.Icon), abilityStoneLevel: number(effect.AbilityStoneLevel, 0, 100),
      effects: entries(effect.Description) };
  }) };
}

function mapArkPassive(raw) {
  if (!object(raw)) return null;
  const points = rows(raw.Points, 8);
  const effects = rows(raw.Effects, 48);
  if (points === null && effects === null && raw.IsArkPassive !== false) return null;
  return {
    isEnabled: typeof raw.IsArkPassive === 'boolean' ? raw.IsArkPassive : null,
    points: points?.map((point) => ({ name: plain(point.Name, 80), value: number(point.Value, 0, 10000),
      description: plain(point.Description), icon: icon(point.Icon) })) ?? [],
    effects: effects?.map((effect) => {
      const category = plain(effect.Name, 80);
      const description = plain(effect.Description);
      const match = /(\d+)티어\s+(.+?)\s+Lv\.\s*(\d+)/.exec(description ?? '');
      const tip = tooltip(effect.ToolTip ?? effect.Tooltip);
      return { category, name: match?.[2] ?? description, tier: number(match?.[1], 0, 100),
        level: number(match?.[3], 0, 100), icon: icon(effect.Icon), description,
        effects: entries(Object.values(tip).flatMap((element) => textLeaves(element.value)
          .map((text) => element.type === 'MultiTextBox' ? text.replace(/\|\|/g, '\n') : text))) };
    }) ?? [],
  };
}

function mapCards(raw) {
  if (!object(raw) || !Array.isArray(raw.Cards) || !Array.isArray(raw.Effects) ||
      raw.Cards.length > 16 || raw.Effects.length > 16 || !raw.Cards.every(object) || !raw.Effects.every(object)) return null;
  const whole = (value, max = 100) => Number.isInteger(value) && value >= 0 && value <= max ? value : null;
  const seenSlots = new Set();
  const items = [];
  for (const card of raw.Cards) {
    const name = plain(card.Name, 160);
    const slot = whole(card.Slot);
    if (!name || (slot !== null && seenSlots.has(slot))) return null;
    if (slot !== null) seenSlots.add(slot);
    let awakeCount = whole(card.AwakeCount);
    let awakeTotal = whole(card.AwakeTotal);
    if (awakeCount !== null && awakeTotal !== null && awakeCount > awakeTotal) awakeCount = awakeTotal = null;
    items.push({ slot, name, grade: plain(card.Grade, 40), icon: icon(card.Icon), awakeCount, awakeTotal });
  }
  const sets = [];
  for (const effect of raw.Effects) {
    if (!Array.isArray(effect.Items) || effect.Items.length > 16 || !effect.Items.every(object) ||
        !Array.isArray(effect.CardSlots) || effect.CardSlots.length > 16 || effect.CardSlots.some(slot => whole(slot) === null) ||
        new Set(effect.CardSlots).size !== effect.CardSlots.length) return null;
    const effects = effect.Items.map(item => ({ name: plain(item.Name, 180), effects: entries(item.Description) }));
    if (effects.some(item => !item.name)) return null;
    sets.push({ index: whole(effect.Index), cardSlots: [...effect.CardSlots], items: effects });
  }
  return { items, sets };
}

const gridInteger = (value, max = 10000) => Number.isInteger(value) && value >= 0 && value <= max ? value : null;

function gridTooltipNumber(parts, title, pattern) {
  const matches = parts.filter(part => part.title === title)
    .flatMap(part => part.entries.map(item => pattern.exec(item.text)?.[1]).filter(value => value !== undefined));
  return matches.length === 1 ? gridInteger(Number(matches[0])) : null;
}

function mapGridGems(raw) {
  // A core with no gem is published as `Gems: null`; that is an observed empty set, not a missing section.
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 4 || !raw.every(object)) return null;
  const slots = new Set();
  const result = [];
  for (const gem of raw) {
    const slot = gridInteger(gem.Index, 3);
    if (slot === null || slots.has(slot)) return null;
    slots.add(slot);
    const tip = tooltip(gem.Tooltip);
    const names = Object.values(tip).filter(element => element.type === 'NameTagBox' && typeof element.value === 'string')
      .map(element => plain(element.value, 180)).filter(Boolean);
    const parts = sections(tip);
    result.push({
      slot, name: names.length === 1 ? names[0] : null,
      grade: plain(gem.Grade, 40), icon: icon(gem.Icon),
      isActive: typeof gem.IsActive === 'boolean' ? gem.IsActive : null,
      points: gridTooltipNumber(parts, '젬 기본 정보', /^젬 포인트\s*:\s*(\d+)\s*$/u),
      corePoints: gridTooltipNumber(parts, '젬 효과', /^(?:질서|혼돈) 포인트\s*:\s*(\d+)\s*$/u),
      willpower: gridTooltipNumber(parts, '젬 효과', /^필요 의지력\s*:\s*(\d+)(?:\s+\([^\n]*\))?\s*$/u),
      target: parseArkgridGemTarget(gem),
      sections: parts,
    });
  }
  return result;
}

function mapGridEffects(raw) {
  if (!Array.isArray(raw) || raw.length > LIMIT.entries || !raw.every(object)) return null;
  const result = raw.map(effect => ({
    name: typeof effect.Name === 'string' ? plain(effect.Name, 120) : null,
    level: gridInteger(effect.Level), entries: entries(effect.Tooltip),
  }));
  return result.some(effect => !effect.name) ? null : result;
}

function mapArkGrid(raw) {
  if (object(raw) && Object.hasOwn(raw, 'Slots') && Object.hasOwn(raw, 'Effects') &&
      raw.Slots === null && raw.Effects === null) return { cores: [], effects: [] };
  if (!object(raw) || !Array.isArray(raw.Slots) || raw.Slots.length > 6 || !raw.Slots.every(object)) return null;
  const slots = new Set();
  const cores = [];
  for (const core of raw.Slots) {
    const slot = gridInteger(core.Index, 5);
    const name = typeof core.Name === 'string' ? plain(core.Name, 180) : null;
    if (!name || slot === null || slots.has(slot)) return null;
    slots.add(slot);
    cores.push({ slot, name, grade: plain(core.Grade, 40), icon: icon(core.Icon),
      points: gridInteger(core.Point), sections: sections(tooltip(core.Tooltip)), gems: mapGridGems(core.Gems) });
  }
  return { cores, effects: mapGridEffects(raw.Effects) };
}

// Absent or malformed sections are null; a received empty array remains an empty section.
export function mapCharacterSpecData(raw = {}) {
  const { equipment, gems, engravings, arkpassive, cards, arkgrid } = object(raw) ? raw : {};
  return { ...mapEquipment(equipment), gems: mapGems(gems), engravings: mapEngravings(engravings), arkpassive: mapArkPassive(arkpassive), cards: mapCards(cards), arkgrid: mapArkGrid(arkgrid) };
}
