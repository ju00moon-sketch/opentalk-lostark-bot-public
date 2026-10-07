import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { gold, EMBED_COLOR } from '../format.js';
import { blocks } from '../kakao/layout.js';
import { searchMarketItems } from '../lostark.js';
import { evenShareBid, preemptBid, resaleCap } from '../bid-calculation.js';

const PARTY_SIZES = [4, 8, 16];
const ENGRAVING_CATEGORY = 40000;
const RELIC = '유물';

// /경매금은 이 정의를 이름만 바꿔 그대로 쓴다 (auction-bid.js).
export function buildData(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription('경매 아이템의 입찰가를 계산합니다 (선점 추천가 · 균등 분배가 · 재판매 상한)')
    .addIntegerOption((option) =>
      option
        .setName('가격')
        .setDescription('아이템의 거래소 시세 (골드)')
        .setRequired(true)
        .setMinValue(1),
    )
    .addIntegerOption((option) =>
      option
        .setName('인원')
        .setDescription('공격대 인원 (기본: 4/8/16 모두 표시)')
        .addChoices(
          { name: '4인', value: 4 },
          { name: '8인', value: 8 },
          { name: '16인', value: 16 },
        ),
    );
}

export const data = buildData('분배금');

// 세 값 모두 중간 계산에서는 소수를 그대로 두고, 화면에 적을 때만 gold()가 버린다.
//
// 나눗셈은 반드시 마지막에 한 번만 한다. 0.95나 1.1처럼 2진수로 딱 떨어지지 않는 수로 나눠 가며
// 계산하면 오차가 쌓여, 답이 정수로 떨어지는 경우까지 어긋난다 —
// 8,800G·4인의 추천가는 정확히 5,700G인데 순서대로 계산하면 5699.999…가 나와 버림에서 1G가 깎였다.
// 분자를 정수로 모아 두고 한 번만 나누면 나눗셈이 한 번뿐이라 그 자리에서 가장 가까운 값으로 떨어진다.

// 균등 분배 기준값: 낙찰자의 재판매 이익과 나머지 인원이 받는 분배금이 같아지는 입찰가.
//   낙찰하면 0.95 x 시세 - B, 낙찰 안 하면 B / (인원-1) → 두 값이 같아지는 B = 0.95 x 시세 x (인원-1)/인원

// 선점 기준 추천가 — 균등 분배 기준값을 1.1로 나눠(= 10/11을 곱해) 낙찰 쪽에 여유를 둔다.

// 재판매 원금 회수 상한 — 되팔아 원금을 회수할 수 있는 한계선(인원과 무관).

const SECTION = {
  preempt: '추천 입찰가 · 선점 기준',
  even: '균등 분배 입찰가',
  cap: '재판매 원금 회수 상한',
};

// 분배금 입력에서 지원하는 각인 줄임말을 정식 이름으로 되돌린다.
const ENGRAVING_NAMES = new Map([
  ['예둔', '예리한 둔기'], ['기습', '기습의 대가'], ['돌대', '돌격대장'],
  ['아드', '아드레날린'], ['저받', '저주받은 인형'], ['질증', '질량 증가'],
  ['타대', '타격의 대가'], ['결대', '결투의 대가'],
]);

// 띄어쓰기를 무시하고 이름을 견주기 위한 꼴 — "질량증가"와 "질량 증가"가 같은 키가 된다.
const compact = (name) => String(name ?? '').normalize('NFC').replace(/\s+/g, '');
const bookName = (name) => `${RELIC} ${name} 각인서`;

// 거래소가 주는 유물 각인서 품명 목록 — 띄어쓰기 없이 친 이름을 정식 품명으로 되돌릴 때만 쓴다.
// 품명은 바뀌지 않으므로 6시간 캐시. 값(띄어쓰기 뺀 품명 → 정식 품명)만 두고 가격은 캐시하지 않는다.
const BOOK_LIST_TTL_MS = 6 * 60 * 60 * 1000;
const BOOK_LIST_MAX_PAGES = 10;
let bookList = null; // { at, byCompact: Map }
let bookListLoading = null;

const isRelicBook = (item) => item?.Grade === RELIC && typeof item.Name === 'string';

async function fetchRelicBookNames(search) {
  const byCompact = new Map();
  for (let page = 1; page <= BOOK_LIST_MAX_PAGES; page += 1) {
    const result = await search(ENGRAVING_CATEGORY, '', { grade: RELIC, page });
    const items = Array.isArray(result?.Items) ? result.Items : [];
    for (const item of items) if (isRelicBook(item)) byCompact.set(compact(item.Name), item.Name);
    const pageSize = result?.PageSize ?? items.length;
    if (items.length === 0 || page * pageSize >= (result?.TotalCount ?? 0)) break;
  }
  return byCompact;
}

async function relicBookNames(search, now) {
  if (bookList && now - bookList.at < BOOK_LIST_TTL_MS) return bookList.byCompact;
  if (!bookListLoading) {
    bookListLoading = fetchRelicBookNames(search)
      .then((byCompact) => { bookList = { at: now, byCompact }; return byCompact; })
      .finally(() => { bookListLoading = null; });
  }
  return bookListLoading;
}

