import { createClient } from './quip.js';
import { parseChatQuestion, CHAT_USAGE } from './chat-input.js';

export const CHAT_MODEL = 'gpt-6-sol';
export const CHAT_TIMEOUT_MS = 20000;
export const CHAT_MAX_ANSWER_LENGTH = 1400;
export const CHAT_FAILED = '답변을 준비하지 못했어요. 잠시 후 다시 질문해 주세요.';
export const CHAT_TIMEOUT = '답변에 시간이 오래 걸리고 있어요. 질문을 조금 더 짧게 하거나 잠시 후 다시 시도해 주세요.';
const TRUNCATED = '\n… 답변이 길어 여기까지 표시했어요. 범위를 좁혀 다시 질문해 주세요.';

const INSTRUCTIONS = [
  '사용자의 질문에 정확하고 유용하게 답하세요. 기본은 한국어 존댓말이며, 번역 등 요청에 따라 언어를 바꿀 수 있습니다.',
  '답부터 말하고 필요한 이유나 예시를 덧붙이세요. 채팅에서 읽기 좋게 보통 1~3개의 짧은 문단, 최대 1,000자로 답하세요.',
  '이번 질문만 주어집니다. 이전 대화나 사용자 정보를 추측하지 마세요. 웹 검색과 실시간 게임 정보 조회는 제공되지 않으므로 최신 정보나 출처를 확인한 것처럼 말하지 마세요.',
].join('\n');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const SEASONS = ['겨울', '겨울', '봄', '봄', '봄', '여름', '여름', '여름', '가을', '가을', '가을', '겨울'];

// 모델은 오늘 날짜를 모르므로 한국 시간 기준 날짜·요일·계절을 지시문에 붙인다(9월 질문에 "봄"이라 답한 신고, 2026-09-17).
export function dateContextLine(now = Date.now()) {
  const kst = new Date(now + KST_OFFSET_MS);
  const month = kst.getUTCMonth();
  return `오늘은 한국 시간 ${kst.getUTCFullYear()}년 ${month + 1}월 ${kst.getUTCDate()}일 (${WEEKDAYS[kst.getUTCDay()]}요일)이고 계절은 ${SEASONS[month]}입니다. 날짜·계절·시기가 관련된 질문은 이 기준으로 답하세요.`;
}

export function buildChatRequest(question, { now = Date.now } = {}) {
  return { model: CHAT_MODEL, instructions: `${INSTRUCTIONS}\n${dateContextLine(now())}`, input: question, max_output_tokens: 4096, store: false };
}

function responseText(response) {
  if (response?.status !== 'completed' || !Array.isArray(response.output)) return null;
  const messages = response.output.filter((item) => item.type === 'message');
  if (!messages.length || messages.some((item) => item.status !== 'completed' || !Array.isArray(item.content))) return null;
  const blocks = messages.flatMap((item) => item.content);
  // API의 거절도 사용자에게 전달할 답변이다. 추론 내용은 내보내지 않는다.
  const texts = blocks.map((block) => block.type === 'output_text' ? block.text : block.type === 'refusal' ? block.refusal : null);
  if (texts.some((text) => typeof text !== 'string')) return null;
  const text = texts.join('\n').trim();
  if (!text) return null;
  if (text.length <= CHAT_MAX_ANSWER_LENGTH) return text;
  const end = CHAT_MAX_ANSWER_LENGTH - TRUNCATED.length;
  return text.slice(0, end).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + TRUNCATED;
}

export function createChatResponder({ client, timeoutMs = CHAT_TIMEOUT_MS, now = Date.now } = {}) {
  let resolvedClient = client;
  const inFlight = new Map();
  return async (input, userKey) => {
    const question = parseChatQuestion(input);
    if (!question) return CHAT_USAGE;
    if (resolvedClient === undefined) resolvedClient = createClient({ env: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY, QUIP_PROVIDER: 'openai', QUIP_MODEL: CHAT_MODEL,
    } });
    if (!resolvedClient?.responses?.create) return '질문 답변 기능이 아직 연결되지 않았어요. 운영자에게 알려 주세요.';
    const key = userKey || Symbol();
    const current = inFlight.get(key);
    if (current) return current.question === question ? current.job : '이전 질문에 답변하고 있어요. 답변을 받은 뒤 다시 질문해 주세요.';
    const job = Promise.resolve().then(async () => {
      try {
        const response = await resolvedClient.responses.create(buildChatRequest(question, { now }), {
          signal: AbortSignal.timeout(timeoutMs), timeout: timeoutMs, maxRetries: 0,
        });
        return responseText(response) ?? CHAT_FAILED;
      } catch (err) {
        const timedOut = /^(AbortError|TimeoutError)$/.test(err?.name);
        console.error('질문 답변 실패:', timedOut ? '시간 초과' : Number.isInteger(err?.status) ? `HTTP ${err.status}` : '요청 오류');
        return timedOut ? CHAT_TIMEOUT : CHAT_FAILED;
      }
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, { question, job });
    return job;
  };
}

export const answerChat = createChatResponder();
