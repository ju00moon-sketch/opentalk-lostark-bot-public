import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBraceletAttackContext as calculate } from '../src/bracelet-attack-context.js';

function tip(parts, other = {}) {
  return JSON.stringify({ ...Object.fromEntries(Object.entries(parts).map(([title, content], i) => [
    `Element_${i}`, { type: 'ItemPartBox', value: { Element_000: `<FONT>${title}</FONT>`, Element_001: content } },
  ])), ...other });
}
function item(Type, parts, other) { return { Type, Tooltip: tip(parts, other) }; }
function fixture() {
  return {
    ArmoryEquipment: [
      item('무기', { '기본 효과': '무기 공격력 +229737' }),
      ...[['투구', 120150], ['상의', 96120], ['하의', 106441], ['장갑', 147786], ['어깨', 127874]]
        .map(([type, value]) => item(type, { '기본 효과': `민첩 +${value}<BR>체력 +3000` })),
      item('완갑', { '기본 효과': '무기 공격력 +10969<BR>민첩 +28608<BR>기본 공격력 +850' }),
      ...[['목걸이', 17831, '적에게 주는 피해 +2.00%'],
        ['귀걸이', 12473, '무기 공격력 +3.00%<BR>공격력 +0.40%'],
        ['귀걸이', 12994, '무기 공격력 +1.80%<BR>공격력 +0.95%'],
        ['반지', 12259, '치명타 적중률 +1.55%'], ['반지', 12743, '치명타 피해 +2.40%']]
        .map(([type, value, effect]) => item(type, { '기본 효과': `힘 +${value}<BR>민첩 +${value}<BR>지능 +${value}`, '연마 효과': effect })),
      item('팔찌', { '팔찌 효과': '치명 +83<BR>특화 +90<BR>민첩 +14912<BR>치명타 피해가 8.4% 증가한다.' }),
      item('어빌리티 스톤', { '기본 효과': '체력 +7000' }, {
        Element_stone: { type: 'IndentStringGroup', value: { a: { contentStr: { a: { contentStr: '[레벨 보너스] 기본 공격력 +1.50%' } } } } },
      }),
    ],
    ArmoryAvatars: [
      ...[['무기 아바타', 2], ['머리 아바타', 2], ['상의 아바타', 1], ['하의 아바타', 1]]
        .map(([Type, value]) => ({ Type, IsInner: false, Tooltip: tip({ '기본 효과': `민첩 +${value}.00%` }) })),
      { Type: '무기 아바타', IsInner: false, Tooltip: tip({ '기본 효과': '민첩 +1.00%' },
        { warning: { type: 'SingleTextBox', value: '아래 능력들이 적용되지 않는 상태입니다. (덧입기 슬롯에 착용 중)' } }) },
    ],
    ArmoryGem: { Gems: [{ Slot: 0 }], Effects: { Description: '<FONT>기본 공격력 총합 : 6.60%</FONT>' } },
    ArmoryEngraving: { ArkPassiveEffects: [{ Name: '아드레날린', Grade: '유물', Level: 4, AbilityStoneLevel: 3 }] },
    ArkPassive: { Points: [{ Name: '깨달음', Description: '6랭크 28레벨' }] },
    ArkGrid: {
      Slots: [{ Name: '혼돈의 별 코어 : 공격', Point: 20, Tooltip: tip({ '코어 옵션':
        '[10P] 공격력이 900 증가한다.<BR>[14P] 공격력이 0.55% 증가한다.<BR>'
        + '[17P] 공격력이 1.10% 증가하고, 추가로 1800 증가한다.<BR>'
        + '[18P] 공격력이 0.16% 증가한다.<BR>[19P] 공격력이 0.16% 증가한다.<BR>[20P] 공격력이 0.16% 증가한다.' }) }],
      Effects: [{ Name: '공격력', Tooltip: "공격력 <font color='#ffd200'>+1.83%</font>" }],
    },
  };
}
function replaceBracelet(raw, content) {
  raw.ArmoryEquipment.find(item => item.Type === '팔찌').Tooltip = tip({ '팔찌 효과': content });
}

