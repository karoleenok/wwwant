import { normLink, cleanText } from './validate.js';

export const NB = ' ';
export const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NB) + NB + '₽';

export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** Через сколько недель хватит при обычной сумме. */
export function etaWeeks(remaining, weekAmount) {
  if (!(remaining > 0) || !(weekAmount > 0)) return 0;
  return Math.ceil(remaining / weekAmount);
}
export const weeksText = w => `${w}${NB}${plural(w, ['неделя', 'недели', 'недель'])}`;

function shorten(s, max) {
  s = cleanText(s, 400);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.:;—–-]+$/, '') + '…';
}

const URL_RE = /https?:\/\/[^\s<>"']+/i;
// число в конце: 4300, 4 300, 11.500, с рублём или без
const PRICE_RE = /(?:^|\s)(\d{1,3}(?:[  .]\d{3})+|\d+)(?:[.,]\d{1,2})?\s*(₽|р\.?|руб\.?|руб|rub)?\s*$/i;

/**
 * Разбираем сообщение: ссылка, цена в конце, остальное название.
 * Ссылку только запоминаем: на сервере мы её не открываем (нет SSRF и нет парсинга чужих сайтов).
 */
export function parseAdd(text) {
  let t = String(text || '').trim();
  let link = '';
  const m = t.match(URL_RE);
  if (m) {
    link = normLink(m[0].replace(/[.,;:!?)»\]]+$/, '')) || '';
    t = t.replace(m[0], ' ');
  }
  t = t.replace(/\s+/g, ' ').trim();
  let price = 0;
  let name = t;
  const pm = t.match(PRICE_RE);
  if (pm) {
    const val = parseInt(pm[1].replace(/\D/g, ''), 10);
    // «iPhone 15» без знака рубля: 15 это не цена
    if (val >= 1 && val <= 99999999 && (pm[2] || val >= 50)) {
      price = val;
      name = t.slice(0, pm.index).trim();
    }
  }
  name = shorten(name.replace(/^[-—–,:;\s"«]+|[-—–,:;\s"»]+$/g, ''), 60);
  return { link, price, name };
}

export function parseAmount(text) {
  const m = String(text || '').match(/^\s*(\d[\d  .]*)\s*(₽|р\.?|руб\.?|руб)?\s*$/i);
  if (!m) return 0;
  const v = parseInt(m[1].replace(/\D/g, ''), 10);
  return v >= 1 && v <= 10000000 ? v : 0;
}
