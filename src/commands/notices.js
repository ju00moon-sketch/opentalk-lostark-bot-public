import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getNotices } from '../lostark.js';
import { fetchSiteNotices } from '../notice-site.js';
import { trunc, EMBED_COLOR } from '../format.js';

export const data = new SlashCommandBuilder()
  .setName('공지')
  .setDescription('로스트아크 최신 공지사항');

export const API_FOOTER = '제목을 누르면 공식 공지로 이동해요';
export const SITE_FOOTER = '공식 API 점검 중이라 홈페이지 공지 목록으로 표시했어요 · 제목을 누르면 공식 공지로 이동해요';

// 공식 API가 실패하면(점검 중 5xx 등) 홈페이지 공지 목록으로 대체한다. 둘 다 실패하면 원래의 API 오류를 그대로 낸다.
export function createNoticesExecute({ fetchNotices = getNotices, fetchSite = fetchSiteNotices } = {}) {
  return async (interaction) => {
    await interaction.deferReply();

    let notices;
    let footer = API_FOOTER;
    try {
      notices = await fetchNotices();
    } catch (err) {
      console.error('공지 API 실패, 홈페이지 목록으로 대체:', Number.isInteger(err?.status) ? `HTTP ${err.status}` : '요청 오류');
      notices = await fetchSite();
      if (!notices) throw err;
      footer = SITE_FOOTER;
    }
    if (!notices || notices.length === 0) {
      await interaction.editReply('공지사항을 가져오지 못했어요.');
      return;
    }

    const lines = notices.slice(0, 6).map(
      (n) => `\`${n.Type}\` [**${n.Title}**](${n.Link}) — ${String(n.Date).slice(5, 10).replace('-', '.')}`,
    );

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('📢 최신 공지사항')
      .setDescription(trunc(lines.join('\n'), 4096))
      .setFooter({ text: footer });

    await interaction.editReply({ embeds: [embed] });
  };
}

export const execute = createNoticesExecute();
