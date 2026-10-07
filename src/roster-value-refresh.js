// /환산가치가 읽는 원정대 환산 가치를 홈페이지가 다시 계산하도록 시작 10분 뒤 1회 + 매일 03:30 KST에 요청한다.
// 수요일 06:00 재부팅·08:00 크리스탈 자동 갱신과 겹치지 않는 시각이며, 계산 자체는 홈페이지가 순차로 돌린다
// (README.md).
import { getAllLinks } from './user-store.js';
import { getRosterValueRefreshStatus, requestRosterValueRefresh } from './site-valuation.js';

export const REFRESH_HOUR_KST = 3;
export const REFRESH_MINUTE_KST = 30;
export const STARTUP_DELAY_MS = 10 * 60 * 1000;
export const SKIP_WINDOW_MS = 24 * 60 * 60 * 1000;
// 한 요청에 담을 수 있는 앵커 수(홈페이지 API 상한)와 한 번 갱신할 때 보내는 요청 수(홈페이지 분당 6회 제한 안).
export const MAX_ANCHORS = 64;
export const MAX_REQUESTS = 6;

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET = 9 * 60 * 60 * 1000;

export function msUntilNextRefresh(at) {
  const kst = at + KST_OFFSET;
  let target = Math.floor(kst / DAY_MS) * DAY_MS + REFRESH_HOUR_KST * 60 * 60 * 1000 + REFRESH_MINUTE_KST * 60 * 1000;
  if (target <= kst) target += DAY_MS;
  return target - kst;
}

// 등록 캐릭터 전체(디스코드·카카오톡 공통, 중복 제거). 디스코드 길드 조회는 필요 없다 — 갱신 대상은 등록자 전부다.
export function anchorNames(links) {
  const names = [];
  const seen = new Set();
  for (const value of Object.values(links ?? {})) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

// 등록자 전원을 한 요청 상한(64명)씩 나눈다. 홈페이지는 한 번에 64명만 계산하고, 실행 중에 받은 나머지는 대기열에
// 넣어 다음 실행부터 차례로 처리한다(명세 §갱신 실행). 그래서 뒤쪽 등록자도 적어도 한 번은 보내야 차례가 온다 —
// 전에는 앞 64명에서 끊어 65번째부터는 영영 요청되지 않았다. 요청 수 상한을 넘을 만큼 많으면 KST 날짜마다 시작
// 위치를 64명씩 옮겨, 상한 밖의 등록자도 며칠 안에 차례가 온다.
export function anchorBatches(names, at = Date.now(), size = MAX_ANCHORS, limit = MAX_REQUESTS) {
  const list = Array.isArray(names) ? names : [];
  if (!list.length) return [];
  const day = Math.floor((at + KST_OFFSET) / DAY_MS);
  const start = list.length > size * limit ? (day * size) % list.length : 0;
  const rotated = [...list.slice(start), ...list.slice(0, start)];
  const batches = [];
  for (let offset = 0; offset < rotated.length && batches.length < limit; offset += size) batches.push(rotated.slice(offset, offset + size));
  return batches;
}

export function startRosterValueRefresh({
  links = getAllLinks, requestRefresh = requestRosterValueRefresh, readStatus = getRosterValueRefreshStatus,
  token = process.env.BOT_INTERNAL_TOKEN, setTimer = setTimeout, now = Date.now,
} = {}) {
  if (typeof token !== 'string' || token.length < 32) {
    console.log('환산 가치 갱신: 내부 토큰이 없어 켜지 않음');
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;
  let startup = true;

  const run = async () => {
    timer = null;
    if (stopped) return;
    try {
      // 시작 직후 1회만 마지막 성공 시각을 보고 24시간 안이면 건너뛴다 — 재시작이 잦아도 같은 계산을 또 돌리지 않게.
      const status = startup ? await readStatus() : null;
      const recent = Number.isSafeInteger(status?.lastSuccessAt) && now() - status.lastSuccessAt < SKIP_WINDOW_MS;
      if (!startup || !recent) {
        const names = anchorNames(links());
        const batches = anchorBatches(names, now());
        let sent = 0, failed = 0;
        for (const batch of batches) {
          let result = null;
          try { result = await requestRefresh(batch); } catch { result = null; }
          if (result) sent += batch.length; else failed += 1;
        }
        if (names.length > 0) {
          console.log(`환산 가치 갱신: 앵커 ${names.length}개 중 ${sent}개 요청${failed ? ` (요청 ${failed}건 실패)` : ''}`);
        }
      }
    } catch {
      console.error('환산 가치 갱신: 요청 실패');
    } finally {
      startup = false;
      if (!stopped) {
        timer = setTimer(run, msUntilNextRefresh(now()));
        timer?.unref?.();
      }
    }
  };

  timer = setTimer(run, STARTUP_DELAY_MS);
  timer?.unref?.();
  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
