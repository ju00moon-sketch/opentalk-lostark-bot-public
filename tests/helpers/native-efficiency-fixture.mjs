// Synthetic official-shaped values; no account or captured character data.
export const icon = "<img src='emoticon_tooltip_bracelet_changeable'></img>";
export const box = (title, body) => ({ type: 'ItemPartBox', value: { Element_000: title, Element_001: body } });
export function tooltip(parts, title = {}) {
  return JSON.stringify({ title: { type: 'ItemTitle', value: title }, ...Object.fromEntries(Object.entries(parts).map(([name, value], i) => [`part${i}`, box(name, value)])) });
}
export function setBracelet(raw, body) {
  raw.ArmoryEquipment.find((i) => i.Type === '팔찌').Tooltip = tooltip({ '팔찌 효과': body }, { leftStr2: '아이템 티어 4' });
}
export function gridGem(point = 3, Index = 0, IsActive = true) {
  return { Index, IsActive, Tooltip: tooltip({ '젬 효과': `질서 포인트 : ${point}<BR>공격력 +1.00%` }) };
}
export function gridEffect(Name, value, Level = 10) {
  const labels = { '보스 피해': '보스 등급 이상 몬스터에게 주는 피해', '아군 공격 강화': '아군 공격력 강화 효과', '아군 피해 강화': '아군 피해량 강화 효과' };
  return { Name, Level, Tooltip: `${labels[Name] ?? Name} <font>+${value}%</font>` };
}
export function fixture(body = `${icon}치명 +100`) {
  return {
    ArmoryProfile: { CharacterName: '시험캐릭터', CharacterClassName: '블레이드', Stats: [{ Type: '치명', Value: '1000' }, { Type: '특화', Value: '1500' }, { Type: '신속', Value: '100' }] },
    ArmoryEquipment: [
      { Type: '무기', Tooltip: tooltip({ '기본 효과': '무기 공격력 +100000' }, { qualityValue: 100 }) },
      { Type: '상의', Tooltip: tooltip({ '기본 효과': '민첩 +30000' }) },
      { Type: '팔찌', Tooltip: tooltip({ '팔찌 효과': body }, { leftStr2: '아이템 티어 4' }) },
    ],
    ArmoryAvatars: [], ArmorySkills: [], ArmoryGem: { Gems: [], Effects: null },
    ArmoryEngraving: { ArkPassiveEffects: [] },
    ArkPassive: { Points: [{ Name: '깨달음', Description: '0랭크 0레벨' }], Effects: [{ Description: '깨달음 2티어 잔재된 기운 Lv.3' }] },
    ArkGrid: { Slots: [], Effects: [] },
  };
}
export function withGrid(raw = fixture(), point = 20) {
  raw.ArkGrid = { Slots: [{ Index: 0, Name: '혼돈의 별 코어 : 공격', Grade: '고대', Point: point, Gems: [gridGem(3)],
    Tooltip: tooltip({ '코어 옵션': '[10P] 공격력이 900 증가한다.<BR>[14P] 공격력이 0.55% 증가한다.<BR>[17P] 공격력이 1.10% 증가하고, 추가로 1800 증가한다.<BR>[18P] 공격력이 0.16% 증가한다.<BR>[19P] 공격력이 0.16% 증가한다.<BR>[20P] 공격력이 0.16% 증가한다.' }) }],
    Effects: [gridEffect('공격력', 3), gridEffect('추가 피해', 2), gridEffect('보스 피해', 1)] };
  return raw;
}
