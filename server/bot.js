import crypto from 'node:crypto';
import { makeGate } from './limits.js';
import { parseAdd, parseAmount, fmt, etaWeeks, weeksText } from './text.js';
import { buildDigest, pickTarget } from './digest.js';
import { isJpeg, ZONE_NAMES } from './validate.js';

const DRAFT_TTL = 30 * 60 * 1000;
const FB_TTL = 15 * 60 * 1000;          // сколько ждём текст отзыва после /feedback
const FB_MAP_TTL = 30 * 86400000;       // сколько можно отвечать на отзыв
const NP_TTL = 60 * 60 * 1000;          // черновик рассылки
const NP_MAX = 10;                      // сообщений в одном посте (альбом считается по штукам)
const WELCOME_BTN = 'Выйти на тропу';   // подпись кнопки под приветственным постом
const WELCOME_TAIL = 'Дальше по кнопке.'; // у альбома кнопку повесить нельзя, она уходит отдельной строкой

export const USER_COMMANDS = [
  { command: 'start', description: 'Начать' },
  { command: 'week', description: 'Сводка за неделю сейчас' },
  { command: 'feedback', description: 'Обратная связь' },
  { command: 'digest_off', description: 'Выключить сводку' },
  { command: 'delete_me', description: 'Удалить все мои данные' }
];
export const ADMIN_COMMANDS = [
  { command: 'stats', description: 'Статистика' },
  { command: 'new', description: 'Новый пост для всех' },
  { command: 'welcome', description: 'Приветственный пост' },
  ...USER_COMMANDS
];
const rid = () => 1 + crypto.randomInt(2147483000);

