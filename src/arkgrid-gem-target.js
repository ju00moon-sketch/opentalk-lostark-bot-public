import { createHash } from 'node:crypto';

const SOURCE = 'official-arkgrid-gem-tooltip';
const MAX_TOOLTIP = 131072;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const TYPES = {
  질서: { id: 'order', subtypes: ['안정', '견고', '불변'] },
  혼돈: { id: 'chaos', subtypes: ['침식', '왜곡', '붕괴'] },
};
// Official subtype pools and activation requirements; the same labelled values
// are verified in the Korean equipped-gem response rather than filled in.
// https://www.playlostark.com/en-us/game/releases/day-of-prophecy
const SUBTYPE_RULES = [
  { names: ['안정', '침식'], base: 8, options: ['공격력', '추가 피해', '낙인력', '아군 피해 강화'] },
  { names: ['견고', '왜곡'], base: 9, options: ['공격력', '보스 피해', '아군 피해 강화', '아군 공격 강화'] },
  { names: ['불변', '붕괴'], base: 10, options: ['추가 피해', '보스 피해', '낙인력', '아군 공격 강화'] },
];
const GRADE_POINTS = { 전설: [4, 15], 유물: [16, 18], 고대: [19, 20] };
class TargetError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const fail = reason => { throw new TargetError(reason); };
const requireValue = (value, reason) => { if (!value) fail(reason); };

// JSON.parse alone silently accepts duplicate object keys. Check the already
// valid JSON's structure so an overwritten official field cannot become a target.
function uniqueJsonKeys(raw) {
  let index = 0, nodes = 0;
  const whitespace = () => { while (/[\t\r\n ]/.test(raw[index] ?? '\0')) index++; };
  function string() {
    const start = index++;
    while (index < raw.length) {
      if (raw[index] === '\\') index += 2;
      else if (raw[index++] === '"') return JSON.parse(raw.slice(start, index));
    }
    fail('invalid_tooltip');
  }
  function value(depth = 0) {
    requireValue(depth <= 32 && ++nodes <= 4096, 'invalid_tooltip');
    whitespace();
    if (raw[index] === '"') { string(); return; }
    if (raw[index] === '{') {
      index++; whitespace(); const keys = new Set();
      if (raw[index] === '}') { index++; return; }
      while (index < raw.length) {
        whitespace(); const key = string();
        requireValue(!keys.has(key), 'ambiguous_tooltip'); keys.add(key);
        whitespace(); index++; value(depth + 1); whitespace();
        if (raw[index++] === '}') return;
      }
    } else if (raw[index] === '[') {
      index++; whitespace();
      if (raw[index] === ']') { index++; return; }
      while (index < raw.length) { value(depth + 1); whitespace(); if (raw[index++] === ']') return; }
    } else {
      while (index < raw.length && !/[\t\r\n ,}\]]/.test(raw[index])) index++;
      return;
    }
    fail('invalid_tooltip');
  }
  value(); whitespace(); requireValue(index === raw.length, 'invalid_tooltip');
}

function plain(value) {
  requireValue(typeof value === 'string' && value.length <= 16384 && value.isWellFormed(), 'invalid_tooltip');
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  let text = value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()];
    const hex = entity[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    requireValue(code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff), 'invalid_tooltip');
    return String.fromCodePoint(code);
  });
  requireValue(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(text), 'invalid_tooltip');
  let output = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '<') { requireValue(text[index] !== '>', 'invalid_tooltip'); output += text[index]; continue; }
    const end = text.indexOf('>', index + 1);
    requireValue(end !== -1, 'invalid_tooltip');
    const tag = text.slice(index, end + 1);
    if (/^<br\s*\/?>$|^<\/(?:p|div)>$/i.test(tag)) output += '\n';
    else requireValue(/^<\/?(?:font|b|i|u|span|p|div|img)(?:\s+[^<>]*)?\s*>$/i.test(tag), 'invalid_tooltip');
    index = end;
  }
  return output.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\t\u00a0 ]+/g, ' ').trim();
}

function exactlyOne(values, reason = 'ambiguous_tooltip') {
  requireValue(values.length === 1, reason);
  return values[0];
}

function labelled(lines, prefix, pattern, reason) {
  const line = exactlyOne(lines.filter(value => value.startsWith(prefix)), reason);
  const match = pattern.exec(line);
  requireValue(match, reason);
  return match;
}

