import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

/**
 * Проверка Telegram initData по HMAC (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * Возвращает {id, first_name} или null. Ничему из клиента не верим, пока подпись не сошлась.
 */
export function verifyInitData(raw, token, maxAgeSec = 86400, nowMs = Date.now()) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 4096 || !token) return null;
  let p;
  try { p = new URLSearchParams(raw); } catch { return null; }
  const hash = p.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  p.delete('hash');
  const dcs = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + '=' + v)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== calc.length || !crypto.timingSafeEqual(given, calc)) return null;
  const ad = Number(p.get('auth_date'));
  const now = nowMs / 1000;
  if (!ad || now - ad > maxAgeSec || ad - now > 300) return null;
  try {
    const u = JSON.parse(p.get('user') || '');
    if (!u || !Number.isSafeInteger(u.id) || u.id <= 0) return null;
    return { id: u.id, first_name: String(u.first_name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 40) };
  } catch { return null; }
}

/** Для тестов: собрать подписанный initData. */
export function signInitData(user, token, authDate = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams();
  p.set('auth_date', String(authDate));
  p.set('query_id', 'AAH' + crypto.randomBytes(6).toString('hex'));
  p.set('user', JSON.stringify(user));
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
