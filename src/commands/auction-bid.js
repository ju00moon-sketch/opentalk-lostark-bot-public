// /경매금 — /분배금과 같은 계산기. 사용자 요청(2026-09-17)으로 이름만 다른 두 번째 진입점을 둔다.
// 옵션·계산·출력은 bid.js 그대로이며, 채팅 초성 ㄱㅁㄱ(text-commands.js)도 이 커맨드로 풀린다.
import { buildData, execute } from './bid.js';

export const data = buildData('경매금');
export { execute };