test('same-gear reference numbers retain all intermediate floors and rounding', () => {
  const result = calculate(fixture());
  assert.deepEqual(result.missing, []);
  assert.equal(result.without, 228299);
  assert.equal(result.with, 230688);
  const d = result.diagnostics;
  assert.equal(d.equipmentPrimary, 626979);
  assert.equal(d.accessoryPrimary, 68300); // Three primary labels in accessories count once.
  assert.equal(d.avatarPercent, 6); // Overlay does not add another one percent.
  assert.equal(d.weaponFlat, 240706);
  assert.equal(d.weaponMultiplier, 1.076);
  assert.deepEqual([d.P, d.M, d.H, d.G], [1.081, 2700, 1.0531, 1.1569]);
  assert.deepEqual(d.without, { primary: 743948, weapon: 258999, basic: 194637,
    normalAttack: 207816, inversePrimary: 743951, finalAttack: 228299 });
  assert.deepEqual(d.with, { primary: 759904, weapon: 258999, basic: 196703,
    normalAttack: 209991, inversePrimary: 759898, finalAttack: 230688 });
});

test('non-attack bracelet effects alone leave attack unchanged', () => {
  const raw = fixture();
  replaceBracelet(raw, '치명 +100<BR>특화 +90<BR>치명타 피해가 8.4% 증가한다.');
  const result = calculate(raw);
  assert.deepEqual(result.missing, []);
  assert.equal(result.with, result.without);
});

test('an explicitly unequipped bracelet has a neutral attack contribution', () => {
  const raw = fixture(); raw.ArmoryEquipment = raw.ArmoryEquipment.filter(item => item.Type !== '팔찌');
  const result = calculate(raw);
  assert.deepEqual(result.missing, []);
  assert.equal(result.without, 228299);
  assert.equal(result.with, result.without);
  assert.equal(result.diagnostics.normalAttackWithout, 207816);
});

test('conditional weapon has separate displayed and expected values', () => {
  const raw = fixture();
  replaceBracelet(raw, '민첩 +14912<BR>무기 공격력이 6300 증가한다.<BR>자신의 생명력이 50% 이상일 경우 적에게 공격 적중 시 5초 동안 무기 공격력이 1800 증가한다.');
  const result = calculate(raw);
  assert.deepEqual(result.missing, []);
  assert.equal(result.without, 228299);
  assert.deepEqual(result.diagnostics.bracelet, { primary: 14912, weaponOrigin: 6300, weaponExpected: 8100 });
  assert.equal(result.diagnostics.with.weapon, 267715);
  assert.equal(result.diagnostics.with.inversePrimary, 759757.72);
  assert.equal(result.diagnostics.braceletWeaponModel, 'expected-weapon-avatar');
  assert.ok(result.with > 230688);
});

test('slow stacks use average 8.5 and fast stacks use six, including coexistence', () => {
  const raw = fixture();
  replaceBracelet(raw, '무기 공격력이 6000 증가한다.<BR>공격 적중 시 30초마다 120초 동안 무기 공격력이 120 증가한다. (최대 30중첩)<BR>'
    + '공격 적중 시 매 초마다 10초 동안 무기 공격력이 1000, 공격 및 이동 속도가 1% 증가한다. (최대 6중첩)');
  const result = calculate(raw);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.diagnostics.bracelet, { primary: 0, weaponOrigin: 6000, weaponExpected: 13020 });
  assert.equal(result.diagnostics.model.slowWeaponAverageStacks, 8.5);
});

test('plain weapon values work while percentages and unfamiliar conditions fail closed', () => {
  for (const text of ['무기 공격력 +6300%', '무기 공격력이 6300 증가한다. 알 수 없는 조건']) {
    const raw = fixture(); replaceBracelet(raw, text);
    assert.ok(calculate(raw).missing.includes('bracelet.weaponOption'));
    assert.equal(calculate(raw).with, null);
  }
  const raw = fixture(); replaceBracelet(raw, '무기 공격력 +6300');
  assert.equal(calculate(raw).diagnostics.bracelet.weaponExpected, 6300);
});

