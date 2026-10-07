// 홈페이지 캐릭터 화면의 스펙업 탭에 넘기는 판(README.md).
//
// 계산은 `/스펙업`이 쓰던 getSpecupGuide 그대로다. 웹 서비스는 NoNewPrivileges로 돌아 격리 계정
// 래퍼를 쓸 수 없고 봇 루트의 크리스탈 시세 파일도 읽지 못하므로, 같은 기기의 웹이 루프백으로 이
// 경로를 읽어 간다. 공개 주소로는 넘기지 않으며 루프백 주소와 공유 토큰이 모두 맞아야 답한다.
// 내보내는 것은 캐릭터 이름과 계산 결과뿐이고 사용자 키·방 기록 같은 것은 넣지 않는다.
//
// 한 번의 계산이 10~30초라 요청을 붙잡지 않는다. 계산을 걸어 두고 곧바로 running을 주고, 화면이
// 다시 물어보면 끝난 판을 준다. 스펙업 슬롯은 하나뿐이고 카카오톡·디스코드도 같이 쓰므로
// 홈페이지 몫은 동시 3건까지만 받는다 — 그 이상은 봇의 대기줄에 서지 않고 busy로 돌려보낸다.
import { getSpecupGuide } from './lopec-sim.js';
import { crystalStore } from './crystal-price.js';

export const SPECUP_SITE_PATH = '/internal/site/specup';
export const SPECUP_SITE_ROWS = 200;
const KEEP_MS = 5 * 60 * 1000; // 코어의 결과 캐시와 같은 길이
const MAX_JOBS = 40;
const MAX_ACTIVE = 3;
const NAME = /^[가-힣A-Za-z0-9]{2,12}$/u;

export const isSpecupName = (value) => typeof value === 'string' && NAME.test(value.normalize('NFC'));

// 코어가 준 행에서 화면이 쓰는 값만 옮긴다. 반올림·상위 N은 표시 계층의 일이라 여기서 하지 않는다.
function siteRow(row) {
  const value = {
    kind: row.kind, option: row.option, gainPercent: row.gainPercent, gainSource: row.gainSource,
    finalScore: row.finalScore, expectedCost: row.expectedCost, per100k: row.per100k, priceSource: row.priceSource,
  };
  if (row.gem) value.gem = { skill: row.gem.skill, type: row.gem.type, from: row.gem.from, to: row.gem.to };
  return value;
}

const siteGuide = (guide) => ({
  baseScore: guide.baseScore, pricedAt: guide.pricedAt ?? null, priceStale: Boolean(guide.priceStale),
  droppedForPrice: guide.droppedForPrice ?? 0, crystalPrice95: guide.crystalPrice95 ?? null,
  rows: guide.rows.slice(0, SPECUP_SITE_ROWS).map(siteRow),
});

export function createSiteSpecup({ getGuide = getSpecupGuide, store = crystalStore, now = Date.now,
  keepMs = KEEP_MS, maxJobs = MAX_JOBS, maxActive = MAX_ACTIVE } = {}) {
  const jobs = new Map(); // 캐릭터 이름 → { startedAt, finishedAt, state, guide, crystal }

  function sweep(at) {
    for (const [name, job] of jobs) if (job.finishedAt !== null && at - job.finishedAt >= keepMs) jobs.delete(name);
    if (jobs.size <= maxJobs) return;
    // 넘치면 끝난 일부터 오래된 순으로 버린다. 진행 중인 일은 남긴다.
    const finished = [...jobs].filter(([, job]) => job.finishedAt !== null).sort((a, b) => a[1].finishedAt - b[1].finishedAt);
    for (const [name] of finished) {
      if (jobs.size <= maxJobs) break;
      jobs.delete(name);
    }
  }

  const answer = (name, job) => (job.state === 'running'
    ? { status: 'running', name, startedAt: job.startedAt, elapsedMs: Math.max(0, now() - job.startedAt) }
    : { status: job.state, name, startedAt: job.startedAt, finishedAt: job.finishedAt,
      ...(job.state === 'done' ? { guide: job.guide, crystal: job.crystal } : {}) });

  return {
    // 기다리지 않는다. 걸어 둔 일이 있으면 그 상태를, 없으면 새로 걸고 running을 준다.
    request(name) {
      if (!isSpecupName(name)) return null;
      const key = name.normalize('NFC');
      const at = now();
      sweep(at);
      const existing = jobs.get(key);
      if (existing) return answer(key, existing);
      if ([...jobs.values()].filter((job) => job.state === 'running').length >= maxActive) return { status: 'busy' };

      const crystal = store.get();
      const price95 = Number.isFinite(crystal?.price95) && crystal.price95 > 0 ? crystal.price95 : null;
      const job = { startedAt: at, finishedAt: null, state: 'running', guide: null,
        crystal: price95 === null ? null : { price95, at: crystal.at ?? null, source: crystal.source ?? null } };
      jobs.set(key, job);
      // 계산은 지금 시작한다 — 한 틱 미루면 곧바로 물어본 쪽이 아직 걸리지도 않은 일을 기다린다.
      // 코어는 실패를 null로 돌려주지만 예외가 새더라도 진행 중으로 남지 않게 잡는다.
      let work;
      try { work = Promise.resolve(getGuide(key, { crystalPrice95: price95 })); }
      catch (error) { work = Promise.reject(error); }
      work
        .then((guide) => {
          job.state = guide ? 'done' : 'unavailable';
          job.guide = guide ? siteGuide(guide) : null;
        }, (error) => {
          job.state = 'unavailable';
          console.error('[스펙업] 홈페이지 조회 실패:', error?.message ?? error);
        })
        .finally(() => { job.finishedAt = now(); });
      return answer(key, job);
    },
  };
}
