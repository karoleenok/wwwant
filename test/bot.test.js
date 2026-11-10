import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../server/db.js';
import { makeBot } from '../server/bot.js';
import { makeConfig } from '../server/config.js';
import { buildDigest, isDigestTime, inDigestWindow, digestTick } from '../server/digest.js';
import { outboxTick } from '../server/outbox.js';
import { TgError } from '../server/tg.js';
import { JPEG, d1Shim } from './helpers.js';

const cfg = makeConfig({ WEBAPP_URL: 'https://wwwant.example' });
const U = 555;
const fakeTg = { call: async m => (m === 'getFile' ? { file_path: 'photos/a.jpg' } : true), download: async () => JPEG };
const raw = (x = {}) => ({ id: 1, name: 'x', price: 100, saved: 0, zone: 1, icon: 'package', tint: 0, bg: '', ln: '', fit: 'contain', link: '', ...x });

function setup() {
  const d1 = d1Shim();
  const db = makeDb(d1);
  const bot = makeBot({ db, tg: fakeTg, cfg });
  const sent = () => d1.raw.prepare('SELECT method,payload FROM outbox ORDER BY id').all().map(r => ({ method: r.method, ...JSON.parse(r.payload) }));
  const msg = (text, extra = {}) => bot.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: U, type: 'private' }, from: { id: U, first_name: 'Каро' }, text, ...extra } });
  const cb = data => bot.handleUpdate({ update_id: 2, callback_query: { id: 'cb1', from: { id: U, first_name: 'Каро' }, data, message: { message_id: 9, chat: { id: U } } } });
  const last = () => sent().filter(x => x.method === 'sendMessage').at(-1);
  return { d1, db, bot, sent, msg, cb, last };
}
const consent = async s => { await s.msg('/start'); await s.cb('consent:yes'); };

test('/start без согласия просит согласие и ничего не сохраняет', async () => {
  const s = setup();
  await s.msg('/start');
  const m = s.last();
  assert.match(m.text, /согласие на обработку данных/);
  assert.equal(m.reply_markup.inline_keyboard[0][0].callback_data, 'consent:yes');
  assert.equal(m.reply_markup.inline_keyboard[1][0].url, 'https://wwwant.example/policy');
  await s.msg('Лампа 4300');                    // без согласия вещь не создаётся
  assert.equal(await s.db.countItems(U), 0);
  await s.cb('consent:no');
  assert.equal((await s.db.getUser(U)).consent_at, null);
});

test('адрес мини-аппки подхватывается, даже если появился после создания бота', async () => {
  const late = makeConfig({});
  const d1 = d1Shim(); const db = makeDb(d1);
  const bot = makeBot({ db, tg: fakeTg, cfg: late });
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: U, type: 'private' }, from: { id: U, first_name: 'К' }, text: '/start' } });
  const before = JSON.parse(d1.raw.prepare('SELECT payload FROM outbox').get().payload);
  assert.equal(before.reply_markup.inline_keyboard.length, 1);          // адреса ещё нет, кнопки политики нет
  late.webappUrl = 'https://wwwant.example';
  await bot.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: U, type: 'private' }, from: { id: U, first_name: 'К' }, text: '/start' } });
  const rows = d1.raw.prepare('SELECT payload FROM outbox ORDER BY id').all();
  assert.equal(JSON.parse(rows[1].payload).reply_markup.inline_keyboard[1][0].url, 'https://wwwant.example/policy');
});

test('согласие: кнопка меню ставится один раз', async () => {
  const s = setup();
  await consent(s);
  assert.ok((await s.db.getUser(U)).consent_at);
  assert.equal(s.sent().filter(x => x.method === 'setChatMenuButton').length, 1);
  await s.cb('consent:yes');
  assert.equal(s.sent().filter(x => x.method === 'setChatMenuButton').length, 1);
});

test('добавление: ссылка + цена одним сообщением', async () => {
  const s = setup(); await consent(s);
  await s.msg('Лампа 4300 https://www.ozon.ru/t/abc123');
  const [it] = await s.db.listItems(U);
  assert.equal(it.name, 'Лампа'); assert.equal(it.price, 4300); assert.equal(it.zone, 1);
  assert.equal(s.d1.raw.prepare('SELECT link,icon FROM items').get().link, 'https://www.ozon.ru/t/abc123');
  assert.equal(s.d1.raw.prepare('SELECT icon FROM items').get().icon, 'auto');
  assert.match(s.last().text, /Добавлено: «Лампа», 4\s300\s₽/);
});

test('добавление: только ссылка, потом название, потом цена', async () => {
  const s = setup(); await consent(s);
  await s.msg('https://market.yandex.ru/cc/9rsgau');
  assert.match(s.last().text, /Что это за вещь и сколько стоит/);
  await s.msg('Наушники');
  assert.match(s.last().text, /Сколько стоит «Наушники»/);
  assert.equal(await s.db.countItems(U), 0);
  await s.msg('12 900');
  const [it] = await s.db.listItems(U);
  assert.equal(it.price, 12900); assert.equal(it.name, 'Наушники');
});

