import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { formatEquipmentSummary } from '../src/kakao/equipment-summary.js';

const equipment = [
  ['무기', 25, 100], ['투구', 21, 99], ['상의', 21, 100],
  ['하의', 21, 94], ['장갑', 21, 100], ['어깨', 21, 94],
].map(([Type, level, qualityValue]) => ({ Type, Grade: '고대', Name: `+${level} 장비 이름`,
  Tooltip: JSON.stringify({ quality: { value: { qualityValue } } }) }));
equipment.push({ Type: '완갑', Grade: '유물', Name: '+20 완갑 이름',
  Tooltip: JSON.stringify({ quality: { value: { qualityValue: 1 } } }) });
equipment.push({ Type: '보주', Grade: '고대', Name: '보주',
  Tooltip: JSON.stringify({ text: '<FONT>낙원력 : 36,007,252</FONT>' }) });

const profile = {
  CharacterName: '합성캐릭터1', CharacterClassName: '인파이터', ItemAvgLevel: '1,783.33',
  CharacterLevel: 70, ExpeditionLevel: 328, CombatPower: '8,059.40',
  ServerName: '루페온', GuildName: '포근해', UsingSkillPoint: 482, TotalSkillPoint: 483,
  Stats: [{ Type: '치명', Value: '1373' }, { Type: '신속', Value: '1128' },
    { Type: '공격력', Value: '253853' }, { Type: '최대 생명력', Value: '410578' }],
};
const armory = { ArmoryProfile: profile, ArmoryEquipment: equipment,
  ArmoryEngraving: { ArkPassiveEffects: [
    { Name: '원한', Level: 4 }, { Name: '아드레날린', Level: 4, AbilityStoneLevel: 1 },
    { Name: '기습의 대가', Level: 4 }, { Name: '저주받은 인형', Level: 4, AbilityStoneLevel: 4 },
    { Name: '돌격대장', Level: 4 },
  ] }, ArmoryCard: { Effects: [{ Items: [{ Name: '세상을 구하는 빛 6세트 (30각성합계)' }] }] } };
const collectibles = [
  ['섬의 마음', 84], ['위대한 미술품', 59], ['거인의 심장', 15], ['오르페우스의 별', 10],
  ['세계수의 잎', 92], ['항해 모험물', 41], ['이그네아의 징표', 12], ['모코코 씨앗', 1080],
  ['기억의 오르골', 20], ['해도', 2], ['환영석', 12],
].map(([Type, Point]) => ({ Type, Point }));
const requested = [];
globalThis.__infoFixture = { armory, collectibles, ark: { Points: [
  { Name: '진화', Value: 140 }, { Name: '깨달음', Value: 101 }, { Name: '도약', Value: 70 },
] }, requested };
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/src/lostark.js')) return { shortCircuit: true, format: 'module', source: `
    export const getArmory = async name => { globalThis.__infoFixture.requested.push('armory'); return globalThis.__infoFixture.armory; };
    export const getArmoryPart = async (name, part) => {
      globalThis.__infoFixture.requested.push(part);
      if (part === 'arkpassive') return globalThis.__infoFixture.ark;
      if (part === 'collectibles') return globalThis.__infoFixture.collectibles;
      throw Error('Unexpected additional API request');
    };` };
  if (url.endsWith('/src/user-store.js')) return { shortCircuit: true, format: 'module', source: `
    export const resolveCharacter = interaction => interaction.options.getString('닉네임');
    export const NO_CHARACTER_HINT = '캐릭터를 지정해 주세요.';` };
  return nextLoad(url, context);
} });
const { execute } = await import('../src/commands/info.js');
function interaction(platform = 'kakao', name = '합성캐릭터1') {
  const payloads = [];
  return { platform, payloads, options: { getString: () => name },
    async deferReply() {}, async editReply(value) { payloads[0] = value; },
    async reply(value) { payloads[0] = value; }, async followUp(value) { payloads.push(value); } };
}

const expectedEquipment = `❙ 합성캐릭터1님의 장비 정보

고대 무기 +25: 100
고대 투구 +21: 99
고대 상의 +21: 100
고대 하의 +21: 94
고대 장갑 +21: 100
고대 어깨 +21: 94
유물 완갑 +20

