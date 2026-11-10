export const BGS = ['#BBE5F2', '#FBE7F5', '#B3D0FF', '#E3ECFF', '#D1E7F5', '#FFFFFF'];
export const LNS = ['#111111', '#3F63C9', '#B8438F', '#2A7D9C'];
export const ZONE_NAMES = ['Сейчас', 'Потом', 'Мечты'];

export function cleanText(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Только http/https, длина до 500, у хоста есть точка. Пустая строка = ссылки нет. null = ссылка плохая. */
export function normLink(v) {
  v = String(v ?? '').trim();
  if (!v) return '';
  if (v.length > 500) return null;
  if (!/^https?:\/\//i.test(v)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[^/]+:\d+/.test(v)) return null;
    v = 'https://' + v;
  }
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.hostname.indexOf('.') < 1) return null;
    if (u.username || u.password) return null;
    return u.href.length > 500 ? null : u.href;
  } catch { return null; }
}

const int = (v, min, max) => (Number.isSafeInteger(v) && v >= min && v <= max ? v : null);

export function cleanItem(o) {
  if (!o || typeof o !== 'object') return { err: 'item' };
  const id = int(o.id, 1, 2147483647);
  const name = cleanText(o.name, 60);
  const price = int(o.price, 1, 99999999);
  let saved = int(o.saved, 0, 99999999);
  const zone = int(o.zone, 0, 2);
  const tint = int(o.tint ?? 0, 0, 4);
  const link = normLink(o.link);
  if (id === null || !name || price === null || saved === null || zone === null || tint === null || link === null) return { err: 'item' };
  if (saved > price) saved = price;
  const icon = typeof o.icon === 'string' && /^[a-z0-9_-]{1,24}$/.test(o.icon) ? o.icon : 'package';
  const bg = BGS.includes(o.bg) ? o.bg : '';
  const ln = LNS.includes(o.ln) ? o.ln : '';
  const fit = o.fit === 'cover' ? 'cover' : 'contain';
  return { v: { id, name, price, saved, zone, icon, tint, bg, ln, fit, link } };
}

export function cleanBought(o) {
  if (!o || typeof o !== 'object') return null;
  const name = cleanText(o.name, 60);
  const price = int(o.price, 0, 99999999);
  const at = int(o.at, 1, Date.now() + 86400000);
  if (!name || price === null || at === null) return null;
  const icon = typeof o.icon === 'string' && /^[a-z0-9_-]{1,24}$/.test(o.icon) ? o.icon : 'package';
  return { name, price, at, icon, bg: BGS.includes(o.bg) ? o.bg : '', ln: LNS.includes(o.ln) ? o.ln : '' };
}

export function isJpeg(buf) {
  return buf && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}
