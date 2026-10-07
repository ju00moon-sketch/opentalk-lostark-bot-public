import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNativeSpecScore as analyze, classifyNativeSpecTier as tier } from '../src/native-spec-score.js';
import { fixture as baseFixture, tooltip, box, icon } from './helpers/native-efficiency-fixture.mjs';

function fixture() {
  const raw = baseFixture();
  raw.ArmoryEquipment[0].Grade = '고대';
  for (const type of ['목걸이', '반지', '반지']) raw.ArmoryEquipment.push({ Type: type, Grade: '고대', Tooltip: tooltip({ '기본 효과': '민첩 +0', '연마 효과': '' }) });
  raw.ArkPassive.IsArkPassive = true;
  raw.ArkPassive.Points = ['진화', '깨달음', '도약'].map((Name, i) => ({ Name, Value: [140, 100, 70][i], Description: '0랭크 0레벨' }));
  raw.ArmoryGem = { Gems: [], Effects: { Description: '', Skills: [] } };
  return raw;
}
function equipGem(raw, { skill = '소울 앱소버', type = 'damage', level = 10, percent = 44, tier = 4 } = {}) {
  const slot = raw.ArmoryGem.Gems.length;
  raw.ArmoryGem.Gems.push({ Slot: slot, Level: level });
  raw.ArmoryGem.Effects.Skills.push({ GemSlot: slot, Name: skill, Description: [`${type === 'damage' ? '피해' : '재사용 대기시간'} ${percent}% ${type === 'damage' ? '증가' : '감소'}`], Option: tier === 4 ? '기본 공격력 1.2% 증가' : '' });
  raw.ArmoryGem.Effects.Description = tier === 4 ? `기본 공격력 총합 : ${raw.ArmoryGem.Gems.length * 1.2}%` : '';
}

