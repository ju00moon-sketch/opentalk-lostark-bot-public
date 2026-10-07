import { createHash } from 'node:crypto';
import { BRACELET_T4_EFFECTS } from './bracelet-t4-data.js';
import { BRACELET_T4_TEXT_KEYS } from './bracelet-t4-text-keys.js';
import { parseTooltip, stripTags } from './tooltip.js';
import { readBraceletT3Input } from './bracelet-t3-input.js';

const statIds = { 힘: 'base.mainStat', 민첩: 'base.mainStat', 지능: 'base.mainStat', 체력: 'base.vitality',
  치명: 'combat.crit', 특화: 'combat.specialization', 제압: 'combat.domination', 신속: 'combat.swiftness', 인내: 'combat.endurance', 숙련: 'combat.expertise' };
export function canonicalBraceletOptionText(text) {
  return text.normalize('NFC').replace(/\d+(?:,\d{3})*(?:\.\d+)?/g, match => {
    const [integer, fraction = ''] = match.replaceAll(',', '').split('.');
    const whole = integer.replace(/^0+(?=\d)/, '');
    const decimal = fraction.replace(/0+$/, '');
    return decimal ? `${whole}.${decimal}` : whole;
  }).replace(/\s+/g, '')
    // The armory adds this exact definition of protection to the published row.
    // Preserve every duration, condition, and effect value for the full-row hash.
    .replace(/^파티효과로보호효과\(보호막,생명력회복,받는피해감소\)/, '파티효과로보호효과')
    // The armory's damage-taken statement uses 피해량이 for the table's 피해가.
    .replace(/^시드등급이하몬스터에게받는피해량이(?=\d+(?:\.\d+)?%감소한다\.$)/, '시드등급이하몬스터에게받는피해가');
}

export function readBraceletExpectationInput(item) {
  const unavailable = reason => ({ status: 'unavailable', reason });
  if (!item || item.Type !== '팔찌' || typeof item.Tooltip !== 'string' || item.Tooltip.length > 131072) return unavailable('팔찌 정보가 없습니다.');
  const rarity = item.Grade === '고대' ? 'ancient' : item.Grade === '유물' ? 'relic' : null;
  const tooltip = parseTooltip(item.Tooltip);
  if (!tooltip || typeof tooltip !== 'object' || Array.isArray(tooltip)) return unavailable('팔찌 툴팁을 확인할 수 없습니다.');
  const titles=Object.values(tooltip).filter(row=>row?.type==='ItemTitle');
  const title=titles.length===1?stripTags(titles[0].value?.leftStr2):'';
  if (/(?:^|\s|\()티어\s*3(?:\s|\)|$)/.test(title)) return {...readBraceletT3Input(item),itemTier:3};
  if (!rarity || !/(?:^|\s|\()티어\s*4(?:\s|\)|$)/.test(title)) return unavailable('3·4티어 유물·고대 팔찌를 지원합니다.');
  const parts = Object.values(tooltip).filter(row => row?.type === 'ItemPartBox' && stripTags(row.value?.Element_000) === '팔찌 효과');
  const html = parts.length === 1 ? parts[0]?.value?.Element_001 : null;
  if (typeof html !== 'string' || html.length > 16000) return unavailable('팔찌 효과를 확인할 수 없습니다.');
  const markers = [...html.matchAll(/<img\b[^>]*\bemoticon_tooltip_bracelet_(locked|changeable)\b[^>]*>(?:<\/img>)?/gi)];
  if (!markers.length || markers.length > 5 || stripTags(html.slice(0, markers[0].index))) return unavailable('고정·부여 옵션을 구분할 수 없습니다.');
  const complete = Object.values(tooltip).some(row => row?.type === 'SingleTextBox' && stripTags(row.value).trim() === '효과 부여 불가');
  // An upgrade locks the old granted effects as well. The observed completed
  // ancient layout has four locked rows followed by its one newly granted row.
  // Five effects permit only two initial fixed + three granted slots. Recover
  // this layout only when both extra locked rows are published grant-only effects.
  const upgraded = rarity === 'ancient' && complete && markers.length === 5
    && markers.slice(0, 4).every(marker => marker[1].toLowerCase() === 'locked')
    && markers[4][1].toLowerCase() === 'changeable';
  const input = { itemTier:4,rarity, fixed: [], granted: [], startingBraceletGold: null, reconversionTickets: 3 };
  const target = [];
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index];
    // A continuation after <BR> belongs to its preceding icon, not a new effect.
    const text = stripTags(html.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? html.length)).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 1000) return unavailable('팔찌 효과 문구가 올바르지 않습니다.');
    const upgradedGrant = upgraded && index >= 2 && index <= 3;
    const isFixed = marker[1].toLowerCase() === 'locked' && !upgradedGrant;
    const stat = /^(힘|민첩|지능|체력|치명|특화|제압|신속|인내|숙련)\s*\+([\d,]+)$/.exec(text);
    let entry;
    if (stat && /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(stat[2])) {
      if (upgradedGrant) return unavailable('승급 전 고정·부여 옵션을 명확히 구분할 수 없습니다.');
      entry = { id: statIds[stat[1]], value: Number(stat[2].replaceAll(',', '')) };
    }
    else {
      // Match the complete published statement. A changed fixed duration, polarity,
      // or extra condition must not receive the probability of a different effect.
      const digest = createHash('sha256').update(canonicalBraceletOptionText(text)).digest('hex');
      const known = BRACELET_T4_TEXT_KEYS[`${rarity}:${digest}`];
      const effect = known && BRACELET_T4_EFFECTS.find(row => row.id === known.id);
      if (!effect || (isFixed && !effect.fixedAllowed)) return unavailable(`공식 확률표와 일치하지 않는 옵션: ${text}`);
      if (upgradedGrant && effect.fixedAllowed) return unavailable('승급 전 고정·부여 옵션을 명확히 구분할 수 없습니다.');
      entry = { id: known.id, tier: known.tier };
    }
    input[isFixed ? 'fixed' : 'granted'].push(entry);
    target.push({ fixed: isFixed, text, ...entry });
  }
  if (input.granted.length === 0 && complete) {
    return unavailable('고정 옵션만 있는 효과 부여 불가 팔찌는 효과 변환 기댓값을 계산하지 않습니다.');
  }
  return { status: 'ok',itemTier:4,input,target };
}