test('core thresholds add only the active effects, and missing active tiers are not zero', () => {
  const raw = fixture(); raw.ArkGrid.Slots[0].Point = 14;
  let result = calculate(raw);
  assert.deepEqual(result.missing, []);
  assert.equal(result.diagnostics.cores.attackFlat, 900);
  assert.equal(result.diagnostics.cores.attackPercent, 0.55);
  raw.ArkGrid.Slots[0].Tooltip = tip({ '코어 옵션': '[10P] 공격력이 900 증가한다.' });
  result = calculate(raw);
  assert.ok(result.missing.includes('ArkGrid.coreEffect'));
  assert.equal(result.with, null);
});

test('weapon core percentage, vambrace flat and percent use different formula positions', () => {
  const raw = fixture();
  raw.ArkGrid.Slots = [{ Name: '혼돈의 별 코어 : 무기', Point: 14, Tooltip: tip({ '코어 옵션':
    '[10P] 무기 공격력이 1300 증가한다.<BR>[14P] 무기 공격력이 0.75% 증가한다.' }) }];
  const arm = raw.ArmoryEquipment.find(item => item.Type === '완갑');
  arm.Tooltip = tip({ '기본 효과': '민첩 +28608<BR>무기 공격력 +10969<BR>기본 공격력 +2030', '추가 효과': '기본 공격력 +1.00%' });
  const result = calculate(raw);
  assert.deepEqual(result.missing, []);
  assert.deepEqual([result.diagnostics.weaponFlat, result.diagnostics.weaponMultiplier, result.diagnostics.P], [242006, 1.0835, 1.091]);
  assert.equal(result.diagnostics.vambraceBaseFlat, 2030);
  assert.equal(result.diagnostics.M, 0);
});

test('null or missing API blocks never silently become an unbuffed calculation', () => {
  // A null or missing ArmoryEngraving is the official no-engraving form since 2026-09-18 and is covered separately.
  for (const key of ['ArmoryGem', 'ArkPassive', 'ArkGrid', 'ArmoryEquipment']) {
    for (const value of key === 'ArkGrid' ? [undefined, {}, { Slots: null }, { Slots: [] }] : [null, undefined]) {
      const raw = fixture(); raw[key] = value;
      const result = calculate(raw);
      assert.equal(result.without, null, key);
      assert.equal(result.with, null, key);
      assert.ok(result.missing.length, key);
    }
  }
});

test('explicit empty optional equipment sources are valid zeros', () => {
  const raw = fixture(); raw.ArmoryAvatars = []; raw.ArkGrid = { Slots: [], Effects: [] };
  raw.ArmoryGem = { Gems: [], Effects: null }; raw.ArmoryEngraving.ArkPassiveEffects = [];
  const result = calculate(raw);
  assert.deepEqual(result.missing, []);
  assert.equal(result.diagnostics.avatarPercent, 0);
  assert.equal(result.diagnostics.gemBasePercent, 0);
  assert.equal(result.diagnostics.engravingAttackPercent, 0);
  assert.ok(result.with > result.without);
});

test('official unequipped Gems:null requires explicitly empty effect data', () => {
  const raw = fixture(); raw.ArmoryGem = { Gems: null, Effects: { Description: '', Skills: [] } };
  assert.deepEqual(calculate(raw).missing, []);
  assert.equal(calculate(raw).diagnostics.gemBasePercent, 0);
  for (const Effects of [null, {}, { Description: '기본 공격력 총합 : 6.60%', Skills: [] }, { Description: '', Skills: [{}] }]) {
    raw.ArmoryGem = { Gems: null, Effects };
    assert.ok(calculate(raw).missing.includes('ArmoryGem'));
  }
  raw.ArmoryGem = { Gems: [], Effects: { Description: '기본 공격력 총합 : 6.60%', Skills: [] } };
  assert.ok(calculate(raw).missing.includes('ArmoryGem.emptyConflict'));
});

