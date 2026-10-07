import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { optimizeHoning } from '../honing-optimizer.js';
import { honingPrices } from '../honing-prices.js';
import { amount, trunc, EMBED_COLOR } from '../format.js';
import { TITLE } from '../kakao/layout.js';

// 일반 재련을 목표 단계까지 올릴 때의 최저 기대 비용과, 매 시도에 넣을 보조 재료를 알려 준다.
// 계산은 `honing-optimizer.js`, 시세는 `honing-prices.js`. 여기서는 표시만 한다.
export const data = new SlashCommandBuilder()
  .setName('강화')
  .setDescription('재련 최저 비용 — 숨결·책을 어떻게 넣는 게 가장 싼지 현재 시세로 계산')
  .addStringOption(option => option.setName('부위').setDescription('무기 또는 방어구').setRequired(true)
    .addChoices({ name: '무기', value: 'weapon' }, { name: '방어구', value: 'armor' }))
  .addIntegerOption(option => option.setName('현재').setDescription('지금 재련 단계 (예: 18)').setRequired(true).setMinValue(0).setMaxValue(24))
  .addIntegerOption(option => option.setName('목표').setDescription('올리고 싶은 단계 (예: 20)').setRequired(true).setMinValue(1).setMaxValue(25));

export const USAGE = '강화 부위 현재 목표 (예: /강화 무기 18 20)';
const PRICE_FAILED = '거래소에서 재련 재료 시세를 받지 못했어요. 잠시 후 다시 시도해 주세요';
const RANGE_FAILED = '현재 단계보다 높은 목표 단계를 적어 주세요 (0~25)';
const KIND_LABEL = { weapon: '무기', armor: '방어구' };
const NOTE_TEXT = {
  book_none_for_stage: '+21 이상은 거래소에 재련 책이 없어 숨결만 계산했어요',
  book_price_unavailable: '일부 책 시세를 받지 못해 그 단계는 책 없이 계산했어요',
  breath_price_unavailable: '숨결 시세를 받지 못해 숨결 없이 계산했어요',
  breath_table_missing: '일부 낮은 단계는 숨결 수치 자료가 없어 빼고 계산했어요',
  growth_shards_unverified: '일부 낮은 단계는 장비 성장 파편 자료가 없어 그만큼은 합계에 넣지 못했어요',
};

const gold = value => `${amount(Math.round(value))} G`;
const percent = bps => `${(bps / 100).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}%`;

// 한 단계에서 실제로 무엇을 넣으라는 것인지 한 줄로. 장인의 기운이 차면 보조 재료가 빠지므로
// 회차마다 답이 달라진다 — 같은 선택이 이어지는 구간으로 묶어 "몇 회차까지 무엇"으로 적는다.
const describe = row => {
  const parts = [];
  if (row.book) parts.push('책 1개');
  if (row.breath > 0) parts.push(`숨결 ${row.breath}개`);
  return parts.length ? parts.join(' + ') : '보조 재료 없이';
};

// 뒤쪽 구간은 거기까지 실패를 거듭해야 닿으므로 대부분 확률이 0에 가깝다.
// 실제로 그 회차를 볼 가능성이 이만큼은 되어야 조언에 적는다.
const REACHABLE = 0.05;

export function adviceFor(stage) {
  // 확정 성공 회차는 아무것도 넣지 않으므로 조언에서 뺀다.
  const segments = (stage.segments ?? []).filter(segment => !segment.guaranteed);
  if (!segments.length) return '보조 재료 없이';
  // 첫 구간은 항상 적고, 뒤 구간은 실제로 그 회차를 볼 가능성이 있을 때만 적는다.
  const shown = segments.filter((segment, index) => index === 0 || segment.reachProbability >= REACHABLE);
  if (shown.length === 1) return describe(shown[0]);
  // 닿는 구간은 전부 적는다. 넷에서 자르고 「그 뒤는 전체 보기」라고 쓰면 도달 확률 90%가 넘는
  // 구간까지 감춰지는데, 실제로 펼쳐 볼 수단이 없다.
  return shown.map(segment =>
    `${segment.from === segment.to ? `${segment.from}회` : `${segment.from}-${segment.to}회`} ${describe(segment)}`)
    .join(' · ');
}

export function boardLines(result) {
  const lines = [`${KIND_LABEL[result.kind]} +${result.from} → +${result.to}`, ''];
  for (const stage of result.stages) {
    lines.push(`+${stage.from}→+${stage.to} · 기본 ${percent(stage.successBps)} · ${gold(stage.expectedGold)}`);
    lines.push(`   ${adviceFor(stage)} → 첫 시도 ${percent(stage.plan[0].successBps)} · 평균 ${stage.expectedAttempts.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}회`);
  }
  const saved = result.plainGold - result.expectedGold;
  lines.push('', `합계 ${gold(result.expectedGold)}`);
  lines.push(`보조 재료 없이 두드리면 ${gold(result.plainGold)} — ${gold(saved)} 아낍니다 (${(saved / result.plainGold * 100).toFixed(1)}%)`);
  return lines;
}

export function footerFor(result, at, now = Date.now()) {
  const minutes = Math.floor((now - at) / 60000);
  const parts = ['거래소 최저가 기준 기대 비용', '실링·귀속 재료 제외',
    minutes > 0 ? `${minutes}분 전 시세` : '방금 조회한 시세'];
  for (const note of result.notes) if (NOTE_TEXT[note]) parts.push(NOTE_TEXT[note]);
  return parts.join(' · ');
}

// 의존성을 주입할 수 있게 실행 함수를 만드는 공장 — 테스트에서 시세를 대역으로 바꾼다.
export function createExecute({ prices = honingPrices, optimize = optimizeHoning } = {}) {
  return async function execute(interaction) {
    const kind = interaction.options.getString('부위');
    const from = interaction.options.getInteger('현재');
    const to = interaction.options.getInteger('목표');
    if (!KIND_LABEL[kind] || !Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
      await interaction.reply(RANGE_FAILED);
      return;
    }
    await interaction.deferReply();

    const { priceOf, at, missing } = await prices.load();
    if (missing.length) {
      await interaction.editReply(PRICE_FAILED);
      return;
    }
    const result = optimize({ kind, from, to, priceOf });
    if (!result || result.status !== 'ok') {
      await interaction.editReply(result?.reason === 'material_price_unavailable' ? PRICE_FAILED
        : `+${from} → +${to} 구간은 아직 계산할 자료가 없어요`);
      return;
    }

    const body = boardLines(result).join('\n');
    const footer = footerFor(result, at);
    if (interaction.platform === 'kakao') {
      await interaction.editReply({ content: `${TITLE(`${KIND_LABEL[kind]} 재련 최저 비용`)}\n${body}\n\n${footer.split(' · ').join('\n')}` });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`⚒️ ${KIND_LABEL[kind]} 재련 최저 비용`)
      .setDescription(trunc(body, 4096))
      .setFooter({ text: trunc(footer, 2048) });
    await interaction.editReply({ embeds: [embed] });
  };
}

export const execute = createExecute();
