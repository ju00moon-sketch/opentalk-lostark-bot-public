import model from './data/gem-model-facts.json' with { type: 'json' };
import { calculateBraceletAttackContext } from './bracelet-attack-context.js';
import { mapBraceletModelInput, calculateBraceletFactors } from './bracelet-model.js';
import { withNormalizedCores } from './arkgrid-core-names.js';

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const pct = (a, b) => finite(a) && finite(b) && b > 0 ? Math.floor((a / b - 1) * 10000) / 100 : null;
const text = (s) => typeof s === 'string' && s.length <= 262144 ? s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim() : '';
const effectLabels = { 공격력: '공격력', '추가 피해': '추가 피해', '보스 피해': '보스 등급 이상 몬스터에게 주는 피해', '아군 공격 강화': '아군 공격력 강화 효과', '아군 피해 강화': '아군 피해량 강화 효과', 낙인력: '낙인력' };
function unavailable(messages, status = 'unavailable') { return { status, efficiency: null, optionEfficiency: null, pointEfficiency: null, effectEfficiencies: [], assumptions: [], formulas: [], omitted: [...new Set(messages)] }; }

function coreDamage(cores, job) {
  const key = Object.keys(model.classCores).find((name) => name.replace(/\s/g, '') === String(job ?? '').replace(/\s/g, ''));
  const pool = model.classCores[key], names = pool ? [...pool.mainCore, ...pool.starCore] : [];
  const equipped = cores.filter((c) => names.includes(c.Name.trim()));
  const pair = equipped.some((c) => c.Name.startsWith('질서의 해')) && equipped.some((c) => c.Name.startsWith('질서의 달'));
  let direct = 1, generic = 1;
  for (const c of cores) {
    const grade = c.Grade === '고대' ? '고대' : '유물';
    direct *= model.coreFinal[c.Name]?.[c.Point]?.[grade]?.finalDmg ?? 1;
    if (!names.includes(c.Name.trim())) continue;
    let group, point = c.Point;
    if (c.Name.startsWith('질서의 별')) group = 'group2';
    else if (c.Name.startsWith('질서의 해') || c.Name.startsWith('질서의 달')) { group = 'group1'; if (point >= 14 && !pair) point = 10; }
    if (group) generic *= model.coreModel[group]?.[grade]?.[point] ?? 1;
  }
  return { direct, generic };
}

export function evaluateNativeGemScore(raw) {
  raw = withNormalizedCores(raw);
  if (!raw?.ArkGrid || !Array.isArray(raw.ArkGrid.Slots) || !Array.isArray(raw.ArkGrid.Effects)) return { value: null, missing: ['아크그리드 점수 입력 누락'] };
  const attack = calculateBraceletAttackContext(raw);
  const input = mapBraceletModelInput(raw, attack, { allowAbsentBracelet: true });
  if (!input) return { value: null, missing: ['팔찌 모형 입력을 만들 수 없습니다.'] };
  const bracelet = calculateBraceletFactors(input), normalAttack = attack.diagnostics?.without?.normalAttack;
  const missing = [...bracelet.missing, ...attack.missing];
  if (!finite(normalAttack) || normalAttack <= 0) missing.push('팔찌 제외 기본 공격력 재구성 불가');
  if (!finite(input.additionalDamage.withoutPercent)) missing.push('추가 피해 재구성 불가');
  if (missing.length) return { value: null, missing: [...new Set(missing)] };
  const cores = raw.ArkGrid.Slots, damage = coreDamage(cores, input.diagnostics.job);
  const boss = raw.ArkGrid.Effects.find((e) => e.Name === '보스 피해');
  const bossValue = boss ? /\+([\d.]+)%/.exec(text(boss.Tooltip))?.[1] : 0;
  if (boss && (!finite(Number(bossValue)) || Number(bossValue) < 0 || Number(bossValue) > 100)) missing.push('젬 보스 피해 수치 미확인');
  const factors = { normalAttack, additionalDamage: 1 + input.additionalDamage.withoutPercent / 100, coreFinalDamage: damage.direct, genericClassCore: damage.generic, bossDamage: 1 + Number(bossValue) / 100, bracelet: bracelet.multiplier };
  const values = Object.values(factors);
  return { value: missing.length || values.some((n) => !finite(n) || n <= 0) ? null : values.reduce((a, b) => a * b, 1), factors, missing: [...new Set(missing)], baseline: input.diagnostics };
}

function gemCorePoints(gem) {
  if (!gem || gem.IsActive === false) return { value: 0 };
  if (gem.IsActive !== true || typeof gem.Tooltip !== 'string' || gem.Tooltip.length > 262144) return { missing: '젬 활성 상태 또는 툴팁 미확인' };
  let parsed; try { parsed = JSON.parse(gem.Tooltip); } catch { return { missing: '젬 툴팁 JSON 오류' }; }
  const sections = Object.values(parsed ?? {}).filter((v) => v?.type === 'ItemPartBox' && text(v.value?.Element_000) === '젬 효과');
  if (sections.length !== 1) return { missing: '젬 효과 항목 누락 또는 중복' };
  const pointLines = text(sections[0].value?.Element_001).split('\n').map((line) => line.trim()).filter((line) => /(?:질서|혼돈)\s*포인트/.test(line));
  const match = pointLines.length === 1 ? /^(?:질서|혼돈) 포인트\s*:\s*(0|[1-9]\d*)$/.exec(pointLines[0]) : null;
  if (!match) return { missing: '질서/혼돈 젬 포인트 미확인' };
  let point = Number(match[1]);
  if (point >= 10 && point <= 50 && point % 10 === 0) point /= 10;
  if (!Number.isInteger(point) || point < 0 || point > 5) return { missing: '젬 포인트 범위/단위 미확인' };
  return { value: point };
}