test('добавление: фото с подписью забирает JPEG', async () => {
  const s = setup(); await consent(s);
  await s.msg(undefined, { text: undefined, caption: 'Кроссовки 12800', photo: [{ file_id: 'a', file_size: 5000 }, { file_id: 'b', file_size: 90000 }] });
  const [it] = await s.db.listItems(U);
  assert.equal(it.name, 'Кроссовки'); assert.equal(it.has_photo, 1);
  assert.deepEqual(await s.db.getPhoto(U, it.id), JPEG);
});

test('перенос по кнопке и защита от чужих id', async () => {
  const s = setup(); await consent(s);
  await s.msg('Лампа 4300');
  const id = (await s.db.listItems(U))[0].id;
  await s.cb(`mv:${id}:0`);
  assert.equal((await s.db.listItems(U))[0].zone, 0);
  await s.cb('mv:999:2'); await s.cb('mv:abc:2'); await s.cb(`mv:${id}:9`);
  assert.equal((await s.db.listItems(U))[0].zone, 0);
});

test('сводка: цель, прогноз, кнопка «как обычно», отмена', async () => {
  const s = setup(); await consent(s);
  await s.msg('Шкаф-купе 11500'); await s.msg('Лампа 4300');
  const ids = (await s.db.listItems(U)).map(i => i.id);
  await s.db.setItemSaved(U, ids[0], 4200);
  await s.db.setSettings(U, { weekAmount: 3000 });
  await s.msg('/week');
  const d = s.last();
  assert.match(d.text, /Копим на «Шкаф-купе»: 4\s200\s₽ из 11\s500\s₽/);
  assert.match(d.text, /хватит через\s3\sнедели/);
  const usual = d.reply_markup.inline_keyboard[0][0];
  assert.equal(usual.callback_data, `usual:${ids[0]}:3000`);
  await s.cb(usual.callback_data);
  assert.equal((await s.db.getItem(U, ids[0])).saved, 7200);
  const undo = s.last().reply_markup.inline_keyboard[0][0].callback_data;
  await s.cb(undo);
  assert.equal((await s.db.getItem(U, ids[0])).saved, 4200);
  await s.cb(undo);                                // повторная отмена не уводит в минус
  assert.equal((await s.db.getItem(U, ids[0])).saved, 4200);
});

test('«обычная сумма» не пробивает цену вещи, без суммы просит задать', async () => {
  const s = setup(); await consent(s);
  await s.msg('Лампа 4300');
  const id = (await s.db.listItems(U))[0].id;
  await s.db.setItemSaved(U, id, 4000);
  await s.cb(`usual:${id}:3000`);
  assert.equal((await s.db.getItem(U, id)).saved, 4300);
  assert.match(s.last().text, /Хватает, можно покупать/);
  const s2 = setup(); await consent(s2);
  await s2.msg('Лампа 4300'); await s2.msg('/week');
  assert.equal(s2.last().reply_markup.inline_keyboard[0][0].callback_data, 'setamt');
  await s2.cb('setamt'); await s2.msg('3 000');
  assert.equal((await s2.db.getUser(U)).week_amount, 3000);
});

test('/delete_me стирает всё и не оставляет очереди', async () => {
  const s = setup(); await consent(s);
  await s.msg('Лампа 4300');
  await s.msg('/delete_me');
  assert.equal(await s.db.countItems(U), 1);           // пока не подтвердили
  await s.cb('delme:yes');
  assert.equal(await s.db.getUser(U), null); assert.equal(await s.db.countItems(U), 0);
  const left = s.d1.raw.prepare('SELECT method FROM outbox').all().map(r => r.method);
  assert.ok(left.includes('sendMessage'));       // только «Всё удалено»
  assert.equal(left.filter(m => m === 'sendMessage').length, 1);
});

test('лимит вещей на тропе', async () => {
  const s = setup(); await consent(s);
  for (let i = 0; i < 60; i++) await s.db.upsertItem(U, raw({ id: i + 1, name: 'в' + i }));
  await s.msg('Лампа 4300');
  assert.equal(await s.db.countItems(U), 60);
  assert.match(s.last().text, /максимум/);
});

test('окно сводки: воскресенье 18:00 по Москве, раз в неделю', () => {
  const sunday1830 = Date.UTC(2026, 10, 15, 15, 30);   // 15.11.2026, 18:30 MSK
  const user = { last_digest_at: null };
  assert.equal(isDigestTime(cfg, sunday1830, user), true);
  assert.equal(isDigestTime(cfg, Date.UTC(2026, 10, 15, 10, 0), user), false);  // 13:00 MSK
  assert.equal(isDigestTime(cfg, Date.UTC(2026, 10, 16, 15, 30), user), false); // понедельник
  assert.equal(isDigestTime(cfg, sunday1830, { last_digest_at: sunday1830 - 3600000 }), false);
});

