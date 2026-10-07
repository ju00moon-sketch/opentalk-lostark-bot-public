// Attack-only input for the bracelet model. All parsing is local and does not
// depend on the profile's displayed (buff/snapshot-dependent) attack value.
const ARMOR = new Set(['투구', '상의', '하의', '장갑', '어깨']);
const ACCESSORY = new Set(['목걸이', '귀걸이', '반지']);
const PRIMARY = ['힘', '민첩', '지능'];
const MAX_TOOLTIP = 160_000;
const NUMBER = '(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\\.[0-9]+)?';
const NUMBER_FORMAT = new RegExp(`^${NUMBER}$`);
const MODEL = Object.freeze({ petPrimaryPercent: 1, karmaWeaponPercentPerLevel: 0.1,
  slowWeaponAverageStacks: 8.5, fastWeaponStacks: 6 });

function plain(value) {
  return typeof value === 'string' ? value.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').trim() : '';
}
const compact = value => plain(value).replace(/\s/g, '');
function numeric(value, max = 10_000_000) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !NUMBER_FORMAT.test(value))) return null;
  const result = typeof value === 'number' ? value : Number(value.replace(/,/g, ''));
  return Number.isFinite(result) && result >= 0 && result <= max ? result : null;
}
function tooltip(raw, label, missing) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_TOOLTIP) {
    missing.add(`${label}.tooltip`); return {};
  }
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { missing.add(`${label}.tooltip`); return {}; }
}
function leaves(value, depth = 0) {
  if (depth > 12) return [];
  if (typeof value === 'string') return [plain(value)];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).slice(0, 100).flatMap(item => leaves(item, depth + 1));
}
function section(tip, name, label, missing, required = false) {
  const found = Object.values(tip).filter(part => part?.type === 'ItemPartBox'
    && compact(part.value?.Element_000) === name);
  if (found.length !== 1) {
    if (required || found.length > 1) missing.add(`${label}.${name}`);
    return [];
  }
  const content = found[0]?.value?.Element_001;
  if (typeof content !== 'string') { missing.add(`${label}.${name}`); return []; }
  return plain(content).split('\n').map(line => line.trim()).filter(Boolean);
}
function stat(lines, name, label, missing, { percent = false, required = false } = {}) {
  const re = new RegExp(`^${name}\\s*\\+(${NUMBER})${percent ? '%' : ''}$`);
  const matches = lines.map(line => re.exec(line)).filter(Boolean);
  if (matches.length > 1 || (!matches.length && required)) missing.add(`${label}.${name}`);
  if (!matches.length) {
    // The absence of an optional effect is zero; an unrecognizable present effect is not.
    if (lines.some(line => line.startsWith(name) && !new RegExp(`^${name}\\s*\\+${NUMBER}${percent ? '$' : '%$'}`).test(line))) {
      missing.add(`${label}.${name}`);
    }
    return 0;
  }
  const value = numeric(matches[0][1], percent ? 100 : 10_000_000);
  if (value === null) missing.add(`${label}.${name}`);
  return value ?? 0;
}

function braceletStats(lines, missing) {
  let text = compact(lines.join(''));
  const result = { primary: PRIMARY.reduce((sum, name) => sum + stat(lines, name, 'bracelet', missing), 0), weaponOrigin: 0, weaponExpected: 0 };
  if (!text.includes('무기공격력')) return result;
  // Multiple distinct weapon options can coexist. Consume complete supported
  // descriptions, then reject any remaining unrecognized weapon phrase.
  const patterns = [
    [/공격적중시매초마다10초동안무기공격력이(\d+),공격및이동속도가1%증가한다\.\(최대6중첩\)/g,
      a => [0, a * MODEL.fastWeaponStacks]],
    [/무기공격력이(\d+)증가한다\.자신의생명력이50%이상일경우적에게공격적중시5초동안무기공격력이(\d+)증가한다\./g,
      (a, b) => [a, a + b]],
    [/무기공격력이(\d+)증가한다\.공격적중시30초마다120초동안무기공격력이(\d+)증가한다\.\(최대30중첩\)/g,
      (a, b) => [a, a + b * MODEL.slowWeaponAverageStacks]],
    [/무기공격력\+(\d+)(?![\d.,%])/g, a => [a, a]],
  ];
  for (const [pattern, values] of patterns) {
    let count = 0;
    text = text.replace(pattern, (...args) => {
      const [origin, expected] = values(Number(args[1]), Number(args[2]));
      result.weaponOrigin += origin; result.weaponExpected += expected; count += 1;
      return '';
    });
    if (count > 1) missing.add('bracelet.duplicateWeaponOption');
  }
  if (text.includes('무기공격력')) missing.add('bracelet.weaponOption');
  if (numeric(result.weaponOrigin, 100_000) === null || numeric(result.weaponExpected, 100_000) === null) missing.add('bracelet.weaponOption');
  return result;
}

