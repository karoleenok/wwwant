import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb } from '../server/db.js';
import { makeBot } from '../server/bot.js';
import { makeConfig } from '../server/config.js';
import { buildDigest, isDigestTime, digestTick } from '../server/digest.js';
import { outboxTick } from '../server/outbox.js';
import { TgError } from '../server/tg.js';
import { JPEG } from './helpers.js';

const cfg = makeConfig({ WEBAPP_URL: 'https://wwwant.example' });
const U = 555;
const fakeTg = { call: async m => (m === 'getFile' ? { file_path: 'photos/a.jpg' } : true), download: async () => JPEG };

function setup() {
  const db = openDb(':memory:');
  const bot = makeBot({ db, tg: fakeTg, cfg });
  const sent = () => db.raw.prepare("SELECT method,payload FROM outbox ORDER BY id").all().map(r => ({ method: r.method, ...JSON.parse(r.payload) }));
  const msg = (text, extra = {}) => bot.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: U, type: 'private' }, from: { id: U, first_name: 'Каро' }, text, ...extra } });
  const cb = (data) => bot.handleUpdate({ update_id: 2, callback_query: { id: 'cb1', from: { id: U, first_name: 'Каро' }, data, message: { message_id: 9, chat: { id: U } } } });
  const last = () => sent().filter(x => x.method === 'sendMessage').at(-1);
  return { db, bot, sent, msg, cb, last };
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
  assert.equal(s.db.countItems(U), 0);
  await s.cb('consent:no');
  assert.equal(s.db.getUser(U).consent_at, null);
});

test('согласие: кнопка меню ставится один раз', async () => {
  const s = setup();
  await consent(s);
  assert.ok(s.db.getUser(U).consent_at);
  assert.equal(s.sent().filter(x => x.method === 'setChatMenuButton').length, 1);
  await s.cb('consent:yes');
  assert.equal(s.sent().filter(x => x.method === 'setChatMenuButton').length, 1);
});

test('добавление: ссылка + цена одним сообщением', async () => {
  const s = setup(); await consent(s);
  await s.msg('Лампа 4300 https://www.ozon.ru/t/abc123');
  const [it] = s.db.listItems(U);
  assert.equal(it.name, 'Лампа'); assert.equal(it.price, 4300); assert.equal(it.zone, 1);
  assert.equal(s.db.raw.prepare('SELECT link,icon FROM items').get().link, 'https://www.ozon.ru/t/abc123');
  assert.equal(s.db.raw.prepare('SELECT icon FROM items').get().icon, 'auto');
  assert.match(s.last().text, /Добавлено: «Лампа», 4 300 ₽/);
});

test('добавление: только ссылка, потом название, потом цена', async () => {
  const s = setup(); await consent(s);
  await s.msg('https://market.yandex.ru/cc/9rsgau');
  assert.match(s.last().text, /Что это за вещь и сколько стоит/);
  await s.msg('Наушники');
  assert.match(s.last().text, /Сколько стоит «Наушники»/);
  assert.equal(s.db.countItems(U), 0);
  await s.msg('12 900');
  assert.equal(s.db.listItems(U)[0].price, 12900);
  assert.equal(s.db.listItems(U)[0].name, 'Наушники');
});

test('добавление: фото с подписью забирает JPEG', async () => {
  const s = setup(); await consent(s);
  await s.msg(undefined, { text: undefined, caption: 'Кроссовки 12800', photo: [{ file_id: 'a', file_size: 5000 }, { file_id: 'b', file_size: 90000 }] });
  const [it] = s.db.listItems(U);
  assert.equal(it.name, 'Кроссовки'); assert.equal(it.has_photo, 1);
  assert.ok(s.db.getPhoto(U, it.id).length > 100);
});

test('перенос по кнопке и защита от чужих id', async () => {
  const s = setup(); await consent(s);
  await s.msg('Лампа 4300');
  const id = s.db.listItems(U)[0].id;
  await s.cb(`mv:${id}:0`);
  assert.equal(s.db.listItems(U)[0].zone, 0);
  await s.cb('mv:999:2'); await s.cb('mv:abc:2'); await s.cb(`mv:${id}:9`);
  assert.equal(s.db.listItems(U)[0].zone, 0);
});

test('сводка: цель, прогноз, кнопка «как обычно», отмена', async () => {
  const s = setup(); await consent(s);
  await s.msg('Шкаф-купе 11500'); await s.msg('Лампа 4300');
  const ids = s.db.listItems(U).map(i => i.id);
  s.db.setItemSaved(U, ids[0], 4200);
  s.db.setSettings(U, { weekAmount: 3000 });
  await s.msg('/week');
  const d = s.last();
  assert.match(d.text, /Копим на «Шкаф-купе»: 4 200 ₽ из 11 500 ₽/);
  assert.match(d.text, /хватит через 3 недели/);
  const usual = d.reply_markup.inline_keyboard[0][0];
  assert.equal(usual.callback_data, `usual:${ids[0]}:3000`);
  await s.cb(usual.callback_data);
  assert.equal(s.db.getItem(U, ids[0]).saved, 7200);
  const undo = s.last().reply_markup.inline_keyboard[0][0].callback_data;
  await s.cb(undo);
  assert.equal(s.db.getItem(U, ids[0]).saved, 4200);
  await s.cb(undo);                                // повторная отмена не уводит в минус
  assert.equal(s.db.getItem(U, ids[0]).saved, 4200);
});

