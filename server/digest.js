import { fmt, etaWeeks, weeksText, NB } from './text.js';

/** Куда кладём «обычную сумму»: первая недокопленная вещь по зонам (Сейчас, Потом, Мечты). */
export function pickTarget(items) {
  return items.filter(i => i.saved < i.price).sort((a, b) => a.zone - b.zone || a.pos - b.pos)[0] || null;
}

export function buildDigest(user, items, webappUrl) {
  const total = items.reduce((s, i) => s + i.saved, 0);
  const ready = items.filter(i => i.saved >= i.price);
  const target = pickTarget(items);
  const lines = ['Неделя прошла. Сколько отложили?', ''];
  const rows = [];
  if (target) {
    lines.push(`Копим на «${target.name}»: ${fmt(target.saved)} из ${fmt(target.price)}.`);
    const w = etaWeeks(target.price - target.saved, user.week_amount);
    if (w) lines.push(`При ${fmt(user.week_amount)} в неделю хватит через ${weeksText(w)}.`);
  }
  if (ready.length) {
    const names = ready.slice(0, 3).map(i => `«${i.name}»`).join(', ') + (ready.length > 3 ? ' и ещё ' + (ready.length - 3) : '');
    lines.push(`Уже хватает: ${names}. Можно покупать.`);
  }
  lines.push(`Всего отложено ${fmt(total)}.`);
  if (target) {
    rows.push([user.week_amount
      ? { text: `+${fmt(user.week_amount)} как обычно`, callback_data: `usual:${target.id}:${user.week_amount}` }
      : { text: 'Задать обычную сумму', callback_data: 'setamt' }]);
  }
  const row2 = [];
  if (webappUrl) row2.push({ text: 'Открыть тропу', web_app: { url: webappUrl } });
  row2.push({ text: 'Пропустить', callback_data: 'skip' });
  rows.push(row2);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

/** Окно сводки: нужный день недели и 4 часа после нужного часа, не чаще раза в 6 дней. */
export function isDigestTime(cfg, nowMs, user) {
  const d = new Date(nowMs + cfg.digest.tzOffset * 3600000);
  if (d.getUTCDay() !== cfg.digest.dow) return false;
  const h = d.getUTCHours();
  if (h < cfg.digest.hour || h >= cfg.digest.hour + 4) return false;
  return !user.last_digest_at || nowMs - user.last_digest_at > 6 * 86400000;
}

export function digestTick({ db, cfg, nowMs = Date.now() }) {
  let sent = 0;
  for (const u of db.digestCandidates()) {
    if (!isDigestTime(cfg, nowMs, u)) continue;
    const items = db.listItems(u.tg_id);
    if (!items.length) continue;
    const d = buildDigest(u, items, cfg.webappUrl);
    db.enqueue(u.tg_id, 'sendMessage', { chat_id: u.tg_id, text: d.text, reply_markup: d.reply_markup });
    db.setDigestSent(u.tg_id, nowMs);
    sent++;
  }
  return sent;
}
export { NB };
