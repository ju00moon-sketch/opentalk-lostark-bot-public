import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArkgridGemTarget } from '../src/arkgrid-gem-target.js';
import { mapCharacterSpecData } from '../web/src/character-spec-data.js';

function fixture({ type = '질서', subtype = '안정', grade = '고대', efficiency = 5, corePoints = 5, levels = [5, 5], base } = {}) {
  const group = ['견고', '왜곡'].includes(subtype) ? 1 : ['불변', '붕괴'].includes(subtype) ? 2 : 0;
  base ??= 8 + group;
  const names = [['공격력', '추가 피해'], ['공격력', '보스 피해'], ['추가 피해', '보스 피해']][group];
  const points = efficiency + corePoints + levels[0] + levels[1];
  const data = {
    Element_000: { type: 'NameTagBox', value: `<FONT>${type}의 젬 : ${subtype}</FONT>` },
    Element_002: { type: 'SingleTextBox', value: '가공 완료' },
    Element_003: { type: 'SingleTextBox', value: '거래 불가' },
    Element_004: { type: 'ItemPartBox', value: { Element_000: '젬 기본 정보', Element_001: `젬 타입 : ${type}<BR>젬 포인트 : <FONT>${points}</FONT>` } },
    Element_005: { type: 'ItemPartBox', value: { Element_000: '젬 효과', Element_001:
      `<img src='emoticon_arkgrid_willpower' width='20'></img>필요 의지력 : ${base - efficiency} (기본 값 ${base} – 의지력 효율 ${efficiency})<BR><img src='emoticon_arkgrid_corepoint'></img>${type} 포인트 : ${corePoints}<BR>[${names[0]}] Lv.${levels[0]}<BR>${names[0]} +1.00%<BR>[${names[1]}] Lv.${levels[1]}<BR>${names[1]} +1.00%` } },
    Element_006: null,
    Element_007: { type: 'Progress', value: null },
    Element_010: { type: 'SingleTextBox', value: '[젬 가공] 아크 그리드 젬<BR>[젬 융합] 가공 완료 젬' },
  };
  return { Index: 0, Icon: 'https://cdn-lostark.game.onstove.com/efui_iconatlas/use/use_13_202.png', IsActive: true, Grade: grade, Tooltip: JSON.stringify(data) };
}
function change(gem, action) { const tip = JSON.parse(gem.Tooltip); action(tip); return { ...gem, Tooltip: JSON.stringify(tip) }; }
function rejected(gem, reason) {
  const result = parseArkgridGemTarget(gem);
  assert.deepEqual(Object.keys(result).sort(), ['reason', 'status']);
  assert.equal(result.status, 'unavailable');
  if (reason) assert.equal(result.reason, reason);
}

test('completed official labels yield a canonical target without processing cost or history guesses', () => {
  const gem = fixture(), before = structuredClone(gem), result = parseArkgridGemTarget(gem);
  assert.equal(result.status, 'ok'); assert.equal(result.source, 'official-arkgrid-gem-tooltip');
  assert.equal(result.name, '질서의 젬 : 안정'); assert.equal(result.type, 'order'); assert.equal(result.typeName, '질서');
  assert.equal(result.subtype, '안정'); assert.equal(result.grade, '고대'); assert.equal(result.completed, true);
  assert.equal(result.points, 20); assert.equal(result.corePoints, 5); assert.equal(result.willpower, 3);
  assert.equal(result.baseWillpower, 8); assert.equal(result.willpowerEfficiency, 5);
  assert.deepEqual(result.options, [{ name: '공격력', level: 5 }, { name: '추가 피해', level: 5 }]);
  assert.match(result.targetKey, /^[0-9a-f]{64}$/);
  for (const field of ['processingCost', 'processingGold', 'remainingAttempts', 'usedResets']) assert.equal(Object.hasOwn(result, field), false);
  assert.deepEqual(gem, before);
});

