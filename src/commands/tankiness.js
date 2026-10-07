import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBED_COLOR } from '../format.js';

// 공개 사본에는 원본 차트 이미지를 포함하지 않는다.
// 권리를 확인한 차트를 직접 추가하면 이미지 응답을 사용할 수 있다.
const CHART_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'charts', 'chembang.png',
);

export const data = new SlashCommandBuilder()
  .setName('체방')
  .setDescription('직업별 체방(체력×방어력) 계수표');

// scripts/chembang-chart.html의 숫자 표를 텍스트로도 제공한다.
const TEXT_TABLE = [
  '직업별 체방(체력×방어력) 계수 · 2026-08-29 기준',
  '홀리나이트(중갑3) 4.62 · 바드(중갑) 3.60 · 도화가(중갑) 3.60 · 블래스터(포격) 3.50',
  '홀리나이트(중갑1) 2.77 · 워로드 2.50 · 가디언나이트 2.42 · 스카우터(변신) 2.40 · 디스트로이어 2.20',
  '브레이커 2.11 · 인파이터 2.11 · 데모닉(변신) 2.10 · 슬레이어 2.02 · 버서커 2.02',
  '스트라이커 1.93 · 창술사 1.93 · 배틀마스터 1.93 · 홀리나이트(딜) 1.93 · 발키리(딜) 1.93',
  '블래스터(화강1) 1.84 · 기공사 1.84 · 블레이드 1.83 · 버서커(광기) 1.80',
  '소울이터 1.75 · 기상술사 1.75 · 환수사 1.75 · 데모닉 1.75 · 블래스터 1.75',
  '호크아이 1.66 · 서머너 1.66 · 아르카나 1.66 · 소서리스 1.66',
  '데빌헌터 1.58 · 건슬링어 1.58 · 스카우터 1.58 · 리퍼 1.58 · 바드(딜) 1.50 · 도화가(딜) 1.50',
  '수치가 높을수록 단단해요 · 수치 출처: 다로아(daloa.xyz)',
].join('\n');

export async function execute(interaction) {
  if (!existsSync(CHART_PATH)) {
    await interaction.reply(TEXT_TABLE);
    return;
  }

  const file = new AttachmentBuilder(CHART_PATH, { name: 'chembang.png' });
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('🛡️ 직업별 체방 계수')
    .setImage('attachment://chembang.png')
    .setFooter({ text: '2026-08-29 기준 · 수치가 높을수록 단단해요' });

  await interaction.reply({ embeds: [embed], files: [file] });
}
