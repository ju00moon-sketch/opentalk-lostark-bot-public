import model from './data/spec-score-model.json' with { type: 'json' };
import braceletFacts from './data/bracelet-model.json' with { type: 'json' };
import { calculateBraceletAttackContext } from './bracelet-attack-context.js';
import { mapBraceletModelInput } from './bracelet-model.js';
import { evaluateNativeGemScore } from './native-gem-efficiency.js';
import { tierFromScore } from './score-tier.js';
import { isSupportCharacter, evaluateNativeSupportScore } from './native-support-efficiency.js';
import { withNormalizedCores } from './arkgrid-core-names.js';
import { isAbilityStoneReduction, isUnopenedKarma, engravingEffects } from './official-input-forms.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const compact = value => value.replace(/\s/g, '');
const plain = value => typeof value === 'string' && value.length <= 262144
  ? value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() : '';
const canonical = value => compact(value).replace(/\d+(?:\.\d+)?/g, number => String(Number(number)));
const accessoryFacts = new Map(Object.entries(model.accessoryOptions).map(([name, value]) => [canonical(name), value]));
const DAMAGE3 = [3, 6, 9, 12, 15, 18, 21, 24, 30, 40];
const DAMAGE4 = [8, 12, 16, 20, 24, 28, 32, 36, 40, 44];
const COOLDOWN3 = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
const COOLDOWN4 = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24];
const omittedResult = (role, omitted, status = 'unavailable') => ({ status, score: null, tier: null, role,
  modelVersion: model.modelVersion, assumptions: [], formulas: [], omitted: [...new Set(omitted)] });
