const MAX_ID = 9223372036854775807n;
export class WelcomeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const requireWelcome = (ok, code) => { if (!ok) throw new WelcomeError(code); };

// Iris serializes DB integers as strings; preserve large integers inside feed JSON too.
export function parseWelcomeJson(text) {
  try {
    return JSON.parse(text, (_key, value, context) =>
      typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
        ? context.source : value);
  } catch { throw new WelcomeError('INVALID_JSON'); }
}

export function welcomeId(value) {
  requireWelcome(typeof value === 'string' || Number.isSafeInteger(value), 'INVALID_ID');
  const text = String(value);
  requireWelcome(/^[1-9]\d{0,18}$/.test(text) && BigInt(text) <= MAX_ID, 'INVALID_ID');
  return text;
}

export function welcomeName(value) {
  requireWelcome(typeof value === 'string' && value.trim().length > 0 && value.length <= 100
    && !/[\r\n\u0000-\u001f\u007f\ufffd]/u.test(value), 'INVALID_NICKNAME');
  return value;
}

export function welcomeRoomName(value) {
  requireWelcome(typeof value === 'string' && value.trim().length > 0 && value.length <= 1000
    && !/[\r\n\u0000-\u001f\u007f\ufffd]/u.test(value), 'INVALID_ROOM_NAME');
  return value;
}

export function parseWelcomeEvent(envelope) {
  const raw = envelope?.json;
  requireWelcome(raw && typeof raw === 'object' && !Array.isArray(raw), 'IRIS_ENVELOPE_REQUIRED');
  const roomId = welcomeId(raw.chat_id);
  const eventId = welcomeId(raw.id ?? raw._id);
  const createdAt = String(raw.created_at ?? '');
  requireWelcome(/^\d{10}$/.test(createdAt), 'UNIX_SECONDS_REQUIRED');
  const at = Number(createdAt) * 1000;
  const v = typeof raw.v === 'string' ? parseWelcomeJson(raw.v) : raw.v;
  requireWelcome(v && typeof v === 'object', 'IRIS_ORIGIN_REQUIRED');
  const common = { roomId, eventId, at };
  if (v.origin === 'MSG') return { ...common, actorId: welcomeId(raw.user_id), kind: 'message' };
  if (v.origin !== 'NEWMEM') return { ...common, kind: 'ignored' };
  requireWelcome(String(raw.type) === '0', 'JOIN_FEED_REQUIRED');
  const feed = typeof raw.message === 'string' ? parseWelcomeJson(raw.message) : raw.message;
  requireWelcome(feed && Number(feed.feedType) === 4, 'OPEN_JOIN_FEED_REQUIRED');
  // OPENLINK_JOIN carries members, not the sender/inviter of the feed.
  requireWelcome(Array.isArray(feed.members) && feed.members.length > 0 && feed.members.length <= 100,
    'JOIN_MEMBERS_REQUIRED');
  const members = feed.members.map((member) => ({ id: welcomeId(member?.userId), name: welcomeName(member?.nickName) }));
  requireWelcome(new Set(members.map((member) => member.id)).size === members.length, 'DUPLICATE_JOIN_MEMBER');
  return { ...common, kind: 'join', members };
}

export function welcomeKst(at) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23' }).formatToParts(new Date(at));
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function formatWelcome(name, roomName) {
  return `${welcomeName(name)}님 "${welcomeRoomName(roomName)}"에 어서오세요!\n즐거운 길드 생활 되세요!`;
}

export function formatPreviousEntry(entry) {
  return `이전 이름: ${welcomeName(entry.name)}\n날짜: ${welcomeKst(entry.at)}`;
}

export function createWelcomeHandler({ store, iris, rooms, botId, send = false, now = Date.now,
  maxAgeMs = 120_000, startedAt = now() }) {
  const allowed = new Set(rooms.map(welcomeId));
  botId = welcomeId(botId);
  requireWelcome(allowed.size > 0, 'ROOM_ALLOWLIST_REQUIRED');
  store.assertBaseline(botId, [...allowed]);
  const started = Math.floor(startedAt / 1000) * 1000;
  let prunedAt = now();
  store.prune(prunedAt);
  let pending = Promise.resolve();
  async function process(envelope) {
    // Reject unrelated rooms before parsing their content or querying user profiles.
    const roomId = welcomeId(envelope?.json?.chat_id);
    if (!allowed.has(roomId)) return { status: 'ignored_room' };
    const event = parseWelcomeEvent(envelope);
    if (event.kind === 'ignored') return { status: 'ignored_event' };
    const observedAt = now();
    if (observedAt - prunedAt >= 86_400_000) { store.prune(observedAt); prunedAt = observedAt; }
    if (event.at < started || observedAt - event.at > maxAgeMs) return { status: 'stale' };
    requireWelcome(event.at <= observedAt + 5_000, 'FUTURE_EVENT');
    if (store.hasEvent(event.roomId, event.eventId)) return { status: 'duplicate' };
    requireWelcome(await iris.getBotId() === botId, 'IRIS_ACCOUNT_CHANGED');
    if (event.kind === 'message') {
      if (event.actorId === botId) return { status: 'ignored_self' };
      const name = welcomeName(await iris.getName(event.roomId, event.actorId));
      requireWelcome(await iris.getBotId() === botId, 'IRIS_ACCOUNT_CHANGED');
      store.observe({ ...event, observedAt: now() }, name);
      return { status: 'observed_name' };
    }
    // Resolve every member before storing any snapshot or submitting any reply.
    const members = [];
    if (send) requireWelcome(!store.hasUnconfirmed(), 'UNCONFIRMED_REPLY_REQUIRES_REVIEW');
    requireWelcome(typeof iris.getRoomName === 'function', 'ROOM_NAME_LOOKUP_REQUIRED');
    const roomName = welcomeRoomName(await iris.getRoomName(event.roomId));
    for (const member of event.members) {
      if (member.id === botId) continue;
      // Query validates the actual member's current profile. The welcome uses the
      // feed's nickname, which is the name recorded at the actual entry time.
      const latestName = welcomeName(await iris.getName(event.roomId, member.id));
      members.push({ ...member, latestName, latestAt: now() });
    }
    if (now() - event.at > maxAgeMs) return { status: 'stale' };
    requireWelcome(await iris.getBotId() === botId, 'IRIS_ACCOUNT_CHANGED');
    const prepared = store.prepareJoin(event, members, send ? 'reserved' : 'simulated', roomName);
    if (prepared === null) return { status: 'duplicate' };
    if (!send) return { status: 'simulated', results: prepared.map((item) => ({
      memberId: item.id, status: 'simulated', messages: item.messages.map(({ text }) => text),
    })) };
    // Iris uses a conflated channel. Confirm each individual message in the
    // outgoing log before submitting the next member or previous-entry message.
    let stopped = false;
    for (const item of prepared) {
      for (const message of item.messages) {
        if (stopped) break;
        let status = 'confirmed_in_iris';
        try { await iris.reply(event.roomId, message.text, botId); }
        catch { status = 'uncertain'; stopped = true; }
        store.finishMessage(event.roomId, event.eventId, message.sequence, status);
      }
    }
    return { status: 'processed', results: prepared.map((item) => ({ memberId: item.id,
      status: store.welcomeStatus(event.roomId, event.eventId, item.id) })) };
  }
  return (envelope) => {
    const result = pending.then(() => process(envelope));
    pending = result.catch(() => {});
    return result;
  };
}
