import { parseRoomIdentity } from './interaction.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DELIVERY_POLICY = Object.freeze(JSON.parse(readFileSync(new URL('./bridge-policy-defaults.json', import.meta.url), 'utf8')));
const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../../kakao-bridge-policy.json', import.meta.url));
const COUNT_MAX = { requestMessages: 5, requestChars: 4000, roomMessages: 60, roomChars: 30000, userMessages: 30, userChars: 15000 };
export const bridgeReadableLength = text => String(text ?? '').replace(/\u200b/g, '').length;

export function parseDeliveryPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_DELIVERY_POLICY, key))) return null;
  const result = { ...DEFAULT_DELIVERY_POLICY, ...value };
  for (const [key, number] of Object.entries(result)) {
    const maximum = key.endsWith('Ms') ? 7 * 86400000 : key === 'attemptLimit' ? 4096 : COUNT_MAX[key];
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) return null;
  }
  if (result.attemptTtlMs < Math.max(result.windowMs, result.repeatIntervalMs, result.roomIntervalMs, result.userIntervalMs)) return null;
  return result;
}

// Read only operator-owned configuration. Invalid or unavailable explicit configuration denies replies.
let lastRejection = null;
function rejectPolicy(stage) {
  if (lastRejection !== stage) console.warn(`[카카오 브리지 설정] 거부 단계: ${stage}`);
  lastRejection = stage;
  return { allowedRoomIds: [], delivery: DEFAULT_DELIVERY_POLICY };
}

export function readBridgePolicy(env = process.env) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(env.KAKAO_BRIDGE_POLICY_FILE || DEFAULT_POLICY_PATH, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' || env.KAKAO_BRIDGE_POLICY_FILE) return rejectPolicy(error instanceof SyntaxError ? 'json' : 'read');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['allowedRoomIds', 'delivery'].includes(key))) return rejectPolicy('shape');
  const delivery = parseDeliveryPolicy(config.delivery);
  if (!delivery) return rejectPolicy('delivery');
  let roomIds;
  try { roomIds = Object.hasOwn(config, 'allowedRoomIds') ? config.allowedRoomIds
    : env.KAKAO_BRIDGE_ALLOWED_ROOM_IDS === undefined ? [] : JSON.parse(env.KAKAO_BRIDGE_ALLOWED_ROOM_IDS); }
  catch { return rejectPolicy('allowlist'); }
  const allowedRoomIds = parseAllowedRoomIds(roomIds);
  if (!Array.isArray(roomIds) || (roomIds.length > 0 && allowedRoomIds.length === 0)) return rejectPolicy('allowlist');
  lastRejection = null;
  return { allowedRoomIds, delivery };
}

// Room IDs are opaque strings; large numeric IDs lose precision before comparison.
export function parseAllowedRoomIds(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value) || value.length > 128
    || value.some(roomId => !parseRoomIdentity({ source: 'android-conversation-shortcut-v1', roomId }))) return [];
  return [...new Set(value)];
}

export function isAllowedBridgeRoom(body, allowedRoomIds) {
  if (body?.isGroupChat !== true) return false;
  const identity = parseRoomIdentity(body.roomIdentity);
  return Boolean(identity && parseAllowedRoomIds(allowedRoomIds).includes(identity.roomId));
}
