import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// /체급은 로펙이 기억하는 환산 점수의 합으로 순위를 매긴다(골드 환산 순위는 /환산가치).
// 등록자 목록과 로펙 원정대 조회를 고정 자료로 바꿔 실제 명령 경로를 그대로 돌린다.
globalThis.__scoreTierLinks = {};
globalThis.__scoreTierExpeditions = {};
let stateWrites = 0;
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/json-store.js')) {
      return {
        format: 'module', shortCircuit: true,
        source: `
          export class CorruptStoreError extends Error {}
          export function readJson(path) {
            if (!String(path).endsWith('user-links.json')) throw new Error('Unexpected state read');
            return structuredClone(globalThis.__scoreTierLinks);
          }
          export const readJsonLenient = readJson;
          export const writeJsonAtomic = () => { globalThis.__scoreTierWrite(); };
        `,
      };
    }
    if (url.endsWith('/src/lopec.js')) {
      return {
        format: 'module', shortCircuit: true,
        source: `
          export async function getLopecExpedition(name) {
            const rows = globalThis.__scoreTierExpeditions[name];
            return rows === undefined ? null : structuredClone(rows);
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});
globalThis.__scoreTierWrite = () => { stateWrites += 1; throw new Error('Unexpected state write'); };

const { expeditionBoard, execute } = await import('../src/commands/tier.js');

const character = (itemLevel, lopecScore, role = 'dealer') => ({ itemLevel, lopecScore, role });
globalThis.__scoreTierExpeditions = {
  큰손: [character('1,780.00', 7400), character('1,745.00', 6100), character('1,700.00', 5000)],
  한캐만: [character('1,730.00', 6000), character('1,690.00', 4000, 'support')],
  점수없음: [character('1,750.00', 0), character('1,740.00', 3000, 'support')],
  저렙만: [character('1,700.00', 5200)],
};
const entries = [
  { userId: '111111111111111111', character: '한캐만' },
  { userId: 'kakao:1', character: '큰손' },
  { userId: 'kakao:2', character: '점수없음' },
  { userId: 'kakao:3', character: '저렙만' },
  { userId: 'kakao:4', character: '못찾음' },
];

test('the board adds the reference scores of 1720+ characters and keeps a failed lookup aside', async () => {
  const board = await expeditionBoard(entries);
  const order = board.sections[0].ranked.map((row) => row.character);
  assert.deepEqual(order, ['큰손', '한캐만', '점수없음', '저렙만']);
  assert.deepEqual(board.failed, ['못찾음']);
  assert.match(board.failedHint, /lopec\.kr/);
  assert.match(board.title, /로펙 점수 합/);
  assert.match(board.footer, /로펙 환산 점수 합/);
  const [top, , third, low] = board.sections[0].lines;
  // 1720 미만은 합계에서 빠지고, 줄에는 합·캐릭 수·역할·평균·템렙 합이 적힌다.
  assert.match(top, /큰손[\s\S]*최고 1,780/);
  assert.match(top, /로펙 합 \*\*13,500\*\* · 1720↑ \*\*2캐\*\* \(딜 2 · 폿 0\) · 평균 6,750 · 템렙 합 3,525/);
  // 점수가 0인 캐릭터는 합에서 0으로 세고 몇 캐인지 따로 적는다.
  assert.match(third, /로펙 합 \*\*3,000\*\*[\s\S]*점수 없음 1캐/);
  assert.match(low, /1720↑ 캐릭 없음 · 총 1캐/);
  assert.equal(stateWrites, 0);
});

test('both platforms print the score board and the buttons point at the other two rankings', async () => {
  globalThis.__scoreTierLinks = Object.fromEntries(entries.map((row) => [row.userId, row.character]));
  for (const platform of ['discord', 'kakao']) {
    const replies = [];
    const interaction = {
      platform, user: { id: entries[0].userId },
      guild: { members: { fetch: async ({ user }) => new Map(user.map((id) => [id, {}])) } },
      options: { getInteger: () => null },
      async deferReply() {}, async reply(value) { replies.push(value); }, async editReply(value) { replies.push(value); },
    };
    await execute(interaction);
    assert.equal(replies.length, 1);
    const text = platform === 'discord' ? JSON.stringify(replies[0].embeds[0].toJSON()) : replies[0].content;
    assert.match(text, /큰손[\s\S]*한캐만[\s\S]*점수없음[\s\S]*저렙만/);
    assert.match(text, /13,500/);
    assert.match(text, /못찾음/);
    assert.doesNotMatch(text, /undefined|NaN/);
    const ids = replies[0].components.flatMap((row) => row.toJSON().components.map((button) => button.custom_id));
    assert.deepEqual(ids, ['cmd:랭킹', 'cmd:환산가치']);
  }
  assert.equal(stateWrites, 0);
});
