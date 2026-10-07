import { createHash, randomBytes } from 'node:crypto';
import { createStore } from '../../src/store.js';

const digest = token => createHash('sha256').update(token).digest('hex');

export function verifyOwnership(store, account, characterName, now) {
  const sessionHash = account.tokenHash || digest(account.token);
  const previous = store.ownership.summary(account.id);
  const selected = store.ownership.select(account.id, sessionHash, { characterName,
    serverName: '루페온', characterClass: '바드', itemLevel: 1740, guildName: '포근해' }, previous.revision, now);
  const proof = store.ownership.beginStove(account.id, sessionHash, selected.revision, now);
  return store.ownership.finishStove(proof, { stoveAccountId: `fixture-${account.id}`, characterName }, now);
}

// Explicit existing-owner fixture for feature tests whose subject is not registration.
export function approvedRequester(dbPath, now = Date.now()) {
  const store = createStore(dbPath), token = randomBytes(32).toString('base64url');
  try {
    store.createSession({ provider: 'discord', providerId: '7770000001', displayName: '기존 승인 회원',
      tokenHash: digest(token), expiresAt: now + 86400000, epoch: 0 }, now);
    store.guild.bootstrapOwner(store.getSession(digest(token), now).id, now);
  } finally { store.close(); }
  return (url, options = {}) => fetch(url, { ...options, headers: { Cookie: `__Host-web_session=${token}`, ...options.headers } });
}