function avatarPercent(avatars, primary, missing) {
  // The official full armory response leaves the avatar block out entirely (the section endpoint answers null)
  // when no avatar is worn: both forms are a known 0% (2026-09-18). Any other non-array value stays unresolved.
  if (avatars === null || avatars === undefined) return 0;
  if (!Array.isArray(avatars) || avatars.length > 30) { missing.add('ArmoryAvatars'); return 0; }
  let total = 0;
  const activeTypes = new Set();
  for (const [index, avatar] of avatars.entries()) {
    if (!['무기 아바타', '머리 아바타', '상의 아바타', '하의 아바타'].includes(avatar?.Type)) continue;
    const label = `avatar[${index}]`;
    const tip = tooltip(avatar.Tooltip, label, missing);
    if (leaves(tip).some(line => /능력들이 적용되지 않는 상태|덧입기 슬롯에 착용 중/.test(line))) continue;
    if (activeTypes.has(avatar.Type)) missing.add(`avatar.duplicate.${avatar.Type}`);
    activeTypes.add(avatar.Type);
    const lines = section(tip, '기본효과', label, missing, true);
    total += stat(lines, primary, label, missing, { percent: true, required: true });
  }
  if (total > 20) missing.add('avatar.primaryPercent');
  return total;
}

function coreBonuses(grid, missing) {
  const result = { attackFlat: 0, attackPercent: 0, weaponFlat: 0, weaponPercent: 0, gemAttackPercent: 0 };
  // The grid arrives normalized: official null collections are already empty arrays.
  if (!grid || !Array.isArray(grid.Slots) || !Array.isArray(grid.Effects) || grid.Slots.length > 6 || grid.Effects.length > 30) {
    missing.add('ArkGrid'); return result;
  }
  const seen = new Set();
  for (const core of grid.Slots) {
    if (!['혼돈의 별 코어 : 공격', '혼돈의 별 코어 : 무기'].includes(core?.Name)) continue;
    if (seen.has(core.Name)) missing.add('ArkGrid.duplicateCore');
    seen.add(core.Name);
    const point = numeric(core.Point, 20);
    if (point === null || !Number.isInteger(point)) { missing.add('ArkGrid.corePoint'); continue; }
    const label = core.Name;
    const lines = section(tooltip(core.Tooltip, label, missing), '코어옵션', label, missing, true);
    const thresholds = new Set();
    const isWeapon = core.Name.endsWith('무기');
    for (const line of lines) {
      const hit = /^\[(\d+)P\]\s*(.+)$/.exec(line);
      if (!hit) { missing.add('ArkGrid.coreEffect'); continue; }
      const at = Number(hit[1]);
      if (thresholds.has(at)) missing.add('ArkGrid.duplicateThreshold');
      thresholds.add(at);
      if (at > point) continue;
      const re = new RegExp(`^${isWeapon ? '무기 ' : ''}공격력이 (${NUMBER})(%)? 증가(?:한다\\.|하고, 추가로 (${NUMBER}) 증가한다\\.)$`);
      const effect = re.exec(hit[2]);
      if (!effect) { missing.add('ArkGrid.coreEffect'); continue; }
      const value = numeric(effect[1], effect[2] ? 100 : 100_000);
      const extra = effect[3] ? numeric(effect[3], 100_000) : 0;
      if (value === null || extra === null) { missing.add('ArkGrid.coreEffect'); continue; }
      result[isWeapon ? 'weaponFlat' : 'attackFlat'] += (effect[2] ? 0 : value) + extra;
      result[isWeapon ? 'weaponPercent' : 'attackPercent'] += effect[2] ? value : 0;
    }
    if ([10, 14, 17, 18, 19, 20].some(at => at <= point && !thresholds.has(at))) missing.add('ArkGrid.coreEffect');
  }
  const effects = grid.Effects.filter(effect => effect?.Name === '공격력');
  if (effects.length > 1) missing.add('ArkGrid.duplicateAttackEffect');
  if (effects.length) {
    const match = new RegExp(`^공격력\\s*\\+(${NUMBER})%$`).exec(plain(effects[0].Tooltip));
    const value = match ? numeric(match[1], 100) : null;
    if (value === null) missing.add('ArkGrid.gemAttackPercent');
    else result.gemAttackPercent = value;
  }
  return result;
}

