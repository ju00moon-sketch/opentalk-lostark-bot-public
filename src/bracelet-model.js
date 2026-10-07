import tables from './data/bracelet-model.json' with { type: 'json' };
import { readConditionalBraceletEngraving } from './bracelet-conditional-engravings.js';
import { withNormalizedCores, DEALER_CORE_NAMES as knownCores } from './arkgrid-core-names.js';
import { isAbilityStoneReduction, isNeutralBraceletOption, defaultEnlightenmentJob, engravingEffects } from './official-input-forms.js';

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const floor2 = (n) => Math.floor(n * 100) / 100;
const compact = (s) => String(s ?? '').replace(/\s/g, '');
const sum = (items, key) => items.reduce((total, item) => total + (item[key] ?? 0), 0);
const product = (items, key, alternate) => items.reduce((total, item) => total * (item[alternate] ?? item[key] ?? 1), 1);
const numeric = (v) => {
  if (typeof v === 'number') return finite(v) && v >= 0 && v <= 1e9 ? v : null;
  if (typeof v !== 'string' || !/^(?:(?:0|[1-9]\d*)|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/.test(v.trim())) return null;
  return numeric(Number(v.replaceAll(',', '')));
};
const plain = (s) => typeof s === 'string' && s.length <= 262144 ? s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() : '';
const list = (v, max = 200) => Array.isArray(v) && v.length <= max ? v : [];
function tooltip(item, field = 'Tooltip') { try { const s = item?.[field]; if (typeof s !== 'string' || s.length > 262144) return null; const p = JSON.parse(s); return p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length <= 64 ? p : null; } catch { return null; } }
function part(item, name) {
  const entries = Object.values(tooltip(item) ?? {}).filter((e) => e?.type === 'ItemPartBox' && plain(e.value?.Element_000) === name);
  return entries.length === 1 && typeof entries[0].value.Element_001 === 'string' ? entries[0].value.Element_001 : null;
}
function parseNodes(raw) {
  const nodes = { evolution: [], enlightenment: [] };
  for (const e of list(raw?.ArkPassive?.Effects)) {
    const m = /^(진화|깨달음)\s+(\d+)티어\s+(.+?)\s+Lv\.(\d+)$/.exec(plain(e?.Description));
    if (m) nodes[m[1] === '진화' ? 'evolution' : 'enlightenment'].push({ name: m[3], level: Number(m[4]) });
  }
  return nodes;
}
function levels(nodes) { return Object.fromEntries(nodes.map((n) => [n.name, n.level])); }
function normalizedOptions(item, missing) {
  const s = part(item, '팔찌 효과'); if (s === null || s.length > 16000) return null;
  const tt = tooltip(item), title = Object.values(tt ?? {}).find((e) => e?.type === 'ItemTitle');
  const tier = Number(/티어\s*(\d+)/.exec(plain(title?.value?.leftStr2))?.[1]);
  if (![3, 4].includes(tier)) { missing.push('팔찌 티어 미확인'); return null; }
  const options = [];
  for (const raw of s.split(/(?=<img\b[^>]*bracelet_(?:locked|changeable)[^>]*>)/i)) {
    const text = plain(raw); if (!text) continue;
    const key = compact(text), stat = /^(힘|민첩|지능|체력|치명|특화|신속|제압|인내|숙련)\+([\d,]+)$/.exec(key);
    if (stat && numeric(stat[2]) !== null) {
      options.push({ text, kind: stat[1] === '체력' ? 'vitality' : ['힘', '민첩', '지능'].includes(stat[1]) ? 'primary' : 'combat', stat: stat[1], statValue: numeric(stat[2]) }); continue;
    }
    const entry = tables.bracelet[tier]?.[key];
    if (entry) options.push({ text, ...entry });
    // Non-combat lines the reference treats as neutral keep their text and carry no coefficient (2026-09-18).
    else if (isNeutralBraceletOption(key)) options.push({ text, neutral: true });
    else { options.push({ text, unknown: true }); missing.push(`미확인 팔찌 옵션: ${text}`); }
  }
  return { tier, options };
}
function coreSum(cores, table, key, missing, multiply = false, stepped = false) {
  let total = multiply ? 1 : 0;
  for (const core of cores) {
    const rows = tables[table][core.Name]; if (!rows) continue;
    let point = core.Point;
    if (stepped) point = Math.max(...Object.keys(rows).map(Number).filter((p) => p <= point));
    const row = rows[point], grade = core.Grade === '고대' ? '고대' : '유물';
    if (!row) {
      // The reference's exact lookup treats unevolved intermediate rows as
      // neutral. Future point rows above the comparison floor are unresolved.
      if (core.Point > 17) missing.push(`${core.Name}: ${table} ${core.Point}P 수치 미확인`);
      continue;
    }
    const value = (row[grade] ?? row)[key];
    if (multiply) total *= value ?? 1; else total += value ?? 0;
  }
  return total;
}
function skillBonus(raw, table, field) {
  let total = 0;
  for (const skill of list(raw?.ArmorySkills)) {
    const names = list(skill.Tripods, 20).filter((t) => t?.IsSelected).map((t) => t.Name);
    const values = tables[table][skill.Name]?.[field] ?? {};
    for (const name of names) total += values[name] ?? 0;
  }
  return total;
}
function engravingFact(e, field) {
  const name = Object.keys(tables.engraving).find((n) => compact(n) === compact(e.Name));
  return tables.engraving[name]?.[e.Grade]?.[e.Level]?.[field] ?? 0;
}
function battleExpected(c, h, q, level) {
  const chance = Math.min(c, 100) / 100;
  const regular = 1 - chance + h / 100 * chance * q;
  if (!level) return regular;
  const [base, rate, max] = level === 1 ? [7.5, 1.25, 52.5] : [15, 1.5, 75];
  const evolution = Math.min(base + Math.max(0, Math.min(c, 120) - 80) * rate, max);
  return regular * (1 + evolution / 100);
}

export function calculateBraceletFactors(input) {
  const entries = input.options, missing = [...(input.missing ?? [])];
  const f = { attackRatio: 1, addDamageRatio: 1, statRatio: 1, critRatio: 1, speedRatio: 1, finalDmgRatio: 1, staggeredTargetDmgRatio: 1, fallbackRatio: 1 };
  if (!Array.isArray(entries)) return { factors: f, multiplier: null, efficiency: null, missing: [...missing, '옵션 입력 누락'] };
  if (entries.some((e) => e.kind === 'primary' || e.weaponAtkPlus !== undefined)) {
    if (finite(input.attack?.without) && input.attack.without > 0 && finite(input.attack?.with) && input.attack.with > 0) f.attackRatio = input.attack.with / input.attack.without;
    else missing.push('공격력 반사실 계산 미완료');
  }
  const add = input.additionalDamage;
  if (finite(add?.withoutPercent) && finite(add?.braceletPercent)) f.addDamageRatio = (100 + add.withoutPercent + add.braceletPercent) / (100 + add.withoutPercent);
  else missing.push('추가 피해 기준값 누락');
  const stat = input.stats;
  if (stat && ['critical', 'special', 'haste'].every((k) => finite(stat.without?.[k]) && finite(stat.bracelet?.[k]))) {
    const s = sum(Object.values(stat.without).map((value) => ({ value })), 'value'), d = sum(Object.values(stat.bracelet).map((value) => ({ value })), 'value');
    f.statRatio = (1.3 + .00041 * (s + d)) / (1.3 + .00041 * s);
  } else missing.push('팔찌 제외 치특신 누락');
  const crit = input.critical, dc = sum(entries, 'critRate'), dh = sum(entries, 'critDmg'), cq = product(entries, 'critFinalDmg', 'specCritFinalDmg'), buff = product(entries, 'atkBuffPlus');
  if (dc || dh || cq !== 1 || buff !== 1) {
    if (crit && [crit.withoutRate, crit.withoutDamage, crit.withoutCriticalFinal, crit.bluntThornLevel].every(finite)) {
      const cap = crit.bluntThornLevel === 1 ? 116 : crit.bluntThornLevel >= 2 ? 120 : 100, c = Math.min(crit.withoutRate, cap);
      const e = battleExpected(c, crit.withoutDamage, crit.withoutCriticalFinal, crit.bluntThornLevel);
      if (e <= 0) f.critRatio = cq * buff;
      else {
        const x = battleExpected(Math.min(c + 1, cap), crit.withoutDamage, crit.withoutCriticalFinal, crit.bluntThornLevel) / e - 1;
        const y = battleExpected(c, crit.withoutDamage + 1, crit.withoutCriticalFinal, crit.bluntThornLevel) / e - 1;
        const sensitivity = Math.abs(x) + Math.abs(y) ? Math.max(-1, Math.min(1, (x - y) / (Math.abs(x) + Math.abs(y)))) : 0;
        f.critRatio = (1 + .007 * (1 + .024 * sensitivity) * Math.max(0, Math.min(c + dc, cap) - c)) * (1 + .0035 * (1 - .024 * sensitivity) * dh) * cq * buff;
      }
    } else missing.push('치적·치피·치명타 주피 기준값 누락');
  }
  const speed = sum(entries, 'atkSpeed');
  if (speed) {
    if (finite(input.speed?.withoutAttackBonus)) f.speedRatio = 1 + Math.max(0, Math.min(input.speed.withoutAttackBonus + speed, 140) - input.speed.withoutAttackBonus) * .017 / 6;
    else missing.push('공격 속도 기준값 누락');
  }
  for (const e of entries) {
    if (e.finalDmg && ['critRate', 'critRateBuff', 'critDmg', 'critFinalDmg', 'addDmg', 'devilDmg'].every((k) => e[k] === undefined)) f.finalDmgRatio *= e.finalDmg / (1 + .7 * (e.cdr ?? 0));
    if (input.devilDamageEnabled === true && e.devilDmg) f.finalDmgRatio *= e.devilDmg;
  }
  f.staggeredTargetDmgRatio = 1 + (product(entries, 'staggeredTargetDmg') - 1) * .25;
  for (const e of entries) {
    if (e.kind === 'primary' || (e.kind === 'combat' && ['치명', '특화', '신속'].includes(e.stat)) || ['weaponAtkPlus', 'addDmg', 'critRate', 'critDmg', 'critFinalDmg', 'atkSpeed', 'moveSpeed', 'finalDmg', 'staggeredTargetDmg'].some((k) => e[k] !== undefined)) continue;
    const directional = ['backDmg', 'headDmg', 'normalDmg'].some((k) => e[k] !== undefined);
    const field = { back: 'backDmg', head: 'headDmg', normal: 'normalDmg' }[input.direction];
    if (directional && input.direction !== 'all' && e[field] === undefined) continue;
    f.fallbackRatio *= e.backDmg ?? e.headDmg ?? e.normalDmg ?? e.officialFallbackRatio ?? 1;
  }
  const multiplier = Object.values(f).reduce((a, b) => a * b, 1);
  return { factors: f, multiplier, efficiency: finite(multiplier) ? Math.floor((multiplier * 1.021 - 1) * 10000) / 100 : null, missing: [...new Set(missing)] };
}

export function mapBraceletModelInput(raw, attack, { allowAbsentBracelet = false } = {}) {
  raw = withNormalizedCores(raw);
  const missing = [], equipment = list(raw?.ArmoryEquipment, 30), bracelet = equipment.find((e) => e?.Type === '팔찌');
  // Official null grid collections are already empty arrays here; a missing grid field remains an unknown input.
  const grid = raw?.ArkGrid;
  for (const [label, value, max] of [['ArmorySkills', raw?.ArmorySkills, 200], ['ArkPassive.Effects', raw?.ArkPassive?.Effects, 200],
    ['ArmoryEngraving.ArkPassiveEffects', engravingEffects(raw), 30], ['ArkGrid.Effects', grid?.Effects, 30]]) {
    if (!Array.isArray(value) || value.length > max) missing.push(`${label} 배열 누락 또는 크기 초과`);
  }
  const parsed = !bracelet && allowAbsentBracelet && Array.isArray(raw?.ArmoryEquipment) && raw.ArmoryEquipment.length <= 30 ? { tier: null, options: [] } : normalizedOptions(bracelet, missing); if (!parsed) return null;
  const options = parsed.options, delta = { critical: 0, special: 0, haste: 0 }, keys = { 치명: 'critical', 특화: 'special', 신속: 'haste' };
  for (const e of options) if (keys[e.stat]) delta[keys[e.stat]] += e.statValue;
  const stats = {};
  for (const [name, key] of Object.entries(keys)) {
    const rows = list(raw?.ArmoryProfile?.Stats, 30).filter((s) => s?.Type === name), total = rows.length === 1 ? numeric(rows[0].Value) : null;
    stats[key] = total !== null && total >= delta[key] ? total - delta[key] : null;
    if (stats[key] === null) missing.push(`${name} 총 특성과 팔찌 수치 불일치`);
  }
  const nodes = parseNodes(raw), evo = levels(nodes.evolution), enl = levels(nodes.enlightenment);
  const candidates = Object.keys(tables.classBaseline).filter((job) => nodes.enlightenment.some((n) => compact(n.name).startsWith(compact(job))));
  // No class-path node at all: the reference falls back to the class's default path (2026-09-18). Two or more
  // matching paths, or a support-capable class, stay unresolved.
  const defaulted = !candidates.length && Array.isArray(raw?.ArkPassive?.Effects) ? defaultEnlightenmentJob(raw?.ArmoryProfile?.CharacterClassName) : null;
  const job = candidates.length === 1 ? candidates[0] : defaulted, jobDefaulted = !!defaulted, cls = tables.classBaseline[job] ?? {};
  if (!job) missing.push('직업별 깨달음 계열 판별 불가');
  const cores = list(grid?.Slots, 6);
  const counts = new Map();
  for (const c of cores) counts.set(c?.Index, (counts.get(c?.Index) ?? 0) + 1);
  const validCores = cores.filter((c) => {
    if (!Number.isInteger(c?.Point) || c.Point < 0 || c.Point > 30 || !Number.isInteger(c?.Index) || c.Index < 0 || c.Index > 5 || counts.get(c.Index) !== 1) { missing.push('코어 포인트 또는 슬롯 중복'); return false; }
    // 영웅 (≤10P) and 전설 (≤14P) cores read the 유물 column: the 10P and 14P rows of every core table are identical
    // for 유물 and 고대 (2026-09-18). Points above the grade cap and unknown grades stay unresolved.
    const lower = (c.Grade === '영웅' && c.Point <= 10) || (c.Grade === '전설' && c.Point <= 14);
    if (!['유물', '고대'].includes(c.Grade) && !lower) { missing.push(`${c.Name}: 코어 등급 미확인`); return false; }
    if (typeof c.Name !== 'string' || !knownCores.has(c.Name)) { missing.push(`${typeof c.Name === 'string' ? c.Name : '이름 없음'}: 효과를 확인할 수 없는 코어`); return false; }
    return true;
  });
  if (!grid || !Array.isArray(grid.Slots) || grid.Slots.length > 6) missing.push('아크그리드 자료 누락 또는 슬롯 크기 초과');
  const allEngravings = list(engravingEffects(raw), 30), assumptions = [];
  if (jobDefaulted) assumptions.push(`깨달음 직업 계열 노드가 없어 ${job} 기준으로 계산했습니다.`);
  for (const e of allEngravings) {
    if (!e || typeof e !== 'object') { missing.push('각인 항목 형식 오류'); continue; }
    if (isAbilityStoneReduction(e)) continue;
    const conditional = readConditionalBraceletEngraving(e);
    if (conditional) { assumptions.push(conditional.assumption); continue; }
    const key = Object.keys(tables.engraving).find((name) => compact(name) === compact(e.Name));
    if (!key || !['영웅', '전설', '유물', '고대'].includes(e.Grade) || !Number.isInteger(e.Level) || e.Level < 0 || !tables.engraving[key]?.[e.Grade]?.[e.Level]) missing.push(`${e.Name ?? '이름 없음'}: 각인 등급/레벨 모형 미확인`);
  }
  const engravings = allEngravings.filter((e) => e && typeof e === 'object' && !isAbilityStoneReduction(e) && Number.isInteger(e.Level) && e.Level >= 0);
  for (const skill of list(raw?.ArmorySkills)) {
    if (!skill || typeof skill.Name !== 'string' || !Array.isArray(skill.Tripods) || skill.Tripods.length > 20) { missing.push('스킬 또는 트라이포드 배열 형식 오류'); continue; }
    const selected = new Set();
    for (const tripod of skill.Tripods) {
      if (!tripod || typeof tripod.Name !== 'string' || typeof tripod.IsSelected !== 'boolean') { missing.push(`${skill.Name}: 트라이포드 형식 오류`); continue; }
      if (tripod.IsSelected && selected.has(tripod.Name)) missing.push(`${skill.Name}: 선택 트라이포드 중복`);
      if (tripod.IsSelected) selected.add(tripod.Name);
    }
  }
  const speed = (include) => {
    const spec = (stats.special ?? 0) + (include ? delta.special : 0), haste = (stats.haste ?? 0) + (include ? delta.haste : 0);
    const out = {};
    for (const field of ['atkSpeed', 'moveSpeed']) {
      let baseline = cls[field] ?? 0;
      if (job === '광전사의 비기') baseline = floor2(baseline * (1 + Math.floor(spec / .0699 * .26) / 10000));
      let value = 14 + Math.floor(haste / .5821) / 100 + baseline + coreSum(validCores, 'coreSpeed', field, missing, false, true) + skillBonus(raw, 'skillSpeed', field);
      if (field === 'moveSpeed') value += enl['고대의 바람'] ? 10 : 0;
      else value += (enl['징벌의 서막'] ? 5 : 0) + (enl['고속 진입'] >= 1 ? 10 : 0) + 4 * (evo['파괴 전차'] ?? 0) + sum(engravings.map((e) => ({ value: engravingFact(e, field) })), 'value');
      const stone = equipment.find((e) => e.Type === '어빌리티 스톤');
      for (const element of Object.values(tooltip(stone) ?? {})) {
        if (element?.type !== 'IndentStringGroup') continue;
        for (const group of Object.values(element.value ?? {})) for (const line of Object.values(group?.contentStr ?? {})) {
          const m = new RegExp(`${field === 'atkSpeed' ? '공격속도' : '이동속도'} 감소\\s*Lv\\.(\\d+)`).exec(plain(line?.contentStr));
          if (m) value -= 2 * Number(m[1]);
        }
      }
      if (include) value += sum(options, field);
      out[field] = floor2(value);
    }
    return out;
  };
  const speedWithout = speed(false), speedWith = speed(true);
  let classCrit = cls.critRate ?? 0, classDamage = cls.critDamage ?? 0;
  if (job === '광전사의 비기') classCrit = floor2(classCrit * (1 + Math.floor((stats.special ?? 0) / .0699 * .26) / 10000));
  if (job === '질풍노도') { classCrit += floor2(.3 * Math.min(Math.max(speedWith.moveSpeed, 0), 40)); classDamage += floor2(1.2 * Math.min(Math.max(speedWith.moveSpeed, 0), 40)); }
  if (raw?.ArmoryProfile?.CharacterClassName === '소서리스' && validCores.some((c) => c.Name.includes('불완전 연소'))) { classCrit = 0; classDamage = 0; }
  let ringCrit = 0, ringDamage = 0;
  for (const ring of equipment.filter((e) => e?.Type === '반지')) for (const line of plain(part(ring, '연마 효과')).split('\n')) {
    const c = /^치명타 적중률\s*\+([\d.]+)%$/.exec(line), h = /^치명타 피해\s*\+([\d.]+)%$/.exec(line);
    if (c && numeric(c[1]) !== null) ringCrit += numeric(c[1]); if (h && numeric(h[1]) !== null) ringDamage += numeric(h[1]);
  }
  let engravingCrit = 0, engravingDamage = 0;
  for (const e of engravings) {
    const name = compact(e.Name), lv = e.Level;
    if (name === '아드레날린') engravingCrit += 8 + ({ 전설: [0, 1.5, 3, 4.5], 유물: [6, 7.5, 9, 10.5, 12] }[e.Grade]?.[lv] ?? 0);
    if (name === '정밀단도') engravingCrit += 18 + ({ 전설: [0, .75, 1.5, 2.25], 유물: [3, 3.75, 4.5, 5.25, 6] }[e.Grade]?.[lv] ?? 0) + ({ 1: 3, 2: 3.75, 3: 5.25, 4: 6 }[e.AbilityStoneLevel] ?? 0);
    if (name === '예리한둔기' || name === '정밀단도') engravingDamage += engravingFact(e, 'critDmg') + (name === '예리한둔기' ? ({ 1: 7.5, 2: 9.4, 3: 13.2, 4: 15 }[e.AbilityStoneLevel] ?? 0) : 0);
  }
  let enlightenmentCrit = Object.entries({ '전술 훈련': 1.6, 전환난무: .8, '체술 강화': 1.2, '퀵 드로우': 1, '교감 강화': 1.4 }).reduce((n, [key, v]) => n + v * (enl[key] ?? 0), 0);
  if (job !== '이슬비') enlightenmentCrit += enl.단련 ?? 0;
  if (validCores.some((c) => c.Name === '질서의 해 코어 : 적수공권')) enlightenmentCrit += 3 * (enl.자연체 ?? 0);
  let enlightenmentDamage = Object.entries({ '분노 자극': 3, '치명적인 체술': 3, 곡예사: 3, '날카로운 기공': 4, '치명적인 오의': 4, '페일 노트': 4, '격노의 악장': 4 }).reduce((n, [key, v]) => n + v * (enl[key] ?? 0), 0);
  if (enl.오버히트 !== undefined) enlightenmentDamage += (enl.오버히트 - 1) * 3;
  if (job === '이슬비') enlightenmentDamage += 4 * (enl.단련 ?? 0);
  if (enl['할버드의 대가'] !== undefined) { const level = enl['할버드의 대가']; enlightenmentDamage += 4 + 4 * Math.floor(level / 2) - (level % 2 === 0 ? 1 : 0); }
  const evolutionCrit = Object.entries({ '예리한 감각': 4, '혼신의 강타': 12, 일격: 10, 달인: 7 }).reduce((n, [key, v]) => n + v * (evo[key] ?? 0), 0);
  const stream = raw?.ArmoryProfile?.CharacterClassName === '아르카나' && list(raw?.ArmorySkills).some((s) => s.Name === '스트림 오브 엣지' && list(s.Tripods).some((t) => t.IsSelected && t.Name === '다크니스 엣지')) ? 27.6 : 0;
  const C = Math.round((Math.floor((stats.critical ?? 0) / .2794) / 100 + ringCrit + coreSum(validCores, 'coreCritRate', 'critRate', missing) + evolutionCrit + enlightenmentCrit + classCrit + stream + engravingCrit) * 100) / 100;
  const H = 200 + ringDamage + classDamage + engravingDamage + enlightenmentDamage + coreSum(validCores, 'coreCritDamage', 'critDmg', missing) + skillBonus(raw, 'skillCritDamage', 'critDmg');
  const Q = (evo.회심 ? 1.12 : 1) * coreSum(validCores, 'coreCritFinal', 'critFinalDmg', missing, true);
  const weapon = equipment.find((e) => e?.Type === '무기'), quality = Object.values(tooltip(weapon) ?? {}).find((e) => e?.type === 'ItemTitle')?.value?.qualityValue;
  let add = finite(quality) && quality > 0 ? 10 + .002 * quality ** 2 : 0;
  if (!finite(quality) || quality < 0 || quality > 100) missing.push('무기 품질 미확인');
  const necklace = equipment.find((e) => e?.Type === '목걸이'), neckAdd = /^추가 피해\s*\+([\d.]+)%$/m.exec(plain(part(necklace, '연마 효과')));
  if (neckAdd && numeric(neckAdd[1]) !== null) add += numeric(neckAdd[1]);
  const gems = list(grid?.Effects, 30).filter((e) => e.Name === '추가 피해');
  if (gems.length === 1) { const m = /^추가 피해\s*\+([\d.]+)%$/.exec(plain(gems[0].Tooltip)); if (m && numeric(m[1]) !== null) add += numeric(m[1]); else missing.push('젬 추가 피해 수치 미확인'); }
  if (gems.length > 1) missing.push('젬 추가 피해 합산 중복');
  const stable = validCores.find((c) => c.Name === '혼돈의 해 코어 : 안정적인 공격');
  if (stable) { const points = [10, 14, 17, 18, 19, 20], i = Math.max(0, points.findLastIndex((p) => p <= stable.Point)); add += (stable.Grade === '고대' ? [0, .7, 3.5, 3.73, 3.96, 4.19] : [0, .7, 2.1, 2.33, 2.56, 2.78])[i]; }
  const names = new Set(engravings.map((e) => compact(e.Name)));
  const completeStats = Object.values(stats).every(finite);
  return { attack, additionalDamage: { withoutPercent: finite(quality) && quality >= 0 && quality <= 100 ? add : null, braceletPercent: sum(options, 'addDmg') }, stats: { without: stats, bracelet: delta },
    critical: { withoutRate: completeStats && job ? C : null, withoutDamage: job ? H : null, withoutCriticalFinal: Q, bluntThornLevel: evo['뭉툭한 가시'] ?? 0 }, speed: { withoutAttackBonus: completeStats && job ? speedWithout.atkSpeed : null },
    options, assumptions, direction: names.has('기습의대가') ? 'back' : names.has('결투의대가') ? 'head' : names.has('타격의대가') ? 'normal' : 'all', devilDamageEnabled: false,
    missing: [...missing, ...(options.some((e) => e.kind === 'primary' || e.weaponAtkPlus !== undefined) ? attack?.missing ?? [] : [])], diagnostics: { job, jobDefaulted, speedWithout, speedWith, C, H, Q, tier: parsed.tier } };
}
