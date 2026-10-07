import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { EMBED_COLOR } from '../format.js';
import { goldPriceBoard, boardLines, BOARD_TITLE, SOURCE_NAME } from '../gold-price.js';

// 서버별 골드 시세 — 게임비트(중개 사이트) 일봉의 지금 가격을 1만 골드당 원으로, 전일 종가 대비 변동과 함께.
// 양식은 사용자가 지정한 그대로다: 제목 한 줄 + "• 서버: N원 (📉 N)" 여덟 줄. 카톡은 이 본문만, 디스코드는 임베드에 출처 푸터를 더한다.
export const data = new SlashCommandBuilder()
  .setName('골드시세')
  .setDescription('서버별 골드 시세 — 중개 사이트 기준 1만 골드당 원 (지금 가격, 전일 대비 변동)');

export const UNAVAILABLE = '골드 시세를 가져오지 못했어요. 잠시 뒤 다시 시도해 주세요.';
const two = (n) => String(n).padStart(2, '0');
const kstStamp = (ms) => {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
};
const shortDate = (date) => (typeof date === 'string' ? `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}` : '-');

export function createExecute({ board = goldPriceBoard } = {}) {
  return async function execute(interaction) {
    await interaction.deferReply();
    let result = null;
    try { result = await board.get(); } catch { result = null; }
    if (!result || result.servers.every((row) => row.error)) {
      await interaction.editReply(UNAVAILABLE);
      return;
    }
    const lines = boardLines(result);
    if (interaction.platform === 'kakao') {
      await interaction.editReply(`❙ ${BOARD_TITLE}\n${lines.join('\n')}`);
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('💰 골드 시세')
      .setDescription(`**${BOARD_TITLE}**\n${lines.join('\n')}`)
      .setFooter({ text: `${SOURCE_NAME} · ${shortDate(result.date)} 현재가 · 전일 대비 변동 · 조회 ${kstStamp(result.fetchedAt)}` });
    await interaction.editReply({ embeds: [embed] });
  };
}

export const execute = createExecute();