function calculate(raw) {
  // Official null grid collections become empty arrays; an unequipped grid is the absent state.
  raw = withNormalizedCores(raw);
  const grid = raw?.ArkGrid;
  if (!grid || !Array.isArray(grid.Slots) || grid.Slots.length > 6 || !Array.isArray(grid.Effects) || grid.Effects.length > 30) return unavailable(['아크그리드 응답 누락 또는 크기 초과']);
  if (!grid.Slots.length && !grid.Effects.length) return unavailable([], 'absent');
  const missing = [], seen = new Set();
  for (const core of grid.Slots) {
    if (!core || typeof core.Name !== 'string' || !Number.isInteger(core.Index) || core.Index < 0 || core.Index > 5 || seen.has(core.Index) || !Number.isInteger(core.Point) || core.Point < 0 || core.Point > 30) return unavailable(['코어 슬롯/포인트 누락 또는 중복']);
    seen.add(core.Index);
  }
  const effects = [], effectNames = new Set();
  for (const effect of grid.Effects) {
    const name = text(effect?.Name), description = text(effect?.Tooltip);
    const match = /^([^\n]+?)\s+\+(\d+(?:\.\d+)?)%$/.exec(description);
    if (!Object.hasOwn(effectLabels, name) || match?.[1] !== effectLabels[name] || effectNames.has(name) || !Number.isInteger(effect.Level) || effect.Level < 0 || effect.Level > 1000 || !match || Number(match[2]) > 100) return unavailable(['젬 합산 효과의 이름·레벨·수치 누락 또는 중복']);
    effectNames.add(name); effects.push({ name, level: effect.Level, effect: Number(match[2]), description });
  }
  const withoutOptions = { ...raw, ArkGrid: { ...grid, Effects: [] } };
  const baselineCores = grid.Slots.map((core) => {
    if (core.Point <= 17) return { ...core, Gems: null };
    if (!Array.isArray(core.Gems) || core.Gems.length > 4) { missing.push(`${core.Name}: 젬 슬롯 정보 누락`); return core; }
    let total = 0; const indexes = new Set();
    for (const gem of core.Gems) {
      if (!gem) continue;
      if (!Number.isInteger(gem.Index) || gem.Index < 0 || gem.Index > 3 || indexes.has(gem.Index)) { missing.push(`${core.Name}: 젬 슬롯 인덱스 누락 또는 중복`); continue; }
      indexes.add(gem.Index); const p = gemCorePoints(gem);
      if (p.missing) missing.push(`${core.Name}: ${p.missing}`); else total += p.value;
    }
    return { ...core, Point: total > 0 ? Math.max(core.Point - total, 17) : core.Point, Gems: null };
  });
  if (missing.length) return unavailable(missing);
  const baselineRaw = { ...withoutOptions, ArkGrid: { ...withoutOptions.ArkGrid, Slots: baselineCores } };
  const full = evaluateNativeGemScore(raw), off = evaluateNativeGemScore(withoutOptions), baseline = evaluateNativeGemScore(baselineRaw);
  if ([full, off, baseline].some((s) => !finite(s.value))) return unavailable([...(full.missing ?? []), ...(off.missing ?? []), ...(baseline.missing ?? [])]);
  const effectEfficiencies = effects.map((effect) => {
    const adjusted = { ...raw, ArkGrid: { ...grid, Effects: grid.Effects.filter((e) => e.Name !== effect.name) } };
    const score = evaluateNativeGemScore(adjusted);
    return { ...effect, efficiency: pct(full.value, score.value) };
  });
  if (effectEfficiencies.some((effect) => !finite(effect.efficiency))) return unavailable(['젬 개별 효과의 비교 점수를 확인할 수 없습니다.']);
  return { status: 'ok', efficiency: pct(full.value, baseline.value), optionEfficiency: pct(full.value, off.value), pointEfficiency: pct(off.value, baseline.value), effectEfficiencies,
    assumptions: ['전체 점수 모형에서 같은 조건의 젬 옵션과 코어 포인트만 바꿔 비교한 추정 효율입니다. 공식 게임 DPS를 뜻하지 않습니다.',
      '젬 포인트 기준은 각 코어 17P 유지입니다. 17P 이하 효과와 장비·각인·일반 보석 등 동일한 항은 비교에서 상쇄됩니다.',
      '직업별 주력/별 코어는 모형의 공통 계수를 사용합니다. 해·달 코어 쌍과 각 코어의 등급·포인트를 함께 확인합니다.',
      '전체 = 현재점수/기준점수−1, 옵션 = 현재점수/옵션제외점수−1, 포인트 = 옵션제외점수/기준점수−1. 합계는 단순 덧셈이 아닙니다.',
      '개별 효과는 합산 효과 종류 하나를 제거한 기여이며, 개별 젬 한 칸의 교체 효율은 아닙니다.'],
    formulas: [
      { label: '전체 비교 배율', formula: `${full.value} ÷ ${baseline.value}`, value: full.value / baseline.value },
      { label: '젬 옵션 비교 배율', formula: `${full.value} ÷ ${off.value}`, value: full.value / off.value },
      { label: '17P 초과 포인트 비교 배율', formula: `${off.value} ÷ ${baseline.value}`, value: off.value / baseline.value },
    ], omitted: [], diagnostics: { full, withoutOptions: off, baseline, coreBaselinePoints: baselineCores.map((c) => ({ name: c.Name, point: c.Point })) } };
}

export function analyzeNativeGemEfficiency(raw) { try { return calculate(raw); } catch { return unavailable(['젬 계산 입력을 해석할 수 없습니다.']); } }
