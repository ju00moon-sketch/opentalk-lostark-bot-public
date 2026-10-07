import supportFacts from './data/support-bracelet-model.json' with { type: 'json' };
import coreFacts from './data/gem-model-facts.json' with { type: 'json' };
import { calculateBraceletAttackContext } from './bracelet-attack-context.js';
import { withNormalizedCores, DEALER_CORE_NAMES } from './arkgrid-core-names.js';
import { isAbilityStoneReduction, isUnopenedKarma, isNeutralBraceletOption, engravingEffects } from './official-input-forms.js';

const JOBS = Object.freeze({
  도화가: { node: '만개', a: '묵법 : 해그리기', b: '묵법 : 해우물', duration: [8, 6], cooldown: [27, 30], quick: 'b', quickCooldown: 24 },
  바드: { node: '절실한 구원', a: '천상의 연주', b: '음파 진동', duration: [8, 5], cooldown: [30, 24], quick: 'a', quickCooldown: 24 },
  홀리나이트: { node: '축복의 오라', a: '신의 분노', b: '천상의 축복', duration: [8, 8], cooldown: [27, 35] },
  발키리: { node: '해방자', a: '숭고한 맹세', b: '숭고한 도약', duration: [8, 8], cooldown: [27, 36] },
});
const THRESHOLDS = [10, 14, 17, 18, 19, 20];
const EFFECTS = ['공격력', '추가 피해', '보스 피해', '낙인력', '아군 공격 강화', '아군 피해 강화'];
const EFFECT_LABELS = { '보스 피해': '보스 등급 이상 몬스터에게 주는 피해', '아군 공격 강화': '아군 공격력 강화 효과', '아군 피해 강화': '아군 피해량 강화 효과' };
const EXCLUDED_COOLDOWN = new Set(['수호의 연주', '신성한 보호', '빛의 광시곡', '구원의 은총', '구원의 터']);
const IDENTITY_SKILLS = new Set(['신앙 스킬', '세레나데 스킬', '음양 스킬']);
const MARK_NODES = new Set(['빠른 구원', '빛의 흔적', '포용의 세레나데', '낙인의 세레나데', '오누이', '낙인 강화', '해방자의 흔적', '빛의 검기']);
const SPECIAL_NODES = new Set(['신성 해방', '세레나데 코드', '묵법 : 접무', '해방의 날개']);
const knownCores = new Set([...Object.keys(coreFacts.coreFinal), ...coreFacts.classCores['서폿'].mainCore, ...coreFacts.classCores['서폿'].starCore]);
// In-game core point caps by grade. A point above the cap is uninterpretable and fails closed.
const CORE_POINT_CAP = Object.freeze({ 영웅: 10, 전설: 14, 유물: 20, 고대: 20 });
const LOW_CORE_GRADES = new Set(['영웅', '전설']);
// 영웅·전설 cores read the 유물 column: within their caps the 10P and 14P rows of every table are identical for 유물 and 고대.
const tableGrade = core => LOW_CORE_GRADES.has(core.Grade) ? '유물' : core.Grade;
const LOW_GRADE_ASSUMPTION = '영웅·전설 코어는 같은 포인트의 유물 기준표(10·14P는 유물·고대 동일)를 사용합니다.';
const plain = value => typeof value === 'string' ? value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').normalize('NFC').trim() : '';
const compact = value => plain(value).replace(/\s/g, '');
const numeric = value => typeof value === 'number' ? (Number.isFinite(value) && value >= 0 && value <= 1e8 ? value : null)
  : typeof value === 'string' && /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/.test(value.trim()) ? numeric(Number(value.replaceAll(',', ''))) : null;