function gemBonus(gems, missing) {
  const explicitlyEmptyEffects = gems?.Effects && typeof gems.Effects.Description === 'string'
    && gems.Effects.Description.trim() === '' && Array.isArray(gems.Effects.Skills) && gems.Effects.Skills.length === 0;
  // The official API uses Gems:null for an unequipped character, accompanied
  // by an explicitly empty effect description and skill array.
  if (gems?.Gems === null && explicitlyEmptyEffects) return 0;
  if (!gems || !Array.isArray(gems.Gems) || gems.Gems.length > 20) { missing.add('ArmoryGem'); return 0; }
  if (!gems.Gems.length) {
    if (gems.Effects !== null && gems.Effects !== undefined && !explicitlyEmptyEffects) missing.add('ArmoryGem.emptyConflict');
    return 0;
  }
  const description = plain(gems.Effects?.Description);
  // Tier-3 gems carry no base attack option: the official summary is an empty description and every
  // skill effect has an empty Option. That is a known 0%, not a missing value.
  const skills = Array.isArray(gems.Effects?.Skills) ? gems.Effects.Skills : null;
  if (description.trim() === '' && skills && skills.length > 0 && skills.every(skill => (skill?.Option ?? '') === '')) return 0;
  const hit = /^기본 공격력 총합\s*:\s*([\d.]+)%$/.exec(description);
  const result = hit ? numeric(hit[1], 100) : null;
  if (result === null) missing.add('ArmoryGem.baseAttackPercent');
  return result ?? 0;
}

function engravingBonus(engravings, missing) {
  // The official full response omits the block, and an individual lookup returns null, when no engraving is
  // equipped: both are a known 0% (2026-09-18). A block whose list is not an array stays unresolved.
  if (engravings === undefined || engravings === null) return 0;
  if (!Array.isArray(engravings?.ArkPassiveEffects) || engravings.ArkPassiveEffects.length > 10) {
    missing.add('ArmoryEngraving'); return 0;
  }
  // Maximum Adrenaline stacks; Ether uses the reference model's average uptime.
  // Stone increments are additional to the grade/reading-level contribution.
  const ether = { 영웅: [10.08, 10.08, 10.08, 10.08], 전설: [11.34, 11.34, 11.34, 11.34],
    유물: [11.34, 12.15, 12.96, 13.77, 14.58] };
  const stoneAdrenaline = [0, 2.88, 3.6, 4.98, 5.7];
  const stoneEther = [0, 2.7, 3.51, 4.86, 5.4];
  const seen = new Set();
  let total = 0;
  for (const effect of engravings.ArkPassiveEffects) {
    if (isAbilityStoneReduction(effect)) continue;
    const name = compact(effect?.Name);
    if (name === '승부사' || name === '선수필승') {
      if (seen.has(name)) missing.add(`engraving.duplicate.${name}`);
      seen.add(name);
      const conditional = readConditionalBraceletEngraving(effect);
      if (!conditional) missing.add(`engraving.${name}`);
      else total += conditional.attackPercent;
      continue;
    }
    if (name !== '아드레날린' && name !== '에테르포식자') continue;
    if (seen.has(name)) missing.add(`engraving.duplicate.${name}`);
    seen.add(name);
    const level = effect.Level;
    const stone = effect.AbilityStoneLevel ?? 0;
    const grade = effect.Grade;
    if (!Number.isInteger(level) || !Number.isInteger(stone) || stone < 0 || stone > 4 || ether[grade]?.[level] === undefined) {
      missing.add(`engraving.${name}`); continue;
    }
    total += name === '아드레날린' ? 5.4 + stoneAdrenaline[stone] : ether[grade][level] + stoneEther[stone];
  }
  return total;
}

/** Return the attack numerator and denominator for the bracelet-only comparison.
 * Explicit model assumptions are included in diagnostics; absent API blocks
 * produce null results and stable missing keys instead of invented values.
 */
