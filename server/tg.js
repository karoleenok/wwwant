export class TgError extends Error {
  constructor(code, description, retryAfter = 0) {
    super(description);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * Тонкая обёртка над Bot API. Токен берём через getToken() и нигде не пишем в логи и ошибки.
 * bases — список адресов: основной и запасные (мосты). Пробуем по очереди, если сеть не отвечает.
 */
export function makeTg({ bases, getToken, fetchFn = fetch }) {
  async function request(path, init, tokenOverride, timeoutMs) {
    const token = tokenOverride || getToken();
    if (!token) throw new TgError(0, 'no-token');
    let lastNet = null;
    for (const base of bases) {
      try {
        const res = await fetchFn(`${base}${path.replace('<token>', token)}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        return res;
      } catch (e) {
        lastNet = e;
      }
    }
    throw new TgError(0, 'network:' + (lastNet && lastNet.name ? lastNet.name : 'error'));
  }

  async function call(method, params = {}, { token, timeoutMs = 20000 } = {}) {
    const res = await request(`/bot<token>/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params)
    }, token, timeoutMs);
    let j;
    try { j = await res.json(); } catch { throw new TgError(res.status, 'bad-response'); }
    if (!j.ok) throw new TgError(j.error_code || res.status, String(j.description || 'error').slice(0, 200), j.parameters && j.parameters.retry_after || 0);
    return j.result;
  }

  async function download(filePath, { maxBytes = 300000 } = {}) {
    if (!/^[A-Za-z0-9_./-]{1,200}$/.test(filePath) || filePath.includes('..')) throw new TgError(0, 'bad-path');
    const res = await request(`/file/bot<token>/${filePath}`, { method: 'GET' }, null, 20000);
    if (!res.ok) throw new TgError(res.status, 'download-failed');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new TgError(0, 'too-big');
    return buf;
  }

  return { call, download };
}