// 시험용 — 품명 목록 캐시를 비운다.
export function resetBookListCache() {
  bookList = null;
  bookListLoading = null;
}

// 정식 품명과 정확히 일치하는 유물 각인서 매물만 고른다.
async function findExactBook(search, fullName) {
  const result = await search(ENGRAVING_CATEGORY, fullName, { grade: RELIC });
  return (Array.isArray(result?.Items) ? result.Items : [])
    .filter((item) => isRelicBook(item) && item.Name === fullName);
}

// 입력한 각인서명을 유물 각인서 매물로 푼다. 줄임말과 띄어쓰기는 무시하되 다른 이름으로 넓히지는 않는다.
//   1) 줄임말은 정식 이름으로 바꾸고 정확한 품명으로 조회한다.
//   2) 못 찾으면(띄어쓰기를 안 친 경우) 거래소의 유물 각인서 품명 목록에서 띄어쓰기를 뺀 꼴이 같은 품명을 찾아 다시 조회한다.
// 반환: { fullName, matches } — matches가 비어 있으면 그런 각인서가 없다.
export async function resolveRelicBook(input, { search = searchMarketItems, now = Date.now } = {}) {
  const typed = String(input ?? '').normalize('NFC').trim();
  const name = ENGRAVING_NAMES.get(compact(typed)) ?? typed;
  let fullName = bookName(name);
  let matches = await findExactBook(search, fullName);
  if (!matches.length) {
    const canonical = (await relicBookNames(search, now())).get(compact(fullName));
    if (canonical && canonical !== fullName) {
      fullName = canonical;
      matches = await findExactBook(search, fullName);
    }
  }
  return { fullName, matches };
}

// "4인: 30,225G" 줄 묶음 — 인원을 지정하면 그 인원 한 줄만.
const bidLines = (price, sizes, calc) => sizes.map((n) => `${n}인: ${gold(calc(price, n))}`);

// 시험에서 시세 조회를 바꿔 끼울 수 있게 실행 함수를 만들어 준다. /경매금도 같은 실행 함수를 쓴다.
export function createExecute({ search = searchMarketItems, now = Date.now } = {}) {
  return async function execute(interaction) {
    let price = interaction.options.getInteger('가격');
    const book = interaction.options.getString('각인서');
    const partySize = interaction.options.getInteger('인원');
    const sizes = partySize ? [partySize] : PARTY_SIZES;
    let priceNote = null;

    if (book) {
      await interaction.deferReply();
      let resolved;
      try {
        resolved = await resolveRelicBook(book, { search, now });
      } catch {
        await interaction.editReply('유물 각인서 시세를 조회하지 못했어요. 잠시 후 다시 시도해 주세요.');
        return;
      }
      const { fullName, matches } = resolved;
      if (!matches.length) {
        await interaction.editReply('유물 각인서를 찾지 못했어요. 정확한 각인서명을 입력해 주세요.');
        return;
      }
      // 매물의 묶음 가격을 권당 가격으로 바꾸며, 다른 등급이나 부분 일치 품목은 사용하지 않는다.
      const prices = matches.filter((item) => Number.isFinite(item.CurrentMinPrice) && item.CurrentMinPrice > 0
        && Number.isSafeInteger(item.BundleCount) && item.BundleCount > 0)
        .map((item) => item.CurrentMinPrice / item.BundleCount);
      if (!prices.length) {
        await interaction.editReply('이 유물 각인서의 현재 최저가를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.');
        return;
      }
      price = Math.min(...prices);
      priceNote = `${fullName} · 현재 최저가`;
    }

    const reply = (payload) => interaction.deferred ? interaction.editReply(payload) : interaction.reply(payload);

    const title = `분배금 계산기 — 시세 ${gold(price)}`;
    const preempt = bidLines(price, sizes, preemptBid);
    const even = bidLines(price, sizes, evenShareBid);
    const cap = gold(resaleCap(price));

    // 카카오톡: 임베드 필드 격자가 없으므로 제목·구획·주의를 기호와 빈 줄로만 나눈 평문으로 보낸다.
    // 계산은 위에서 이미 끝나 있어 두 플랫폼의 숫자는 같다.
    if (interaction.platform === 'kakao') {
      await reply({
        content: blocks(
          [title, priceNote].filter(Boolean).join('\n'),
          [`❙ ${SECTION.preempt}`, ...preempt].join('\n'),
          [`❙ ${SECTION.even}`, ...even].join('\n'),
          [`❙ ${SECTION.cap}`, cap].join('\n'),
        ),
        allowedMentions: { parse: [] },
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(title)
      .addFields(
        { name: `❙ ${SECTION.preempt}`, value: preempt.join('\n') },
        { name: `❙ ${SECTION.even}`, value: even.join('\n') },
        { name: `❙ ${SECTION.cap}`, value: cap },
      );
    if (priceNote) embed.setDescription(priceNote);

    await reply({ embeds: [embed], allowedMentions: { parse: [] } });
  };
}

export const execute = createExecute();