test('unknown karma, invalid engraving levels and malformed numbers do not produce plausible answers', () => {
  const cases = [
    raw => { raw.ArkPassive.Points[0].Description = 'abc'; },
    raw => { raw.ArkPassive.Points[0].Description = null; },
    raw => { raw.ArkPassive.Points[0].Description = '6랭크 31레벨'; },
    raw => { raw.ArmoryEngraving.ArkPassiveEffects[0].AbilityStoneLevel = 9; },
    raw => { raw.ArmoryGem.Effects.Description = '기본 공격력 총합 : NaN%'; },
    raw => { raw.ArmoryEquipment[0].Tooltip = tip({ '기본 효과': '무기 공격력 +99999999999' }); },
  ];
  for (const modify of cases) {
    const raw = fixture(); modify(raw);
    assert.equal(calculate(raw).with, null);
  }
});

test('numeric raw fields reject coercion and nonstandard comma groups', () => {
  for (const value of [null, '', [], {}, true, '1000,001', '01', '1e1', Infinity]) {
    const raw = fixture(); raw.ArkGrid.Slots[0].Point = value;
    assert.ok(calculate(raw).missing.includes('ArkGrid.corePoint'), String(value));
  }
  for (const value of ['1000,001', '1,00', '01', 'Infinity']) {
    const raw = fixture(); raw.ArmoryEquipment[0].Tooltip = tip({ '기본 효과': `무기 공격력 +${value}` });
    assert.equal(calculate(raw).with, null, value);
  }
});

test('Ether uses its average model contribution and adds stone once', () => {
  const raw = fixture();
  raw.ArmoryEngraving.ArkPassiveEffects = [{ Name: '에테르 포식자', Grade: '유물', Level: 4, AbilityStoneLevel: 2 }];
  const result = calculate(raw);
  assert.deepEqual(result.missing, []);
  assert.equal(result.diagnostics.engravingAttackPercent, 18.09);
});

test('duplicate active avatars, weapon slots and attack aggregates fail closed', () => {
  const cases = [
    raw => raw.ArmoryAvatars.push(raw.ArmoryAvatars[0]),
    raw => raw.ArmoryEquipment.push(raw.ArmoryEquipment[0]),
    raw => raw.ArkGrid.Effects.push(raw.ArkGrid.Effects[0]),
  ];
  for (const modify of cases) { const raw = fixture(); modify(raw); assert.equal(calculate(raw).with, null); }
});

test('HTML display tags and comma grouping do not affect the numeric facts', () => {
  const raw = fixture();
  raw.ArmoryEquipment[0].Tooltip = tip({ '기본 효과': '<FONT color="#abc">무기 공격력</FONT> +229,737' });
  replaceBracelet(raw, '<FONT>민첩</FONT> +14,912<BR>치명 +83');
  assert.equal(calculate(raw).with, 230688);
});

test('parser is bounded, deterministic, and leaves official input untouched', () => {
  const raw = fixture(); const before = JSON.stringify(raw);
  assert.deepEqual(calculate(raw), calculate(raw));
  assert.equal(JSON.stringify(raw), before);
  raw.ArmoryEquipment[0].Tooltip = ' '.repeat(160_001);
  assert.ok(calculate(raw).missing.includes('equipment[0].tooltip'));
});

test('tier-3 gems without a base attack option count as a known 0% instead of a missing value', () => {
  const raw = fixture();
  raw.ArmoryGem = { Gems: [{ Slot: 0, Level: 7, Grade: '전설' }], Effects: { Description: '', Skills: [{ GemSlot: 0, Name: '블레이즈', Description: ['피해 21.00% 증가'], Option: '' }] } };
  const result = calculate(raw);
  assert.deepEqual(result.missing, []); assert.equal(result.diagnostics.gemBasePercent, 0);
  // An empty summary next to a gem that does grant base attack is still inconsistent data.
  raw.ArmoryGem.Effects.Skills[0].Option = '기본 공격력 1.20% 증가';
  assert.ok(calculate(raw).missing.includes('ArmoryGem.baseAttackPercent'));
});