function fail(message) { throw new Error(message); }
function array(value, label, limit) { if (!Array.isArray(value) || value.length > limit) fail(`${label} 자료 누락 또는 크기 초과`); return value; }
function tooltip(item) {
  if (typeof item?.Tooltip !== 'string' || item.Tooltip.length > 262144) fail('장비 툴팁 누락 또는 크기 초과');
  let value; try { value = JSON.parse(item.Tooltip); } catch { fail('장비 툴팁 JSON 오류'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) fail('장비 툴팁 형식 오류');
  return value;
}
function part(item, title, { optional = false } = {}) {
  const sections = Object.values(tooltip(item)).filter(value => value?.type === 'ItemPartBox' && plain(value.value?.Element_000) === title);
  if (optional && !sections.length) return null;
  if (sections.length !== 1 || typeof sections[0].value.Element_001 !== 'string') fail(`${item.Type}: ${title} 자료 누락 또는 중복`);
  return plain(sections[0].value.Element_001);
}
function keyFor(table, name) { return Object.keys(table).find(key => compact(key) === compact(name)); }
// Fixed-cut tier for the score itself; percentile tiers are attached by the website service.
const tierResult = score => tierFromScore(score);
export const classifyNativeSpecTier = tierResult;

function passiveFactors(raw) {
  if (raw?.ArkPassive?.IsArkPassive !== true) fail('아크 패시브 활성 상태를 확인할 수 없습니다.');
  const points = new Map();
  for (const row of array(raw.ArkPassive.Points, '아크 패시브 포인트', 3)) {
    if (!['진화', '깨달음', '도약'].includes(row?.Name) || points.has(row.Name) || !Number.isInteger(row.Value) || row.Value < 0 || row.Value > 500) fail('아크 패시브 포인트 이름·수치·중복 오류');
    // An empty or '미개방' official description means the karma track is not opened yet: rank 0, level 0 (2026-09-18).
    const description = typeof row.Description === 'string' ? row.Description.trim() : null;
    const karma = isUnopenedKarma(description) ? [description, '0', '0'] : description === null ? null : /^(\d+)랭크\s+(\d+)레벨$/.exec(description);
    if (!karma || Number(karma[1]) > 6 || Number(karma[2]) > 30) fail(`${row.Name}: 카르마 단계 미확인`);
    points.set(row.Name, { value: row.Value, rank: Number(karma[1]) });
  }
  if (points.size !== 3) fail('아크 패시브 포인트 누락');
  const select = (value, thresholds) => thresholds.find(([minimum]) => value >= minimum)?.[1] ?? 1;
  const evolution = points.get('진화'), enlightenment = points.get('깨달음').value, leap = points.get('도약').value;
  return {
    evolution: evolution.value === 0 ? 1 : select(evolution.value, [[140, 1.79], [120, 1.65], [105, 1.45], [90, 1.4], [80, 1.35], [70, 1.3], [60, 1.25], [50, 1.2]]) + evolution.rank / 100,
    enlightenment: select(enlightenment, [[100, 1.42], [98, 1.4], [96, 1.37], [94, 1.36], [92, 1.35], [90, 1.34], [88, 1.33], [86, 1.28], [84, 1.27], [82, 1.26], [80, 1.25], [78, 1.18], [76, 1.17], [74, 1.16], [72, 1.15], [64, 1.13], [56, 1.125], [48, 1.12], [40, 1.115], [32, 1.11], [24, 1.1]]),
    leap: select(leap, [[70, 1.15], [68, 1.14], [66, 1.13], [64, 1.12], [62, 1.11], [60, 1.1], [50, 1.05], [40, 1.03]]),
  };
}

function accessoryMultiplier(equipment, notes) {
  let result = 1;
  const necklaces = equipment.filter(item => item.Type === '목걸이'), rings = equipment.filter(item => item.Type === '반지');
  if (necklaces.length > 1 || rings.length > 2) fail('목걸이·반지 착용 정보 중복');
  // A missing necklace or ring is a factor of 1, like the reference (2026-09-18).
  if (necklaces.length < 1 || rings.length < 2) notes.push('목걸이·반지 일부가 없어 해당 부위 연마 효과는 반영하지 않았습니다.');
  for (const item of [...necklaces, ...rings]) {
    const seen = new Set();
    // Accessories without a refinement section (tier 3 and below) have no refinement effect (2026-09-18).
    const section = part(item, '연마 효과', { optional: true });
    if (section === null) { notes.push('연마 효과 절이 없는 악세서리는 연마 효과 없음으로 계산했습니다.'); continue; }
    for (const line of section.split('\n').map(value => value.trim()).filter(Boolean)) {
      const name = line.replace(/\s*\+[\d.]+%?$/, '');
      if (seen.has(name)) fail('악세서리 연마 효과 중복'); seen.add(name);
      const value = accessoryFacts.get(canonical(line));
      if (value !== undefined) { result *= value; continue; }
      // A damage, crit-rate or crit-damage value outside the table is a factor of 1 in the reference (2026-09-18).
      if (/^(적에게 주는 피해|치명타 적중률|치명타 피해) \+\d+(?:\.\d+)?%$/.test(line)) { notes.push(`연마 효과 '${line}'은 환산 표에 없어 반영하지 않았습니다.`); continue; }
      if (/^(적에게 주는 피해|치명타 적중률|치명타 피해)/.test(line)) fail(`악세서리 환산 수치 미확인: ${line}`);
      // Every other refinement option the game offers stays outside this score: support buffs, the identity
      // gauge, vitality, mana, status duration and in-combat recovery do not enter combat power.
      if (!/^(추가 피해|공격력|무기 공격력|최대 생명력|최대 마나|상태이상 공격 지속시간|전투 중 생명력 회복량|파티원 회복 효과|파티원 보호막 효과|아군 공격력 강화 효과|아군 피해량 강화 효과|낙인력|세레나데, 신앙, 조화 게이지 획득량) \+\d+(?:\.\d+)?%?$/.test(line)) fail(`악세서리 연마 효과 미확인: ${line}`);
    }
  }
  return result;
}
function engravingMultiplier(raw, job) {
  const excludedKey = keyFor(model.invalidEngravings, job);
  if (!excludedKey) fail('직업별 각인 적합성 모형 미확인');
  const excluded = new Set(model.invalidEngravings[excludedKey].map(compact)), seen = new Set(); let result = 1;
  for (const row of array(engravingEffects(raw), '각인', 16)) {
    if (isAbilityStoneReduction(row)) continue;
    if (typeof row?.Name !== 'string') fail('각인 이름 누락');
    const key = keyFor(braceletFacts.engraving, row.Name), identity = compact(row.Name);
    if (!key || seen.has(identity) || !Number.isInteger(row.Level) || row.Level < 0 || !['영웅', '전설', '유물', '고대'].includes(row.Grade)) fail('각인 이름·등급·레벨·중복 오류');
    seen.add(identity);
    const fact = braceletFacts.engraving[key][row.Grade]?.[row.Level];
    if (!fact) fail(`${row.Name}: 각인 단계 미확인`);
    const stone = row.AbilityStoneLevel;
    if (stone !== null && (!Number.isInteger(stone) || stone < 0 || stone > 4)) fail('어빌리티 스톤 단계 미확인');
    const damage = model.engravingDamage[key]?.[row.Grade]?.[row.Level];
    if (!finite(damage)) fail(`${row.Name}: 각인 피해 배율 미확인`);
    if (excluded.has(identity) || !damage) continue;
    result *= 1 + (damage + ([0, 3, 3.75, 5.25, 6][stone ?? 0])) / 100;
  }
  return result;
}
function orbMultiplier(equipment, notes) {
  const items = equipment.filter(item => item.Type === '보주');
  if (!items.length) return 1;
  if (items.length !== 1) fail('보주 중복');
  const item = items[0], groups = [
    { names: ['운율의 파도 보주'], base: 25, rate: 1000 },
    { names: ['영험한 비전의 보주', '신비로운 투영의 보주', '응축된 자연의 보주', '눈부신 비전의 보주'], base: 20, rate: 800 },
    { names: ['신성한 자연의 보주', '온화한 투영의 보주', '생명의 대지 보주'], base: 14, rate: 544 },
  ];
  const group = groups.find(value => value.names.includes(item.Name));
  // An orb outside the three groups (fixed-damage orbs such as 확산하는 안개의 보주) is a factor of 1 in the reference (2026-09-18).
  if (!group) { if (typeof item.Name !== 'string' || !item.Name.trim()) fail('보주 이름 누락'); notes.push(`보주 '${item.Name}'은 환산 모형에 없어 기여 없음으로 계산했습니다.`); return 1; }
  const lines = part(item, '특수 효과').split('\n').map(line => line.trim()).filter(line => /시즌\d+ 달성 최대 낙원력/.test(line));
  const match = lines.length === 1 ? /^시즌\d+ 달성 최대 낙원력\s*:\s*(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.exec(lines[0]) : null;
  if (!match) fail('보주 최대 낙원력 누락·중복 또는 형식 오류');
  const trinity = Number(match[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(trinity) || trinity < 0 || trinity > 1e12) fail('보주 최대 낙원력 범위 오류');
  const initial = Math.floor((1 + (group.base + group.rate * trinity / 1e8) / 10000) * 1e6) / 1e6;
  return Math.floor((1 + (initial - 1) * .25) * 1e6) / 1e6;
}

function gemFactors(raw, job) {
  const effects = array(raw?.ArmoryGem?.Effects?.Skills, '보석 스킬 효과', 20);
  const absent = raw?.ArmoryGem?.Gems === null && raw?.ArmoryGem?.Effects?.Description === '' && !effects.length;
  const slots = absent ? [] : array(raw?.ArmoryGem?.Gems, '보석', 20);
  const seen = new Set(), equipped = []; let supportOnlyGems = false;
  for (const item of slots) {
    if (!Number.isInteger(item?.Slot) || item.Slot < 0 || item.Slot > 20 || seen.has(item.Slot) || !Number.isInteger(item.Level) || item.Level < 1 || item.Level > 10) fail('보석 슬롯·레벨 오류');
    seen.add(item.Slot);
    const matching = effects.filter(effect => effect?.GemSlot === item.Slot);
    if (matching.length !== 1) fail('보석 스킬 효과 누락 또는 중복');
    const effect = matching[0], all = array(effect.Description, '보석 효과 설명', 2);
    // A dealer-built supporter class keeps its support gems: the `지원 효과 N % 증가` line is ignored. A gem with nothing
    // else (세레나데 스킬) is, like the reference, a damage gem whose percent comes from its level and tier (2026-09-18);
    // it only changes the score on the equal-weight fallback path, since no skill share table names it.
    const descriptions = all.filter(line => !/^지원효과[\d.]+%증가$/.test(compact(plain(line))));
    if (typeof effect.Name !== 'string' || !effect.Name.trim() || effect.Name.length > 100 || descriptions.length > 1) fail('보석 스킬 이름·효과 오류');
    const bonus = typeof effect.Option === 'string' ? /^기본 공격력 (\d+(?:\.\d+)?)% 증가$/.exec(effect.Option.trim()) : null;
    if (!bonus && effect.Option !== '') fail('보석 기본 공격력 효과 미확인');
    const fourthTier = bonus && Number(bonus[1]) > 0;
    if (!descriptions.length) { supportOnlyGems = true; equipped.push({ skill: effect.Name, type: 'damage', level: item.Level, percent: (fourthTier ? DAMAGE4 : DAMAGE3)[item.Level - 1], slot: item.Slot, supportOnly: true }); continue; }
    const match = /^(피해|재사용 대기시간) (\d+(?:\.\d+)?)% (증가|감소)$/.exec(plain(descriptions[0]));
    if (!match || (match[1] === '피해' ? match[3] !== '증가' : match[3] !== '감소')) fail('딜러 보석 효과 종류 미확인');
    const type = match[1] === '피해' ? 'damage' : 'cooldown';
    const percent = (type === 'damage' ? fourthTier ? DAMAGE4 : DAMAGE3 : fourthTier ? COOLDOWN4 : COOLDOWN3)[item.Level - 1];
    if (Number(match[2]) !== percent) fail('보석 레벨과 효과 수치 불일치');
    equipped.push({ skill: effect.Name, type, level: item.Level, percent, slot: item.Slot });
  }
  if (effects.length !== slots.length) fail('보석 효과 슬롯 누락');
  // Two gems of the same skill and effect do not stack in game: only the higher level counts, the earlier slot on a tie (2026-09-18).
  const best = new Map(); let duplicated = false;
  for (const gem of equipped.sort((a, b) => a.slot - b.slot)) {
    const identity = `${gem.skill}:${gem.type}`, current = best.get(identity);
    if (current) duplicated = true;
    if (!current || gem.level > current.level) best.set(identity, gem);
  }
  const gems = [...best.values()];
  const suffix = name => name.includes('코어 :') ? name.slice(name.indexOf('코어 :') + 4).trim() : name.trim();
  const quickPreparation = raw.ArmorySkills.some(skill => skill.Name === '종말의 전조' && skill.Tripods.some(tripod => tripod.IsSelected && tripod.Name === '빠른 준비'));
  const build = model.skillBuilds.find(build => {
    if (!build.cores.length && !build.gems.length) return false;
    const coreMatch = build.cores.every(row => Object.entries(row).every(([name, point]) => raw.ArkGrid.Slots.some(core => suffix(core.Name) === suffix(name) && core.Point >= point)));
    const gemMatch = build.gems.every(row => Object.entries(row).every(([name, type]) => gems.some(gem => gem.skill === name && gem.type === type)));
    return coreMatch && gemMatch && (build.tag !== '333 전탄' || quickPreparation) && (build.tag !== '333 전탄B' || !quickPreparation);
  });
  const classKey = keyFor(model.classSkillShares, job), fallback = !build && !classKey;
  const shares = build?.value ?? model.classSkillShares[classKey] ?? (() => {
    const damage = gems.filter(gem => gem.type === 'damage' && gem.skill !== '없음');
    const share = damage.length ? Math.floor(100 / damage.length) / 100 : 0;
    return Object.fromEntries(damage.map(gem => [gem.skill, share]));
  })();
  const entries = Object.entries(shares).filter(([name]) => !model.excludedSkills.includes(name));
  const totalWeight = entries.reduce((total, [, weight]) => total + weight, 0);
  const weightedDamage = entries.reduce((total, [name, weight]) => total + (gems.find(gem => gem.type === 'damage' && gem.skill === name)?.percent ?? 0) * weight, 0);
  const cooldown = gems.filter(gem => gem.type === 'cooldown'), cooldownWeight = cooldown.reduce((sum, gem) => sum + 2 ** (gem.level - 1), 0);
  const averageCooldown = cooldownWeight ? cooldown.reduce((sum, gem) => sum + gem.percent * 2 ** (gem.level - 1), 0) / cooldownWeight : 0;
  return { damage: totalWeight > 0 ? 1 + weightedDamage / totalWeight * (fallback ? .7 : 1) / 100 : 1,
    cooldown: 1 / (1 - .9 * averageCooldown / 100), tag: build?.tag ?? classKey ?? '동일 가중치', fallback, totalWeight, averageCooldown, duplicated, supportOnlyGems };
}

function dealerScore(raw) {
  // Explicit API nulls mean no grid or no gem effects are equipped; a missing block is unresolved.
  raw = withNormalizedCores(raw);
  const effectLabels = { '공격력': '공격력', '추가 피해': '추가 피해', '보스 피해': '보스 등급 이상 몬스터에게 주는 피해', '낙인력': '낙인력', '아군 공격 강화': '아군 공격력 강화 효과', '아군 피해 강화': '아군 피해량 강화 효과' };
  const seenEffects = new Set();
  for (const effect of array(raw?.ArkGrid?.Effects, '아크그리드 젬 효과', 30)) {
    const match = /^([^\n]+?)\s+\+(\d+(?:\.\d+)?)%$/.exec(plain(effect?.Tooltip));
    if (!Object.hasOwn(effectLabels, effect?.Name) || seenEffects.has(effect.Name) || match?.[1] !== effectLabels[effect.Name] ||
        !Number.isInteger(effect.Level) || effect.Level < 0 || effect.Level > 1000 || Number(match[2]) > 100) fail('아크그리드 젬 효과 이름·레벨·수치 오류');
    seenEffects.add(effect.Name);
  }
  if (array(raw?.ArkGrid?.Slots, '아크그리드 코어', 6).some(core => !Number.isInteger(core?.Point) || core.Point < 0 || core.Point > 20)) fail('아크그리드 코어 포인트 모형 미확인');
  const base = evaluateNativeGemScore(raw);
  if (!finite(base.value)) return omittedResult('dealer', base.missing);
  const attack = calculateBraceletAttackContext(raw), input = mapBraceletModelInput(raw, attack, { allowAbsentBracelet: true });
  const equipment = array(raw.ArmoryEquipment, '장비', 30), weapon = equipment.filter(item => item.Type === '무기');
  if (weapon.length !== 1 || !/^(?:일반|고급|희귀|영웅|전설|유물|고대|에스더(?:\s*-\s*[0-3])?)$/.test(weapon[0].Grade ?? '')) fail('무기 등급 누락 또는 중복');
  const passive = passiveFactors(raw), gem = gemFactors(raw, input.diagnostics.job), notes = [];
  const factors = { ...base.factors, ...passive, accessories: accessoryMultiplier(equipment, notes), engravingDamage: engravingMultiplier(raw, input.diagnostics.job),
    gemDamage: gem.damage, gemCooldown: gem.cooldown, combatStats: 1.3 + Object.values(input.stats.without).reduce((a, b) => a + b, 0) / 5000,
    esther: weapon[0].Grade.includes('에스더') ? 1.01 : 1, orb: orbMultiplier(equipment, notes), braceletCalibration: 1.021, scoreScale: 1 / 1930 };
  if (Object.values(factors).some(value => !finite(value) || value <= 0)) fail('환산 배율 범위 오류');
  const score = Object.values(factors).reduce((a, b) => a * b, 1);
  if (!finite(score) || score <= 0) fail('환산 점수 범위 오류');
  const assumptions = ['공식 캐릭터 정보에 자체 재현한 환산 모형을 적용한 점수입니다. 게임의 공식 전투력이나 실제 DPS가 아닙니다.',
    '현재 장비로 계산하며 과거 달성 최고 점수와 전체·직업 순위는 사용하지 않습니다.',
    '직업·코어·일반 보석 구성에 따른 고정 딜 지분과 쿨다운 환산 90%, 팔찌 모형 보정 1.021을 사용합니다.',
    '악마 계열 추가 피해 옵션은 꺼진 기준이며 보주 기여는 모형의 25% 반영률을 사용합니다.',
    '점수는 반올림 전 값을 반환하며 티어 경계도 같은 값을 사용합니다. 화면 표시는 소수 둘째 자리까지 권장합니다.'];
  if (gem.fallback) assumptions.push('확인된 스킬 구성표가 없어 피해 보석을 같은 비중으로 나누고 피해 보석 효과에 70%를 반영했습니다.');
  if (gem.duplicated) assumptions.push('같은 스킬·효과의 보석이 둘 이상이면 높은 레벨 하나만 반영했습니다.');
  // Input forms accepted on 2026-09-18: each one states its basis for the affected character only.
  if (gem.supportOnlyGems) assumptions.push('지원 효과만 있는 보석은 참조 모형과 같이 레벨 기준 피해 보석으로 반영했습니다.');
  if (input.diagnostics.jobDefaulted) assumptions.push(`깨달음 직업 계열 노드가 없어 ${input.diagnostics.job} 기준으로 계산했습니다.`);
  const neutral = input.options.filter(option => option.neutral).map(option => `'${option.text}'`);
  if (neutral.length) assumptions.push(`팔찌 옵션 ${neutral.join(', ')}은 환산 모형에 영향이 없어 기여 없음으로 계산했습니다.`);
  assumptions.push(...new Set(notes));
  return { status: 'ok', score, tier: tierResult(score), role: 'dealer', modelVersion: model.modelVersion, assumptions,
    formulas: [{ label: '환산 점수', formula: Object.values(factors).join(' × '), value: score }], omitted: [], diagnostics: { factors, gem } };
}

export function analyzeNativeSpecScore(raw) {
  const role = isSupportCharacter(raw) ? 'support' : 'dealer';
  try {
    if (!raw || typeof raw !== 'object' || !raw.ArmoryProfile || typeof raw.ArmoryProfile.CharacterName !== 'string') return omittedResult(role, ['캐릭터 정보 누락']);
    if (role === 'support') {
      const result = evaluateNativeSupportScore(raw);
      if (!finite(result.value) || result.value <= 0 || result.missing?.length) return omittedResult(role, result.missing?.length ? result.missing : ['지원 점수 계산 불가']);
      return { status: 'ok', score: result.value, tier: tierResult(result.value), role, modelVersion: model.modelVersion,
        assumptions: result.assumptions, formulas: [{ label: '지원 환산 점수', formula: `${result.factors.totalBuffPower} ^ 4.24 × ${result.factors.orderCore} × 120`, value: result.value }], omitted: [], diagnostics: { factors: result.factors } };
    }
    return dealerScore(raw);
  } catch (error) { return omittedResult(role, [String(error?.message || '환산 점수 입력 해석 불가').slice(0, 500)]); }
}