const canonical = value => compact(value).replace(/\d+(?:,\d{3})*(?:\.\d+)?/g, value => {
  const [integer, fraction = ''] = value.replaceAll(',', '').split('.');
  const tail = fraction.replace(/0+$/, ''); return integer.replace(/^0+(?=\d)/, '') + (tail ? '.' + tail : '');
});
const braceletFacts = Object.fromEntries(Object.entries(supportFacts.bracelet).map(([tier, rows]) => [tier, new Map(Object.entries(rows).map(([key, value]) => [canonical(key), value]))]));
const empty = (status, omitted = []) => ({ status, efficiency: null, assumptions: [], formulas: [], omitted });
const emptyGem = (status, omitted = []) => ({ ...empty(status, omitted), optionEfficiency: null, pointEfficiency: null, effectEfficiencies: [], pointBreakdown: [] });
const round = value => Math.round(value * 10000) / 10000;
const efficiency = (withValue, withoutValue) => Math.floor((withValue / withoutValue - 1) * 10000 + 1e-9) / 100;
// Supporter efficiency convention shared by the bracelet and the gems: the buff-power ratio becomes a score ratio
// through the 4.24 exponent, the increase is floored to two decimals, then divided by 1.4.
const scoreEfficiency = (withValue, withoutValue) => round(efficiency((withValue / withoutValue) ** 4.24, 1) / 1.4);
function fail(key) { throw new Error(key); }
function array(value, key, max = 100) { if (!Array.isArray(value) || value.length > max) fail(key); return value; }
function tip(value) { if (typeof value !== 'string' || value.length > 160000) fail('tooltip'); let result; try { result = JSON.parse(value); } catch { fail('tooltip'); } if (!result || Array.isArray(result) || typeof result !== 'object' || Object.keys(result).length > 64) fail('tooltip'); return result; }
function section(item, label, required = false) {
  const rows = Object.values(tip(item.Tooltip)).filter(row => row?.type === 'ItemPartBox' && compact(row.value?.Element_000) === compact(label));
  if (rows.length > 1 || (!rows.length && required)) fail(label);
  if (!rows.length) return '';
  if (typeof rows[0].value.Element_001 !== 'string') fail(label);
  return rows[0].value.Element_001;
}
function nodes(raw) {
  const result = { evolution: [], enlightenment: [] }, seen = new Set();
  for (const effect of array(raw?.ArkPassive?.Effects, 'ArkPassive.Effects', 80)) {
    const match = /^(진화|깨달음|도약)\s+(\d+)티어\s+(.+?)\s+Lv\.(\d+)$/.exec(plain(effect?.Description));
    if (!match || effect.Name !== match[1]) fail('ArkPassive.node');
    if (seen.has(match[1] + ':' + compact(match[3]))) fail('ArkPassive.duplicate'); seen.add(match[1] + ':' + compact(match[3]));
    if (Number(match[4]) < 1 || Number(match[4]) > 50) fail('ArkPassive.level');
    if (match[1] !== '도약') result[match[1] === '진화' ? 'evolution' : 'enlightenment'].push({ name: match[3], level: Number(match[4]) });
  }
  return result;
}
export function isSupportCharacter(raw) {
  try { const job = JOBS[raw?.ArmoryProfile?.CharacterClassName]; return !!job && nodes(raw).enlightenment.some(n => compact(n.name) === compact(job.node) && n.level <= 3); } catch { return false; }
}
function bracelet(raw) {
  const items = array(raw.ArmoryEquipment, 'ArmoryEquipment', 40).filter(x => x?.Type === '팔찌');
  if (items.length > 1) fail('팔찌 중복');
  const out = { present: !!items.length, primary: 0, haste: 0, special: 0, atkBuff: 0, damageBuff: 0, weaponAtkPlus: 0, atkBuffPlus: 1, neutral: [] };
  if (!items.length) return out;
  const item = items[0], title = Object.values(tip(item.Tooltip)).find(x => x?.type === 'ItemTitle');
  const tier = /티어\s*(\d+)/.exec(plain(title?.value?.leftStr2))?.[1];
  if (!braceletFacts[tier] || !['고대', '유물'].includes(item.Grade)) fail('팔찌 티어·등급');
  const effectText = section(item, '팔찌 효과', true); if (effectText.length > 16000) fail('팔찌 효과 크기');
  const options = effectText.split(/(?=<img\b[^>]*bracelet_(?:locked|changeable)[^>]*>)/i).map(plain).filter(Boolean);
  if (!options.length || options.length > 5) fail('팔찌 옵션 개수');
  const seen = new Set();
  for (const text of options) {
    const key = canonical(text), stat = /^(힘|민첩|지능|체력|치명|특화|신속|제압|인내|숙련)\+(.+)$/.exec(compact(text));
    // Non-combat lines the reference treats as neutral carry no coefficient and may repeat (효과 부여 가능 ×2) (2026-09-18).
    if (!stat && !braceletFacts[tier].has(key) && isNeutralBraceletOption(compact(text))) { out.neutral.push(text); continue; }
    const identity = stat ? stat[1] : key;
    if (seen.has(identity)) fail('팔찌 옵션 중복'); seen.add(identity);
    if (stat) { const value = numeric(stat[2]); if (value === null || value > (['힘','민첩','지능','체력'].includes(stat[1]) ? 20000 : 200)) fail('팔찌 특성');
      if (['힘','민첩','지능'].includes(stat[1])) out.primary += value;
      if (stat[1] === '특화') out.special += value; if (stat[1] === '신속') out.haste += value; continue; }
    const row = braceletFacts[tier].get(key); if (!row) fail('미확인 팔찌 옵션: ' + text.slice(0, 160));
    for (const field of ['atkBuff', 'damageBuff', 'weaponAtkPlus']) out[field] += row[field] ?? 0;
    out.atkBuffPlus *= row.atkBuffPlus ?? 1;
  }
  return out;
}
function readGems(raw) {
  const container = raw?.ArmoryGem;
  if (container?.Gems === null && container.Effects?.Description === '' && Array.isArray(container.Effects.Skills) && container.Effects.Skills.length === 0) return [];
  const gems = array(container?.Gems, 'ArmoryGem.Gems', 20), skills = array(container?.Effects?.Skills, 'ArmoryGem.Effects.Skills', 20), slots = new Map();
  for (const gem of gems) { if (!Number.isInteger(gem?.Slot) || gem.Slot < 0 || gem.Slot > 20 || slots.has(gem.Slot) || !Number.isInteger(gem.Level) || gem.Level < 1 || gem.Level > 10) fail('보석 슬롯'); slots.set(gem.Slot, gem); }
  const seen = new Set(), result = [];
  for (const skill of skills) {
    const gem = slots.get(skill?.GemSlot); if (!gem || seen.has(skill.GemSlot)) fail('보석 효과 슬롯'); seen.add(skill.GemSlot);
    if (typeof skill.Name !== 'string' || !skill.Name.trim() || skill.Name.length > 100) fail('보석 스킬명');
    let cooldown = null, support = null; const kinds = new Set();
    for (const description of array(skill.Description, '보석 효과', 5)) {
      const text = compact(description); let match, kind, value;
      if ((match = /^재사용대기시간([\d.]+)%감소$/.exec(text))) kind = 'cooldown';
      else if ((match = /^지원효과([\d.]+)%증가$/.exec(text))) kind = 'support';
      else if ((match = /^피해([\d.]+)%증가$/.exec(text))) kind = 'damage';
      else fail('보석 효과 해석');
      value = numeric(match[1]); if (value === null || value > 100 || kinds.has(kind)) fail('보석 효과 수치·중복'); kinds.add(kind);
      if (kind === 'cooldown') cooldown = value;
      if (kind === 'support') support = value;
    }
    if (!kinds.size || (cooldown !== null && (cooldown >= 100 || kinds.size > 1)) || (support !== null && support > 20)) fail('보석 효과 범위');
    result.push({ name: plain(skill.Name), level: gem.Level, cooldown, support });
  }
  if (seen.size !== slots.size) fail('보석 효과 누락');
  return result;
}
function coreRows(raw) {
  // Official null grid collections are already empty arrays here; both empty means no grid is equipped.
  const grid = withNormalizedCores(raw)?.ArkGrid;
  const cores = array(grid?.Slots, 'ArkGrid.Slots', 6), effects = array(grid?.Effects, 'ArkGrid.Effects', 30), seen = new Set(), indexes = new Set(), neutral = [];
  for (const core of cores) {
    if (!Number.isInteger(core?.Index) || core.Index < 0 || core.Index > 5 || indexes.has(core.Index)) fail('아크그리드 코어 슬롯'); indexes.add(core.Index);
    const cap = Object.hasOwn(CORE_POINT_CAP, core?.Grade) ? CORE_POINT_CAP[core.Grade] : -1;
    // A dealer core on a supporter is a known core without a buff effect: it passes the grade, slot and duplicate
    // checks and enters no support table lookup (2026-09-18). A name in neither set still fails.
    const dealerCore = !knownCores.has(core?.Name) && DEALER_CORE_NAMES.has(core?.Name);
    if ((!knownCores.has(core?.Name) && !dealerCore) || seen.has(core.Name) || !Number.isInteger(core.Point) || core.Point < 0 || core.Point > cap) fail('아크그리드 코어'); seen.add(core.Name);
    if (dealerCore) neutral.push(core.Name);
  }
  seen.clear();
  for (const effect of effects) {
    if (!EFFECTS.includes(effect?.Name) || seen.has(effect.Name) || !Number.isInteger(effect.Level) || effect.Level < 0 || effect.Level > 200) fail('아크그리드 젬 효과'); seen.add(effect.Name);
    const match = new RegExp('^'+compact(EFFECT_LABELS[effect.Name] ?? effect.Name)+'\\+([\\d.]+)%$').exec(compact(effect.Tooltip));
    if (!match || numeric(match[1]) === null || numeric(match[1]) > 100) fail('아크그리드 젬 수치');
  }
  return { cores, effects, neutral, absent: !cores.length && !effects.length };
}
function fact(cores, name, field, fallback = 0, stepped = false) {
  const core = cores.find(c => c.Name === name); if (!core || core.Point < 10) return fallback;
  const point = stepped ? THRESHOLDS.filter(p => p <= core.Point).at(-1) : core.Point;
  // This versioned model defines rows only at these six breakpoints. The
  // flowing-mana cooldown alone selects the previous active breakpoint.
  if (!THRESHOLDS.includes(point)) return fallback;
  const row = coreFacts.coreFinal[name]?.[point]?.[tableGrade(core)];
  if (!row) fail('지원 코어 기준표 누락');
  // A field absent from a valid row is a bonus not granted at that breakpoint.
  const value = row[field] ?? fallback;
  if (numeric(value) === null) fail('지원 코어 기준표 수치');
  return value;
}
function context(raw) {
  const job = JOBS[raw?.ArmoryProfile?.CharacterClassName], n = nodes(raw);
  if (!job || !n.enlightenment.some(x => compact(x.name) === compact(job.node))) fail('지원 아크패시브');
  const b = bracelet(raw), attack = calculateBraceletAttackContext(raw), d = attack.diagnostics;
  const missing = attack.missing.filter(x => !(x === 'equipment.bracelet' && !b.present));
  if (missing.length) fail('공격력 입력: ' + missing.join(', '));
  const stats = array(raw.ArmoryProfile.Stats, 'ArmoryProfile.Stats', 20);
  const stat = name => { const rows = stats.filter(x => x?.Type === name), value = numeric(rows[0]?.Value); if (rows.length !== 1 || value === null || value > 5000) fail('전투 특성'); return value; };
  const haste = stat('신속'), special = stat('특화'); if (haste < b.haste || special < b.special) fail('팔찌·전체 특성 불일치');
  const gems = readGems(raw), grid = coreRows(raw);
  const accessory = { atk: 0, damage: 0, mark: 0, identity: 1 };
  for (const item of raw.ArmoryEquipment.filter(x => ['목걸이','반지'].includes(x.Type))) {
    for (const line of plain(section(item, '연마 효과')).split('\n').filter(Boolean)) {
      let match; const text = compact(line);
      if ((match = /^아군공격력강화효과\+([\d.]+)%$/.exec(text))) accessory.atk += Number(match[1]);
      else if ((match = /^아군피해량강화효과\+([\d.]+)%$/.exec(text))) accessory.damage += Number(match[1]);
      else if ((match = /^낙인력\+([\d.]+)%$/.exec(text))) accessory.mark += Number(match[1]);
      else if ((match = /^세레나데,신앙,조화게이지획득량\+([\d.]+)%$/.exec(text))) accessory.identity += Number(match[1]) / 100;
      else if (/아군공격력강화|아군피해량강화|낙인력|게이지획득량/.test(text)) fail('지원 연마 효과');
    }
  }
  let mana = 0, awaken = 0; const seen = new Set();
  for (const e of array(engravingEffects(raw), '각인', 10)) {
    if (isAbilityStoneReduction(e) || !['마나의 흐름','각성'].includes(e?.Name)) continue;
    if (seen.has(e.Name)) fail('지원 각인 중복'); seen.add(e.Name);
    const row = supportFacts.engraving[e.Name]?.[e.Grade]?.[e.Level]; if (!row) fail('지원 각인 단계');
    if (e.Name === '마나의 흐름') mana = row.cdrPercent ?? 0;
    else { const stone = e.AbilityStoneLevel ?? 0; if (!Number.isInteger(stone) || stone < 0 || stone > 4) fail('각성 스톤'); awaken = (row.awakenCdrPercent ?? 0) + [0,.06,.075,.105,.12][stone]; }
  }
  const skills = array(raw.ArmorySkills, 'ArmorySkills', 100);
  const skillNames = new Set();
  for (const skill of skills) {
    if (typeof skill?.Name !== 'string' || !skill.Name.trim() || skill.Name.length > 100 || skillNames.has(skill.Name) || !Number.isInteger(skill.Level) || skill.Level < 1 || skill.Level > 20) fail('스킬 입력');
    skillNames.add(skill.Name);
    for (const tripod of array(skill.Tripods, 'Tripods', 20)) {
      if (typeof tripod?.Name !== 'string' || !tripod.Name.trim() || tripod.Name.length > 100 || typeof tripod.IsSelected !== 'boolean') fail('트라이포드 입력');
    }
  }
  const quick = job.quick && skills.some(skill => skill.Name === job[job.quick] && skill.Level > 1 && array(skill.Tripods, 'Tripods', 20).some(t => t?.IsSelected === true && t.Name === '빠른 준비'));
  const karma = array(raw.ArkPassive.Points, 'ArkPassive.Points', 3).filter(x => x?.Name === '진화');
  // An empty or '미개방' official description means the karma track is not opened yet: rank 0 (2026-09-18).
  const karmaText = karma.length === 1 && typeof karma[0].Description === 'string' ? plain(karma[0].Description) : null;
  const rank = isUnopenedKarma(karmaText) ? [karmaText, '0'] : karmaText === null ? null : /^(\d+)랭크 \d+레벨$/.exec(karmaText);
  if (!rank || Number(rank[1]) > 6) fail('진화 카르마');
  return { raw, job, nodes: n, bracelet: b, attack: d, haste, special, gems, grid, accessory, mana, awaken, quick, karmaRank: Number(rank[1]) };
}

