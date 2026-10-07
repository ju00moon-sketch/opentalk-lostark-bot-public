import { readBraceletExpectationInput } from './bracelet-expectation-input.js';
import { calculateBraceletExpectation } from './bracelet-expectation.js';
import { createHash } from 'node:crypto';

export function analyzeBraceletExpectation(raw) {
  if (!Array.isArray(raw?.ArmoryEquipment) || raw.ArmoryEquipment.length > 32) return { status: 'unavailable', reason: '팔찌 정보가 없습니다.' };
  const input = readBraceletExpectationInput(raw.ArmoryEquipment.find(item => item?.Type === '팔찌'));
  if (input.status !== 'ok') return {...input,...(input.itemTier?{tier:input.itemTier}:{})};
  try {
    const tickets=input.itemTier===3?0:3;
    const calculation = calculateBraceletExpectation({ ...input.input, reconversionTickets:tickets });
    const targetKey = createHash('sha256').update(JSON.stringify({ rarity: input.input.rarity, target: input.target })).digest('hex');
    return { ...calculation, target: input.target, targetKey,
      scenarios: calculation.scenarios.filter(row => row.reconversionTickets === tickets),
      probabilityByRoll: calculation.probabilityByRoll.slice(0, calculation.normalRolls + tickets),
      reconversionTicketUnitGold:null,reconversionTicketCostGold:null };
  }
  catch { return { status: 'unavailable', reason: '현재 옵션 구성을 공식 확률표와 대조할 수 없습니다.' }; }
}