test('all six observed identities and completed rarity boundaries are supported', () => {
  for (const [type, subtypes] of [['질서', ['안정', '견고', '불변']], ['혼돈', ['침식', '왜곡', '붕괴']]]) {
    for (const subtype of subtypes) assert.equal(parseArkgridGemTarget(fixture({ type, subtype })).status, 'ok');
  }
  for (const options of [
    { grade: '전설', efficiency: 1, corePoints: 1, levels: [1, 1] },
    { grade: '전설', efficiency: 4, corePoints: 4, levels: [4, 3] },
    { grade: '유물', efficiency: 4, corePoints: 4, levels: [4, 4] },
    { grade: '유물', efficiency: 5, corePoints: 5, levels: [4, 4] },
    { grade: '고대', efficiency: 5, corePoints: 5, levels: [5, 4] },
  ]) assert.equal(parseArkgridGemTarget(fixture(options)).status, 'ok');
  for (const Grade of ['영웅', '희귀', '', null, 5, ['고대'], new String('고대'), { toString: () => '고대' }]) rejected({ ...fixture(), Grade }, 'invalid_gem_grade');
});

test('activation, socket identity, formatting and option order do not change the target fingerprint', () => {
  const one = fixture(), two = change({ ...one, Index: 3, IsActive: false }, tip => {
    const part = tip.Element_005.value.Element_001;
    tip.Element_005.value.Element_001 = part.replace('[공격력] Lv.5', '[추가 피해] Lv.5').replace(/\[추가 피해\] Lv\.5(?=<BR>추가 피해)/, '[공격력] Lv.5');
    tip.Element_004.value.Element_000 = '<FONT>젬 기본 정보</FONT>';
  });
  assert.equal(parseArkgridGemTarget(one).targetKey, parseArkgridGemTarget(two).targetKey);
  assert.notEqual(parseArkgridGemTarget(one).targetKey, parseArkgridGemTarget(fixture({ levels: [5, 4] })).targetKey);
});

test('completion requires exactly one dedicated label and cannot be inferred from instructions or activation', () => {
  rejected(change(fixture(), tip => { delete tip.Element_002; }), 'completion_unverified');
  rejected(change(fixture(), tip => { tip.Element_002.value = '가공 진행 중'; }), 'completion_unverified');
  rejected(change(fixture(), tip => { tip.Extra = structuredClone(tip.Element_002); }), 'ambiguous_tooltip');
  rejected(change(fixture(), tip => { tip.Element_002.value = '가공 완료 예정'; }), 'completion_unverified');
  assert.equal(parseArkgridGemTarget({ ...fixture(), IsActive: false }).status, 'ok');
});

test('missing and duplicate labelled sections, fields, and decoded JSON keys fail closed', () => {
  for (const key of ['Element_000', 'Element_004', 'Element_005']) {
    rejected(change(fixture(), tip => { delete tip[key]; }));
    rejected(change(fixture(), tip => { tip.Extra = structuredClone(tip[key]); }));
  }
  rejected(change(fixture(), tip => { tip.Element_004.value.Element_001 += '<BR>젬 타입 : 질서'; }));
  rejected(change(fixture(), tip => { tip.Element_004.value.Element_001 += '<BR>젬 포인트 : 20'; }));
  rejected(change(fixture(), tip => { tip.Element_005.value.Element_001 += '<BR>질서 포인트 : 5'; }));
  const gem = fixture();
  rejected({ ...gem, Tooltip: gem.Tooltip.replace('"IndexDoesNotExist":0', '').replace('"Element_000":', '"Element_000":null,"Element_000":') }, 'ambiguous_tooltip');
  rejected({ ...gem, Tooltip: gem.Tooltip.replace('"Element_000":', '"Element_000":null,"\\u0045lement_000":') }, 'ambiguous_tooltip');
});

