export const VERSUS_MAX_LENGTH = 180;
export const VERSUS_USAGE = '서로 다른 두 대상을 입력해 주세요. 예: 노트북 vs 컴퓨터 · .vs 노트북 vs 컴퓨터 (각 80자 이내)';
const separator = /(^|[^a-z/\\])vs\.?(?=$|[^a-z./\\])/gi;
const link = /(?:https?:\/\/|www\.)\S+/i;
const keyOf = (value) => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();

// 영문 단어 내부의 vs는 제외하고 한국어·숫자 선택지는 붙여 쓰기도 받는다.
export function isBareVersusInput(input) {
  if (typeof input !== 'string' || /^[.!/\[]/.test(input.trim()) || link.test(input)) return false;
  return !input.matchAll(separator).next().done;
}

export function parseVersusInput(input) {
  if (typeof input !== 'string' || input.length > VERSUS_MAX_LENGTH || /[\r\n\u0000-\u001f\u007f]/.test(input) || link.test(input)) return null;
  const matches = [...input.matchAll(separator)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const left = input.slice(0, match.index + match[1].length).trim();
  const right = input.slice(match.index + match[0].length).trim();
  if (!left || !right || left.length > 80 || right.length > 80 || keyOf(left) === keyOf(right)) return null;
  if (/[<>\u200b-\u200f\u202a-\u202e\u2066-\u2069]|@everyone|@here/i.test(left + right)) return null;
  return { left, right };
}
