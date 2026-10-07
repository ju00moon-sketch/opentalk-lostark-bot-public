export const CHAT_MAX_QUESTION_LENGTH = 2000;
export const CHAT_USAGE = '/챗 질문 (1~2,000자, 예: /챗 무지개는 왜 생겨?)';

export const isChatCommandInput = (text) => /^[./]챗(?:\s|$)/u.test(String(text ?? '').trimStart());

export function parseChatQuestion(input) {
  if (typeof input !== 'string') return null;
  const question = input.trim();
  return question && question.length <= CHAT_MAX_QUESTION_LENGTH ? question : null;
}