// A common reference-party buff model, not a simulation of an individual party.
function power(ctx, { bracelet = true, effects = ctx.grid.effects, cores = ctx.grid.cores } = {}) {
  const { attack: d, job, accessory: acc, nodes: n } = ctx;
  const b = bracelet ? ctx.bracelet : { primary: 0, weaponAtkPlus: 0, atkBuff: 0, damageBuff: 0, atkBuffPlus: 1 };
  const primary = (d.equipmentPrimary + d.accessoryPrimary + b.primary) * (1 + d.avatarPercent / 100);
  const weaponFlat = d.weaponBase + d.accessoryWeaponFlat + d.vambraceWeaponFlat + fact(cores, '혼돈의 별 코어 : 무기', 'weaponAtkPlus');
  const weapon = (weaponFlat + b.weaponAtkPlus) * (1 + d.karmaLevel * .001 + (d.accessoryWeaponPercent + fact(cores, '혼돈의 별 코어 : 무기', 'weaponAtkPer')) / 100);
  // Ordinary attack percentages are excluded. Equipped skill gems' base-attack
  // bonus belongs to P, unlike Ark Grid's ordinary attack-power gem effect.
  const attack = Math.floor((Math.sqrt(primary * weapon / 6) + d.vambraceBaseFlat) * (1 + (d.gemBasePercent + d.stoneBasePercent + d.vambraceBasePercent) / 100));
  if (!(attack > 0 && Number.isSafeInteger(attack))) fail('지원 공격력');
  const fullHaste = ctx.haste - (bracelet ? 0 : ctx.bracelet.haste), fullSpecial = Math.min(ctx.special - (bracelet ? 0 : ctx.bracelet.special), 1200);
  const haste = (fullHaste + fullSpecial) * .75, special = (fullHaste + fullSpecial) * .25;
  const speedFactor = 1 - .0214739 * haste / 100;
  const has = name => n.evolution.some(x => x.name === name), coreCdr = fact(cores, '혼돈의 해 코어 : 흐르는 마나', 'cdrPercent', 0, true), passiveCdr = has('선각자') ? .05 : 0;
  const cooldownFactor = speedFactor * (1 - ctx.mana) * (1 - passiveCdr) * (1 - coreCdr);
  const effect = name => { const row = effects.find(x => x.Name === name); return row ? Number(/\+([\d.]+)%/.exec(compact(row.Tooltip))[1]) : 0; };
  const cooldown = name => ctx.gems.find(x => x.name === name && x.cooldown !== null)?.cooldown ?? 0;
  const gemBuff = name => Math.max(0, ...ctx.gems.filter(x => x.name === name && x.support !== null).map(x => x.level));
  const cds = [...job.cooldown]; if (ctx.quick) cds[job.quick === 'a' ? 0 : 1] = job.quickCooldown;
  const cdA = cds[0] * cooldownFactor * (1 - cooldown(job.a) / 100), cdB = cds[1] * cooldownFactor * (1 - cooldown(job.b) / 100);
  const uptime = (job.duration[0] + job.duration[1]) / Math.max(job.duration[0] + job.duration[1], cdA, cdB), weightA = job.duration[0] / cdA;
  const nodeAtk = n.evolution.reduce((sum, x) => sum + (['선각자','기원'].includes(x.name) ? 22 : x.name === '진군' ? 21 : 0), 0);
  const sharedAtk = acc.atk + b.atkBuff + nodeAtk + effect('아군 공격 강화');
  const buffAttack = Math.floor(.22 * attack * (weightA * (1 + (sharedAtk + gemBuff(job.a)) / 100) + (1 - weightA) * (1 + (sharedAtk + gemBuff(job.b)) / 100)));
  const damageBuff = acc.damage + b.damageBuff + effect('아군 피해 강화') + fact(cores, '혼돈의 해 코어 : 신념의 강화', 'damageBuff');
  const identityGem = Math.max(0, ...ctx.gems.filter(x => IDENTITY_SKILLS.has(x.name) && x.support !== null).map(x => x.level));
  const specialNode = n.enlightenment.find(x => SPECIAL_NODES.has(x.name));
  const specialFactor = specialNode ? [1.1,1.1,1.2][specialNode.level - 1] : 1; if (!specialFactor) fail('지원 깨달음 단계');
  const markNode = n.evolution.reduce((sum, x) => sum + (x.name === '기원' ? 4 : ['입식 타격가','마나 용광로','안정된 관리자'].includes(x.name) ? 10 * x.level : 0), 0);
  const markExtra = n.enlightenment.filter(x => MARK_NODES.has(x.name)).reduce((sum, x) => sum + x.level - 1, 0);
  const markPercent = 10 * (1 + (acc.mark + markNode + ctx.karmaRank + markExtra + effect('낙인력') + fact(cores, '혼돈의 달 코어 : 낙인의 흔적', 'stigmaPer')) / 100);
  const always = b.atkBuffPlus * fact(cores, '혼돈의 달 코어 : 강철의 흔적', 'atkBuffPlus', 1) * fact(cores, '혼돈의 달 코어 : 치명적인 흔적', 'atkBuffPlus', 1);
  const markFinal = fact(cores, '혼돈의 달 코어 : 낙인의 흔적', 'finalDamageBuff', 1);
  const evolution = n.evolution.filter(x => x.name === '정열의 춤사위').reduce((sum, x) => sum + .07 * x.level, 0);
  const allTime = (1 + buffAttack * uptime / 170000) * (1 + markPercent / 100) * ((1.45 + evolution) / 1.45) * always * markFinal;
  const eligibleGems = ctx.gems.filter(x => x.cooldown !== null && !EXCLUDED_COOLDOWN.has(x.name));
  const averageCdr = eligibleGems.length ? eligibleGems.reduce((sum, x) => sum + x.cooldown, 0) / eligibleGems.length / 100 : 0;
  const awakeningGain = (1 / ((1 - ctx.awaken) * speedFactor * (1 - ctx.mana)) * (1 - coreCdr) - 1) * .15 + 1;
  const identityUptime = .2005 * (acc.identity + fact(cores, '혼돈의 해 코어 : 신념의 강화', 'identityUptime')) * (1 + special / 3020) * awakeningGain / (cooldownFactor * (1 - averageCdr));
  const hyperUptime = .2445 / cooldownFactor;
  const identityExtra = .13 * specialFactor * (1 + (damageBuff + identityGem) / 100) * (1 + special / 2079.1) / markFinal;
  const hyperExtra = .1 * (1 + damageBuff / 100);
  // Expanding these two independent uptime factors gives all four normal /
  // identity / hyper-awakening combinations, including the shared mark once.
  const total = allTime * (1 + identityUptime * identityExtra) * (1 + hyperUptime * hyperExtra);
  if (![total, allTime, uptime, identityUptime, hyperUptime].every(Number.isFinite) || total <= 0 || speedFactor <= 0) fail('지원 버프 계산');
  return { total, attack, primary, weapon, uptime, allTime, identityUptime, hyperUptime };
}
function pointBaseline(core) {
  if (core.Point <= 17) return core.Point;
  const gems = array(core.Gems, 'ArkGrid.Gems', 4), seen = new Set(); let count = 0;
  for (const gem of gems) {
    if (!Number.isInteger(gem.Index) || gem.Index < 0 || gem.Index > 3 || seen.has(gem.Index) || typeof gem.IsActive !== 'boolean') fail('젬 코어 슬롯');
    seen.add(gem.Index); if (!gem.IsActive) continue;
    const lines = plain(section(gem, '젬 효과', true)).split('\n').map(compact).filter(x => /^(질서|혼돈)포인트/.test(x));
    if (lines.length !== 1) fail('젬 코어 포인트');
    const hit = /^(질서|혼돈)포인트:(\d+)$/.exec(lines[0]);
    if (!hit || !core.Name.startsWith(hit[1])) fail('젬 코어 포인트');
    const point = Number(hit[2]); if (point < 0 || point > 5) fail('젬 코어 포인트'); count += point;
  }
  return count > 0 && core.Point > 17 ? Math.max(17, core.Point - count) : core.Point;
}