test('inDigestWindow: быстрая проверка без базы совпадает с окном', () => {
  assert.equal(inDigestWindow(cfg, Date.UTC(2026, 10, 15, 15, 0)), true);    // 18:00 MSK, воскресенье
  assert.equal(inDigestWindow(cfg, Date.UTC(2026, 10, 15, 18, 59)), true);   // 21:59 MSK
  assert.equal(inDigestWindow(cfg, Date.UTC(2026, 10, 15, 19, 0)), false);   // 22:00 MSK
  assert.equal(inDigestWindow(cfg, Date.UTC(2026, 10, 15, 14, 59)), false);  // 17:59 MSK
  assert.equal(inDigestWindow(cfg, Date.UTC(2026, 10, 16, 15, 30)), false);  // понедельник
});

test('digestTick: одному пользователю один раз, выключенным и без вещей не шлёт', async () => {
  const s = setup(); await consent(s);
  await s.msg('Лампа 4300');
  await s.db.ensureUser(7, 'B'); await s.db.setConsent(7, 'bot');           // без вещей
  await s.db.ensureUser(8, 'C'); await s.db.setConsent(8, 'bot'); await s.db.setSettings(8, { digest: false });
  await s.db.upsertItem(8, raw({ id: 1, name: 'x', price: 5, zone: 0 }));
  const t = Date.UTC(2026, 10, 15, 15, 30);
  const before = s.sent().length;
  assert.equal(await digestTick({ db: s.db, cfg, nowMs: t }), 1);
  assert.equal(await digestTick({ db: s.db, cfg, nowMs: t + 600000 }), 0);
  assert.equal(s.sent().length, before + 1);
});

test('сводка, когда копить не на что', () => {
  const d = buildDigest({ week_amount: 3000 }, [{ id: 1, name: 'Лампа', price: 100, saved: 100, zone: 1, pos: 0 }], '');
  assert.match(d.text, /Уже хватает: «Лампа»/);
  assert.ok(!/Копим на/.test(d.text));
});

test('очередь: 429 ждёт, 403 помечает блок, сетевой сбой повторяется', async () => {
  const d1 = d1Shim(); const db = makeDb(d1);
  await db.ensureUser(1, 'a'); await db.ensureUser(2, 'b'); await db.ensureUser(3, 'c');
  await db.enqueue(1, 'sendMessage', { chat_id: 1, text: 'x' }); await db.enqueue(2, 'sendMessage', { chat_id: 2, text: 'y' }); await db.enqueue(3, 'sendMessage', { chat_id: 3, text: 'z' });
  const tg = { call: async (m, p) => { if (p.chat_id === 1) throw new TgError(429, 'slow', 2); if (p.chat_id === 2) throw new TgError(403, 'blocked'); throw new TgError(0, 'network:Timeout'); } };
  await outboxTick({ db, tg });
  const rows = d1.raw.prepare('SELECT tg_id,status,tries,next_at FROM outbox ORDER BY id').all();
  assert.equal(rows[0].status, 'pending'); assert.ok(rows[0].next_at > Date.now());
  assert.equal(rows[1].status, 'failed'); assert.equal((await db.getUser(2)).blocked, 1);
  assert.equal(rows[2].status, 'pending'); assert.equal(rows[2].tries, 1);
});

test('очередь: два параллельных прохода не отправляют одно сообщение дважды', async () => {
  const d1 = d1Shim(); const db = makeDb(d1);
  for (let i = 0; i < 5; i++) await db.enqueue(1, 'sendMessage', { chat_id: 1, text: 'm' + i });
  const got = [];
  const tg = { call: async (m, p) => { got.push(p.text); await new Promise(r => setTimeout(r, 5)); return true; } };
  await Promise.all([outboxTick({ db, tg }), outboxTick({ db, tg })]);
  assert.deepEqual([...got].sort(), ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.equal((await db.outboxStats()).find(r => r.status === 'sent').n, 5);
});

test('очередь: застрявшее сообщение вернётся после окончания аренды', async () => {
  const d1 = d1Shim(); const db = makeDb(d1);
  await db.enqueue(1, 'sendMessage', { chat_id: 1, text: 'a' });
  assert.equal((await db.claimDue()).length, 1);
  assert.equal((await db.claimDue()).length, 0);                       // аренда ещё идёт
  d1.raw.prepare('UPDATE outbox SET next_at=?').run(Date.now() - 1);   // «воркер умер», аренда истекла
  assert.equal((await db.claimDue()).length, 1);
});

test('пакет синхронизации атомарный: при ошибке в середине ничего не записано', async () => {
  const d1 = d1Shim(); const db = makeDb(d1);
  await db.ensureUser(U, 'a');
  await db.upsertItem(U, raw({ id: 1, name: 'старая' }));
  const real = d1.batch.bind(d1);
  d1.batch = async list => {
    if (list.some(x => /^DELETE FROM items/.test(x.sql))) {            // боевой пакет синхронизации: ломаем его последнюю запись
      list[list.length - 1].run = async () => { throw new Error('boom'); };
    }
    return real(list);
  };
  await db.kvGet('x');                                                  // схема создаётся до подмены
  await assert.rejects(db.applySync(U, { remove: [1], upserts: [raw({ id: 2, name: 'новая' })], maxItems: 60, maxBought: 200 }));
  const ids = (await db.listItems(U)).map(i => i.id);
  assert.deepEqual(ids, [1]);                                           // удаление «старой» откатилось вместе со всем
});
