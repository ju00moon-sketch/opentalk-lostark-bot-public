// 인자 없는 비동기 조회를 잠깐 기억한다 — 같은 목록을 연달아 묻는 명령(/공지·/이벤트·업데이트 확인)이
// 매번 공식 API 왕복(0.2~0.3초)을 기다리지 않게 한다.
//   · 성공한 결과만 ttlMs 동안 돌려준다. 실패(거절)는 기억하지 않아 다음 호출이 다시 시도한다.
//   · 진행 중인 호출이 있으면 새 호출은 그 Promise를 같이 기다린다(동시 요청 합치기).
//   · 돌려주는 값은 같은 객체다 — 호출한 쪽은 읽기만 해야 한다.
export function memoTtl(fn, ttlMs, { now = Date.now } = {}) {
  let value;
  let until = 0;
  let inflight = null;
  const memoized = () => {
    if (inflight) return inflight;
    if (until > now()) return Promise.resolve(value);
    // fn은 바로 호출한다(동기 예외도 거절로) — 같은 틱의 동시 호출이 진행 중 Promise를 공유하게.
    inflight = new Promise((resolve) => resolve(fn()))
      .then((result) => {
        value = result;
        until = now() + ttlMs;
        return result;
      })
      .finally(() => { inflight = null; });
    return inflight;
  };
  memoized.clear = () => { value = undefined; until = 0; };
  return memoized;
}
