import { setTimeout as sleep } from 'node:timers/promises';
import { parseWelcomeEvent, requireWelcome, welcomeId, welcomeName, welcomeRoomName, WelcomeError } from './welcome.js';

// Keep the protocol library injected: importing this module never logs in or opens a socket.
export function createWelcomeLoco({ client, Long, rooms, botId, send = false, timeoutMs = 5_000,
  confirmTimeoutMs = 10_000, now = Date.now, pause = sleep }) {
  requireWelcome(client && typeof client.pushReceived === 'function'
    && typeof client.request === 'function' && typeof Long?.fromString === 'function'
    && typeof Long?.isLong === 'function', 'LOCO_CLIENT_REQUIRED');
  const id = (value) => welcomeId(Long.isLong(value) ? value.toString() : value);
  const allowed = new Set(rooms.map(welcomeId));
  botId = welcomeId(botId);
  requireWelcome(allowed.size > 0, 'ROOM_ALLOWLIST_REQUIRED');
  requireWelcome(Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    && Number.isSafeInteger(confirmTimeoutMs) && confirmTimeoutMs > 0, 'INVALID_LOCO_TIMEOUT');
  let installed;
  let original;
  let pending = Promise.resolve();

  function account() {
    requireWelcome(client.logon === true, 'LOCO_NOT_LOGGED_IN');
    requireWelcome(id(client.clientUser?.userId) === botId, 'LOCO_ACCOUNT_CHANGED');
    return botId;
  }
  function channelFor(roomId) {
    account();
    roomId = welcomeId(roomId);
    requireWelcome(allowed.has(roomId), 'LOCO_ROOM_NOT_ALLOWED');
    const channel = client.channelList?.open?.get(Long.fromString(roomId));
    requireWelcome(channel && id(channel.channelId) === roomId, 'LOCO_OPEN_ROOM_NOT_FOUND');
    requireWelcome(id(channel.clientUser?.userId) === botId, 'LOCO_ACCOUNT_CHANGED');
    id(channel.linkId);
    return channel;
  }
  function sameChannel(roomId, channel, linkId) {
    requireWelcome(channelFor(roomId) === channel && id(channel.linkId) === linkId, 'LOCO_ROOM_MISMATCH');
  }
  async function bounded(operation, code, duration = timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new WelcomeError(code)), duration); }),
      ]);
    } catch (error) {
      if (error instanceof WelcomeError) throw error;
      throw new WelcomeError(code);
    } finally { clearTimeout(timer); }
  }
  function success(response, code) {
    requireWelcome(response?.success === true && response.status === 0, code);
    return response.result;
  }
  function envelopeFor(data) {
    const raw = data?.chatLog;
    requireWelcome(raw && typeof raw === 'object', 'LOCO_CHAT_LOG_REQUIRED');
    const roomId = id(raw.chatId);
    if (!allowed.has(roomId)) return null;
    channelFor(roomId);
    if (data.chatId != null) requireWelcome(id(data.chatId) === roomId, 'LOCO_ROOM_MISMATCH');
    const envelope = { json: {
      chat_id: roomId, id: id(raw.logId), created_at: String(raw.sendAt), type: raw.type,
      v: { origin: 'NEWMEM' }, message: raw.message,
    } };
    parseWelcomeEvent(envelope);
    return envelope;
  }

  const adapter = {
    async getBotId() { return account(); },
    async verifyRoom(roomId) {
      roomId = welcomeId(roomId);
      const channel = channelFor(roomId);
      const expectedLinkId = id(channel.linkId);
      const info = success(await bounded(() => channel.getLatestChannelInfo(), 'LOCO_ROOM_UNAVAILABLE'),
        'LOCO_ROOM_UNAVAILABLE');
      requireWelcome(info && id(info.channelId) === roomId && id(info.linkId) === expectedLinkId,
        'LOCO_ROOM_MISMATCH');
      sameChannel(roomId, channel, expectedLinkId);
      await adapter.getName(roomId, botId);
      sameChannel(roomId, channel, expectedLinkId);
      return info;
    },
    async getRoomName(roomId) {
      roomId = welcomeId(roomId);
      const channel = channelFor(roomId);
      const expectedLinkId = id(channel.linkId);
      const info = await adapter.verifyRoom(roomId);
      sameChannel(roomId, channel, expectedLinkId);
      // ChannelMetaType.TITLE is 3 in the pinned SDK. Use its fresh CHATINFO
      // value, not getDisplayName(), which can fall back to an older cached link.
      const title = info.metaMap?.[3]?.content;
      if (title !== undefined && title !== '') return welcomeRoomName(title);
      const link = success(await bounded(() => channel.getLatestOpenLink(), 'LOCO_ROOM_NAME_UNAVAILABLE'),
        'LOCO_ROOM_NAME_UNAVAILABLE');
      sameChannel(roomId, channel, expectedLinkId);
      requireWelcome(link && id(link.linkId) === expectedLinkId, 'LOCO_ROOM_MISMATCH');
      return welcomeRoomName(link.linkName);
    },
    async getName(roomId, memberId) {
      memberId = welcomeId(memberId);
      const channel = channelFor(roomId);
      const users = success(await bounded(() => channel.getLatestUserInfo({ userId: Long.fromString(memberId) }),
        'LOCO_MEMBER_UNAVAILABLE'), 'LOCO_MEMBER_UNAVAILABLE');
      requireWelcome(Array.isArray(users) && users.length === 1 && id(users[0].userId) === memberId,
        'LOCO_MEMBER_NOT_FOUND_OR_AMBIGUOUS');
      account();
      return welcomeName(users[0].nickname);
    },
    async listMembers(roomId) {
      roomId = welcomeId(roomId);
      const channel = channelFor(roomId);
      const users = success(await bounded(() => channel.getAllLatestUserInfo(), 'LOCO_MEMBERS_UNAVAILABLE'),
        'LOCO_MEMBERS_UNAVAILABLE');
      requireWelcome(Array.isArray(users) && users.length > 0 && users.length <= 3_000,
        'LOCO_ROOM_MEMBERS_REQUIRED');
      const members = users.map((user) => ({ roomId, memberId: id(user.userId), name: welcomeName(user.nickname) }));
      const distinct = new Set(members.map((member) => member.memberId));
      requireWelcome(distinct.size === members.length && distinct.has(botId), 'LOCO_ROOM_MEMBERS_INVALID');
      account();
      return members;
    },
    async reply(roomId, text, expectedBotId) {
      requireWelcome(send === true, 'LOCO_RECEIVE_ONLY');
      requireWelcome(welcomeId(expectedBotId) === botId, 'LOCO_ACCOUNT_CHANGED');
      roomId = welcomeId(roomId);
      const channel = channelFor(roomId);
      requireWelcome(typeof text === 'string' && text.length > 0 && text.length <= 4_000, 'INVALID_REPLY');
      const ack = success(await bounded(() => channel.sendChat(text, true), 'LOCO_REPLY_UNCERTAIN'),
        'LOCO_REPLY_NOT_ACKNOWLEDGED');
      const logId = id(ack?.logId);
      account();
      // sendChat may synthesize its Chatlog and put it in the local cache. Verify a fresh
      // server log instead, retaining chatId which getChatListFrom normally strips.
      const deadline = now() + confirmTimeoutMs;
      while (now() < deadline) {
        channelFor(roomId);
        const response = await bounded(() => client.request('MCHATLOGS', {
          chatIds: [Long.fromString(roomId)], sinces: [Long.fromString(String(BigInt(logId) - 1n))],
        }), 'LOCO_REPLY_UNCONFIRMED', Math.min(timeoutMs, Math.max(1, deadline - now())));
        requireWelcome(response?.status === 0 && Array.isArray(response.chatLogs), 'LOCO_REPLY_UNCONFIRMED');
        account();
        if (response.chatLogs.some((log) => id(log.chatId) === roomId && id(log.logId) === logId
          && id(log.authorId) === botId && log.type === 1 && log.message === text)) return;
        await pause(Math.min(500, Math.max(0, deadline - now())));
      }
      throw new WelcomeError('LOCO_REPLY_UNCONFIRMED');
    },
    async start(onEnvelope, onError) {
      requireWelcome(!installed, 'LOCO_RECEIVER_ALREADY_STARTED');
      requireWelcome(typeof onEnvelope === 'function' && typeof onError === 'function', 'LOCO_RECEIVER_CALLBACKS_REQUIRED');
      for (const roomId of allowed) await adapter.verifyRoom(roomId);
      original = client.pushReceived;
      installed = function (method, data, context) {
        // This dedicated receiver does not observe ordinary conversations. Consuming
        // both methods also avoids the library's unbounded MEMBER/addChannel requests.
        if (method === 'MSG') return Promise.resolve();
        if (method !== 'NEWMEM') return original.call(this, method, data, context);
        try {
          const envelope = envelopeFor(data);
          if (envelope) {
            const next = pending.then(() => onEnvelope(envelope));
            pending = next.catch((error) => { onError(error instanceof WelcomeError ? error : new WelcomeError('LOCO_EVENT_FAILED')); });
          }
        } catch (error) {
          onError(error instanceof WelcomeError ? error : new WelcomeError('LOCO_EVENT_INVALID'));
        }
        // The welcome queue resolves profiles itself with a deadline. Leave the
        // packet loop free to receive the next join and connection-control packets.
        return Promise.resolve();
      };
      client.pushReceived = installed;
    },
    async stop() {
      if (installed && client.pushReceived === installed) client.pushReceived = original;
      installed = undefined;
      await pending;
    },
  };
  return adapter;
}