• 아이템 레벨: 1,783.33
• 평균 품질: 97.83`;

test('Kakao info retains the requested fields and adds equipment without another API call', async () => {
  requested.length = 0;
  const i = interaction(); await execute(i);
  assert.equal(i.payloads.length, 2);
  const first = i.payloads[0];
  assert.equal(first.characterCard, '합성캐릭터1');
  assert.equal(first.kakaoPreserveWhitespace, true);
  assert.deepEqual(first.content.split('\n\n')[0].split('\n'), [
    '💠 4,1돌 오우너', '원한(4) 아드(4,1) 기습(4) 저받(4,4) 돌대(4)',
    '세상을 구하는 빛 6세트 (30각성합계)',
  ]);
  assert.equal(first.content.split('\n\n')[1].replace(/ {2,}/g, ' '),
    '템/전/원 1783/70/328\n진/깨/도 140/101/70\n전투력 8,059.40\n낙원력 36,007,252\n서버/길드 루페온/포근해\n전투특성 치:1373 신:1128\n스킬포인트 482/483\n공격력/체력 253853 / 410578');
  assert.equal(first.content.split('\n\n')[2],
    '섬마:84 미술품:59 거심:15 별:10 잎:92 모험물:41 징표:12 모코코:1080 오르골:20 해도:2 환영석:12');
  assert.equal(i.payloads[1].content, expectedEquipment);
  assert.equal(i.payloads[1].kakaoSeparateMessage, true);
  assert.deepEqual(requested.sort(), ['arkpassive', 'armory', 'collectibles']);
});

test('equipment order is stable and auxiliary quality is excluded from the average', () => {
  assert.equal(formatEquipmentSummary(profile, equipment.toReversed()), expectedEquipment);
});

test('missing or invalid quality is not turned into zero or a complete average', () => {
  for (const value of [-1, 101, '99', null]) {
    const changed = structuredClone(equipment);
    changed[0].Tooltip = JSON.stringify({ q: { value: { qualityValue: value } } });
    const result = formatEquipmentSummary(profile, changed);
    assert.match(result, /고대 무기 \+25\n/);
    assert.match(result, /평균 품질: 확인 불가$/);
  }
  for (const tooltip of ['{malformed', 'null', null]) {
    const changed = structuredClone(equipment); changed[0].Tooltip = tooltip;
    assert.match(formatEquipmentSummary(profile, changed), /평균 품질: 확인 불가$/);
  }
  assert.match(formatEquipmentSummary(profile, [equipment[0]]), /평균 품질: 확인 불가$/);
});

test('quality zero and refinement zero are valid and names do not leak into the compact list', () => {
  const item = { Type: '무기', Grade: '유물', Name: '<FONT>+0 테스트 무기</FONT>',
    Tooltip: JSON.stringify({ q: { value: { qualityValue: 0 } } }) };
  assert.match(formatEquipmentSummary(profile, [item]), /유물 무기 \+0: 0\n\n/);
  const allZero = equipment.slice(0, 6).map(e => ({ ...e, Tooltip: item.Tooltip }));
  assert.match(formatEquipmentSummary(profile, allZero), /평균 품질: 0\.00$/);
  assert.doesNotMatch(formatEquipmentSummary(profile, [item]), /테스트 무기/);
});

test('missing equipment and item level are described without fabricated values', () => {
  const result = formatEquipmentSummary({ CharacterName: '다른캐릭터' }, null);
  assert.match(result, /^❙ 다른캐릭터님의 장비 정보/);
  assert.match(result, /장착한 장비 정보가 없습니다./);
  assert.match(result, /아이템 레벨: 확인 불가\n• 평균 품질: 확인 불가$/);
});

test('Discord retains one embed response without the Kakao equipment follow-up', async () => {
  const i = interaction('discord'); await execute(i);
  assert.equal(i.payloads.length, 1);
  assert.equal(i.payloads[0].embeds[0].data.title, '합성캐릭터1 — 인파이터');
  assert.match(i.payloads[0].embeds[0].data.description, /```\n템\/전\/원/);
  assert.equal(i.payloads[0].kakaoSeparateMessage, undefined);
});

test('missing character produces one existing error reply without an equipment message', async () => {
  const previous = globalThis.__infoFixture.armory;
  globalThis.__infoFixture.armory = null;
  try {
    const i = interaction(); await execute(i);
    assert.equal(i.payloads.length, 1); assert.match(i.payloads[0], /캐릭터를 찾을 수 없어요/);
  } finally { globalThis.__infoFixture.armory = previous; }
});
