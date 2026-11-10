import crypto from 'node:crypto';
import { makeLimiter } from './limits.js';
import { parseAdd, parseAmount, fmt, etaWeeks, weeksText } from './text.js';
import { buildDigest, pickTarget } from './digest.js';
import { isJpeg, ZONE_NAMES } from './validate.js';

const DRAFT_TTL = 30 * 60 * 1000;
const rid = () => 1 + crypto.randomInt(2147483000);

export function makeBot({ db, tg, cfg }) {
  const msgLimit = makeLimiter(30, 60000);
  const url = cfg.webappUrl;
  const openKb = () => (url ? [[{ text: 'Открыть тропу', web_app: { url } }]] : []);

  const send = (to, text, kb) => db.enqueue(to, 'sendMessage', { chat_id: to, text, ...(kb && kb.length ? { reply_markup: { inline_keyboard: kb } } : {}) });
  const answer = (to, id, text) => db.enqueue(to, 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  const dropButtons = (to, msg) => msg && db.enqueue(to, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });

  const consentKb = () => {
    const rows = [[{ text: 'Принимаю', callback_data: 'consent:yes' }, { text: 'Не принимаю', callback_data: 'consent:no' }]];
    if (url) rows.push([{ text: 'Политика обработки данных', url: url + '/policy' }]);
    return rows;
  };
  const askConsent = to => send(to,
    'Привет. Это тропа покупок: складываешь сюда, что хочется, и копишь на это по шагам.\n\n' +
    'Чтобы хранить твои вещи и суммы, нужно согласие на обработку данных. Что храним и как всё стереть, написано в политике.',
    consentKb());

  function sendMenuOnce(tgId) {
    const u = db.getUser(tgId);
    if (!url || !u || u.menu_set) return;
    db.enqueue(tgId, 'setChatMenuButton', { chat_id: tgId, menu_button: { type: 'web_app', text: 'Тропа', web_app: { url } } });
    db.setMenuSet(tgId);
  }

  const getDraft = id => {
    const raw = db.kvGet('draft:' + id);
    if (!raw) return null;
    try { const d = JSON.parse(raw); return d.exp > Date.now() ? d : null; } catch { return null; }
  };
  const setDraft = (id, d) => db.kvSet('draft:' + id, JSON.stringify({ ...d, exp: Date.now() + DRAFT_TTL }));
  const clearDraft = id => db.kvDel('draft:' + id);

  async function fetchPhoto(fileId) {
    try {
      const f = await tg.call('getFile', { file_id: fileId });
      if (!f || !f.file_path) return null;
      const buf = await tg.download(f.file_path, { maxBytes: 200000 });
      return isJpeg(buf) ? buf : null;
    } catch { return null; }
  }

  async function createItem(from, d) {
    if (db.countItems(from) >= cfg.maxItems) {
      clearDraft(from);
      send(from, `На тропе уже ${cfg.maxItems} вещей, это максимум. Убери что-нибудь в приложении, потом пришли ещё раз.`, openKb());
      return;
    }
    const id = rid();
    db.upsertItem(from, { id, name: d.name, price: d.price, saved: 0, zone: 1, icon: 'auto', tint: crypto.randomInt(5), bg: '', ln: '', fit: 'contain', link: d.link || '' });
    let withPhoto = false;
    if (d.fileId) {
      const buf = await fetchPhoto(d.fileId);
      if (buf) { db.setPhoto(from, id, buf); withPhoto = true; }
    }
    clearDraft(from);
    const kb = [[{ text: '→ Сейчас', callback_data: `mv:${id}:0` }, { text: '→ Мечты', callback_data: `mv:${id}:2` }], ...openKb()];
    send(from, `Добавлено: «${d.name}», ${fmt(d.price)}. Лежит в «Потом»${withPhoto ? '' : d.fileId ? ' (фото не получилось забрать, поставишь в приложении)' : ''}.`, kb);
  }

  async function onAddFlow(from, msg, text) {
    const photos = Array.isArray(msg.photo) ? msg.photo : [];
    let fileId = '';
    if (photos.length) {
      const ok = photos.filter(p => p.file_size && p.file_size <= 190000).sort((a, b) => b.file_size - a.file_size)[0];
      fileId = (ok || photos[0]).file_id;
    }
    const p = parseAdd(text);
    let d = getDraft(from);
    const fresh = !!(p.link || fileId);
    if (fresh) d = { name: p.name, price: p.price, link: p.link, fileId };
    else if (d) {
      if (p.name && p.price) { d.name = p.name; d.price = p.price; }
      else { if (!d.price && p.price) d.price = p.price; if (!d.name && p.name) d.name = p.name; }
    } else if (p.name && p.price) d = { name: p.name, price: p.price, link: '', fileId: '' };
    else {
      send(from, 'Пришли ссылку на товар (Ozon, Wildberries, Яндекс Маркет) или напиши название и цену. Например: Лампа 4300.', openKb());
      return;
    }
    if (d.name && d.price) { await createItem(from, d); return; }
    setDraft(from, d);
    if (d.name) send(from, `Сколько стоит «${d.name}»? Напиши числом.`);
    else if (d.price) send(from, `Цена ${fmt(d.price)}. Как назвать вещь?`);
    else send(from, 'Что это за вещь и сколько стоит? Например: Лампа 4300.');
  }

  function weekNow(from) {
    const u = db.getUser(from);
    const items = db.listItems(from);
    if (!items.length) { send(from, 'На тропе пока пусто. Пришли ссылку или напиши «Лампа 4300».', openKb()); return; }
    const d = buildDigest(u, items, url);
    send(from, d.text, d.reply_markup.inline_keyboard);
  }

  async function onMessage(msg) {
    if (!msg.from || msg.from.is_bot || !msg.chat || msg.chat.type !== 'private') return;
    const from = msg.from.id;
    if (!msgLimit(from)) return;
    const user = db.ensureUser(from, msg.from.first_name || '');
    const text = String(msg.text ?? msg.caption ?? '').slice(0, 2000);
    const cmd = text.startsWith('/') ? text.split(/[\s@]/)[0].toLowerCase() : '';

    if (cmd === '/start' || cmd === '/help') {
      if (!user.consent_at) { askConsent(from); return; }
      send(from, 'Пришли ссылку на товар и цену, например:\nЛампа 4300 https://ozon.ru/t/…\n\nКоманды: /week сводка сейчас, /digest_off и /digest_on включают и выключают сводку, /delete_me стирает всё.', openKb());
      return;
    }
    if (cmd === '/delete_me') {
      send(from, 'Удалю всё: вещи, суммы, историю покупок и твою учётку. Вернуть будет нельзя.', [[{ text: 'Удалить всё', callback_data: 'delme:yes' }, { text: 'Оставить', callback_data: 'delme:no' }]]);
      return;
    }
    if (!user.consent_at) { askConsent(from); return; }

    if (cmd === '/week') { weekNow(from); return; }
    if (cmd === '/digest_off') { db.setSettings(from, { digest: false }); send(from, 'Сводку по воскресеньям выключил. Включить снова: /digest_on.'); return; }
    if (cmd === '/digest_on') { db.setSettings(from, { digest: true }); send(from, 'Сводка включена. Буду писать раз в неделю, по воскресеньям вечером.'); return; }
    if (cmd) return;

    const await_ = Number(db.kvGet('await_amt:' + from) || 0);
    if (await_ > Date.now()) {
      const amt = parseAmount(text);
      if (amt) {
        db.kvDel('await_amt:' + from);
        db.setSettings(from, { weekAmount: amt });
        send(from, `Обычная сумма: ${fmt(amt)} в неделю. В сводке появится кнопка «+${fmt(amt)} как обычно».`);
        return;
      }
    }
    await onAddFlow(from, msg, text);
  }

  async function onCallback(cb) {
    if (!cb.from || !cb.data || !cb.message) return;
    const from = cb.from.id;
    if (!msgLimit(from)) return;
    const [kind, a, b] = String(cb.data).slice(0, 64).split(':');
    const user = db.ensureUser(from, cb.from.first_name || '');

    if (kind === 'consent') {
      if (a === 'yes') {
        db.setConsent(from, 'bot');
        answer(from, cb.id);
        dropButtons(from, cb.message);
        sendMenuOnce(from);
        send(from, 'Готово. Открывай тропу. Чтобы добавить вещь, пришли ссылку на товар и цену, например: Лампа 4300. Ссылку я только сохраню, в магазин по ней не хожу.', openKb());
      } else {
        answer(from, cb.id);
        dropButtons(from, cb.message);
        send(from, 'Хорошо, ничего не сохраняю. Если передумаешь, нажми /start.');
      }
      return;
    }
    if (kind === 'delme') {
      if (a === 'yes') {
        db.deleteUser(from); // чистит и очередь, поэтому ответы ставим после
        answer(from, cb.id);
        dropButtons(from, cb.message);
        db.enqueue(from, 'sendMessage', { chat_id: from, text: 'Всё удалено. Если захочешь вернуться, нажми /start.' });
      } else {
        answer(from, cb.id);
        dropButtons(from, cb.message);
        send(from, 'Ок, ничего не трогаю.');
      }
      return;
    }
    if (!user.consent_at) { answer(from, cb.id); askConsent(from); return; }

    const id = Number(a), amt = Number(b);
    if (kind === 'mv' && Number.isSafeInteger(id) && [0, 1, 2].includes(amt)) {
      const it = db.getItem(from, id);
      answer(from, cb.id);
      if (!it) return;
      db.setItemZone(from, id, amt);
      dropButtons(from, cb.message);
      send(from, `Теперь «${it.name}» в «${ZONE_NAMES[amt]}».`, openKb());
      return;
    }
    if (kind === 'usual' && Number.isSafeInteger(id) && Number.isSafeInteger(amt) && amt > 0 && amt <= 10000000) {
      const it = db.getItem(from, id);
      if (!it) { answer(from, cb.id, 'Этой вещи уже нет'); return; }
      const add = Math.min(amt, it.price - it.saved);
      answer(from, cb.id);
      dropButtons(from, cb.message);
      if (add <= 0) { send(from, `На «${it.name}» уже хватает.`, openKb()); return; }
      db.setItemSaved(from, id, it.saved + add);
      const now = it.saved + add;
      let t = `Добавил ${fmt(add)} к «${it.name}»: ${fmt(now)} из ${fmt(it.price)}.`;
      if (now >= it.price) t += ' Хватает, можно покупать.';
      else { const w = etaWeeks(it.price - now, amt); if (w) t += ` При такой сумме хватит через ${weeksText(w)}.`; }
      const nonce = crypto.randomBytes(5).toString('hex');
      db.kvSet('undo:' + nonce, `${Date.now() + 3600000}:${from}:${id}:${add}`);
      send(from, t, [[{ text: 'Отменить', callback_data: `undo:${nonce}` }], ...openKb()]);
      return;
    }
    if (kind === 'undo' && /^[0-9a-f]{10}$/.test(a || '')) {
      answer(from, cb.id);
      dropButtons(from, cb.message);
      const val = db.kvGet('undo:' + a);
      db.kvDel('undo:' + a);                       // одноразово: повторное нажатие ничего не делает
      const [exp, who, itemId, add] = String(val || '').split(':').map(Number);
      const it = val && who === from && exp > Date.now() ? db.getItem(from, itemId) : null;
      if (!it || it.saved < add) { send(from, 'Отменить уже нельзя: отмена использована или сумма изменилась.'); return; }
      db.setItemSaved(from, itemId, it.saved - add);
      send(from, `Отменил. На «${it.name}» снова ${fmt(it.saved - add)}.`);
      return;
    }
    if (kind === 'setamt') {
      answer(from, cb.id);
      db.kvSet('await_amt:' + from, String(Date.now() + 10 * 60 * 1000));
      send(from, 'Сколько обычно откладываете за неделю? Напиши числом, например 3000.');
      return;
    }
    if (kind === 'skip') { answer(from, cb.id); dropButtons(from, cb.message); send(from, 'Ок, на этой неделе без записи.'); return; }
    answer(from, cb.id);
  }

  async function onMyChatMember(m) {
    if (!m.chat || m.chat.type !== 'private' || !m.new_chat_member) return;
    const st = m.new_chat_member.status;
    if (db.getUser(m.chat.id)) db.setBlocked(m.chat.id, st === 'kicked' || st === 'left');
  }

  async function handleUpdate(u) {
    if (u.message) return onMessage(u.message);
    if (u.callback_query) return onCallback(u.callback_query);
    if (u.my_chat_member) return onMyChatMember(u.my_chat_member);
  }

  return { handleUpdate, pickTarget };
}

/** Длинный опрос. Останавливается через stop(). Токен берётся из getToken(), пока его нет, просто ждём. */
export function startPolling({ db, tg, bot, getToken, log = () => {} }) {
  let stopped = false;
  let backoff = 1000;
  (async () => {
    while (!stopped) {
      if (!getToken()) { await new Promise(r => setTimeout(r, 2000)); continue; }
      try {
        const offset = Number(db.kvGet('tg_offset') || 0);
        const updates = await tg.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query', 'my_chat_member'] }, { timeoutMs: 40000 });
        backoff = 1000;
        for (const u of updates) {
          try { await bot.handleUpdate(u); } catch (e) { log('update-error', e && e.message); }
          db.kvSet('tg_offset', u.update_id + 1);
        }
      } catch (e) {
        log('poll-error', e && e.message);
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  })();
  return { stop() { stopped = true; } };
}
