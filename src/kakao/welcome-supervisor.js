import { requireWelcome, WelcomeError } from './welcome.js';
import { performance } from 'node:perf_hooks';

const DEFAULT_BACKOFF = [5_000, 15_000, 30_000, 60_000, 300_000];

// The owner classifies account, room, authentication and uncertain-send failures as
// blocked. This supervisor only retries a session whose owner permits reconnecting.
// ready means approved credentials and room configuration exist, not socket health.
export function createWelcomeSupervisor({ getStatus, reconnect, onError, now = () => performance.now(),
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, pollMs = 1_000,
  stableMs = 60_000, backoffMs = DEFAULT_BACKOFF }) {
  requireWelcome(typeof getStatus === 'function' && typeof reconnect === 'function'
    && typeof onError === 'function', 'SUPERVISOR_CALLBACKS_REQUIRED');
  requireWelcome(Number.isSafeInteger(pollMs) && pollMs > 0
    && Number.isSafeInteger(stableMs) && stableMs > 0, 'INVALID_SUPERVISOR_TIMING');
  requireWelcome(Array.isArray(backoffMs) && backoffMs.length > 0
    && backoffMs.every((delay, index) => Number.isSafeInteger(delay) && delay > 0 && delay <= 300_000
      && (index === 0 || delay >= backoffMs[index - 1])), 'INVALID_SUPERVISOR_BACKOFF');
  const delays = [...backoffMs];
  let running = false;
  let generation = 0;
  let timer;
  let inFlight;
  let attempts = 0;
  let nextAttemptAt = null;
  let stableSince = null;
  let statusError = null;
  let checking = false;

  function report(error) {
    // A logging callback must not create an unhandled rejection or stop the timer.
    try { return Promise.resolve(onError(error)).catch(() => {}); }
    catch { return Promise.resolve(); }
  }
  function cancelTimer() {
    if (timer !== undefined) clearTimeoutImpl(timer);
    timer = undefined;
  }
  function schedule() {
    if (!running) return;
    cancelTimer();
    let delay = pollMs;
    if (nextAttemptAt !== null && nextAttemptAt > now()) delay = Math.min(delay, nextAttemptAt - now());
    const scheduledGeneration = generation;
    const scheduledTimer = setTimeoutImpl(() => {
      if (!running || generation !== scheduledGeneration || timer !== scheduledTimer) return;
      timer = undefined;
      check();
    }, delay);
    timer = scheduledTimer;
  }
  function readStatus() {
    let status;
    try { status = getStatus(); }
    catch {
      if (statusError !== 'SUPERVISOR_STATUS_FAILED') report(new WelcomeError('SUPERVISOR_STATUS_FAILED'));
      statusError = 'SUPERVISOR_STATUS_FAILED';
      return null;
    }
    if (!status || ['connected', 'ready', 'busy', 'blocked'].some((key) => typeof status[key] !== 'boolean')) {
      if (statusError !== 'SUPERVISOR_STATUS_INVALID') report(new WelcomeError('SUPERVISOR_STATUS_INVALID'));
      statusError = 'SUPERVISOR_STATUS_INVALID';
      return null;
    }
    statusError = null;
    return status;
  }
  function beginReconnect() {
    const attemptGeneration = generation;
    nextAttemptAt = null;
    const operation = Promise.resolve().then(() => {
      // stop() can be called after a timer fires but before this microtask starts.
      if (!running || generation !== attemptGeneration) return;
      const status = readStatus();
      if (!running || generation !== attemptGeneration || !status || !status.ready || status.blocked || status.busy
        || (status.connected && status.ready)) return;
      attempts++;
      return reconnect();
    }).catch((error) => {
      if (running && generation === attemptGeneration) {
        return report(error instanceof Error ? error : new WelcomeError('LOCO_RECONNECT_FAILED'));
      }
    }).finally(() => {
      if (inFlight === operation) inFlight = undefined;
      if (running && generation === attemptGeneration) check();
    });
    inFlight = operation;
  }
  function check() {
    if (!running || checking) return;
    checking = true;
    try {
      const status = readStatus();
      if (!running) return;
      if (!status || !status.ready || status.blocked) {
        nextAttemptAt = null;
        stableSince = null;
        return;
      }
      if (status.connected && status.ready) {
        nextAttemptAt = null;
        if (stableSince === null) stableSince = now();
        if (now() - stableSince >= stableMs) attempts = 0;
        return;
      }
      stableSince = null;
      if (inFlight) return;
      if (nextAttemptAt === null) nextAttemptAt = now() + delays[Math.min(attempts, delays.length - 1)];
      if (!status.busy && now() >= nextAttemptAt) beginReconnect();
    } finally {
      checking = false;
      schedule();
    }
  }
  return {
    start() {
      if (running) return;
      running = true;
      generation++;
      attempts = 0;
      nextAttemptAt = null;
      stableSince = null;
      statusError = null;
      check();
    },
    stop() {
      running = false;
      generation++;
      cancelTimer();
      nextAttemptAt = null;
      stableSince = null;
    },
    check,
    getState() {
      // These times use the injected monotonic clock, not Unix timestamps.
      return { running, reconnecting: inFlight !== undefined, attempts, nextAttemptAt, stableSince };
    },
  };
}
