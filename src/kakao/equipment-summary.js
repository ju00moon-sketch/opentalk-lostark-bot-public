import { getQuality, parseTooltip, stripTags } from '../tooltip.js';

const MAIN_TYPES = ['무기', '투구', '상의', '하의', '장갑', '어깨'];

export function formatEquipmentSummary(profile, equipment = []) {
  const items = Array.isArray(equipment) ? equipment : [];
  const main = MAIN_TYPES.map(type => items.find(item => item.Type === type)).filter(Boolean);
  const quality = item => {
    const value = getQuality(parseTooltip(item.Tooltip) ?? {});
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  };
  const line = (item, withQuality = true) => {
    const refinement = /^\+(\d+)(?:\s|$)/.exec(stripTags(item.Name));
    const value = withQuality ? quality(item) : null;
    return `${item.Grade ?? ''} ${item.Type}${refinement ? ` +${refinement[1]}` : ''}${value === null ? '' : `: ${value}`}`.trim();
  };
  const armlet = items.find(item => item.Type === '완갑');
  const lines = [...main.map(item => line(item)), ...(armlet ? [line(armlet, false)] : [])];
  const qualities = main.map(quality);
  const average = main.length === MAIN_TYPES.length && qualities.every(value => value !== null)
    ? (qualities.reduce((sum, value) => sum + value, 0) / qualities.length).toFixed(2)
    : '확인 불가';
  const itemLevel = Number(String(profile.ItemAvgLevel ?? '').replaceAll(',', ''));
  const level = Number.isFinite(itemLevel) && itemLevel > 0
    ? itemLevel.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '확인 불가';
  return [
    `❙ ${profile.CharacterName}님의 장비 정보`,
    lines.length ? lines.join('\n') : '장착한 장비 정보가 없습니다.',
    `• 아이템 레벨: ${level}\n• 평균 품질: ${average}`,
  ].join('\n\n');
}
