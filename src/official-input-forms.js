// Official armory input forms that mean "nothing here" and are shared by every score and efficiency reader (2026-09-18).

// The engraving list also carries the ability stone's reduction line, for example
// `{ Name: '방어력 감소', Grade: '', Level: 0, AbilityStoneLevel: -1 }`. It is not an engraving book and never
// enters a score, so every engraving reader skips it. A reduction-like name with a real grade is still read under
// the ordinary engraving rules.
export function isAbilityStoneReduction(effect) {
  return !!effect && typeof effect === 'object' && effect.Grade === '' && effect.Level === 0
    && ((typeof effect.AbilityStoneLevel === 'number' && effect.AbilityStoneLevel < 0) || (typeof effect.Name === 'string' && /감소$/.test(effect.Name.trim())));
}

// A karma track that is not opened yet has an ArkPassive point description of '' or '미개방' instead of
// 'N랭크 M레벨': rank 0, level 0. The caller passes the description already stripped of tags and outer spaces;
// any other string keeps failing closed.
export function isUnopenedKarma(description) {
  return description === '' || description === '미개방';
}

// The official full response omits `ArmoryEngraving` when a character has no engraving at all, and an individual
// lookup returns `null` (2026-09-18). Both mean "no engravings": an empty list. An `ArmoryEngraving` object is
// returned as its `ArkPassiveEffects` value untouched so every reader keeps its own array check.
export function engravingEffects(raw) {
  const block = raw?.ArmoryEngraving;
  if (block === undefined || block === null) return [];
  return block?.ArkPassiveEffects;
}

// Bracelet options the reference score treats as neutral (no coefficient): non-combat lines the game rolls on a
// bracelet. The caller passes the option text with every whitespace removed. Anything outside this family is
// still an unknown bracelet option and fails closed.
const NEUTRAL_BRACELET_OPTIONS = [
  /^효과부여가능$/, /^(물리|마법)방어력\+\d+$/, /^최대생명력\+\d+$/, /^전투중생명력회복량\+\d+$/, /^전투자원자연회복량\+[\d.]+%$/,
  /^\[긴급수혈\]/, /^\[강타\]/, /^\[회생\]/, /^\[반전\]/, /^\[마나회수\]/, /^\[응급처치\]/, /^\[앵콜\]/,
];
export function isNeutralBraceletOption(compactText) {
  return typeof compactText === 'string' && compactText.length <= 400 && NEUTRAL_BRACELET_OPTIONS.some(pattern => pattern.test(compactText));
}

// When no enlightenment node names a class path, the reference score falls back to the class's first path (the
// first entry of its per-class path list, which is the classCores key order of src/data/gem-model-facts.json).
// Support-capable classes (바드·홀리나이트·도화가·발키리) have no default so a support build is never scored as a dealer path.
const DEFAULT_ENLIGHTENMENT_JOB = Object.freeze({
  디스트로이어: '분노의 망치', 워로드: '고독한 기사', 버서커: '광전사의 비기', 슬레이어: '처단자',
  배틀마스터: '초심', 인파이터: '충격 단련', 기공사: '역천지체', 창술사: '절정', 스트라이커: '일격필살', 브레이커: '권왕파천무',
  데빌헌터: '전술 탄환', 블래스터: '포격 강화', 호크아이: '죽음의 습격', 스카우터: '아르데타인의 기술', 건슬링어: '피스메이커',
  서머너: '넘치는 교감', 아르카나: '황후의 은총', 소서리스: '점화',
  블레이드: '버스트', 데모닉: '멈출 수 없는 충동', 리퍼: '달의 소리', 소울이터: '만월의 집행자',
  기상술사: '질풍노도', 환수사: '야성', 가디언나이트: '업화의 계승자', 차원술사: '시간 관리자',
});
export function defaultEnlightenmentJob(className) {
  return typeof className === 'string' && Object.hasOwn(DEFAULT_ENLIGHTENMENT_JOB, className) ? DEFAULT_ENLIGHTENMENT_JOB[className] : null;
}