// Versioned support score coefficients, distinct from the dealer core model.
const SUPPORT_ORDER_TABLE = {
  group1: {
    유물: { 10: 1.012, 14: 1.012, 17: 1.078, 18: 1.0798, 19: 1.081, 20: 1.0822 },
    고대: { 10: 1.012, 14: 1.012, 17: 1.09, 18: 1.0918, 19: 1.093, 20: 1.0942 },
  },
  group2: {
    유물: { 10: 1, 14: 1.006, 17: 1.021, 18: 1.022, 19: 1.023, 20: 1.024 },
    고대: { 10: 1, 14: 1.006, 17: 1.03, 18: 1.031, 19: 1.032, 20: 1.033 },
  },
};
// The official slot Index is the equip order, so a sun, moon or star core can sit in any slot (2026-09-18).
// The core kind comes from its name prefix; a kind equipped twice cannot be resolved.
const ORDER_KIND = [['질서의 해', 'group1'], ['질서의 달', 'group1'], ['질서의 별', 'group2']];
function supportOrderMultiplier(cores) {
  const allowed = new Set([...coreFacts.classCores['서폿'].mainCore, ...coreFacts.classCores['서폿'].starCore]);
  const kinds = new Map();
  for (const core of cores.filter(core => allowed.has(core.Name))) {
    const kind = ORDER_KIND.find(([prefix]) => core.Name.startsWith(prefix));
    if (!kind) fail('지원 질서 코어 종류');
    if (kinds.has(kind[0])) fail('지원 질서 코어 중복');
    kinds.set(kind[0], core);
  }
  const paired = kinds.has('질서의 해') && kinds.has('질서의 달');
  let factor = 1;
  for (const [prefix, group] of ORDER_KIND) {
    const core = kinds.get(prefix);
    if (!core) continue;
    const point = group === 'group1' && !paired && core.Point >= 14 ? 10 : core.Point;
    // The discrete score table grants no coefficient at other point values.
    if (!THRESHOLDS.includes(point)) continue;
    const value = SUPPORT_ORDER_TABLE[group]?.[tableGrade(core)]?.[point];
    if (!Number.isFinite(value) || value < 1) fail('지원 질서 코어 점수표');
    factor *= value;
  }
  return factor;
}