function parse(gem) {
  requireValue(object(gem) && typeof gem.Grade === 'string' && Object.hasOwn(GRADE_POINTS, gem.Grade), 'invalid_gem_grade');
  requireValue(typeof gem.Tooltip === 'string' && gem.Tooltip.length > 0 && gem.Tooltip.length <= MAX_TOOLTIP && gem.Tooltip.isWellFormed(), 'invalid_tooltip');
  let tip;
  try { tip = JSON.parse(gem.Tooltip); } catch { fail('invalid_tooltip'); }
  requireValue(object(tip) && Object.keys(tip).length <= 64 && Object.values(tip).every(value => value === null || object(value)), 'invalid_tooltip');
  uniqueJsonKeys(gem.Tooltip);
  const parts = Object.values(tip).filter(object);
  const completed = parts.filter(part => part.type === 'SingleTextBox').map(part => plain(part.value)).filter(value => value === '가공 완료');
  requireValue(completed.length > 0, 'completion_unverified');
  exactlyOne(completed);
  const name = exactlyOne(parts.filter(part => part.type === 'NameTagBox').map(part => plain(part.value)));
  const identity = /^(질서|혼돈)의 젬 : (안정|견고|불변|침식|왜곡|붕괴)$/.exec(name);
  requireValue(identity && TYPES[identity[1]].subtypes.includes(identity[2]), 'invalid_gem_identity');
  const typeName = identity[1], subtype = identity[2];
  const subtypeRule = SUBTYPE_RULES.find(rule => rule.names.includes(subtype));
  const sections = parts.filter(part => part.type === 'ItemPartBox').map(part => {
    requireValue(object(part.value), 'invalid_tooltip');
    return { title: plain(part.value.Element_000), lines: plain(part.value.Element_001).split('\n').map(line => line.trim()).filter(Boolean) };
  });
  const basic = exactlyOne(sections.filter(part => part.title === '젬 기본 정보')).lines;
  const effects = exactlyOne(sections.filter(part => part.title === '젬 효과')).lines;
  requireValue(basic.length <= 32 && effects.length <= 32, 'invalid_tooltip');
  const declaredType = labelled(basic, '젬 타입', /^젬 타입\s*:\s*(질서|혼돈)$/, 'invalid_gem_identity')[1];
  requireValue(declaredType === typeName, 'inconsistent_gem_target');
  const points = Number(labelled(basic, '젬 포인트', /^젬 포인트\s*:\s*([1-9]\d?)$/, 'invalid_gem_points')[1]);
  const pointLine = exactlyOne(effects.filter(line => /^(?:질서|혼돈)\s*포인트/.test(line)), 'invalid_gem_points');
  const coreMatch = /^(질서|혼돈) 포인트\s*:\s*([1-5])$/.exec(pointLine);
  requireValue(coreMatch, 'invalid_gem_points');
  requireValue(coreMatch[1] === typeName, 'inconsistent_gem_target');
  const corePoints = Number(coreMatch[2]);
  const will = labelled(effects, '필요 의지력', /^필요 의지력\s*:\s*(0|[1-9]\d{0,4})\s*\(기본 값 ([1-9]\d{0,4})\s*[–−-]\s*의지력 효율 ([1-5])\)$/, 'invalid_gem_willpower');
  const willpower = Number(will[1]), baseWillpower = Number(will[2]), willpowerEfficiency = Number(will[3]);
  requireValue(baseWillpower === subtypeRule.base && baseWillpower - willpowerEfficiency === willpower, 'inconsistent_gem_target');
  const options = effects.filter(line => line.startsWith('[') || /\bLv\./.test(line)).map(line => {
    const match = /^\[([^\]]+)\] Lv\.([1-5])$/.exec(line);
    requireValue(match && subtypeRule.options.includes(match[1]), 'invalid_gem_options');
    return { name: match[1], level: Number(match[2]) };
  });
  requireValue(options.length === 2 && new Set(options.map(option => option.name)).size === 2, 'invalid_gem_options');
  options.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const [minimum, maximum] = GRADE_POINTS[gem.Grade];
  requireValue(points >= minimum && points <= maximum && points === willpowerEfficiency + corePoints + options[0].level + options[1].level, 'inconsistent_gem_target');
  const target = { source: SOURCE, name, type: TYPES[typeName].id, typeName, subtype, grade: gem.Grade,
    completed: true, points, corePoints, willpower, baseWillpower, willpowerEfficiency, options };
  const targetKey = createHash('sha256').update(JSON.stringify(['arkgrid-gem-target-v1', target])).digest('hex');
  return { status: 'ok', ...target, targetKey };
}

// Cost, processing opportunities and historical spending are not inferred from
// a completed equipped gem. Only its explicitly observed target is returned.
export function parseArkgridGemTarget(gem) {
  try { return parse(gem); }
  catch (error) { return { status: 'unavailable', reason: error instanceof TargetError ? error.reason : 'invalid_tooltip' }; }
}
