// Display classification shares the auction option values; it does not estimate item strength.
import { OPTIONS, GRADE_INDEX } from './data/refine.js';

const ACCESSORIES = new Set(['목걸이', '귀걸이', '반지']);
const GRADES = Object.keys(GRADE_INDEX);
const key = value => value.normalize('NFC').replace(/[\s·,]/gu, '');

// Slot and unit are part of the identity: flat attack and attack percent must never mix.
const definitions = [
  [42, '목걸이', '%', '적주피'], [41, '목걸이', '%', '추피'],
  [44, '목걸이', '%', '낙인'], [43, '목걸이', '%', '조게획'],
  [45, '귀걸이', '%', '공%'], [46, '귀걸이', '%', '무공%'],
  [47, '귀걸이', '%', '회복'], [48, '귀걸이', '%', '보호막'],
  [49, '반지', '%', '치적'], [50, '반지', '%', '치피'],
  [51, '반지', '%', '아공강'], [52, '반지', '%', '아피강'],
  [53, null, null, '공'], [54, null, null, '무공'], [55, null, null, '최생'],
].map(([code, slot, unit, shortName]) => {
  const option = OPTIONS[code];
  const name = option.full.replace(/\s*[%+]$/, '');
  const names = [name];
  if ([51, 52].includes(code)) names.push(name.replace(/ 효과$/, ''));
  return { code, slot, unit, shortName, names: names.map(key), values: option.values };
});

// Remaining shared effects are the existing /연마표 rows, not new auction option codes.
definitions.push(
  { code: null, slot: null, unit: null, shortName: '최마', names: [key('최대 마나')], values: [6, 15, 30] },
  { code: null, slot: null, unit: '%', shortName: '상태이상', names: [key('상태이상 공격 지속시간')], values: [20, 50, 100] },
  { code: null, slot: null, unit: null, shortName: '전투회복', names: [key('전투 중 생명력 회복량')], values: [10, 25, 50] },
);

function scaledValue(raw, unit) {
  const [whole, fraction = ''] = raw.replaceAll(',', '').split('.');
  const places = unit === '%' ? 2 : 0;
  if (!/^0*$/.test(fraction.slice(places))) return null;
  const value = Number(whole) * (unit === '%' ? 100 : 1) + Number(fraction.slice(0, places).padEnd(places, '0'));
  return Number.isSafeInteger(value) && value <= 1e9 ? value : null;
}

export function classifyRefinementOption(slot, text) {
  if (!ACCESSORIES.has(slot) || typeof text !== 'string' || !text.trim() || text.length > 1200) return null;
  const result = { text, optionCode: null, shortName: null, value: null, unit: null, grade: null };
  const match = /^(.+?)\s*\+((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)\s*(%)?$/.exec(text.trim());
  if (!match) return result;
  const unit = match[3] ?? null;
  const value = Number(match[2].replaceAll(',', ''));
  if (!Number.isFinite(value) || value > 1e9) return result;
  result.value = value; result.unit = unit;
  const definition = definitions.find(option => (!option.slot || option.slot === slot) && option.unit === unit && option.names.includes(key(match[1])));
  if (!definition) return result;
  result.optionCode = definition.code; result.shortName = definition.shortName;
  const scaled = scaledValue(match[2], unit);
  const index = definition.values.indexOf(scaled);
  if (index !== -1) result.grade = GRADES.find(grade => GRADE_INDEX[grade] === index) ?? null;
  return result;
}

export function accessoryRefinementOptions(slot, sections) {
  if (!ACCESSORIES.has(slot) || !Array.isArray(sections)) return null;
  const selected = sections.slice(0, 16).filter(section => typeof section?.title === 'string' && key(section.title) === '연마효과');
  if (!selected.length) return null;
  return selected.flatMap(section => Array.isArray(section.entries) ? section.entries.slice(0, 32) : [])
    .slice(0, 32).map(entry => classifyRefinementOption(slot, entry?.text)).filter(Boolean);
}