// Official input forms accepted on 2026-09-18 (roster scan of 221 characters).
test('official null grid collections equal an empty grid while a half-missing grid stays unresolved', () => {
  const empty = fixture(); empty.ArkGrid = { Slots: [], Effects: [] };
  const expected = calculate(empty);
  assert.deepEqual(expected.missing, []);
  for (const grid of [null, { Slots: null, Effects: null }]) {
    const raw = fixture(); raw.ArkGrid = grid;
    const before = JSON.stringify(raw);
    assert.deepEqual(calculate(raw), expected, JSON.stringify(grid));
    assert.equal(JSON.stringify(raw), before);
  }
  const cores = fixture(); cores.ArkGrid.Effects = null;
  const withCores = fixture(); withCores.ArkGrid.Effects = [];
  assert.deepEqual(calculate(cores), calculate(withCores));
  assert.equal(calculate(cores).diagnostics.cores.attackFlat, 2700);
  assert.deepEqual(calculate(cores).missing, []);
});

test('an absent or null avatar block is a known zero percent while other shapes stay unresolved', () => {
  const none = fixture(); none.ArmoryAvatars = [];
  const expected = calculate(none);
  assert.deepEqual(expected.missing, []); assert.equal(expected.diagnostics.avatarPercent, 0);
  for (const value of [null, undefined]) {
    const raw = fixture(); if (value === undefined) delete raw.ArmoryAvatars; else raw.ArmoryAvatars = value;
    assert.deepEqual(calculate(raw), expected, String(value));
  }
  for (const value of [{}, 'none', 0, Array(31).fill({ Type: '무기 아바타' })]) {
    const raw = fixture(); raw.ArmoryAvatars = value;
    assert.ok(calculate(raw).missing.includes('ArmoryAvatars'), String(value));
  }
});

test('an unopened karma description is level zero and only the weapon multiplier changes', () => {
  for (const description of ['', '미개방', ' <FONT></FONT> ']) {
    const raw = fixture(); raw.ArkPassive.Points[0].Description = description;
    const result = calculate(raw);
    assert.deepEqual(result.missing, [], description);
    assert.equal(result.diagnostics.karmaLevel, 0);
    assert.equal(result.diagnostics.weaponMultiplier, 1.048);
  }
});

test('the ability stone reduction line is skipped while graded engravings keep their rules', () => {
  const raw = fixture(), baseline = calculate(fixture());
  raw.ArmoryEngraving.ArkPassiveEffects.push({ Name: '방어력 감소', Grade: '', Level: 0, AbilityStoneLevel: -1 });
  raw.ArmoryEngraving.ArkPassiveEffects.push({ Name: '공격 속도 감소', Grade: '', Level: 0, AbilityStoneLevel: null });
  assert.deepEqual(calculate(raw), baseline);
  raw.ArmoryEngraving.ArkPassiveEffects = [{ Name: '아드레날린', Grade: '', Level: 0, AbilityStoneLevel: -1 }];
  assert.deepEqual(calculate(raw).diagnostics.engravingAttackPercent, 0);
  raw.ArmoryEngraving.ArkPassiveEffects = [{ Name: '아드레날린', Grade: '유물', Level: 0, AbilityStoneLevel: -1 }];
  assert.ok(calculate(raw).missing.includes('engraving.아드레날린'));
});

// Input forms accepted on 2026-09-18, second pass.
test('a missing or null engraving block is a known zero percent while a block without an array stays unresolved', () => {
  for (const value of [null, undefined]) {
    const raw = fixture(); if (value === undefined) delete raw.ArmoryEngraving; else raw.ArmoryEngraving = value;
    const result = calculate(raw); assert.deepEqual(result.missing, [], String(value)); assert.equal(result.diagnostics.engravingAttackPercent, 0); assert.ok(result.without > 0);
  }
  for (const block of [{}, { ArkPassiveEffects: null }]) { const raw = fixture(); raw.ArmoryEngraving = block; assert.ok(calculate(raw).missing.includes('ArmoryEngraving'), JSON.stringify(block)); }
});
