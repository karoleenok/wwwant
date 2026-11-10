import { TgError } from './tg.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Один проход по очереди. Возвращает, сколько сообщений обработано. */
export async function outboxTick({ db, tg, log = () => {}, limit = 10 }) {
  const due = await db.claimDue(limit);
  for (const row of due) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { await db.outboxFail(row.id, 'bad-payload'); continue; }
    try {
      await tg.call(row.method, payload);
      await db.outboxSent(row.id);
    } catch (e) {
      if (!(e instanceof TgError)) { await db.outboxFail(row.id, 'error'); continue; }
      if (e.code === 429) await db.outboxRetry(row.id, (e.retryAfter || 5) * 1000 + 500, '429');
      else if (e.code === 403) { await db.setBlocked(row.tg_id, true); await db.outboxFail(row.id, '403'); }
      else if (e.code === 400 || e.code === 404) await db.outboxFail(row.id, `${e.code}:${e.message}`);
      else if (e.code === 0 && e.message === 'no-token') { /* ждём токен, ничего не трогаем */ }
      else if (row.tries >= 8) await db.outboxFail(row.id, 'gave-up:' + e.message);
      else await db.outboxRetry(row.id, Math.min(3600000, 5000 * 2 ** row.tries), e.message);
      log('outbox', row.id, e.code);
    }
    await sleep(30);
  }
  return due.length;
}