export function evaluateNativeSupportScore(raw) {
  const assumptions = [
    '기준 딜러 공격력 170,000과 공증·낙인·아이덴티티·초각성 버프 가동률을 사용하는 서포터 모형입니다.',
    '지원 특성은 신속과 최대 1,200 특화를 75:25로 환산합니다. 실제 파티별 버프 효과와는 차이가 있습니다.',
    '지원 점수는 종합 버프 배율의 4.24제곱에 질서 코어 보정과 120을 곱합니다.',
    '질서 해·달의 짝이 없으면 14P 이상은 10P 보정으로 제한하며, 그 뒤 10·14·17·18·19·20P 표에 없는 포인트는 보정하지 않습니다.',
  ];
  try {
    if (!isSupportCharacter(raw)) fail('지원 아크패시브');
    const ctx = context(raw);
    if (ctx.grid.cores.some(core => LOW_CORE_GRADES.has(core.Grade))) assumptions.push(LOW_GRADE_ASSUMPTION);
    for (const name of ctx.grid.neutral) assumptions.push(`'${name}'는 서포터 버프 표에 없는 코어라 기여 없음으로 계산했습니다.`);
    if (ctx.bracelet.neutral.length) assumptions.push(`팔찌 옵션 ${ctx.bracelet.neutral.map(text => `'${text}'`).join(', ')}은 환산 모형에 영향이 없어 기여 없음으로 계산했습니다.`);
    const totalBuffPower = power(ctx).total, orderCore = supportOrderMultiplier(ctx.grid.cores);
    const value = totalBuffPower ** 4.24 * orderCore * 120;
    if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) fail('지원 점수 계산');
    return { value, factors: { totalBuffPower, orderCore, exponent: 4.24, scale: 120 }, missing: [], assumptions };
  } catch (error) {
    return { value: null, factors: null, missing: [String(error?.message || '지원 점수 입력').slice(0, 500)], assumptions };
  }
}