test('type, subtype, points, willpower and rarity inconsistencies cannot become a target', () => {
  rejected(fixture({ type: '질서', subtype: '침식' }), 'invalid_gem_identity');
  rejected(change(fixture(), tip => { tip.Element_004.value.Element_001 = tip.Element_004.value.Element_001.replace('젬 타입 : 질서', '젬 타입 : 혼돈'); }), 'inconsistent_gem_target');
  rejected(change(fixture(), tip => { tip.Element_005.value.Element_001 = tip.Element_005.value.Element_001.replace('질서 포인트', '혼돈 포인트'); }), 'inconsistent_gem_target');
  rejected(change(fixture(), tip => { tip.Element_005.value.Element_001 = tip.Element_005.value.Element_001.replace('필요 의지력 : 3', '필요 의지력 : 4'); }), 'inconsistent_gem_target');
  rejected(fixture({ base: 9 }), 'inconsistent_gem_target');
  rejected({ ...fixture(), Grade: '전설' }, 'inconsistent_gem_target');
  rejected(change(fixture(), tip => { tip.Element_004.value.Element_001 = tip.Element_004.value.Element_001.replace('20', '19'); }), 'inconsistent_gem_target');
  for (const token of ['0', '6', '-1', '1.5', '05', '50000']) {
    rejected(change(fixture(), tip => { tip.Element_005.value.Element_001 = tip.Element_005.value.Element_001.replace('질서 포인트 : 5', `질서 포인트 : ${token}`); }));
    rejected(change(fixture(), tip => { tip.Element_005.value.Element_001 = tip.Element_005.value.Element_001.replace('효율 5', `효율 ${token}`); }));
  }
});

test('two distinct known option levels are required, not summed grid effect descriptions', () => {
  for (const replacement of ['[공격력] Lv.5', '[미지 효과] Lv.5', '[추가 피해] Lv.0', '[추가 피해] Lv.6', '[추가 피해] Lv.1.5', '추가 피해 +1.00%']) {
    rejected(change(fixture(), tip => { tip.Element_005.value.Element_001 = tip.Element_005.value.Element_001.replace('[추가 피해] Lv.5', replacement); }), 'invalid_gem_options');
  }
  rejected(change(fixture(), tip => { tip.Element_005.value.Element_001 += '<BR>[낙인력] Lv.5'; }), 'invalid_gem_options');
  rejected(change(fixture(), tip => { tip.Element_005.value.Element_001 = tip.Element_005.value.Element_001.replace('[추가 피해] Lv.5', '[보스 피해] Lv.5'); }), 'invalid_gem_options');
});

test('malformed, excessive and hostile inputs are bounded and never echoed in errors', () => {
  for (const gem of [null, [], 1, {}, { ...fixture(), Tooltip: 'null' }, { ...fixture(), Tooltip: 'not json' },
    { ...fixture(), Tooltip: ' '.repeat(131073) }, { ...fixture(), Tooltip: JSON.stringify({ value: null }) }]) rejected(gem);
  rejected(Object.defineProperty({}, 'Grade', { get() { throw null; } }));
  for (const text of ['<script>secret()</script>가공 완료', '&lt;script&gt;secret()&lt;/script&gt;가공 완료', '가공\u200b 완료', '<'.repeat(16000), '\ud800']) {
    const result = parseArkgridGemTarget(change(fixture(), tip => { tip.Element_002.value = text; }));
    assert.equal(result.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(result), /secret|script|ud800/);
  }
  rejected(change(fixture(), tip => { tip.Extra = JSON.parse('['.repeat(34) + '0' + ']'.repeat(34)); }));
});

test('display mapper adds a target per gem and preserves existing display fields when target parsing fails', () => {
  const good = fixture(), bad = change(fixture(), tip => { delete tip.Element_002; });
  const grid = mapCharacterSpecData({ arkgrid: { Slots: [{ Index: 0, Name: '질서의 해 코어', Grade: '고대', Point: 20, Tooltip: '{}', Gems: [good, { ...bad, Index: 1 }] }], Effects: [] } }).arkgrid;
  assert.equal(grid.cores[0].gems[0].target.status, 'ok');
  const failed = grid.cores[0].gems[1];
  assert.equal(failed.target.status, 'unavailable'); assert.equal(failed.name, '질서의 젬 : 안정');
  assert.equal(failed.points, 20); assert.equal(failed.corePoints, 5); assert.equal(failed.willpower, 3);
});
