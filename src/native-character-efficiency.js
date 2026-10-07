// Official armory inputs are evaluated locally with a complete, explicit comparison model.
import { calculateBraceletFactors, mapBraceletModelInput } from './bracelet-model.js';
import { calculateBraceletAttackContext } from './bracelet-attack-context.js';
import { analyzeNativeGemEfficiency } from './native-gem-efficiency.js';
import { analyzeSupportEfficiency, isSupportCharacter } from './native-support-efficiency.js';
export const NATIVE_EFFICIENCY_MODEL_VERSION = '2026-09-16.5';
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const plain = (v, max = 4000) => typeof v === 'string' && v.length <= 262144 ? v.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';
function empty(status, omitted = []) { return { status, efficiency: null, assumptions: [], formulas: [], omitted }; }
function emptyGem(status, omitted = []) { return { ...empty(status, omitted), optionEfficiency: null, pointEfficiency: null, effectEfficiencies: [] }; }
function completeBraceletResult(raw) {
  const attack = calculateBraceletAttackContext(raw);
  const input = mapBraceletModelInput(raw, attack);
  if (!input) return empty('unavailable', ['팔찌 티어 또는 옵션 자료를 확인할 수 없습니다.']);
  const calculation = calculateBraceletFactors(input);
  if (calculation.missing.length) return { ...empty('unavailable', calculation.missing.map((s) => plain(s, 700))), diagnostics: { baseline: input.diagnostics, attack: attack.diagnostics } };
  const labels = { attackRatio: '팔찌 포함·제외 공격력', addDamageRatio: '추가 피해', statRatio: '치특신 배율', critRatio: '치적·치피 민감도', speedRatio: '공격 속도', finalDmgRatio: '직접 피해·쿨 증가', staggeredTargetDmgRatio: '무력화 대상 피해', fallbackRatio: '방향성·기타 효과' };
  const formulas = {
    attackRatio: calculation.factors.attackRatio === 1 && !input.options.some((e) => e.kind === 'primary' || e.weaponAtkPlus !== undefined) ? '팔찌 공격력 변화 없음' : `${attack.with ?? '?'} ÷ ${attack.without ?? '?'}`,
    addDamageRatio: `(100 + ${input.additionalDamage.withoutPercent} + ${input.additionalDamage.braceletPercent}) ÷ (100 + ${input.additionalDamage.withoutPercent})`,
    statRatio: '(1.3 + 0.00041 × 팔찌 포함 치특신) ÷ (1.3 + 0.00041 × 팔찌 제외 치특신)',
    critRatio: `C=${input.critical.withoutRate}, H=${input.critical.withoutDamage}, Q=${input.critical.withoutCriticalFinal}; 치적 계수0.007·치피 계수0.0035·민감도 보정±2.4%`,
    speedRatio: `1 + max(0, min(팔찌 공속, 140 − 기준 공속 ${input.speed.withoutAttackBonus})) × 0.017 ÷ 6`,
    finalDmgRatio: '직접 피해 배율의 곱 ÷ (1 + 쿨 증가율 × 0.7)',
    staggeredTargetDmgRatio: '1 + (무력화 대상 피해 배율 − 1) × 0.25',
    fallbackRatio: `방향성 ${input.direction}: 적용 가능한 옵션 배율의 곱`,
  };
  return {
    status: 'ok', efficiency: calculation.efficiency,
    assumptions: ['팔찌를 제외한 기준과 비교하는 8배율 추정 모형입니다. 실제 DPS나 공식 게임 지표를 뜻하지 않습니다.',
      '직업 상태·스킬 트라이포드·중첩 효과는 명시한 모형 가정을 사용합니다. 파티 치적 시너지와 서포터 팔찌·음식 공속은 기본0입니다.',
      '치특신0.00041, 치적0.007, 치피0.0035, 공속0.017/6, 쿨 증가70%, 무력화 피해 비중25%는 모형 계수입니다.',
      '표시값 = floor((8배율의 곱 × 1.021 − 1) × 10000) / 100. 1.021은 배지 보정이며 공식 피해 효과가 아닙니다.',
      '뭉툭한 가시는 민감도 계산의 치적 상한과 진화 피해 전환에 반영합니다. 같은 치명타 주피 옵션은 배지 전용1.01을 각각 곱합니다.', ...(input.assumptions ?? [])],
    formulas: Object.entries(calculation.factors).map(([key, value]) => ({ label: labels[key], formula: formulas[key], value })),
    omitted: calculation.missing.map((s) => plain(s, 700)), factors: calculation.factors,
    diagnostics: { baseline: input.diagnostics, attack: attack.diagnostics, stat: input.stats, additionalDamage: input.additionalDamage, multiplier: calculation.multiplier, badgeCorrection: 1.021 },
  };
}

function analyze(raw, { now } = {}) {
  const time = typeof now === 'function' ? now() : now ?? Date.now();
  const date = new Date(time);
  const result = { characterName: plain(raw?.ArmoryProfile?.CharacterName, 40), source: 'official-api', modelVersion: NATIVE_EFFICIENCY_MODEL_VERSION, calculatedAt: Number.isFinite(date.getTime()) ? date.getTime() : null };
  if (!object(raw) || !object(raw.ArmoryProfile) || !Array.isArray(raw.ArmoryEquipment) || raw.ArmoryEquipment.length > 30) return { ...result, bracelet: empty('unavailable', ['장비 응답을 확인할 수 없습니다.']), gem: emptyGem('unavailable') };
  if (isSupportCharacter(raw)) return { ...result, ...analyzeSupportEfficiency(raw) };
  const bracelets = raw.ArmoryEquipment.filter((i) => i?.Type === '팔찌');
  return { ...result, bracelet: bracelets.length > 1 ? empty('unavailable', ['팔찌 항목이 중복됩니다.']) : bracelets.length === 0 ? empty('absent') : completeBraceletResult(raw), gem: analyzeNativeGemEfficiency(raw) };
}
export function analyzeNativeEfficiency(raw, options = {}) {
  try { return analyze(raw, options); } catch {
    return { characterName: '', source: 'official-api', modelVersion: NATIVE_EFFICIENCY_MODEL_VERSION, calculatedAt: null,
      bracelet: empty('unavailable', ['효율 입력을 해석할 수 없습니다.']), gem: emptyGem('unavailable', ['효율 입력을 해석할 수 없습니다.']) };
  }
}
