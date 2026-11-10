import { TgError } from './tg.js';

/** Один проход по очереди. Возвращает, сколько сообщений обработано. */
export async function outboxTick({ db, tg, log = () => {} }) {
  const due = db.dueOutbox(10);
  for (const row of due) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { db.outboxFail(row.id, 'bad-payload'); continue; }
    try {
      await tg.call(row.method, payload);
      db.outboxSent(row.id);
    } catch (e) {
      if (!(e instanceof TgError)) { db.outboxFail(row.id, 'error'); continue; }
      if (e.code === 429) db.outboxRetry(row.id, (e.retryAfter || 5) * 1000 + 500, '429');
      else if (e.code === 403) { db.setBlocked(row.tg_id, true); db.outboxFail(row.id, '403'); }
      else if (e.code === 400 || e.code === 404) db.outboxFail(row.id, `${e.code}:${e.message}`);
      else if (e.code === 0 && e.message === 'no-token') { /* ждём токен, ничего не трогаем */ }
      else if (row.tries >= 8) db.outboxFail(row.id, 'gave-up:' + e.message);
      else db.outboxRetry(row.id, Math.min(3600000, 5000 * 2 ** row.tries), e.message);
      log('outbox', row.id, e.code);
    }
    await new Promise(r => setTimeout(r, 40));
  }
  return due.length;
}
