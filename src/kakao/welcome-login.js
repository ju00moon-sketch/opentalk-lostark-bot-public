import { requireWelcome, WelcomeError } from './welcome.js';

export function createWelcomeLogin({ api, connect, now = Date.now }) {
  let stage = 'login';
  let form, attempt, challenge, passcodeError;
  let closed = false, busy = false;
  function clear() {
    form = undefined; challenge = undefined;
    clearTimeout(attempt?.timer); attempt?.controller.abort(); attempt = undefined;
  }
  function active(current) {
    if (!current || current !== attempt || closed || now() >= current.expiresAt || current.controller.signal.aborted) {
      clear(); stage = 'login'; throw new WelcomeError('LOGIN_EXPIRED');
    }
  }
  function expireAt(current, at) {
    current.expiresAt = Math.min(current.expiresAt, at);
    clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      if (attempt === current) { clear(); stage = 'login'; }
    }, Math.max(0, current.expiresAt - now()));
    current.timer.unref();
  }
  function checked(result) {
    requireWelcome(result?.success === true, `AUTH_STATUS_${Number.isInteger(result?.status) ? result.status : 'UNKNOWN'}`);
    return result.result;
  }
  function remaining(result) {
    requireWelcome(Number.isFinite(result?.remainingSeconds) && result.remainingSeconds > 0, 'AUTH_CHALLENGE_INVALID');
    return result.remainingSeconds * 1000;
  }
  async function finish(result, current) {
    active(current);
    const credential = checked(result);
    form = undefined; challenge = undefined;
    await connect(credential, current.controller.signal);
    active(current);
    clear(); stage = 'connected';
  }
  return {
    status() {
      if (attempt && now() >= attempt.expiresAt) { clear(); stage = 'login'; }
      return { stage, busy, ...(challenge ? { challenge: { ...challenge } } : {}) };
    },
    async action(action, input = {}) {
      requireWelcome(!closed, 'LOGIN_CLOSED');
      // Cancellation can invalidate a request while the network is still pending.
      if (action === 'cancel') { clear(); passcodeError = undefined; stage = 'login'; return this.status(); }
      requireWelcome(!busy, 'LOGIN_BUSY');
      requireWelcome(stage !== 'passcode_unavailable', passcodeError);
      busy = true;
      let pendingAttempt;
      try {
        if (action === 'login') {
          requireWelcome(stage !== 'connected', 'ALREADY_CONNECTED');
          requireWelcome(typeof input.email === 'string' && input.email.trim().length > 0 && input.email.length <= 254
            && typeof input.password === 'string' && input.password.length > 0 && input.password.length <= 512, 'LOGIN_FIELDS_REQUIRED');
          clear();
          form = { email: input.email.trim(), password: input.password };
          const current = attempt = { expiresAt: now() + 10 * 60_000, controller: new AbortController() };
          pendingAttempt = current;
          expireAt(current, current.expiresAt);
          const result = await api.login(form, false);
          active(current);
          if (!result.success && result.status === -100) stage = 'registration_required';
          else await finish(result, current);
        } else if (action === 'request-code') {
          requireWelcome(stage === 'registration_required', 'REGISTRATION_NOT_REQUESTED');
          const current = attempt;
          pendingAttempt = current;
          active(current);
          const requestedAt = now();
          const result = checked(await api.generatePasscode(form, { signal: current.controller.signal }));
          active(current);
          requireWelcome(typeof result?.passcode === 'string' && /^\d{4,12}$/.test(result.passcode), 'AUTH_PASSCODE_INVALID');
          expireAt(current, requestedAt + remaining(result));
          active(current);
          challenge = { passcode: result.passcode, expiresAt: current.expiresAt, nextPollAt: now() + 3000 };
          stage = 'awaiting_approval';
        } else if (action === 'check-approval') {
          requireWelcome(stage === 'awaiting_approval' && challenge, 'APPROVAL_NOT_REQUESTED');
          const current = attempt;
          pendingAttempt = current;
          active(current);
          requireWelcome(now() >= challenge.nextPollAt, 'APPROVAL_CHECK_TOO_SOON');
          const requestedAt = now();
          challenge.nextPollAt = now() + 3000;
          const result = await api.pollPasscode(form, { signal: current.controller.signal });
          active(current);
          if (!result.success && result.status === -100) {
            const interval = result.result?.nextRequestIntervalInSeconds ?? 3;
            requireWelcome(Number.isFinite(interval) && interval >= 0, 'AUTH_APPROVAL_RESPONSE_INVALID');
            const seconds = result.result?.remainingSeconds;
            if (seconds !== undefined && seconds !== null) {
              requireWelcome(Number.isFinite(seconds) && seconds >= 0, 'AUTH_APPROVAL_RESPONSE_INVALID');
              requireWelcome(seconds > 0, 'LOGIN_EXPIRED');
              expireAt(current, requestedAt + seconds * 1000);
              active(current);
            }
            challenge.expiresAt = current.expiresAt;
            challenge.nextPollAt = Math.min(current.expiresAt, now() + Math.max(3000, Math.ceil(interval * 1000)));
          } else {
            checked(result);
            await finish(await api.login(form, false), current);
          }
        } else throw new WelcomeError('UNKNOWN_LOGIN_ACTION');
        return this.status();
      } catch (error) {
        if (pendingAttempt && (closed || pendingAttempt !== attempt)) throw new WelcomeError('LOGIN_EXPIRED');
        if (action === 'request-code' && /^AUTH_HTTP_404(?:_STATUS_-?\d+)?$/.test(error.code ?? '')) {
          clear(); stage = 'passcode_unavailable';
          passcodeError = error.code.replace('AUTH_HTTP_', 'AUTH_PASSCODE_HTTP_');
          throw new WelcomeError(passcodeError);
        }
        if (!['APPROVAL_CHECK_TOO_SOON', 'REGISTRATION_NOT_REQUESTED'].includes(error.code)) {
          clear(); if (stage !== 'connected') stage = 'login';
        }
        throw error;
      } finally { busy = false; }
    },
    close() { closed = true; clear(); stage = 'login'; },
  };
}
