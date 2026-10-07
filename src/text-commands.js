// 초성 텍스트 커맨드: 채팅에 "ㅂㅂㄱ 4000"처럼 치면 슬래시 커맨드처럼 동작한다.
// 슬래시 인터랙션을 흉내 내는 어댑터로 기존 커맨드 로직을 그대로 재사용한다.
import { mealAtTime } from './meals.js';
import { parseGemSearch } from './gem-search.js';
import { isBareVersusInput, parseVersusInput, VERSUS_MAX_LENGTH, VERSUS_USAGE } from './versus-input.js';
import { parseChatQuestion, CHAT_USAGE } from './chat-input.js';

const toInt = (s) => {
  const n = parseInt(String(s ?? '').replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

const GRADE_MAP = {
  전설: '전설', 영웅: '영웅', 희귀: '희귀',
  '7회': '전설', '6회': '영웅', '5회': '희귀',
  7: '전설', 6: '영웅', 5: '희귀',
};

const GEM_TYPES = ['겁화', '작열', '광휘', '멸화', '홍염'];

// 쪽 번호는 슬래시 옵션과 같게 1~20 정수만 받는다. 안 적으면 1쪽.
// toInt는 "2.5"를 2로, "-1"을 -1로 통과시키므로 여기서 자릿수부터 확인한다.
const PAGE_MAX = 20;
const parsePage = (p) => {
  if (p.length === 0) return {};
  if (!/^[0-9]+$/.test(p[0])) return null;
  const 페이지 = Number(p[0]);
  return 페이지 >= 1 && 페이지 <= PAGE_MAX ? { 페이지 } : null;
};

// /환산가치는 쪽 번호 외에 「갱신」을 받는다 — 슬래시 옵션 이름(갱신)과 값(지금)을 그대로 맞춘다.
// 둘을 같이 치면(ㅎㅅㄱㅊ 2 갱신) 커맨드 쪽에서 갱신을 먼저 처리한다.
const parseValue = (p) => {
  const rest = p.filter((token) => token !== '갱신');
  const page = parsePage(rest);
  return page === null ? null : { ...page, 갱신: rest.length === p.length ? null : '지금' };
};

// /보석 세 가지 쓰임을 한 파서에서 가른다: 인자 없음 → 시세판, "겁화 10" → 단일 보석, 그 밖 → 캐릭터 닉네임.
const parseGemArgs = (p) => {
  if (p.length === 0) return {};
  if (GEM_TYPES.includes(p[0])) {
    const 레벨 = toInt(p[1]);
    return 레벨 ? { 종류: p[0], 레벨 } : null;
  }
  return { 닉네임: p.join(' ') };
};

// 숫자 입력은 기존 규칙을 유지하고, 각인명은 마지막의 선택 인원만 떼어 공백을 보존한다.
// 띄어쓰기 없이 친 각인명(질량증가)은 커맨드 쪽(bid.js)이 정식 품명으로 되돌린다.
const parseBidArgs = (p) => {
  if (!p.length) return null;
  const 가격 = toInt(p[0]);
  if (가격 !== null) {
    if (가격 < 1) return null;
    const 인원 = toInt(String(p[1] ?? '').replace('인', ''));
    return [4, 8, 16].includes(인원) ? { 가격, 인원 } : { 가격 };
  }
  const parts = [...p];
  let 인원;
  if (/^[0-9]+인?$/.test(parts.at(-1))) {
    인원 = Number(parts.pop().replace(/인$/, ''));
    if (![4, 8, 16].includes(인원)) return null;
  }
  const 각인서 = parts.join(' ').normalize('NFC').replace(/^유물\s+/, '').replace(/\s+각인서$/, '').trim();
  return 각인서 ? { 각인서, ...(인원 ? { 인원 } : {}) } : null;
};

// parse는 인자 배열을 받아 옵션 객체를 반환한다. null이면 사용법 안내.
// 강화: 부위(무기·방어구)와 두 단계. 「18 20」처럼 숫자만 적으면 무기로 본다.
function parseHoningArgs(parts) {
  const kinds = { 무기: 'weapon', 방어구: 'armor', 방어: 'armor', 방: 'armor', 무: 'weapon' };
  const words = parts.filter((part) => !/^\d+$/.test(part));
  const numbers = parts.filter((part) => /^\d+$/.test(part)).map(Number);
  if (words.length > 1 || numbers.length !== 2) return null;
  const kind = words.length ? kinds[words[0]] : 'weapon';
  const [from, to] = numbers;
  if (!kind || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 25 || to <= from) return null;
  return { 부위: kind, 현재: from, 목표: to };
}

export const ALIASES = {
  ㄱㄹㄷ: { cmd: '아크그리드', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  앜그: { cmd: '아크그리드', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㅂㅂㄱ: { cmd: '분배금', usage: 'ㅂㅂㄱ 가격|각인서명 [인원] (예: ㅂㅂㄱ 4000 · ㅂㅂㄱ 원한 8, 각인서는 유물만)', parse: parseBidArgs },
  ㄱㅁㄱ: { cmd: '경매금', usage: 'ㄱㅁㄱ 가격|각인서명 [인원] (예: ㄱㅁㄱ 4000 · ㄱㅁㄱ 원한 8, 각인서는 유물만)', parse: parseBidArgs }, // 분배금과 같은 계산기
  ㄱㅁ: { cmd: '경매금', usage: 'ㄱㅁ 가격|각인서명 [인원] (예: ㄱㅁ 4000 · ㄱㅁ 원한 8, 각인서는 유물만)', parse: parseBidArgs }, // ㄱㅁㄱ의 더 짧은 초성(사용자 요청 2026-09-17)
  ㅁㅎㅅ: { cmd: '모험섬', parse: () => ({}) },
  ㅊㅊ: { cmd: '출첵', parse: () => ({}) },
  ㅊㅊㅎㅎ: { cmd: '출석현황', desc: '출석현황의 초성', parse: () => ({}) }, // 카톡에서 접두사 없이 허용(사용자 요청 2026-09-17), 뒤에 붙은 말은 무시
  ㅎㅁㄷ: { cmd: '한마디', parse: () => ({}) },
  ㅈㅁㅊ: { cmd: '점메추', usage: 'ㅈㅁㅊ (추가 입력 없이 사용)', parse: (p) => (p.length === 0 ? {} : null) },
  저메추: { cmd: '저메추', usage: '.저메추 (추가 입력 없이 사용)', parse: (p) => (p.length === 0 ? {} : null) },
  ㄸㅅ: { cmd: '떠상', usage: 'ㄸㅅ [서버] (예: ㄸㅅ · ㄸㅅ 루페온)', parse: (p) => ({ 서버: p[0] ?? null }) },
  ㄱㅌ: { cmd: '가토', parse: (p) => ({ 전체: /전체/.test(p.join(' ')) ? '전체' : null }) },
  // 등급은 필수 — 없으면 사용법 (사용자 요청 2026-09-04: 등급 없이 결과가 나오지 않게)
  ㅈㅇ: { cmd: '지옥', usage: 'ㅈㅇ 등급 (전설·영웅·희귀 또는 7회·6회·5회) (예: ㅈㅇ 전설)', parse: (p) => (GRADE_MAP[p[0]] ? { 등급: GRADE_MAP[p[0]] } : null) },
  ㄴㄹ: { cmd: '나락', usage: 'ㄴㄹ 등급 (전설·영웅·희귀 또는 7회·6회·5회) (예: ㄴㄹ 전설)', parse: (p) => (GRADE_MAP[p[0]] ? { 등급: GRADE_MAP[p[0]] } : null) },
  ㅅㄴㅈ: { cmd: '시너지', parse: (p) => ({ 검색: p.join(' ') || null }) },
  ㅊㅂ: { cmd: '체방', parse: () => ({}) },
  ㄱㅎ: { cmd: '강화', usage: 'ㄱㅎ 부위 현재 목표 (예: ㄱㅎ 무기 18 20)', parse: parseHoningArgs },
  ㅋㄱ: { cmd: '클골', parse: (p) => ({ 레이드명: p.join(' ') || null }) },
  ㅈㄱ: { cmd: '주급', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㅅㅅ: { cmd: '시세', usage: 'ㅅㅅ 아이템명 (예: ㅅㅅ 운명의 파괴석)', parse: (p) => (p[0] ? { 아이템명: p.join(' ') } : null) },
  ㄱㅇㅅ: { cmd: '각인서', usage: 'ㄱㅇㅅ 각인명 (예: ㄱㅇㅅ 원한)', parse: (p) => (p[0] ? { 각인명: p.join(' ') } : null) },
  ㅂㅅ: { cmd: '보석', usage: 'ㅂㅅ [종류 레벨 | 닉네임] (예: ㅂㅅ · ㅂㅅ 겁화 10 · ㅂㅅ 합성캐릭터4)', parse: parseGemArgs },
  ㅄ: { cmd: '보석', usage: 'ㅄ [종류 레벨 | 닉네임] (예: ㅄ · ㅄ 겁화 10 · ㅄ 합성캐릭터4)', parse: parseGemArgs },
  보석최저가: { cmd: '보석최저가', usage: '.보석최저가 (추가 입력 없이 사용)', parse: (p) => (p.length === 0 ? {} : null) },
  ㄱㅁㅈ: { cmd: '경매장', usage: 'ㄱㅁㅈ 레벨+종류 (1~10레벨 겁화·작열, 예: ㄱㅁㅈ 10겁 · ㄱㅁㅈ 9작)', parse: (p) => {
    const 검색어 = p.join(' ');
    return parseGemSearch(검색어) ? { 검색어 } : null;
  } },
  ㅅㅋㅋㄷ: { cmd: '스킬코드', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  비싼유각: { cmd: '유각', desc: '유각과 같은 커맨드', usage: '.비싼유각 [쪽] (1~20 정수, 예: .비싼유각 2)', parse: parsePage },
  ㅂㅆㅇㄱ: { cmd: '유각', usage: 'ㅂㅆㅇㄱ [쪽] (1~20 정수, 예: ㅂㅆㅇㄱ 2)', parse: parsePage },
  ㅇㄱ: { cmd: '유각', usage: 'ㅇㄱ [쪽] (1~20 정수, 예: ㅇㄱ 2)', parse: parsePage },
  ㅈㄱㅇ: { cmd: '전각', usage: 'ㅈㄱㅇ [쪽] (1~20 정수, 예: ㅈㄱㅇ 2)', parse: parsePage },
  ㄷㅈㅂ: { cmd: '딜지분', usage: 'ㄷㅈㅂ 레이드[관문] [피해량] (예: ㄷㅈㅂ 세하1관 2700억)', parse: (p) => (p[0] ? { 레이드: p.join(' ') } : null) },
  ㄷㅋ: { cmd: '딜컷', usage: 'ㄷㅋ 레이드[관문] [분] (예: ㄷㅋ 세하 10)', parse: (p) => (p[0] ? { 레이드: p.join(' ') } : null) },
  ㅋㄹㅌ: { cmd: '캐릭터', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㅈㅂ: { cmd: '정보', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㄷㄹ: { cmd: '등록', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㅊㅈ: { cmd: '치적', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㄹㅍ: { cmd: '로펙', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㅍㅍ: { cmd: '포펙', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㅂㅋ: { cmd: '부캐', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㅈㅎㅇ: { cmd: '젬효율', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㅅㅍㅇ: { cmd: '스펙업', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㅆ: { cmd: '쌀', parse: () => ({}) },
  ㄱㄷㅅㅅ: { cmd: '골드시세', parse: () => ({}) },
  ㅍㅉㄱㅅ: { cmd: '팔찌검색', usage: 'ㅍㅉㄱㅅ 옵션 (예: ㅍㅉㄱㅅ 특90치90 · ㅍㅉㄱㅅ 특90 치90 부여3)', parse: (p) => (p[0] ? { 옵션: p.join(' ') } : null) },
  쌀값: { cmd: '쌀', desc: '쌀과 같은 커맨드', parse: () => ({}) },
  출석체크현황: { cmd: '출석현황', desc: '출석현황의 옛 이름', parse: () => ({}) }, // 개명 전 이름을 한동안 그대로 받는다(2026-09-09)
  ㅋㄹㅅㅌ: { cmd: '크리스탈', usage: 'ㅋㄹㅅㅌ [95개가격] (예: ㅋㄹㅅㅌ 16626)', parse: (p) => {
    if (!p[0]) return {};
    const 가격 = Number(p[0].replace(/,/g, ''));
    return Number.isInteger(가격) ? { 가격 } : null;
  } },
  ㄱㅈ: { cmd: '군장', parse: (p) => ({ 닉네임: p.join(' ') || null }) },
  ㄹㅋ: { cmd: '랭킹', usage: 'ㄹㅋ [쪽] (예: ㄹㅋ 2)', parse: parsePage },
  ㅊㄱ: { cmd: '체급', usage: 'ㅊㄱ [쪽] (예: ㅊㄱ 2)', parse: parsePage },
  ㅎㅅㄱㅊ: { cmd: '환산가치', usage: 'ㅎㅅㄱㅊ [쪽] (예: ㅎㅅㄱㅊ 2) · 지금 장비로 다시 계산하려면 ㅎㅅㄱㅊ 갱신', parse: parseValue },
  ㅇㄷㅇㅌ: { cmd: '업데이트', parse: () => ({}) },
  업뎃: { cmd: '업데이트', parse: () => ({}) },
  시전: { cmd: 'cpm', usage: '.cpm 횟수 시간 [목표] (예: .cpm 35 7분)', parse: (p) => {
    const 횟수 = toInt(p[0]);
    return 횟수 && p[1] ? { 횟수, 시간: p[1], 목표: p[2] ? Number(p[2]) : null } : null;
  } },
  ㄷㅇㅁ: { cmd: '도움말', parse: () => ({}) },
};

// 슬래시 인터랙션 흉내 어댑터
class TextInteraction {
  constructor(message, options) {
    this.message = message;
    this.channelId = message.channelId;
    this.guildId = message.guildId;
    this.guild = message.guild;
    this.channel = message.channel;
    this.user = message.author;
    this.member = message.member; // 서버 닉네임을 캐릭터명으로 쓰는 폴백용
    this.deferred = false;
    this.replied = false;
    this.options = {
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getNumber: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getChannel: () => null,
      getSubcommand: () => options.__sub,
    };
  }
  // "입력 중" 표시는 보여 주기용이다 — 기다리면 REST 왕복(서버에서 약 0.1초)만큼 답이 늦어지므로
  // 요청만 보내고 바로 커맨드 실행으로 넘어간다. 답장이 먼저 도착해도 표시는 그때 사라진다.
  async deferReply() {
    this.deferred = true;
    Promise.resolve().then(() => this.channel.sendTyping()).catch(() => {});
  }
  async reply(payload) {
    this.replied = true;
    return this.#send(payload);
  }
  // 첫 editReply는 답장을 보내고, 그 뒤의 editReply는 그 답장을 고친다 (예: 기댓값 계산이 끝났을 때 갱신).
  async editReply(payload) {
    if (this.sent?.edit) return this.sent.edit(this.#payload(payload)).catch(() => this.#send(payload));
    return this.#send(payload);
  }
  // 두 번째 메시지 — 답장 뒤에 채널로 따로 보낸다 (/포펙의 티어 카드 → 스펙 요약).
  async followUp(payload) {
    const p = typeof payload === 'string' ? { content: payload } : { ...payload };
    delete p.flags;
    return this.channel.send(p);
  }
  #payload(payload) {
    const p = typeof payload === 'string' ? { content: payload } : { ...payload };
    delete p.flags; // 텍스트 커맨드에는 에페메랄이 없다
    return p;
  }
  async #send(payload) {
    const p = this.#payload(payload);
    this.sent = await this.message.reply(p).catch(() => this.channel.send(p));
    return this.sent;
  }
}

// 규칙: 초성(ㅂㅂㄱ)은 접두사 없이 바로, 원래 단어(분배금·지옥 등)는 반드시 "." 또는 "!"를
// 붙여야 반응한다 — 일반 대화("지옥 같네")가 오작동하지 않도록.
// ALIASES에 초성이 아닌 축약("업뎃")을 넣을 수도 있는데, 이런 단어형도 접두사를 요구한다.
const WORD_CMDS = new Map(Object.values(ALIASES).map((def) => [def.cmd, def]));
const CHOSUNG_ONLY = /^[ㄱ-ㅎ]+$/;
// 원정대 아크그리드 현황을 부르는 이름 — 정식 `앜그현황`과 같은 커맨드인 `코어현황`(접두사 필수, 초성·단독 입력 없음)
const ROSTER_STATUS_NAMES = new Set(['앜그현황', '코어현황']);

// 악세 연마 조합 단축어 — ".상상", ".상중 70" 처럼 쓴다.
// ALIASES와 달리 슬래시 커맨드로는 등록하지 않는다 (초성 별칭 없음).
const REFINE_PATTERNS = ['상단일', '중단일', '상상상', '상상중', '상상하', '상상', '상중', '상하', '중중', '중하'];

function matchRefinePattern(token, params) {
  if (!REFINE_PATTERNS.includes(token)) return null;
  const 품질 = toInt(params[0]);
  return { cmd: '악세', options: { 검색: token, 품질: 품질 ?? null } };
}

// ── 슬래시 옵션 정의로 범용 파싱 (별칭이 없는 커맨드용 — 카카오에서 /장비 닉네임 같은 형태)
const OPT = { SUB: 1, SUB_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, CHANNEL: 7, NUMBER: 10 };

function usageOf(name, defs) {
  const parts = defs.map((o) => {
    const label = o.choices ? o.choices.map((c) => c.value).join('|') : o.name;
    return o.required ? label : `[${label}]`;
  });
  return `/${name} ${parts.join(' ')}`.trim();
}

// tokens를 옵션 정의 순서대로 채운다. "옵션명:값"으로 특정 옵션을 지정할 수도 있다.
// 마지막에 남은 옵션이 문자열이면 남은 토큰을 통째로 받는다(닉네임·검색어에 띄어쓰기 허용).
export function parseGenericOptions(command, tokens) {
  const json = command.data.toJSON();
  const defs = (json.options ?? []).filter((o) => ![OPT.SUB, OPT.SUB_GROUP, OPT.CHANNEL].includes(o.type));
  if (defs.length === 0) return { options: {} };
  const usage = usageOf(json.name, defs);
  const options = {};
  const rest = [];
  for (const token of tokens) {
    const m = /^([^:]+):(.+)$/.exec(token);
    const def = m && defs.find((o) => o.name === m[1]);
    if (def) options[def.name] = m[2];
    else rest.push(token);
  }
  const unfilled = defs.filter((o) => !(o.name in options));
  unfilled.forEach((def, i) => {
    if (rest.length === 0) return;
    const isLastString = i === unfilled.length - 1 && def.type === OPT.STRING;
    options[def.name] = isLastString ? rest.splice(0).join(' ') : rest.shift();
  });
  for (const def of defs) {
    const raw = options[def.name];
    if (raw === undefined) {
      if (def.required) return { usage };
      options[def.name] = null;
      continue;
    }
    let value = raw;
    if (def.type === OPT.INTEGER) value = toInt(raw);
    else if (def.type === OPT.NUMBER) value = Number(String(raw).replace(/,/g, ''));
    else if (def.type === OPT.BOOLEAN) value = /^(true|1|예|응|on|켜기)$/i.test(raw);
    if (value === null || (typeof value === 'number' && !Number.isFinite(value))) return { usage };
    if (def.choices && !def.choices.some((c) => String(c.value) === String(value))) return { usage };
    // 슬래시 옵션에 적어 둔 범위(min_value·max_value)는 채팅·카카오에서도 똑같이 지킨다
    if (typeof value === 'number') {
      if (def.min_value != null && value < def.min_value) return { usage };
      if (def.max_value != null && value > def.max_value) return { usage };
    }
    options[def.name] = value;
  }
  return { options };
}

// 사용법 문구는 디스코드 채팅 기준(초성은 바로, 단어는 .)으로 적혀 있다. 초성을 접두사 없이 못 쓰는 곳(카카오)에서는
// 문구 속 별칭·".단어"에 사용자가 친 접두사를 붙여 그대로 따라 쳐도 동작하게 바꿔 준다:
//   "/"로 쳤으면 "ㅂㅂㄱ 가격 (예: ㅂㅂㄱ 4000)" → "/ㅂㅂㄱ 가격 (예: /ㅂㅂㄱ 4000)", "."로 쳤으면 ".ㅂㅂㄱ 가격 (예: .ㅂㅂㄱ 4000)"
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function usageForPrefix(usage, key, prefix) {
  if (!usage || !prefix) return usage;
  const p = prefix.replace(/\$/g, '$$$$'); // 치환 문자열 안의 $ 보호
  return usage
    .replace(/(^|[\s(])[.!](?=\S)/g, `$1${p}`)                                        // ".cpm" → "/cpm" 또는 ".cpm"
    .replace(new RegExp(`(^|[\\s(])(${escapeRegExp(key)})(?=[\\s)]|$)`, 'g'), `$1${p}$2`); // "ㅂㅂㄱ" → "/ㅂㅂㄱ" 또는 ".ㅂㅂㄱ"
}

// 발화를 (커맨드, 옵션)으로 해석한다. 처리 대상이 아니면 null, 옵션이 부족하면 { command, usage }.
//   prefixes    — 단어형 커맨드(정보·상상)에 요구하는 접두사. 디스코드는 . ! / 카카오는 /
//   bareChosung — 초성 별칭을 접두사 없이 허용할지 (디스코드 true, 카카오 false)
//   bareAliases — 접두사 없이 허용할 별칭의 예외 목록
//   anyCommand  — 별칭이 없는 커맨드도 슬래시 옵션 정의로 파싱해 허용할지 (카카오 true)
export function matchTextCommand(content, commandMap, { prefixes = ['.', '!'], bareChosung = true, bareAliases = [], anyCommand = false, now = Date.now } = {}) {
  const parts = content.trim().split(/\s+/);
  const raw = parts[0] ?? '';
  const prefix = prefixes.find((p) => raw.startsWith(p));
  const hasPrefix = prefix !== undefined;
  const token = hasPrefix ? raw.slice(prefix.length) : raw;
  const params = parts.slice(1);
  if (!token) return null;

  // 질문은 옵션명이나 vs 비교로 다시 해석하지 않고 줄바꿈·따옴표까지 보존한다.
  if (token === '챗') {
    if (!hasPrefix || !['/', '.'].includes(prefix)) return null;
    const command = commandMap.get('챗');
    if (!command) return null;
    const question = parseChatQuestion(content.trimStart().slice(raw.length));
    return question ? { command, options: { 질문: question }, label: raw }
      : { command, usage: CHAT_USAGE, label: raw };
  }

  // 팔찌는 닉네임 또는 검색 조건을 한 문자열로 받는다. 기존 "닉네임:값" 형식도 유지한다.
  if (hasPrefix && token === '팔찌') {
    const command = commandMap.get('팔찌');
    return command ? { command, ...parseGenericOptions(command, params), label: raw } : null;
  }

  // 원정대 현황은 사용자 지정 형태만 허용한다(접두사 / 또는 .). 초성·느낌표 별칭은 만들지 않는다.
  // `.코어현황`은 사용자 지시(2026-09-14)로 `.앜그현황`과 같은 커맨드로 연결한다.
  if (ROSTER_STATUS_NAMES.has(token)) {
    if (!hasPrefix || !['/', '.'].includes(prefix)) return null;
    const command = commandMap.get('앜그현황');
    return command ? { command, ...parseGenericOptions(command, params), label: raw } : null;
  }

  if (hasPrefix && token.toLowerCase() === 'vs') {
    const command = commandMap.get('vs');
    if (!command) return null;
    const input = content.trimStart().slice(raw.length + 1);
    return content.length <= VERSUS_MAX_LENGTH + raw.length + 1
      && !/[\r\n\u0000-\u001f\u007f]/.test(content) && parseVersusInput(input)
      ? { command, options: { 비교: input }, label: raw }
      : { command, usage: VERSUS_USAGE, label: raw };
  }

  // 악세 연마 조합(.상상)은 단어형이라 접두사가 필요하다
  const refine = hasPrefix ? matchRefinePattern(token, params) : null;
  if (refine) {
    const command = commandMap.get(refine.cmd);
    return command ? { command, options: refine.options, label: raw } : null;
  }

  // 초성은 허용 시 접두사 유무 무관. 개별 예외가 아니면 다른 별칭은 접두사 필수.
  let alias = null;
  if (ALIASES[token] && ((bareChosung && CHOSUNG_ONLY.test(token)) || bareAliases.includes(token) || hasPrefix)) alias = ALIASES[token];
  if (!alias && hasPrefix && WORD_CMDS.has(token)) alias = WORD_CMDS.get(token); // 원래 커맨드명
  if (alias) {
    const commandName = token === 'ㅈㅁㅊ' && mealAtTime(now()) === 'dinner' ? '저메추' : alias.cmd;
    const command = commandMap.get(commandName);
    if (!command) return null;
    const options = alias.parse(params);
    if (options === null) {
      const key = Object.keys(ALIASES).find((k) => ALIASES[k] === alias) ?? token;
      // 초성을 접두사 없이 쓸 수 있는 곳(디스코드)은 문구 그대로, 아니면(카카오) 친 접두사를 붙인 문구로
      return { command, usage: bareChosung ? alias.usage : usageForPrefix(alias.usage, key, prefix), label: raw };
    }
    return { command, options, label: raw };
  }

  // 별칭이 없는 커맨드 — 카카오처럼 모든 커맨드를 /이름 인자 형태로 받을 때만
  if (anyCommand && hasPrefix && commandMap.has(token)) {
    const command = commandMap.get(token);
    const parsed = parseGenericOptions(command, params);
    if (parsed.usage) return { command, usage: parsed.usage, label: raw };
    return { command, options: parsed.options, label: raw };
  }
  if (isBareVersusInput(content)) {
    const command = commandMap.get('vs');
    if (command) return parseVersusInput(content)
      ? { command, options: { 비교: content }, label: 'vs' }
      : { command, usage: VERSUS_USAGE, label: 'vs' };
  }
  return null;
}

// 어댑터를 만들어 커맨드를 실행한다. 항상 true(처리함)를 반환한다.
async function runCommand(command, message, options, label) {
  const fake = new TextInteraction(message, options);
  const started = Date.now();
  try {
    await command.execute(fake);
  } catch (err) {
    console.error(`[채팅 ${label}]`, err);
    await message.reply(`오류가 발생했어요: ${err.message}`).catch(() => {});
  }
  // 카톡 브리지의 "[카카오] … 0.3s"와 같은 형식 — 디스코드 채팅 명령의 처리 시간을 로그에서 비교할 수 있게 한다.
  console.log(`[채팅] ${label} ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return true;
}

// 처리했으면 true를 반환한다.
export async function handleTextCommand(message, commandMap) {
  const match = matchTextCommand(message.content, commandMap);
  if (!match) return false;
  if (match.usage) {
    await message.reply(`사용법: \`${match.usage}\``).catch(() => {});
    return true;
  }
  return runCommand(match.command, message, match.options, match.label);
}
