// 일반 재련 보조 재료 — 숨결과 야금술·재봉술 책이 성공 확률을 얼마나 올리는지.
//
// 기존 `honing-valuation.js`는 보조 재료를 하나도 쓰지 않는 기대비용이라 최저 비용 경로가 아니다.
// 최적 비용을 계산하려면 "이번 시도에 숨결을 몇 개 넣고 책을 쓸지"를 골라야 하고, 그러려면 이 표가 필요하다.
//
// 규칙(아래 출처에서 확인):
//  - 숨결은 개수만큼 확률을 더하되 **합계가 기본 확률을 넘지 못한다**(기본 확률이 1%p보다 낮으면 1%p까지).
//    표의 개수는 상한일 뿐이고, 그 앞에서 한도에 닿으면 거기서 멈춘다.
//  - 책은 1개만 쓰며 **기본 확률만큼 더한다**(확률이 두 배). 숨결 한도와 별개로 더해진다.
//  - 장인의 기운은 보조 재료까지 더한 최종 확률에 비례해 쌓인다. 구현은 기존
//    `HONING_MODEL.artisan`을 그대로 쓴다 — 계수 0.465를 곱하고 매 실패마다 1/1000 단위로 반올림한다.
//    출처의 정확한 `/2.15`와는 **다른 모델**이며(0.465는 1/2.15의 반올림, 격자도 근사) 그 차이가
//    최적 정책을 바꾼다. 어느 쪽이 실제 게임 동작인지 미실측이라 공용 계수를 바꾸지 않았다.
//    근거와 반례는 `README.md` 2절에 적었다.
//
// 자료 범위: 목표 +14 이상의 모든 단계에 숨결 수치가 있다(길드가 실제로 두드리는 구간).
// 그보다 낮은 단계(기본 45%·30%·15%)의 숨결 수치는 확인하지 못해 비워 두었다.
// 목표 +21 이상은 거래소에 해당 책 자체가 없어 숨결만 쓴다(없는 것이지 모르는 것이 아니다).
// 비어 있으면 계산에서 그 보조 재료를 빼고 「자료 없음」으로 표시한다 — 추측해서 채우지 않는다.
const freeze = (value) => Object.freeze(value);

export const BOOST_MODEL = freeze({
  version: '2026-09-21.1',
  // 숨결 합계 상한: 기본 확률과 이 값 중 큰 쪽.
  breathFloorBps: 100,
  sources: [
    { kind: 'official', url: 'https://lostark.game.onstove.com/GameGuide/Pages/%EC%9E%AC%EB%A0%A8',
      scope: '보조 재료가 성공 확률을 올린다는 규칙과 장인의 기운 천장(수치는 미기재)' },
    { kind: 'open-source-calculator', url: 'https://github.com/icepeng/loa-calc', license: 'MIT',
      path: 'src/app/refining/data.ts · src/app/refining/refine.ts', observedAt: '2026-09-21',
      scope: '티어 4 숨결 개수·개당 확률, 숨결 합계 상한 규칙, 책 1개가 기본 확률만큼 더하는 규칙, 장인 2.15 분모' },
    { kind: 'community', url: 'https://www.inven.co.kr/board/lostark/4821/84928', observedAt: '2026-09-21',
      scope: '장인의 기운 = 최종 확률 ÷ 2.15 (티어 3 기준 검산)' },
  ],
});

export const BREATH_NAMES = freeze({ weapon: '용암의 숨결', armor: '빙하의 숨결' });

// 기본 확률(bps) → { 최대 개수, 개당 확률(bps) }. 무기·방어구가 같은 수치를 쓴다.
export const BREATH_TABLE = freeze({
  1000: freeze({ count: 20, perBps: 50 }),
  500: freeze({ count: 20, perBps: 25 }),
  400: freeze({ count: 20, perBps: 20 }),
  300: freeze({ count: 20, perBps: 15 }),
  225: freeze({ count: 25, perBps: 12 }),
  150: freeze({ count: 25, perBps: 6 }),
  100: freeze({ count: 25, perBps: 4 }),
  50: freeze({ count: 50, perBps: 2 }),
});

// 목표 단계 → 책 이름. 책은 언제나 1개이며 기본 확률만큼 더한다.
// 이름은 거래소 「재련 추가 재료」(50020)의 실제 품명이며 대괄호 안이 적용 구간이다(2026-09-21 조회).
// 운명(업화) 장비는 목표 +20까지만 책이 있고 +21 이상은 아예 없다. 운명의 전율은 전율 책을 쓴다.
// 「강화 야금술 : 업화 [19-20]」처럼 앞에 강화가 붙은 상위 책은 추가 확률을 확인하지 못해 쓰지 않는다.
const bookRange = (prefix, grade, ranges) => {
  const table = {};
  for (const [from, to] of ranges) {
    for (let stage = from; stage <= to; stage++) table[stage] = `${prefix} : ${grade} [${from}-${to}]`;
  }
  return freeze(table);
};

export const BOOK_NAMES = freeze({
  t4: freeze({
    weapon: bookRange('야금술', '업화', [[11, 14], [15, 18], [19, 20]]),
    armor: bookRange('재봉술', '업화', [[11, 14], [15, 18], [19, 20]]),
  }),
  serka: freeze({
    weapon: bookRange('야금술', '전율', [[12, 15], [16, 19]]),
    armor: bookRange('재봉술', '전율', [[12, 15], [16, 19]]),
  }),
  vambrace: freeze({ weapon: freeze({}), armor: freeze({}) }),
});

// 이 단계에서 숨결을 얼마나 쓸 수 있는지. 표에 없는 기본 확률이면 null(= 자료 없음).
export function breathLimit(successBps) {
  const row = BREATH_TABLE[successBps];
  if (!row) return null;
  const cap = Math.max(successBps, BOOST_MODEL.breathFloorBps);
  // 한도에 먼저 닿으면 표의 개수를 다 쓰지 않는다.
  const count = Math.min(Math.ceil(cap / row.perBps), row.count);
  return { count, perBps: row.perBps, capBps: cap };
}

// 숨결 n개가 실제로 더해 주는 확률(bps). 한도를 넘지 않는다.
export function breathGainBps(successBps, used) {
  const limit = breathLimit(successBps);
  if (!limit || !Number.isInteger(used) || used < 0 || used > limit.count) return null;
  return Math.min(used * limit.perBps, limit.capBps);
}

export const bookName = (family, kind, targetStage) => BOOK_NAMES[family]?.[kind]?.[targetStage] ?? null;
