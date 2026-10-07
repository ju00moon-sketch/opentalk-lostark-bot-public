// These two conditional effects are read from the complete official armory
// statement. Their encounter assumptions belong to the bracelet comparison.
export function readConditionalBraceletEngraving(effect) {
  if (!effect || !['승부사', '선수필승'].includes(effect.Name) || !['전설', '유물'].includes(effect.Grade)
      || !Number.isInteger(effect.Level) || effect.Level < 0 || effect.Level > 4
      || typeof effect.Description !== 'string' || effect.Description.length > 4000) return null;
  const description = effect.Description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (effect.Name === '승부사') {
    const hit = /^적을 처치할 때 마다 (\d+)초 동안, 공격력이 (\d+(?:\.\d+)?)% 증가한다\. \(최대 (\d+)중첩\)$/.exec(description);
    if (!hit) return null;
    const duration = Number(hit[1]), perStack = Number(hit[2]), stacks = Number(hit[3]);
    if (duration < 1 || duration > 120 || perStack <= 0 || perStack > 10 || stacks < 1 || stacks > 20 || perStack * stacks > 100) return null;
    return { name: effect.Name, attackPercent: perStack * stacks,
      assumption: `승부사는 공식 툴팁의 최대 ${stacks}중첩(공격력 ${perStack * stacks}%)을 유지하는 기준입니다. 실제 처치 빈도에 따른 유지율은 반영하지 않습니다.` };
  }
  const hit = /^생명력이 최대인 시드 등급 이하 몬스터에게 공격 적중 시 치명타 적중률이 100%로 적용된다\. 또한 이 치명타는 (\d+(?:\.\d+)?)%의 추가 치명타 배율을 가진다\.$/.exec(description);
  if (!hit || Number(hit[1]) <= 0 || Number(hit[1]) > 1000) return null;
  return { name: effect.Name, attackPercent: 0,
    assumption: '선수필승은 생명력이 최대인 시드 등급 이하 몬스터 전용이므로 보스 대상 팔찌 효율에는 적용하지 않습니다.' };
}
