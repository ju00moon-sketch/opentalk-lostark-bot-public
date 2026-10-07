import { SlashCommandBuilder } from 'discord.js';
import { answerChat, CHAT_FAILED } from '../chat.js';
import { CHAT_MAX_QUESTION_LENGTH, CHAT_USAGE, parseChatQuestion } from '../chat-input.js';

export const data = new SlashCommandBuilder()
  .setName('챗')
  .setDescription('궁금한 질문을 보내고 답변을 받아요')
  .addStringOption((option) => option.setName('질문').setDescription('예: 무지개는 왜 생겨?')
    .setRequired(true).setMinLength(1).setMaxLength(CHAT_MAX_QUESTION_LENGTH));

export function createChatExecute({ answer = answerChat } = {}) {
  return async (interaction) => {
    const question = parseChatQuestion(interaction.options.getString('질문'));
    if (!question) {
      await interaction.reply({ content: CHAT_USAGE, allowedMentions: { parse: [] }, kakaoNoPublicStore: true });
      return;
    }
    await interaction.deferReply();
    let content;
    try {
      const key = JSON.stringify([interaction.platform ?? 'discord', interaction.guildId,
        interaction.channelId ?? interaction.attendanceIdentity?.roomId ?? interaction.roomName,
        interaction.attendanceIdentity?.userId ?? interaction.user?.id]);
      content = await answer(question, key);
    } catch {
      console.error('질문 답변 처리 실패');
      content = CHAT_FAILED;
    }
    await interaction.editReply({ content, allowedMentions: { parse: [], repliedUser: false }, kakaoPreserveWhitespace: true, kakaoNoPublicStore: true });
  };
}

export const execute = createChatExecute();
