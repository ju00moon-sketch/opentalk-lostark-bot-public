const GEM_NAMES = { 겁: '겁화', 겁화: '겁화', 작: '작열', 작열: '작열' };

// 줄임말과 정식 이름을 같은 경매장 검색 조건으로 바꾼다.
export function parseGemSearch(input) {
  if (typeof input !== 'string') return null;
  const text = input.normalize('NFC').trim();
  const levelFirst = /^(10|[1-9])(?:레벨)?\s*(겁화|작열|겁|작)(?:의\s*보석)?$/.exec(text);
  const typeFirst = /^(겁화|작열|겁|작)\s*(10|[1-9])(?:레벨)?$/.exec(text);
  if (levelFirst) return { 종류: GEM_NAMES[levelFirst[2]], 레벨: Number(levelFirst[1]) };
  if (typeFirst) return { 종류: GEM_NAMES[typeFirst[1]], 레벨: Number(typeFirst[2]) };
  return null;
}