test('«обычная сумма» не пробивает цену вещи, без суммы просит задать', async () => {
  const s = setup(); await consent(s);
  await s.msg('Лампа 4300');
  const id = s.db.listItems(U)[0].id;
  s.db.setItemSaved(U, id, 4000);
  await s.cb(`usual:${id}:3000`);
  assert.equal(s.db.getItem(U, id).saved, 4300);
  assert.match(s.last().text, /Хватает, можно покупать/);
  const s2 = setup(); await consent(s2);
  await s2.msg('Лампа 4300'); await s2.msg('/week');
  assert.equal(s2.last().reply_markup.inline_keyboard[0][0].callback_data, 'setamt');
  await s2.cb('setamt'); await s2.msg('3 000');
  assert.equal(s2.db.getUser(U).week_amount, 3000);
});

test('/delete_me стирает всё и не оставляет очереди', async () => {
  const s = setup(); await consent(s);
  await s.msg('Лампа 4300');
  await s.msg('/delete_me');
  assert.equal(s.db.countItems(U), 1);           // пока не подтвердили
  await s.cb('delme:yes');
  assert.equal(s.db.getUser(U), null); assert.equal(s.db.countItems(U), 0);
  const left = s.db.raw.prepare('SELECT method FROM outbox').all().map(r => r.method);
  assert.ok(left.includes('sendMessage'));       // только «Всё удалено»
  assert.equal(left.filter(m => m === 'sendMessage').length, 1);
});

test('лимит вещей на тропе', async () => {
  const s = setup(); await consent(s);
  for (let i = 0; i < 60; i++) s.db.upsertItem(U, { id: i + 1, name: 'в' + i, price: 100, saved: 0, zone: 1, icon: 'package', tint: 0, bg: '', ln: '', fit: 'contain', link: '' });
  await s.msg('Лампа 4300');
  assert.equal(s.db.countItems(U), 60);
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

test('digestTick: одному пользователю один раз, выключенным и без вещей не шлёт', async () => {
  const s = setup(); await consent(s);
  await s.msg('Лампа 4300');
  s.db.ensureUser(7, 'B'); s.db.setConsent(7, 'bot');           // без вещей
  s.db.ensureUser(8, 'C'); s.db.setConsent(8, 'bot'); s.db.setSettings(8, { digest: false });
  s.db.upsertItem(8, { id: 1, name: 'x', price: 5, saved: 0, zone: 0, icon: 'package', tint: 0, bg: '', ln: '', fit: 'contain', link: '' });
  const t = Date.UTC(2026, 10, 15, 15, 30);
  const before = s.sent().length;
  assert.equal(digestTick({ db: s.db, cfg, nowMs: t }), 1);
  assert.equal(digestTick({ db: s.db, cfg, nowMs: t + 600000 }), 0);
  assert.equal(s.sent().length, before + 1);
});

test('сводка, когда копить не на что', () => {
  const d = buildDigest({ week_amount: 3000 }, [{ id: 1, name: 'Лампа', price: 100, saved: 100, zone: 1, pos: 0 }], '');
  assert.match(d.text, /Уже хватает: «Лампа»/);
  assert.ok(!/Копим на/.test(d.text));
});

test('очередь: 429 ждёт, 403 помечает блок, сетевой сбой повторяется', async () => {
  const db = openDb(':memory:'); db.ensureUser(1, 'a'); db.ensureUser(2, 'b'); db.ensureUser(3, 'c');
  db.enqueue(1, 'sendMessage', { chat_id: 1, text: 'x' }); db.enqueue(2, 'sendMessage', { chat_id: 2, text: 'y' }); db.enqueue(3, 'sendMessage', { chat_id: 3, text: 'z' });
  const tg = { call: async (m, p) => { if (p.chat_id === 1) throw new TgError(429, 'slow', 2); if (p.chat_id === 2) throw new TgError(403, 'blocked'); throw new TgError(0, 'network:Timeout'); } };
  await outboxTick({ db, tg });
  const rows = db.raw.prepare('SELECT tg_id,status,tries,next_at FROM outbox ORDER BY id').all();
  assert.equal(rows[0].status, 'pending'); assert.ok(rows[0].next_at > Date.now());
  assert.equal(rows[1].status, 'failed'); assert.equal(db.getUser(2).blocked, 1);
  assert.equal(rows[2].status, 'pending'); assert.equal(rows[2].tries, 1);
});

test('бэкап: копия открывается, хранятся 14 последних', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwb-'));
  const data = path.join(dir, 'data'), out = path.join(dir, 'bk');
  const db = openDb(path.join(data, 'wwwant.sqlite'));
  db.ensureUser(1, 'a'); db.close();
  fs.mkdirSync(out, { recursive: true });
  for (let i = 1; i <= 16; i++) fs.writeFileSync(path.join(out, `wwwant-2026-10-${String(i).padStart(2, '0')}.sqlite`), 'x');
  const r = spawnSync(process.execPath, ['server/backup.js'], { env: { ...process.env, DATA_DIR: data, BACKUP_DIR: out }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readdirSync(out).length, 14);
  const today = fs.readdirSync(out).filter(f => f.includes(new Date().toISOString().slice(0, 10)))[0];
  assert.equal(fs.statSync(path.join(out, today)).mode & 0o777, 0o600);
  const copy = openDb(path.join(out, today));
  assert.equal(copy.getUser(1).first_name, 'a');
  fs.rmSync(dir, { recursive: true, force: true });
});