test('whole dealer score restores passive stats and calibration factors instead of returning a comparison subtotal', () => {
  const raw = fixture(), result = analyze(raw);
  const attack = Math.floor(Math.sqrt(30300 * 100000 / 6));
  const bracelet = (1.3 + .00041 * 2600) / (1.3 + .00041 * 2500);
  const expected = attack * 1.3 * bracelet * 1.79 * 1.42 * 1.15 * 1.8 * 1.021 / 1930;
  assert.equal(result.status, 'ok'); assert.equal(result.role, 'dealer'); assert.ok(Math.abs(result.score - expected) < 1e-10);
  assert.equal(result.diagnostics.factors.gemDamage, 1); assert.equal(result.diagnostics.factors.gemCooldown, 1);
  assert.equal(result.formulas[0].value, result.score);
  assert.ok(Math.abs(result.formulas[0].formula.split(' × ').map(Number).reduce((a, b) => a * b, 1) - result.score) < 1e-10);
});
test('every tier uses inclusive raw-score lower boundaries before display rounding', () => {
  // Fixed score minimums from src/data/score-tier-cuts.json (the percentile-less fallback).
  const rows = [[0, '아이언'], [800, '브론즈'], [1500, '실버'], [2300, '골드'], [3300, '플래티넘'], [4300, '다이아몬드'], [5600, '마스터'], [7400, '그랜드마스터'], [8000, '챌린저'], [8800, '에스더']];
  rows.forEach(([cutoff, name], index) => {
    assert.equal(tier(cutoff).name, name); assert.equal(tier(cutoff).progress, index === rows.length - 1 ? 100 : 0);
    if (index) assert.equal(tier(cutoff - .0001).name, rows[index - 1][1]);
  });
  assert.equal(tier(1900).progress, 50); assert.equal(tier(1900).remaining, 400);
  assert.equal(tier(8800).nextName, null);
  for (const value of [-1, null, NaN, Infinity, '8800']) assert.equal(tier(value), null);
});
test('accessory and engraving damage modifiers are explicit and affect the total exactly once', () => {
  const raw = fixture(), baseline = analyze(raw).score;
  raw.ArmoryEquipment.find(item => item.Type === '목걸이').Tooltip = tooltip({ '기본 효과': '민첩 +0', '연마 효과': '적에게 주는 피해 +2.00%' });
  raw.ArmoryEngraving.ArkPassiveEffects.push({ Name: '원한', Grade: '유물', Level: 4, AbilityStoneLevel: 2, Description: '' });
  const result = analyze(raw); assert.equal(result.status, 'ok');
  // The score model's Grudge coefficient is19, plus stone level2's3.75.
  assert.ok(Math.abs(result.score / baseline - 1.02 * 1.2275) < 1e-12);
  assert.equal(result.diagnostics.factors.engravingDamage, 1.2275);
  raw.ArmoryEngraving.ArkPassiveEffects[0].Grade = '확인 안 된 등급'; assert.equal(analyze(raw).score, null);
});
test('accessory options outside combat power are skipped while unknown lines still fail', () => {
  const raw = fixture(), baseline = analyze(raw).score;
  raw.ArmoryEquipment.find(item => item.Type === '목걸이').Tooltip = tooltip({ '기본 효과': '민첩 +0', '연마 효과': '낙인력 +8.00%<BR>세레나데, 신앙, 조화 게이지 획득량 +1.60%' });
  raw.ArmoryEquipment.find(item => item.Type === '반지').Tooltip = tooltip({ '기본 효과': '민첩 +0', '연마 효과': '전투 중 생명력 회복량 +25<BR>아군 피해량 강화 효과 +7.50%' });
  const result = analyze(raw); assert.equal(result.status, 'ok'); assert.equal(result.score, baseline);
  raw.ArmoryEquipment.find(item => item.Type === '목걸이').Tooltip = tooltip({ '기본 효과': '민첩 +0', '연마 효과': '정체불명 효과 +1.00%' });
  const unknown = analyze(raw); assert.equal(unknown.status, 'unavailable'); assert.match(unknown.omitted[0], /연마 효과 미확인: 정체불명 효과/);
});
test('evolution karma and passive point steps change only their defined score factors', () => {
  const raw = fixture(); raw.ArkPassive.Points[0].Description = '6랭크 21레벨';
  let result = analyze(raw); assert.equal(result.status, 'ok'); assert.equal(result.diagnostics.factors.evolution, 1.85);
  raw.ArkPassive.Points[0].Value = 119; raw.ArkPassive.Points[1].Value = 98; raw.ArkPassive.Points[2].Value = 68;
  result = analyze(raw); assert.equal(result.diagnostics.factors.evolution, 1.51); assert.equal(result.diagnostics.factors.enlightenment, 1.4); assert.equal(result.diagnostics.factors.leap, 1.14);
});
test('damage gem weights and level-weighted cooldown use separate factors', () => {
  const raw = fixture();
  equipGem(raw); equipGem(raw, { skill: '마엘스톰', type: 'cooldown', level: 10, percent: 24 });
  equipGem(raw, { skill: '터닝 슬래쉬', type: 'cooldown', level: 7, percent: 18 });
  const result = analyze(raw); assert.equal(result.status, 'ok'); assert.ok(result.diagnostics.factors.gemDamage > 1);
  const expectedAverage = (24 * 512 + 18 * 64) / (512 + 64);
  assert.equal(result.diagnostics.gem.averageCooldown, expectedAverage);
  assert.equal(result.diagnostics.factors.gemCooldown, 1 / (1 - .9 * expectedAverage / 100));
});
test('declared no-gem and no-bracelet states remain valid while absent structures do not', () => {
  const raw = fixture(); raw.ArmoryGem.Gems = null;
  raw.ArmoryEquipment = raw.ArmoryEquipment.filter(item => item.Type !== '팔찌');
  const result = analyze(raw); assert.equal(result.status, 'ok'); assert.equal(result.diagnostics.factors.bracelet, 1);
  assert.equal(result.diagnostics.factors.gemDamage, 1); assert.equal(result.diagnostics.factors.gemCooldown, 1);
  delete raw.ArmoryGem; assert.equal(analyze(raw).score, null);
});
test('explicitly unequipped ArkGrid is neutral while an omitted response is unresolved', () => {
  const raw = fixture(); raw.ArkGrid = { Slots: [], Effects: [] };
  const expected = analyze(raw); assert.equal(expected.status, 'ok');
  raw.ArkGrid = null;
  assert.deepEqual(analyze(raw), expected); assert.equal(raw.ArkGrid, null);
  delete raw.ArkGrid;
  assert.equal(analyze(raw).status, 'unavailable'); assert.equal(analyze(raw).score, null);
});