export function makeBot({ db, tg, cfg, limiter }) {
  const msgLimit = makeGate(limiter, 30, 60000);
  // Адрес мини-аппки может появиться уже после старта (берётся из адреса Worker), поэтому читаем его в момент вызова.
  const url = () => cfg.webappUrl;
  const openKb = () => (url() ? [[{ text: 'Открыть тропу', web_app: { url: url() } }]] : []);

  const send = (to, text, kb) => db.enqueue(to, 'sendMessage', { chat_id: to, text, ...(kb && kb.length ? { reply_markup: { inline_keyboard: kb } } : {}) });
  const answer = (to, id, text) => db.enqueue(to, 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  const dropButtons = async (to, msg) => { if (msg) await db.enqueue(to, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }); };

  const consentKb = () => {
    const rows = [[{ text: 'Принимаю', callback_data: 'consent:yes' }, { text: 'Не принимаю', callback_data: 'consent:no' }]];
    if (url()) rows.push([{ text: 'Политика обработки данных', url: url() + '/policy' }]);
    return rows;
  };
  const askConsent = to => send(to,
    'Привет. Это тропа покупок: складываешь сюда, что хочется, и копишь на это по шагам.\n\n' +
    'Чтобы хранить твои вещи и суммы, нужно согласие на обработку данных. Что храним и как всё стереть, написано в политике.',
    consentKb());

  async function sendMenuOnce(tgId) {
    const u = await db.getUser(tgId);
    if (!url() || !u || u.menu_set) return;
    await db.enqueue(tgId, 'setChatMenuButton', { chat_id: tgId, menu_button: { type: 'web_app', text: 'Тропа', web_app: { url: url() } } });
    await db.setMenuSet(tgId);
  }

  const getDraft = async id => {
    const raw = await db.kvGet('draft:' + id);
    if (!raw) return null;
    try { const d = JSON.parse(raw); return d.exp > Date.now() ? d : null; } catch { return null; }
  };
  const setDraft = (id, d) => db.kvSet('draft:' + id, JSON.stringify({ ...d, exp: Date.now() + DRAFT_TTL }));
  const clearDraft = id => db.kvDel('draft:' + id);

  // ---------- админ ----------
  const adminId = async () => Number(await db.kvGet('admin_id')) || 0;
  /** Админ определяется по username из ADMIN_USERNAMES один раз, дальше только по числовому id. */
  async function isAdmin(from, username) {
    const id = await adminId();
    if (id) return id === from;
    if (username && cfg.adminUsernames.includes(String(username).toLowerCase())) {
      await db.kvAdd('admin_id', from);                 // кто успел первым с нужным username, тот и админ
      if ((await adminId()) !== from) return false;
      await db.enqueue(from, 'setMyCommands', { commands: ADMIN_COMMANDS, scope: { type: 'chat', chat_id: from } });
      return true;
    }
    return false;
  }
  const who = (name, username) => `${name || 'без имени'}${username ? ' (@' + username + ')' : ''}`;
  async function notifyJoin({ id, name, username }) {
    const a = await adminId();
    if (!a || a === id) return;
    await send(a, `Новый участник: ${who(name, username)}. Всего: ${await db.consentedCount()}.`);
  }
  async function statsText() {
    const s = await db.stats();
    return [
      `Участников: ${s.consented}${s.blocked ? ` (заблокировали бота: ${s.blocked})` : ''}`,
      `Пришли за сутки: ${s.d1}, за неделю: ${s.d7}`,
      `Вещей на тропе: ${s.items}, куплено: ${s.bought}`,
      `Сводка включена у ${s.digest}`,
      `Очередь отправки: ждёт ${s.pending}, не доставлено ${s.failed}`
    ].join('\n');
  }
  const getNp = async id => {
    const raw = await db.kvGet('np:' + id);
    if (!raw) return null;
    try { const d = JSON.parse(raw); return d.exp > Date.now() ? d : null; } catch { return null; }
  };
  const setNp = (id, d) => db.kvSet('np:' + id, JSON.stringify({ ...d, exp: Date.now() + NP_TTL }));
  const npKb = [[{ text: 'Предпросмотр', callback_data: 'np:prev' }], [{ text: 'Отмена', callback_data: 'np:cancel' }]];

  // ---------- приветственный пост ----------
  // Лежит одной записью kv: { from, ids, album, btn, at }. Копируется с сообщений в чате админа, поэтому их нельзя удалять.
  const getWelcome = async () => {
    const raw = await db.kvGet('welcome');
    if (!raw) return null;
    try { const w = JSON.parse(raw); return w && Array.isArray(w.ids) && w.ids.length && w.from ? w : null; } catch { return null; }
  };
  /** Из чего состоит приветствие для одного человека. Админу показываем ровно то же, что уйдёт новичкам. */
  function welcomeParts(w, to) {
    const base = { chat_id: to, from_chat_id: w.from };
    if (!(w.btn && url())) return [['copyMessages', { ...base, message_ids: w.ids }]];
    const kb = { inline_keyboard: [[{ text: WELCOME_BTN, web_app: { url: url() } }]] };
    if (w.album) return [['copyMessages', { ...base, message_ids: w.ids }], ['sendMessage', { chat_id: to, text: WELCOME_TAIL, reply_markup: kb }]];
    const parts = [];
    if (w.ids.length > 1) parts.push(['copyMessages', { ...base, message_ids: w.ids.slice(0, -1) }]);
    parts.push(['copyMessage', { ...base, message_id: w.ids.at(-1), reply_markup: kb }]);
    return parts;
  }
  /** Новичку: в очередь отправки, один раз на версию поста. */
  async function sendWelcome(to) {
    const w = await getWelcome();
    if (!w || (await db.kvGet('wel:' + to)) === String(w.at)) return;
    for (const [m, p] of welcomeParts(w, to)) await db.enqueue(to, m, p);
    await db.kvSet('wel:' + to, w.at);
  }
  /** Админу: сразу, без очереди, чтобы увидеть ошибку, если исходные сообщения удалили. */
  async function previewWelcome(to, w) {
    try { for (const [m, p] of welcomeParts(w, to)) await tg.call(m, p); return true; } catch { return false; }
  }
  async function welcomeMenu(from) {
    const w = await getWelcome();
    if (!w) {
      await send(from, 'Приветственного поста пока нет. Собери пост через /new, на предпросмотре нажми «Сделать приветственным».');
      return;
    }
    const off = [{ text: 'Убрать приветствие', callback_data: 'wel:off' }];
    if (!(await previewWelcome(from, w))) {
      await send(from, 'Не получилось показать приветствие: исходные сообщения, похоже, удалили. Новичкам оно не дойдёт. Собери пост заново через /new или убери его.', [off]);
      return;
    }
    await send(from, `Выше то, что получает новичок после /start, до просьбы о согласии. Кнопка «${WELCOME_BTN}»: ${w.btn ? 'есть' : 'нет'}.`,
      [[{ text: w.btn ? 'Убрать кнопку' : `Добавить кнопку «${WELCOME_BTN}»`, callback_data: 'wel:btn' }], off]);
  }

  async function startFeedback(from) {
    await db.kvSet('fb:' + from, String(Date.now() + FB_TTL));
    await send(from, 'Напиши, что думаешь о тропе: идея, баг, что не нравится. Можно текст, скриншот или голосовое. Я передам, ответ придёт сюда. Отменить: /start.');
  }
  async function passFeedback(from, msg, name, username) {
    const a = await adminId();
    if (!a) { await send(from, 'Пока некому передать. Попробуй чуть позже.'); return; }
    try {
      const head = await tg.call('sendMessage', { chat_id: a, text: `Отзыв от ${who(name, username)}.\nОтветь на это сообщение или на следующее, ответ уйдёт ему.` });
      const copy = await tg.call('copyMessage', { chat_id: a, from_chat_id: from, message_id: msg.message_id });
      const exp = Date.now() + FB_MAP_TTL;
      for (const m of [head, copy]) if (m && m.message_id) await db.kvSet('fbmap:' + m.message_id, `${from}:${exp}`);
      await db.kvDel('fb:' + from);
      await send(from, 'Передал. Если нужно, отвечу здесь.');
    } catch { await send(from, 'Не получилось передать. Напиши ещё раз чуть позже.'); }
  }


  /** Отзыв из мини-аппки: тот же путь к админу, что и у /feedback, только текст приходит из формы. */
  async function submitFeedback({ from, name, username, text }) {
    const a = await adminId();
    if (!a) return 'no-admin';
    try {
      const head = await tg.call('sendMessage', { chat_id: a, text: `Отзыв из приложения от ${who(name, username)}:\n\n${text}\n\nОтветь на это сообщение, ответ уйдёт ему в бот.` });
      if (head && head.message_id) await db.kvSet('fbmap:' + head.message_id, `${from}:${Date.now() + FB_MAP_TTL}`);
      return 'ok';
    } catch { return 'fail'; }
  }

  async function fetchPhoto(fileId) {
    try {
      const f = await tg.call('getFile', { file_id: fileId });
      if (!f || !f.file_path) return null;
      const buf = await tg.download(f.file_path, { maxBytes: 200000 });
      return isJpeg(buf) ? buf : null;
    } catch { return null; }
  }

  async function createItem(from, d) {
    if (await db.countItems(from) >= cfg.maxItems) {
      await clearDraft(from);
      await send(from, `На тропе уже ${cfg.maxItems} вещей, это максимум. Убери что-нибудь в приложении, потом пришли ещё раз.`, openKb());
      return;
    }
    const id = rid();
    await db.upsertItem(from, { id, name: d.name, price: d.price, saved: 0, zone: 1, icon: 'auto', tint: crypto.randomInt(5), bg: '', ln: '', fit: 'contain', link: d.link || '' });
    let withPhoto = false;
    if (d.fileId) {
      const buf = await fetchPhoto(d.fileId);
      if (buf) { await db.setPhoto(from, id, buf); withPhoto = true; }
    }
    await clearDraft(from);
    const kb = [[{ text: '→ Сейчас', callback_data: `mv:${id}:0` }, { text: '→ Мечты', callback_data: `mv:${id}:2` }], ...openKb()];
    await send(from, `Добавлено: «${d.name}», ${fmt(d.price)}. Лежит в «Потом»${withPhoto ? '' : d.fileId ? ' (фото не получилось забрать, поставишь в приложении)' : ''}.`, kb);
  }

  async function onAddFlow(from, msg, text) {
    const photos = Array.isArray(msg.photo) ? msg.photo : [];
    let fileId = '';
    if (photos.length) {
      const ok = photos.filter(p => p.file_size && p.file_size <= 190000).sort((a, b) => b.file_size - a.file_size)[0];
      fileId = (ok || photos[0]).file_id;
    }
    const p = parseAdd(text);
    let d = await getDraft(from);
    const fresh = !!(p.link || fileId);
    if (fresh) d = { name: p.name, price: p.price, link: p.link, fileId };
    else if (d) {
      if (p.name && p.price) { d.name = p.name; d.price = p.price; }
      else { if (!d.price && p.price) d.price = p.price; if (!d.name && p.name) d.name = p.name; }
    } else if (p.name && p.price) d = { name: p.name, price: p.price, link: '', fileId: '' };
    else {
      await send(from, 'Пришли ссылку на товар (Ozon, Wildberries, Яндекс Маркет) или напиши название и цену. Например: Лампа 4300.', openKb());
      return;
    }
    if (d.name && d.price) { await createItem(from, d); return; }
    await setDraft(from, d);
    if (d.name) await send(from, `Сколько стоит «${d.name}»? Напиши числом.`);
    else if (d.price) await send(from, `Цена ${fmt(d.price)}. Как назвать вещь?`);
    else await send(from, 'Что это за вещь и сколько стоит? Например: Лампа 4300.');
  }

  async function weekNow(from) {
    const u = await db.getUser(from);
    const items = await db.listItems(from);
    if (!items.length) { await send(from, 'На тропе пока пусто. Пришли ссылку или напиши «Лампа 4300».', openKb()); return; }
    const d = buildDigest(u, items, url());
    await send(from, d.text, d.reply_markup.inline_keyboard);
  }

  async function onMessage(msg) {
    if (!msg.from || msg.from.is_bot || !msg.chat || msg.chat.type !== 'private') return;
    const from = msg.from.id;
    if (!(await msgLimit(from))) return;
    const user = await db.ensureUser(from, msg.from.first_name || '');
    const text = String(msg.text ?? msg.caption ?? '').slice(0, 2000);
    const cmd = text.startsWith('/') ? text.split(/[\s@]/)[0].toLowerCase() : '';
    const admin = await isAdmin(from, msg.from.username);

    if (cmd === '/start' || cmd === '/help') {
      if (!user.consent_at) {
        if (/^\/start(@\w+)?$/i.test(text.trim())) await sendWelcome(from);   // с «/start feedback» человек пришёл по делу, без приветствия
        await askConsent(from);
        return;
      }
      await db.kvDel('fb:' + from);
      if (/^\/start(@\w+)?\s+feedback\b/i.test(text)) { await startFeedback(from); return; }
      await send(from, 'Пришли ссылку на товар и цену, например:\nЛампа 4300 https://ozon.ru/t/…\n\nКоманды: /week сводка сейчас, /feedback написать мне, /digest_off и /digest_on включают и выключают сводку, /delete_me стирает всё.', openKb());
      return;
    }
    if (admin && cmd === '/stats') { await send(from, await statsText()); return; }
    if (admin && cmd === '/new') {
      await setNp(from, { ids: [] });
      await send(from, `Пришли пост: текст, картинки, всё что нужно, можно несколькими сообщениями (до ${NP_MAX}). Премиум-эмодзи подойдут. Потом нажми «Предпросмотр».`, [[{ text: 'Отмена', callback_data: 'np:cancel' }]]);
      return;
    }
    if (admin && cmd === '/welcome') { await welcomeMenu(from); return; }
    // ответ админа на отзыв: уходит тому, кто писал
    if (admin && msg.reply_to_message) {
      const m = String(await db.kvGet('fbmap:' + msg.reply_to_message.message_id) || '').split(':').map(Number);
      if (m[0] && m[1] > Date.now()) {
        await send(m[0], 'Ответ от создателя:');
        await db.enqueue(m[0], 'copyMessage', { chat_id: m[0], from_chat_id: from, message_id: msg.message_id });
        await send(from, 'Отправил.');
        return;
      }
    }
    // сборка поста для рассылки
    if (admin && !cmd) {
      const np = await getNp(from);
      if (np) {
        if (np.ids.length >= NP_MAX) { await send(from, `Уже ${NP_MAX} сообщений, это максимум. Нажми «Предпросмотр».`, npKb); return; }
        np.ids.push(msg.message_id);
        const again = msg.media_group_id && np.group === msg.media_group_id;   // альбом подтверждаем один раз
        np.group = msg.media_group_id || '';
        await setNp(from, np);
        if (!again) await send(from, `Добавил (${np.ids.length}). Можно прислать ещё или нажать «Предпросмотр».`, npKb);
        return;
      }
    }
    if (cmd === '/delete_me') {
      await send(from, 'Удалю всё: вещи, суммы, историю покупок и твою учётку. Вернуть будет нельзя.', [[{ text: 'Удалить всё', callback_data: 'delme:yes' }, { text: 'Оставить', callback_data: 'delme:no' }]]);
      return;
    }
    if (!user.consent_at) { await askConsent(from); return; }

    if (cmd === '/week') { await weekNow(from); return; }
    if (cmd === '/feedback') { await startFeedback(from); return; }
    if (cmd === '/digest_off') { await db.setSettings(from, { digest: false }); await send(from, 'Сводку по воскресеньям выключил. Включить снова: /digest_on.'); return; }
    if (cmd === '/digest_on') { await db.setSettings(from, { digest: true }); await send(from, 'Сводка включена. Буду писать раз в неделю, по воскресеньям вечером.'); return; }
    if (cmd) return;

    if (Number(await db.kvGet('fb:' + from) || 0) > Date.now()) { await passFeedback(from, msg, user.first_name, msg.from.username); return; }

    const await_ = Number(await db.kvGet('await_amt:' + from) || 0);
    if (await_ > Date.now()) {
      const amt = parseAmount(text);
      if (amt) {
        await db.kvDel('await_amt:' + from);
        await db.setSettings(from, { weekAmount: amt });
        await send(from, `Обычная сумма: ${fmt(amt)} в неделю. В сводке появится кнопка «+${fmt(amt)} как обычно».`);
        return;
      }
    }
    await onAddFlow(from, msg, text);
  }

  async function onCallback(cb) {
    if (!cb.from || !cb.data || !cb.message) return;
    const from = cb.from.id;
    if (!(await msgLimit(from))) return;
    const [kind, a, b] = String(cb.data).slice(0, 64).split(':');
    const user = await db.ensureUser(from, cb.from.first_name || '');

    if (kind === 'consent') {
      if (a === 'yes') {
        const first = !user.consent_at;
        await db.setConsent(from, 'bot');
        if (first) await notifyJoin({ id: from, name: user.first_name, username: cb.from.username });
        await answer(from, cb.id);
        await dropButtons(from, cb.message);
        await sendMenuOnce(from);
        await send(from, 'Готово. Открывай тропу. Чтобы добавить вещь, пришли ссылку на товар и цену, например: Лампа 4300. Ссылку я только сохраню, в магазин по ней не хожу.', openKb());
      } else {
        await answer(from, cb.id);
        await dropButtons(from, cb.message);
        await send(from, 'Хорошо, ничего не сохраняю. Если передумаешь, нажми /start.');
      }
      return;
    }
    if (kind === 'delme') {
      if (a === 'yes') {
        await db.deleteUser(from); // чистит и очередь, поэтому ответы ставим после
        await answer(from, cb.id);
        await dropButtons(from, cb.message);
        await db.enqueue(from, 'sendMessage', { chat_id: from, text: 'Всё удалено. Если захочешь вернуться, нажми /start.' });
      } else {
        await answer(from, cb.id);
        await dropButtons(from, cb.message);
        await send(from, 'Ок, ничего не трогаю.');
      }
      return;
    }
    if (kind === 'np') {
      await answer(from, cb.id);
      if (!(await isAdmin(from, cb.from.username))) return;
      const np = await getNp(from);
      if (a === 'cancel') { await db.kvDel('np:' + from); await dropButtons(from, cb.message); await send(from, 'Отменил.'); return; }
      if (!np || !np.ids.length) { await send(from, 'Пост пустой. Пришли текст или картинку.'); return; }
      if (a === 'prev') {
        await dropButtons(from, cb.message);
        try { await tg.call('copyMessages', { chat_id: from, from_chat_id: from, message_ids: np.ids }); }
        catch { await send(from, 'Не получилось показать предпросмотр. Пришли пост заново: /new.'); return; }
        const n = (await db.recipients(from)).length;
        await send(from, `Так увидят получатели. Отправить ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'человеку' : 'людям'}?`,
          [[{ text: 'Отправить всем', callback_data: 'np:send' }], [{ text: 'Сделать приветственным', callback_data: 'np:wel' }],
            [{ text: 'Собрать заново', callback_data: 'np:redo' }, { text: 'Отмена', callback_data: 'np:cancel' }]]);
        return;
      }
      if (a === 'wel' && !b) {
        await dropButtons(from, cb.message);
        await send(from, `Приветственный пост получает каждый новый человек сразу после /start, до просьбы о согласии. Добавить под него кнопку «${WELCOME_BTN}»?`,
          [[{ text: 'С кнопкой', callback_data: 'np:wel:1' }, { text: 'Без кнопки', callback_data: 'np:wel:0' }], [{ text: 'Отмена', callback_data: 'np:cancel' }]]);
        return;
      }
      if (a === 'wel' && (b === '1' || b === '0')) {
        await dropButtons(from, cb.message);
        const w = { from, ids: np.ids, album: !!np.group, btn: b === '1', at: Date.now() };
        if (!(await previewWelcome(from, w))) { await send(from, 'Не получилось собрать приветствие. Пришли пост заново: /new.'); return; }
        await db.kvSet('welcome', JSON.stringify(w));
        await db.kvDel('np:' + from);
        await send(from, 'Готово. Выше то, что получит новый человек после /start. Эти сообщения в чате с ботом не удаляй: приветствие копируется с них. Поменять кнопку или убрать приветствие: /welcome.');
        return;
      }
      if (a === 'redo') { await dropButtons(from, cb.message); await setNp(from, { ids: [] }); await send(from, 'Ок, пришли пост заново.', [[{ text: 'Отмена', callback_data: 'np:cancel' }]]); return; }
      if (a === 'send') {
        await dropButtons(from, cb.message);
        await db.kvDel('np:' + from);                  // повторное нажатие уже ничего не отправит
        const list = await db.recipients(from);
        for (const to of list) await db.enqueue(to, 'copyMessages', { chat_id: to, from_chat_id: from, message_ids: np.ids });
        await send(from, `Поставил в очередь: ${list.length}. Доходит не сразу, около 15 сообщений в минуту. Ход смотри в /stats.`);
        return;
      }
      return;
    }
    if (kind === 'wel') {
      await answer(from, cb.id);
      if (!(await isAdmin(from, cb.from.username))) return;
      await dropButtons(from, cb.message);
      const w = await getWelcome();
      if (!w) { await send(from, 'Приветственного поста уже нет.'); return; }
      if (a === 'off') { await db.kvDel('welcome'); await send(from, 'Убрал. Новые люди получат обычное приветствие без поста.'); return; }
      if (a === 'btn') { await db.kvSet('welcome', JSON.stringify({ ...w, btn: !w.btn })); await welcomeMenu(from); }
      return;
    }
    if (!user.consent_at) { await answer(from, cb.id); await askConsent(from); return; }

    const id = Number(a), amt = Number(b);
    if (kind === 'mv' && Number.isSafeInteger(id) && [0, 1, 2].includes(amt)) {
      const it = await db.getItem(from, id);
      await answer(from, cb.id);
      if (!it) return;
      await db.setItemZone(from, id, amt);
      await dropButtons(from, cb.message);
      await send(from, `Теперь «${it.name}» в «${ZONE_NAMES[amt]}».`, openKb());
      return;
    }
    if (kind === 'usual' && Number.isSafeInteger(id) && Number.isSafeInteger(amt) && amt > 0 && amt <= 10000000) {
      const it = await db.getItem(from, id);
      if (!it) { await answer(from, cb.id, 'Этой вещи уже нет'); return; }
      const add = Math.min(amt, it.price - it.saved);
      await answer(from, cb.id);
      await dropButtons(from, cb.message);
      if (add <= 0) { await send(from, `На «${it.name}» уже хватает.`, openKb()); return; }
      await db.setItemSaved(from, id, it.saved + add);
      const now = it.saved + add;
      let t = `Добавил ${fmt(add)} к «${it.name}»: ${fmt(now)} из ${fmt(it.price)}.`;
      if (now >= it.price) t += ' Хватает, можно покупать.';
      else { const w = etaWeeks(it.price - now, amt); if (w) t += ` При такой сумме хватит через ${weeksText(w)}.`; }
      const nonce = crypto.randomBytes(5).toString('hex');
      await db.kvSet('undo:' + nonce, `${Date.now() + 3600000}:${from}:${id}:${add}`);
      await send(from, t, [[{ text: 'Отменить', callback_data: `undo:${nonce}` }], ...openKb()]);
      return;
    }
    if (kind === 'undo' && /^[0-9a-f]{10}$/.test(a || '')) {
      await answer(from, cb.id);
      await dropButtons(from, cb.message);
      const val = await db.kvGet('undo:' + a);
      await db.kvDel('undo:' + a);                 // одноразово: повторное нажатие ничего не делает
      const [exp, who, itemId, add] = String(val || '').split(':').map(Number);
      const it = val && who === from && exp > Date.now() ? await db.getItem(from, itemId) : null;
      if (!it || it.saved < add) { await send(from, 'Отменить уже нельзя: отмена использована или сумма изменилась.'); return; }
      await db.setItemSaved(from, itemId, it.saved - add);
      await send(from, `Отменил. На «${it.name}» снова ${fmt(it.saved - add)}.`);
      return;
    }
    if (kind === 'setamt') {
      await answer(from, cb.id);
      await db.kvSet('await_amt:' + from, String(Date.now() + 10 * 60 * 1000));
      await send(from, 'Сколько обычно откладываете за неделю? Напиши числом, например 3000.');
      return;
    }
    if (kind === 'skip') { await answer(from, cb.id); await dropButtons(from, cb.message); await send(from, 'Ок, на этой неделе без записи.'); return; }
    await answer(from, cb.id);
  }

  async function onMyChatMember(m) {
    if (!m.chat || m.chat.type !== 'private' || !m.new_chat_member) return;
    const st = m.new_chat_member.status;
    if (await db.getUser(m.chat.id)) await db.setBlocked(m.chat.id, st === 'kicked' || st === 'left');
  }

  async function handleUpdate(u) {
    if (u.message) return onMessage(u.message);
    if (u.callback_query) return onCallback(u.callback_query);
    if (u.my_chat_member) return onMyChatMember(u.my_chat_member);
  }

  return { handleUpdate, pickTarget, notifyJoin, submitFeedback };
}
