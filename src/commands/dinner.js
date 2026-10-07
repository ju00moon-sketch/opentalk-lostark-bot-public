import { SlashCommandBuilder } from 'discord.js';
import { createMealExecute } from '../meals.js';

export const data = new SlashCommandBuilder()
  .setName('저메추')
  .setDescription('오늘 저녁 메뉴 한 가지에 관한 짧은 한마디를 들려드려요');

export const execute = createMealExecute('dinner');