test('unknown or contradictory raw inputs cannot become a lower apparently complete score', () => {
  const changes = [raw => { raw.ArkPassive.Points.pop(); }, raw => { raw.ArkPassive.Points[0].Description = '6랭크'; },
    raw => { raw.ArkPassive.Points[0].Value = '140'; }, raw => { raw.ArkPassive.Points.push(raw.ArkPassive.Points[0]); },
    raw => { raw.ArkGrid.Effects = [{ Name: '보스 피해', Level: 1, Tooltip: '아군 공격력 강화 효과 +1%' }]; },
    raw => { raw.ArkGrid.Slots = [{ Index: 0, Name: '아직 없는 코어', Point: 20, Grade: '고대' }]; },
    raw => { raw.ArmoryEquipment[0].Grade = '아직 없는 등급'; },
    raw => { raw.ArmorySkills = null; }, raw => { raw.ArmoryEquipment.find(item => item.Type === '반지').Tooltip = '{}'; },
    raw => { raw.ArmoryEquipment.push({ Type: '보주', Name: '눈부신 비전의 보주', Tooltip: '{}' }); },
    raw => { raw.ArmoryEquipment.push(raw.ArmoryEquipment.find(item => item.Type === '목걸이')); },
    raw => { raw.ArmoryEquipment.find(item => item.Type === '목걸이').Tooltip = tooltip({ '기본 효과': '민첩 +0', '연마 효과': '적에게 주는 피해 +abc%' }); }];
  for (const change of changes) { const raw = fixture(); change(raw); const result = analyze(raw); assert.equal(result.status, 'unavailable'); assert.equal(result.score, null); assert.equal(result.tier, null); assert.ok(result.omitted.length); }
});
test('gem slot, numeric effect, duplicate and unmatched descriptions fail closed', () => {
  for (const change of [raw => { raw.ArmoryGem.Effects.Skills[0].Description = ['피해 4,,4% 증가']; },
    raw => { raw.ArmoryGem.Effects.Skills[0].Description = ['피해 43% 증가']; }, raw => { raw.ArmoryGem.Gems[0].Level = -1; },
    raw => { raw.ArmoryGem.Effects.Skills[0].GemSlot = 5; }, raw => { equipGem(raw, { type: 'cooldown', percent: 20 }); }]) {
    const raw = fixture(); equipGem(raw); change(raw); assert.equal(analyze(raw).score, null);
  }
});
test('orb fixed-damage proxy uses its own two floor stages and25 percent contribution', () => {
  const raw = fixture(), baseline = analyze(raw).score;
  raw.ArmoryEquipment.push({ Type: '보주', Name: '눈부신 비전의 보주', Tooltip: tooltip({ '특수 효과': '시즌2 달성 최대 낙원력 : 12198635' }) });
  const result = analyze(raw); assert.equal(result.status, 'ok'); assert.equal(result.diagnostics.factors.orb, 1.002939);
  assert.ok(Math.abs(result.score / baseline - 1.002939) < 1e-12);
  for (const value of ['1,,00', '12198635abc', '12198635%', '12198635.5']) {
    raw.ArmoryEquipment.at(-1).Tooltip = tooltip({ '특수 효과': `시즌2 달성 최대 낙원력 : ${value}` });
    assert.equal(analyze(raw).score, null);
  }
});
test('score calculation is deterministic and does not read external state or mutate inputs', () => {
  const raw = fixture(), before = JSON.stringify(raw), result = analyze(raw);
  assert.deepEqual(analyze(raw), result); assert.equal(JSON.stringify(raw), before);
  for (const input of [null, {}, [], { ArmoryProfile: {} }]) assert.equal(analyze(input).score, null);
});
test('support role requires its actual awakening path and missing support inputs do not leak a dealer score', () => {
  const raw = fixture(); raw.ArmoryProfile.CharacterClassName = '도화가';
  raw.ArkPassive.Effects = [{ Name: '깨달음', Description: '깨달음 2티어 만개 Lv.3' }];
  assert.equal(analyze(raw).role, 'support'); assert.equal(analyze(raw).score, null);
  raw.ArkPassive.Effects[0].Description = '깨달음 2티어 회귀 Lv.3';
  assert.equal(analyze(raw).role, 'dealer');
});
test('conditional attack engravings the reference score skips are accepted with a zero damage factor', () => {
  const raw = fixture(), baseline = analyze(raw);
  // Official tooltip wording: the bracelet attack context still reads these rows, the score's engraving factor ignores them.
  raw.ArmoryEngraving.ArkPassiveEffects.push({ Name: '승부사', Grade: '유물', Level: 0, AbilityStoneLevel: null, Description: "적을 처치할 때 마다 <FONT COLOR='#ffff99'>40</FONT>초 동안, 공격력이 <FONT COLOR='#99ff99'>2.10%</FONT> 증가한다. (최대 <FONT COLOR='#ffff99'>8</FONT>중첩)" });
  raw.ArmoryEngraving.ArkPassiveEffects.push({ Name: '선수필승', Grade: '유물', Level: 0, AbilityStoneLevel: null, Description: "생명력이 최대인 시드 등급 이하 몬스터에게 공격 적중 시 치명타 적중률이 100%로 적용된다. 또한 이 치명타는 <FONT COLOR='#99ff99'>140.00%</FONT>의 추가 치명타 배율을 가진다." });
  const result = analyze(raw); assert.equal(result.status, 'ok'); assert.equal(result.score, baseline.score);
  assert.equal(result.diagnostics.factors.engravingDamage, baseline.diagnostics.factors.engravingDamage);
  raw.ArmoryEngraving.ArkPassiveEffects.at(-1).Description = ''; assert.equal(analyze(raw).status, 'unavailable');
});
test('every relic engraving book resolves in both engraving tables and the ignored ones leave the score unchanged', async () => {
  // The 43 relic engraving books the market lists (2026-09-17); class engravings no longer appear on characters.
  const books = ['각성', '강령술', '강화 방패', '결투의 대가', '구슬동자', '굳은 의지', '급소 타격', '긴급 구조', '기습의 대가', '달인의 저력', '돌격대장',
    '마나 효율 증가', '마나의 흐름', '바리케이드', '번개의 분노', '부러진 뼈', '분쇄의 주먹', '불굴', '선수필승', '속전속결', '슈퍼 차지', '승부사', '시선 집중',
    '실드 관통', '아드레날린', '안정된 상태', '약자 무시', '에테르 포식자', '여신의 가호', '예리한 둔기', '원한', '위기 모면', '저주받은 인형', '전문의',
    '정기 흡수', '정밀 단도', '중갑 착용', '질량 증가', '최대 마나 증가', '추진력', '타격의 대가', '탈출의 명수', '폭발물 전문가'];
  const { default: model } = await import('../src/data/spec-score-model.json', { with: { type: 'json' } });
  const { default: facts } = await import('../src/data/bracelet-model.json', { with: { type: 'json' } });
  const compact = name => name.replace(/\s+/g, '');
  const damage = new Set(Object.keys(model.engravingDamage).map(compact)), bracelet = new Set(Object.keys(facts.engraving).map(compact));
  assert.deepEqual(books.filter(name => !damage.has(compact(name)) || !bracelet.has(compact(name))), []);
  const raw = fixture(), baseline = analyze(raw);
  raw.ArmoryEngraving.ArkPassiveEffects.push({ Name: '부러진 뼈', Grade: '유물', Level: 4, AbilityStoneLevel: null, Description: "무력화 중인 대상에게 주는 피해가 <FONT COLOR='#99ff99'>42.00%</FONT> 증가한다." });
  const result = analyze(raw); assert.equal(result.status, 'ok'); assert.equal(result.score, baseline.score);
  assert.equal(result.diagnostics.factors.engravingDamage, baseline.diagnostics.factors.engravingDamage);
});
test('core names with stray spaces from the official API resolve like their canonical names', () => {
  const raw = fixture();
  raw.ArkGrid = { Slots: [{ Index: 0, Name: '질서의 해 코어 : 무법지대', Grade: '고대', Point: 20, Gems: null }, { Index: 1, Name: '질서의 달 코어 : 불릿 무빙 ', Grade: '고대', Point: 20, Gems: null }], Effects: [] };
  raw.ArkPassive.Effects = [{ Name: '깨달음', Description: "<FONT color='#83E9FF'>깨달음</FONT> 1티어 <FONT color='#83E9FF'>사냥의 시간 Lv.3</FONT>" }];
  const before = JSON.stringify(raw);
  const result = analyze(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(result.omitted.filter(line => line.includes('불릿 무빙')), []);
});

// Official input forms accepted on 2026-09-18 (roster scan of 221 characters).
test('official null grid collections score like an empty grid and cores without gem effects keep their cores', () => {
  const raw = fixture(); raw.ArkGrid = { Slots: [], Effects: [] };
  const expected = analyze(raw); assert.equal(expected.status, 'ok');
  for (const grid of [null, { Slots: null, Effects: null }]) {
    raw.ArkGrid = grid; const before = JSON.stringify(raw);
    assert.deepEqual(analyze(raw), expected, JSON.stringify(grid)); assert.equal(JSON.stringify(raw), before);
  }
  const core = { Index: 0, Name: '혼돈의 해 코어 : 현란한 공격', Grade: '유물', Point: 14, Gems: null };
  raw.ArkGrid = { Slots: [core], Effects: [] }; const withCore = analyze(raw); assert.equal(withCore.status, 'ok'); assert.notEqual(withCore.score, expected.score);
  raw.ArkGrid = { Slots: [core], Effects: null }; assert.deepEqual(analyze(raw), withCore);
  for (const grid of [{ Slots: null }, { Effects: null }, { Slots: [] }, {}]) { raw.ArkGrid = grid; assert.equal(analyze(raw).status, 'unavailable', JSON.stringify(grid)); }
});
test('legendary and heroic dealer cores within their caps score like the same relic cores', () => {
  const score = (Grade, Point) => { const raw = fixture(); raw.ArkGrid = { Slots: [{ Index: 0, Name: '혼돈의 해 코어 : 현란한 공격', Grade, Point, Gems: null }], Effects: [] }; return analyze(raw); };
  assert.equal(score('전설', 14).status, 'ok'); assert.equal(score('전설', 14).score, score('유물', 14).score);
  assert.equal(score('전설', 14).diagnostics.factors.coreFinalDamage, 1.01);
  assert.equal(score('영웅', 10).score, score('유물', 10).score); assert.notEqual(score('전설', 14).score, score('영웅', 10).score);
  for (const [grade, point] of [['전설', 15], ['영웅', 11], ['희귀', 10]]) {
    const result = score(grade, point); assert.equal(result.status, 'unavailable', `${grade} ${point}`); assert.match(result.omitted.join(' '), /코어 등급 미확인/);
  }
});
test('an unopened karma description counts as rank zero while any other wording still fails', () => {
  const raw = fixture(), expected = analyze(raw); assert.equal(expected.status, 'ok');
  for (const description of ['', '  ', '미개방']) {
    for (const row of raw.ArkPassive.Points) row.Description = description;
    const result = analyze(raw); assert.equal(result.status, 'ok', description);
    assert.equal(result.score, expected.score); assert.equal(result.diagnostics.factors.evolution, 1.79);
  }
  raw.ArkPassive.Points[0].Description = '6랭크 21레벨'; assert.equal(analyze(raw).diagnostics.factors.evolution, 1.85);
  for (const description of ['abc', '미개방 상태', null]) { raw.ArkPassive.Points[0].Description = description; assert.equal(analyze(raw).status, 'unavailable', String(description)); }
});
test('the ability stone reduction line is skipped while a graded reduction name follows the engraving rules', () => {
  const raw = fixture(), expected = analyze(raw);
  raw.ArmoryEngraving.ArkPassiveEffects.push({ Name: '방어력 감소', Grade: '', Level: 0, AbilityStoneLevel: -1 });
  raw.ArmoryEngraving.ArkPassiveEffects.push({ Name: '공격 속도 감소', Grade: '', Level: 0, AbilityStoneLevel: null });
  const result = analyze(raw); assert.equal(result.status, 'ok'); assert.equal(result.score, expected.score);
  assert.equal(result.diagnostics.factors.engravingDamage, expected.diagnostics.factors.engravingDamage);
  raw.ArmoryEngraving.ArkPassiveEffects = [{ Name: '방어력 감소', Grade: '유물', Level: 0, AbilityStoneLevel: -1 }];
  assert.equal(analyze(raw).status, 'unavailable');
  raw.ArmoryEngraving.ArkPassiveEffects = [{ Name: '원한', Grade: '', Level: 0, AbilityStoneLevel: 2 }];
  assert.equal(analyze(raw).status, 'unavailable');
});
test('two gems of the same skill and effect count once at the higher level with a stated assumption', () => {
  const line = '같은 스킬·효과의 보석이 둘 이상이면 높은 레벨 하나만 반영했습니다.';
  const raw = fixture(); equipGem(raw, { skill: '마엘스톰', type: 'cooldown', level: 7, percent: 18 });
  equipGem(raw, { skill: '마엘스톰', type: 'cooldown', level: 10, percent: 24 });
  equipGem(raw, { skill: '터닝 슬래쉬', type: 'cooldown', level: 5, percent: 14 });
  const result = analyze(raw); assert.equal(result.status, 'ok');
  const single = fixture(); equipGem(single, { skill: '마엘스톰', type: 'cooldown', level: 10, percent: 24 }); equipGem(single, { skill: '터닝 슬래쉬', type: 'cooldown', level: 5, percent: 14 });
  const expected = analyze(single);
  assert.equal(result.diagnostics.gem.averageCooldown, expected.diagnostics.gem.averageCooldown);
  assert.equal(result.diagnostics.factors.gemCooldown, expected.diagnostics.factors.gemCooldown);
  assert.ok(result.assumptions.includes(line)); assert.ok(!expected.assumptions.includes(line));
  const tie = fixture(); equipGem(tie, { skill: '마엘스톰', type: 'cooldown', level: 10, percent: 24 }); equipGem(tie, { skill: '마엘스톰', type: 'cooldown', level: 10, percent: 24 });
  assert.equal(analyze(tie).diagnostics.gem.averageCooldown, 24); assert.ok(analyze(tie).assumptions.includes(line));
  const one = fixture(); equipGem(one);
  const damage = fixture(); equipGem(damage); equipGem(damage, { level: 9, percent: 40 });
  assert.equal(analyze(damage).status, 'ok'); assert.equal(analyze(damage).diagnostics.factors.gemDamage, analyze(one).diagnostics.factors.gemDamage);
});
test('an absent or null avatar block is a known zero percent for the dealer score', () => {
  const raw = fixture(), expected = analyze(raw); assert.equal(expected.status, 'ok'); assert.deepEqual(raw.ArmoryAvatars, []);
  raw.ArmoryAvatars = null; assert.equal(analyze(raw).score, expected.score);
  delete raw.ArmoryAvatars; assert.equal(analyze(raw).score, expected.score);
  raw.ArmoryAvatars = {}; assert.equal(analyze(raw).status, 'unavailable');
});

// Input forms accepted on 2026-09-18, second pass (the 28 roster characters left unavailable by the first pass).
test('an orb outside the model groups is a factor of one with a stated assumption while table orbs keep their rules', () => {
  const raw = fixture(), baseline = analyze(raw);
  raw.ArmoryEquipment.push({ Type: '보주', Name: '확산하는 안개의 보주', Tooltip: tooltip({ '특수 효과': '[천둥채움] 고정 피해' }) });
  const result = analyze(raw); assert.equal(result.status, 'ok'); assert.equal(result.diagnostics.factors.orb, 1); assert.equal(result.score, baseline.score);
  assert.ok(result.assumptions.includes("보주 '확산하는 안개의 보주'은 환산 모형에 없어 기여 없음으로 계산했습니다."));
  assert.ok(!baseline.assumptions.some(line => line.startsWith('보주 ')));
  raw.ArmoryEquipment.at(-1).Name = '눈부신 비전의 보주'; assert.equal(analyze(raw).status, 'unavailable');
  raw.ArmoryEquipment.at(-1).Tooltip = tooltip({ '특수 효과': '시즌2 달성 최대 낙원력 : 12198635' }); assert.equal(analyze(raw).diagnostics.factors.orb, 1.002939);
  raw.ArmoryEquipment.push({ Type: '보주', Name: '확산하는 안개의 보주', Tooltip: '{}' }); assert.equal(analyze(raw).status, 'unavailable');
  const unnamed = fixture(); unnamed.ArmoryEquipment.push({ Type: '보주', Tooltip: '{}' }); assert.equal(analyze(unnamed).status, 'unavailable');
});
test('a class without any path node scores on its default path with a stated assumption while ambiguous or support classes still fail', () => {
  const line = '깨달음 직업 계열 노드가 없어 광전사의 비기 기준으로 계산했습니다.';
  const raw = fixture(); raw.ArmoryProfile.CharacterClassName = '버서커'; raw.ArkPassive.Effects = [{ Description: '깨달음 1티어 전술 훈련 Lv.1' }];
  const result = analyze(raw); assert.equal(result.status, 'ok'); assert.ok(result.assumptions.includes(line));
  const explicit = fixture(); explicit.ArmoryProfile.CharacterClassName = '버서커';
  explicit.ArkPassive.Effects = [{ Description: '깨달음 1티어 광전사의 비기 Lv.1' }, { Description: '깨달음 1티어 전술 훈련 Lv.1' }];
  const direct = analyze(explicit); assert.equal(direct.status, 'ok'); assert.equal(direct.score, result.score); assert.ok(!direct.assumptions.includes(line));
  raw.ArmoryProfile.CharacterClassName = '바드'; const bard = analyze(raw);
  assert.equal(bard.status, 'unavailable'); assert.match(bard.omitted.join(' '), /직업별 깨달음 계열 판별 불가/);
  raw.ArmoryProfile.CharacterClassName = '버서커'; raw.ArkPassive.Effects = [{ Description: '깨달음 1티어 광전사의 비기 Lv.1' }, { Description: '깨달음 1티어 광기 Lv.1' }];
  assert.equal(analyze(raw).status, 'unavailable');
});
test('neutral bracelet lines carry no coefficient on the dealer score while other unknown lines still fail', () => {
  const raw = fixture(), baseline = analyze(raw), bracelet = raw.ArmoryEquipment.find(item => item.Type === '팔찌');
  const neutral = ['효과 부여 가능', '효과 부여 가능', '마법 방어력 +1200', '[긴급수혈] 생명력이 50% 이하일 경우 몬스터에게 피격 시 30% 확률로 생명력을 16000 회복한다. (재사용 대기시간 120초)', '[강타] 치명타 적중 후 4초 동안 제압이 65, 숙련이 65 증가한다.'];
  bracelet.Tooltip = tooltip({ '팔찌 효과': `${icon}치명 +100${neutral.map(text => icon + text).join('')}` }, { leftStr2: '아이템 티어 4' });
  const result = analyze(raw); assert.equal(result.status, 'ok'); assert.equal(result.score, baseline.score);
  const line = result.assumptions.find(text => text.startsWith('팔찌 옵션 '));
  assert.ok(line.includes("'효과 부여 가능', '효과 부여 가능', '마법 방어력 +1200', '[긴급수혈]") && line.endsWith('기여 없음으로 계산했습니다.'));
  assert.ok(!baseline.assumptions.some(text => text.startsWith('팔찌 옵션 ')));
  bracelet.Tooltip = tooltip({ '팔찌 효과': `${icon}치명 +100${icon}[정체불명] 새 효과` }, { leftStr2: '아이템 티어 4' });
  const unknown = analyze(raw); assert.equal(unknown.status, 'unavailable'); assert.match(unknown.omitted.join(' '), /미확인 팔찌 옵션: \[정체불명\] 새 효과/);
});
test('support effect lines on gems are ignored and a support-only gem is a level-based damage gem like the reference', () => {
  const line = '지원 효과만 있는 보석은 참조 모형과 같이 레벨 기준 피해 보석으로 반영했습니다.';
  // A dealer-built bard: no skill share table names its skills, so the equal-weight fallback path is used.
  const bard = () => { const raw = fixture(); raw.ArmoryProfile.CharacterClassName = '바드'; raw.ArkPassive.Effects = [{ Description: '깨달음 1티어 진실된 용맹 Lv.1' }]; return raw; };
  const raw = bard(); equipGem(raw, { skill: '천상의 연주', level: 6, percent: 28 });
  const expected = analyze(raw); assert.equal(expected.status, 'ok'); assert.equal(expected.diagnostics.gem.fallback, true); assert.equal(expected.diagnostics.factors.gemDamage, 1 + 28 * .7 / 100);
  raw.ArmoryGem.Effects.Skills[0].Description = ['피해 28.00% 증가', '지원 효과 6.00 % 증가'];
  const twoLine = analyze(raw); assert.equal(twoLine.status, 'ok'); assert.equal(twoLine.score, expected.score); assert.ok(!twoLine.assumptions.includes(line));
  equipGem(raw, { skill: '세레나데 스킬', level: 6, percent: 28 }); raw.ArmoryGem.Effects.Skills[1].Description = ['지원 효과 6.00% 증가'];
  // The second gem also adds its base attack option, so the damage factor (not the whole score) is compared.
  const supportOnly = analyze(raw); assert.equal(supportOnly.status, 'ok'); assert.equal(supportOnly.diagnostics.factors.gemDamage, expected.diagnostics.factors.gemDamage); assert.ok(supportOnly.assumptions.includes(line));
  raw.ArmoryGem.Gems[1].Level = 7; const higher = analyze(raw);
  assert.equal(higher.diagnostics.factors.gemDamage, 1 + (28 + 32) / 2 * .7 / 100); assert.equal(higher.diagnostics.factors.normalAttack, supportOnly.diagnostics.factors.normalAttack);
  const third = bard(); equipGem(third, { skill: '세레나데 스킬', level: 6, percent: 18, tier: 3 }); third.ArmoryGem.Effects.Skills[0].Description = ['지원 효과 6.00 % 증가'];
  assert.equal(analyze(third).status, 'ok'); assert.equal(analyze(third).diagnostics.factors.gemDamage, 1 + 18 * .7 / 100);
  const mixed = bard(); equipGem(mixed, { skill: '천상의 연주', level: 6, percent: 28 }); mixed.ArmoryGem.Effects.Skills[0].Description = ['피해 28.00% 증가', '재사용 대기시간 16.00% 감소'];
  assert.equal(analyze(mixed).status, 'unavailable');
});
test('a missing necklace or ring is a factor of one with a stated assumption while extra accessories still fail', () => {
  const line = '목걸이·반지 일부가 없어 해당 부위 연마 효과는 반영하지 않았습니다.';
  const raw = fixture(), baseline = analyze(raw);
  raw.ArmoryEquipment.find(item => item.Type === '목걸이').Tooltip = tooltip({ '기본 효과': '민첩 +0', '연마 효과': '적에게 주는 피해 +2.00%' });
  raw.ArmoryEquipment.splice(raw.ArmoryEquipment.findIndex(item => item.Type === '반지'), 1);
  const oneRing = analyze(raw); assert.equal(oneRing.status, 'ok'); assert.equal(oneRing.diagnostics.factors.accessories, 1.02); assert.ok(oneRing.assumptions.includes(line));
  raw.ArmoryEquipment = raw.ArmoryEquipment.filter(item => !['목걸이', '반지'].includes(item.Type));
  const none = analyze(raw); assert.equal(none.status, 'ok'); assert.equal(none.diagnostics.factors.accessories, 1); assert.equal(none.score, baseline.score);
  assert.ok(!baseline.assumptions.includes(line));
  for (const type of ['목걸이', '반지']) {
    const extra = fixture(); extra.ArmoryEquipment.push(extra.ArmoryEquipment.find(item => item.Type === type));
    const result = analyze(extra); assert.equal(result.status, 'unavailable', type); assert.match(result.omitted[0], /목걸이·반지 착용 정보 중복/);
  }
});
test('accessories without a refinement section and refinement values outside the table are neutral with stated assumptions', () => {
  const raw = fixture(), baseline = analyze(raw);
  raw.ArmoryEquipment.find(item => item.Type === '반지').Tooltip = tooltip({ '기본 효과': '민첩 +0' });
  const noSection = analyze(raw); assert.equal(noSection.status, 'ok'); assert.equal(noSection.score, baseline.score);
  assert.ok(noSection.assumptions.includes('연마 효과 절이 없는 악세서리는 연마 효과 없음으로 계산했습니다.'));
  raw.ArmoryEquipment.find(item => item.Type === '목걸이').Tooltip = tooltip({ '기본 효과': '민첩 +0', '연마 효과': '적에게 주는 피해 +0.54%<BR>치명타 적중률 +0.42%<BR>치명타 피해 +2.30%' });
  const outside = analyze(raw); assert.equal(outside.status, 'ok'); assert.equal(outside.diagnostics.factors.accessories, 1.0083375);
  assert.ok(outside.assumptions.includes("연마 효과 '적에게 주는 피해 +0.54%'은 환산 표에 없어 반영하지 않았습니다."));
  assert.ok(outside.assumptions.includes("연마 효과 '치명타 적중률 +0.42%'은 환산 표에 없어 반영하지 않았습니다."));
  assert.ok(!outside.assumptions.some(line => line.includes("'치명타 피해 +2.30%'")));
  raw.ArmoryEquipment.find(item => item.Type === '목걸이').Tooltip = tooltip({ '기본 효과': '민첩 +0', '연마 효과': '적에게 주는 피해 +abc%' });
  assert.equal(analyze(raw).status, 'unavailable');
  raw.ArmoryEquipment.find(item => item.Type === '목걸이').Tooltip = JSON.stringify({ a: box('연마 효과', ''), b: box('연마 효과', '') });
  assert.equal(analyze(raw).status, 'unavailable');
});
test('a missing or null engraving block is no engraving while a block without an array still fails', () => {
  const raw = fixture(), expected = analyze(raw); assert.equal(expected.status, 'ok'); assert.deepEqual(raw.ArmoryEngraving.ArkPassiveEffects, []);
  raw.ArmoryEngraving = null; const nulled = analyze(raw); assert.equal(nulled.status, 'ok'); assert.equal(nulled.score, expected.score);
  delete raw.ArmoryEngraving; assert.equal(analyze(raw).score, expected.score);
  for (const block of [{}, { ArkPassiveEffects: null }, { ArkPassiveEffects: 'none' }]) { raw.ArmoryEngraving = block; assert.equal(analyze(raw).status, 'unavailable', JSON.stringify(block)); }
});
