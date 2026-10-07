import { requireWelcome, WelcomeError } from './welcome.js';

// Keep credentials on the pinned origin and expose only numeric failure codes.
export function createWelcomeAuthWeb({ signal, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const url = 'https://katalk.kakao.com';
  async function send(path, body, headers, contentType, requestSignal) {
      try {
        const response = await fetchImpl(`${url}/${path}`, {
          method: 'POST', body, redirect: 'error',
          headers: { ...headers, 'content-type': contentType },
          signal: AbortSignal.any([...[signal, requestSignal].filter(Boolean), AbortSignal.timeout(timeoutMs)]),
        });
        const httpError = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
          ? `AUTH_HTTP_${response.status}` : 'AUTH_HTTP_ERROR';
        let size = 0;
        const chunks = [];
        try {
          for await (const chunk of response.body) {
            size += chunk.length;
            requireWelcome(size <= 65536, 'AUTH_RESPONSE_TOO_LARGE');
            chunks.push(chunk);
          }
        } catch (error) {
          if (!response.ok) throw new WelcomeError(httpError);
          throw error;
        }
        const bytes = Buffer.concat(chunks);
        let result;
        try { result = JSON.parse(bytes.toString('utf8')); } catch {}
        const hasStatus = result && !Array.isArray(result) && Number.isInteger(result.status)
          && Math.abs(result.status) <= 1_000_000_000;
        if (!response.ok) throw new WelcomeError(httpError + (hasStatus ? `_STATUS_${result.status}` : ''));
        requireWelcome(hasStatus, 'AUTH_RESPONSE_INVALID');
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } catch (error) {
        const code = error instanceof WelcomeError
          && /^(?:AUTH_HTTP_[1-5][0-9]{2}(?:_STATUS_-?[0-9]{1,10})?|AUTH_HTTP_ERROR|AUTH_RESPONSE_TOO_LARGE|AUTH_RESPONSE_INVALID)$/.test(error.code)
          ? error.code : 'AUTH_CONNECTION_FAILED';
        throw new WelcomeError(code);
      }
  }
  return {
    url,
    async request(method, path, form, headers = {}) {
      requireWelcome(method === 'POST' && /^win32\/account\/(login|request_passcode|register_device)\.json$/.test(path), 'AUTH_ENDPOINT_REJECTED');
      const body = new URLSearchParams(Object.entries(form ?? {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)]));
      return send(path, body, headers, 'application/x-www-form-urlencoded');
    },
    async requestJson(path, body, headers = {}, { signal: requestSignal } = {}) {
      requireWelcome(/^win32\/account\/passcodeLogin\/(generate|registerDevice)$/.test(path), 'AUTH_ENDPOINT_REJECTED');
      const bytes = await send(path, JSON.stringify(body), headers, 'application/json', requestSignal);
      return JSON.parse(Buffer.from(bytes).toString('utf8'));
    },
    async requestMultipart() { throw new WelcomeError('AUTH_ENDPOINT_REJECTED'); },
  };
}

// Keep the existing Windows login identity and headers for device approval.
export function createWelcomePasscodeApi({ api, web }) {
  async function request(endpoint, form, device, options, extra = {}) {
    const result = await web.requestJson(`win32/account/passcodeLogin/${endpoint}`,
      { email: form.email, password: form.password, ...extra, device },
      await api.createAuthHeader(form), options);
    for (const field of ['remainingSeconds', 'nextRequestIntervalInSeconds']) {
      requireWelcome(result[field] == null || (typeof result[field] === 'number' && Number.isFinite(result[field])), 'AUTH_RESPONSE_INVALID');
    }
    return { status: result.status, success: result.status === 0, result: {
      ...(typeof result.passcode === 'string' ? { passcode: result.passcode } : {}),
      ...(typeof result.remainingSeconds === 'number' ? { remainingSeconds: result.remainingSeconds } : {}),
      ...(typeof result.nextRequestIntervalInSeconds === 'number'
        ? { nextRequestIntervalInSeconds: result.nextRequestIntervalInSeconds } : {}),
    } };
  }
  return {
    login: (form, forced = false) => api.login(form, forced),
    generatePasscode: (form, options) => request('generate', form, {
      name: api.name, uuid: api.deviceUUID, model: api.config.deviceModel,
      osVersion: api.config.osVersion, isOneStore: false,
    }, options, { permanent: true }),
    pollPasscode: (form, options) => request('registerDevice', form, { uuid: api.deviceUUID }, options),
  };
}