export function analyzeSupportEfficiency(raw) {
  try {
    if (!isSupportCharacter(raw)) return { bracelet: empty('unsupported'), gem: emptyGem('unsupported') };
    const ctx = context(raw), withPower = power(ctx), without = power(ctx, { bracelet: false });
    const assumptions = ['기준 딜러 공격력 170,000과 공증·낙인·아이덴티티·초각성 버프 가동률을 사용하는 서포터 모형입니다.', '지원 특성은 신속과 최대 1,200 특화를 75:25로 환산합니다. 실제 파티별 버프 효과와는 차이가 있습니다.'];
    if (ctx.grid.cores.some(core => core.Point > 10 && !THRESHOLDS.includes(core.Point))) assumptions.push('코어는 10·14·17·18·19·20P 기준표를 사용합니다. 11~13·15~16P는 표의 비활성 값이며 흐르는 마나의 쿨다운만 이전 구간을 적용합니다.');
    if (ctx.grid.cores.some(core => LOW_CORE_GRADES.has(core.Grade))) assumptions.push(LOW_GRADE_ASSUMPTION);
    const buffRatio = withPower.total / without.total, scoreRatio = buffRatio ** 4.24, braceletEfficiency = scoreEfficiency(withPower.total, without.total);
    const bracelet = ctx.bracelet.present ? { ...empty('ok'), efficiency: braceletEfficiency, assumptions: [...assumptions, '팔찌는 점수 증가율(%)을 소수 둘째 자리에서 내림한 뒤 1.4로 나눕니다.'], formulas: [
      { label: '팔찌 장착/해제 버프 배율', formula: `${round(withPower.total)} ÷ ${round(without.total)}`, value: round(buffRatio) },
      { label: '지원 점수 배율', formula: `${round(buffRatio)} ^ 4.24`, value: round(scoreRatio) },
      { label: '팔찌 효율 (%)', formula: `${efficiency(scoreRatio, 1)} ÷ 1.4 (점수 증가율은 소수 둘째 자리 내림)`, value: braceletEfficiency },
      { label: '지원 기본 공격력 장착/해제', formula: `${withPower.attack} ÷ ${without.attack}`, value: round(withPower.attack / without.attack) },
    ] } : empty('absent');
    if (ctx.grid.absent) return { bracelet, gem: emptyGem('absent') };
    try {
    const noOptions = power(ctx, { effects: [] }), baseline = ctx.grid.cores.map(core => ({ ...core, Point: pointBaseline(core) })), noGem = power(ctx, { effects: [], cores: baseline });
    const gemEfficiency = scoreEfficiency(withPower.total, noGem.total);
    const gem = { ...emptyGem('ok'), efficiency: gemEfficiency, optionEfficiency: scoreEfficiency(withPower.total, noOptions.total), pointEfficiency: scoreEfficiency(noOptions.total, noGem.total), assumptions: [...assumptions, '젬 효율도 팔찌와 같이 점수 증가율(%)을 소수 둘째 자리에서 내림한 뒤 1.4로 나눕니다.'], formulas: [{ label: '아크그리드 젬 버프 모형', formula: `${round(withPower.total)} ÷ ${round(noGem.total)} (옵션 제거 ${round(noOptions.total)})`, value: round(withPower.total / noGem.total) }, { label: '젬 효율 (%)', formula: `(${round(withPower.total / noGem.total)} ^ 4.24 − 1) ÷ 1.4 (점수 증가율은 소수 둘째 자리 내림)`, value: gemEfficiency }], effectEfficiencies: ctx.grid.effects.map(e => ({ name: e.Name, level: e.Level, effect: Number(/\+([\d.]+)%/.exec(compact(e.Tooltip))[1]), description: plain(e.Tooltip), efficiency: scoreEfficiency(withPower.total, power(ctx, { effects: ctx.grid.effects.filter(x => x !== e) }).total) })), pointBreakdown: baseline.flatMap((core, i) => core.Point < ctx.grid.cores[i].Point ? [{ coreName: core.Name, grade: core.Grade, beforePoint: core.Point, afterPoint: ctx.grid.cores[i].Point, gainedPoint: ctx.grid.cores[i].Point - core.Point }] : []) };
    return { bracelet, gem };
    } catch (error) {
      return { bracelet, gem: emptyGem('unavailable', [String(error?.message || '지원 젬 입력').slice(0, 500)]) };
    }
  } catch (error) { const omitted = [String(error?.message || '지원 효율 입력').slice(0, 500)]; return { bracelet: empty('unavailable', omitted), gem: emptyGem('unavailable', [...omitted]) }; }
}