export function calculateBraceletAttackContext(raw) {
  raw = withNormalizedCores(raw);
  const missing = new Set();
  const diagnostics = { model: { ...MODEL } };
  const equipment = raw?.ArmoryEquipment;
  if (!Array.isArray(equipment) || equipment.length > 40) {
    return { without: null, with: null, diagnostics, missing: ['ArmoryEquipment'] };
  }
  const parsed = equipment.map((item, index) => {
    const label = `equipment[${index}]`;
    const tip = tooltip(item?.Tooltip, label, missing);
    return { item, label, tip, basic: section(tip, '기본효과', label, missing) };
  });
  const armor = parsed.filter(({ item }) => ARMOR.has(item?.Type));
  const primaryNames = new Set(armor.flatMap(({ basic }) => PRIMARY.filter(name => basic.some(line => new RegExp(`^${name} \\+`).test(line)))));
  if (primaryNames.size !== 1) missing.add('equipment.primaryType');
  const primary = [...primaryNames][0] ?? '힘';
  const weapon = parsed.filter(({ item }) => item?.Type === '무기');
  if (weapon.length !== 1) missing.add('equipment.weapon');
  const bangle = parsed.filter(({ item }) => item?.Type === '팔찌');
  // A complete equipment array can explicitly show no equipped bracelet.
  // Its attack contribution is then zero, which also permits gem comparisons.
  if (bangle.length > 1) missing.add('equipment.bracelet');
  const totals = { primaryType: primary, equipmentPrimary: 0, accessoryPrimary: 0,
    weaponBase: 0, accessoryWeaponFlat: 0, accessoryWeaponPercent: 0,
    accessoryAttackFlat: 0, accessoryAttackPercent: 0,
    vambraceWeaponFlat: 0, vambraceBaseFlat: 0, vambraceBasePercent: 0, stoneBasePercent: 0 };
  const unique = new Set();
  for (const { item, tip, basic, label } of parsed) {
    const type = item?.Type;
    if (ARMOR.has(type) || type === '완갑' || type === '무기' || type === '어빌리티 스톤') {
      if (unique.has(type)) missing.add(`equipment.duplicate.${type}`);
      unique.add(type);
    }
    if (ARMOR.has(type) || type === '완갑') totals.equipmentPrimary += stat(basic, primary, label, missing, { required: true });
    if (type === '무기') totals.weaponBase += stat(basic, '무기 공격력', label, missing, { required: true });
    if (type === '완갑') {
      totals.vambraceWeaponFlat += stat(basic, '무기 공격력', label, missing, { required: true });
      totals.vambraceBaseFlat += stat(basic, '기본 공격력', label, missing);
      totals.vambraceBasePercent += stat(section(tip, '추가효과', label, missing), '기본 공격력', label, missing, { percent: true });
    }
    if (ACCESSORY.has(type)) {
      totals.accessoryPrimary += stat(basic, primary, label, missing, { required: true });
      const options = section(tip, '연마효과', label, missing);
      totals.accessoryWeaponFlat += stat(options, '무기 공격력', label, missing);
      totals.accessoryWeaponPercent += stat(options, '무기 공격력', label, missing, { percent: true });
      totals.accessoryAttackFlat += stat(options, '공격력', label, missing);
      totals.accessoryAttackPercent += stat(options, '공격력', label, missing, { percent: true });
    }
    if (type === '어빌리티 스톤') {
      const candidates = leaves(tip).filter(line => line.includes('기본 공격력'));
      if (candidates.length > 1) missing.add('stone.duplicateBaseAttackPercent');
      if (candidates.length) {
        const hit = /(?:^|\]\s*)기본 공격력 \+([\d.]+)%$/.exec(candidates[0]);
        const value = hit ? numeric(hit[1], 100) : null;
        if (value === null) missing.add('stone.baseAttackPercent');
        else totals.stoneBasePercent = value;
      }
    }
  }
  const bracelet = bangle.length ? braceletStats(section(bangle[0].tip, '팔찌효과', 'bracelet', missing, true), missing)
    : { primary: 0, weaponOrigin: 0, weaponExpected: 0 };
  const avatar = avatarPercent(raw?.ArmoryAvatars, primary, missing);
  const points = raw?.ArkPassive?.Points;
  const karma = Array.isArray(points) ? points.filter(item => item?.Name === '깨달음') : [];
  // An empty or '미개방' official description means the karma track is not opened yet: level 0 (2026-09-18).
  const karmaText = karma.length === 1 && typeof karma[0].Description === 'string' ? plain(karma[0].Description) : null;
  const karmaMatch = karmaText === null ? null : /^\d+랭크 (\d+)레벨$/.exec(karmaText);
  const karmaLevel = isUnopenedKarma(karmaText) ? 0 : karmaMatch ? numeric(karmaMatch[1], 30) : null;
  if (karmaLevel === null) missing.add('ArkPassive.enlightenmentKarma');
  const cores = coreBonuses(raw?.ArkGrid, missing);
  const gemBasePercent = gemBonus(raw?.ArmoryGem, missing);
  const engravingAttackPercent = engravingBonus(raw?.ArmoryEngraving, missing);
  Object.assign(diagnostics, { ...totals, bracelet, avatarPercent: avatar, karmaLevel, cores, gemBasePercent, engravingAttackPercent });
  if (missing.size) return { without: null, with: null, diagnostics, missing: [...missing] };
  const weaponFlat = totals.weaponBase + totals.accessoryWeaponFlat + totals.vambraceWeaponFlat + cores.weaponFlat;
  const weaponMultiplier = 1 + (totals.accessoryWeaponPercent + karmaLevel * MODEL.karmaWeaponPercentPerLevel + cores.weaponPercent) / 100;
  const primaryBase = totals.equipmentPrimary + totals.accessoryPrimary;
  const primaryMultiplier = 1 + avatar / 100 + MODEL.petPrimaryPercent / 100;
  const P = 1 + (totals.stoneBasePercent + gemBasePercent + totals.vambraceBasePercent) / 100;
  const M = totals.accessoryAttackFlat + cores.attackFlat;
  const attackPercent = totals.accessoryAttackPercent + cores.attackPercent + cores.gemAttackPercent;
  const H = 1 + attackPercent / 100;
  const G = 1 + (attackPercent + engravingAttackPercent) / 100;
  const finalAttack = (primaryValue, weaponValue) => Math.floor(((Math.sqrt(primaryValue * weaponValue / 6)
    + totals.vambraceBaseFlat) * P + M) * G);
  function normalAndInvert(braceletPrimary, braceletWeapon) {
    const primaryValue = Math.floor((primaryBase + braceletPrimary) * primaryMultiplier);
    const weaponValue = Math.floor((weaponFlat + braceletWeapon) * weaponMultiplier);
    const basic = Math.floor((Math.sqrt(primaryValue * weaponValue / 6) + totals.vambraceBaseFlat) * P);
    const normalAttack = Math.round((basic + M) * H);
    const inversePrimary = Math.round(6 / weaponValue * Math.max(0, (normalAttack / H - M) / P - totals.vambraceBaseFlat) ** 2);
    return { primary: primaryValue, weapon: weaponValue, basic, normalAttack, inversePrimary,
      finalAttack: finalAttack(inversePrimary, weaponValue) };
  }
  if (!(weaponFlat > 0 && primaryBase > 0)) return { without: null, with: null, diagnostics, missing: ['equipment.attackInputs'] };
  const without = normalAndInvert(0, 0);
  let withBracelet;
  if (bracelet.weaponExpected > 0) {
    // This bonus path deliberately uses the avatar multiplier only; the normal
    // baseline already contains pet stats. Re-applying the pet factor differs
    // from the comparison model for weapon-option bracelets.
    const avatarMultiplier = 1 + avatar / 100;
    const inversePrimary = (without.inversePrimary / avatarMultiplier + bracelet.primary) * avatarMultiplier;
    const weaponValue = Math.floor((weaponFlat + bracelet.weaponExpected) * weaponMultiplier);
    withBracelet = { inversePrimary, weapon: weaponValue, finalAttack: finalAttack(inversePrimary, weaponValue) };
  } else withBracelet = normalAndInvert(bracelet.primary, 0);
  Object.assign(diagnostics, { weaponFlat, weaponMultiplier, primaryBase, primaryMultiplier, P, M, H, G,
    without, with: withBracelet, normalAttackWithout: without.normalAttack,
    braceletWeaponModel: bracelet.weaponExpected > 0 ? 'expected-weapon-avatar' : 'normal-primary' });
  if (![without.finalAttack, withBracelet.finalAttack].every(value => Number.isSafeInteger(value) && value > 0)) {
    return { without: null, with: null, diagnostics, missing: ['calculation.nonFinite'] };
  }
  return { without: without.finalAttack, with: withBracelet.finalAttack, diagnostics, missing: [] };
}
import { readConditionalBraceletEngraving } from './bracelet-conditional-engravings.js';
import { withNormalizedCores } from './arkgrid-core-names.js';
import { isAbilityStoneReduction, isUnopenedKarma } from './official-input-forms.js';
