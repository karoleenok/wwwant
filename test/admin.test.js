import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../server/db.js';
import { makeBot, ADMIN_COMMANDS, USER_COMMANDS } from '../server/bot.js';
import { makeConfig } from '../server/config.js';
import { JPEG, d1Shim, startApp, authHeader, call, ORIGIN, TOKEN } from './helpers.js';

const ADMIN = 1, A_NAME = 'karolenok', GUEST = 2, GUEST2 = 3;
const tgCalls = [];
const fakeTg = { call: async (m, p) => { tgCalls.push({ m, p }); return m === 'sendMessage' || m === 'copyMessage' ? { message_id: 500 + tgCalls.length } : true; }, download: async () => JPEG };

function setup() {
  tgCalls.length = 0;
  const d1 = d1Shim(); const db = makeDb(d1);
  const bot = makeBot({ db, tg: fakeTg, cfg: makeConfig({ WEBAPP_URL: 'https://x.example' }) });
  const queue = () => d1.raw.prepare('SELECT tg_id,method,payload FROM outbox ORDER BY id').all().map(r => ({ to: r.tg_id, method: r.method, ...JSON.parse(r.payload) }));
  let mid = 100;
  const msg = (id, text, extra = {}, username) => bot.handleUpdate({ update_id: 1, message: { message_id: ++mid, chat: { id, type: 'private' }, from: { id, first_name: 'N' + id, ...(username ? { username } : {}) }, text, ...extra } });
  const cb = (id, data, username) => bot.handleUpdate({ update_id: 2, callback_query: { id: 'c', from: { id, first_name: 'N' + id, ...(username ? { username } : {}) }, data, message: { message_id: 9, chat: { id } } } });
  const join = async (id, username) => { await msg(id, '/start', {}, username); await cb(id, 'consent:yes', username); };
  return { db, queue, msg, cb, join };
}

test('админ привязывается по username один раз, чужие не становятся админом', async () => {
  const s = setup();
  await s.msg(GUEST, '/stats');                                  // без username
  assert.equal(await s.db.kvGet('admin_id'), null);
  await s.msg(GUEST, '/stats', {}, 'someone_else');
  assert.equal(await s.db.kvGet('admin_id'), null);
  await s.msg(ADMIN, '/start', {}, 'Karolenok');                 // регистр не важен
  assert.equal(await s.db.kvGet('admin_id'), String(ADMIN));
  await s.msg(GUEST, '/stats', {}, 'karolenok');                 // тот же username у другого id: уже поздно
  assert.equal(await s.db.kvGet('admin_id'), String(ADMIN));
  const q = s.queue();
  assert.ok(q.some(x => x.method === 'setMyCommands' && x.scope.chat_id === ADMIN && x.commands.some(c => c.command === 'stats')));
  assert.ok(!q.some(x => x.to === GUEST && /Участников/.test(x.text || '')));
});

test('меню команд: у всех обратная связь, статистика и рассылка только у админа', () => {
  const names = l => l.map(c => c.command);
  assert.ok(names(USER_COMMANDS).includes('feedback'));
  assert.ok(!names(USER_COMMANDS).includes('stats'));
  assert.ok(names(ADMIN_COMMANDS).includes('stats') && names(ADMIN_COMMANDS).includes('new') && names(ADMIN_COMMANDS).includes('feedback'));
});

test('новый участник: админу приходит уведомление, повторное согласие не дублирует', async () => {
  const s = setup();
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await s.join(GUEST, 'guest_u');
  let n = s.queue().filter(x => x.to === ADMIN && /Новый участник/.test(x.text || ''));
  assert.equal(n.length, 1);
  assert.match(n[0].text, /N2 \(@guest_u\)\. Всего: 1/);
  await s.cb(GUEST, 'consent:yes', 'guest_u');
  n = s.queue().filter(x => x.to === ADMIN && /Новый участник/.test(x.text || ''));
  assert.equal(n.length, 1);
});

test('/stats показывает числа админу', async () => {
  const s = setup();
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await s.join(GUEST, 'g'); await s.join(GUEST2, 'g2');
  await s.msg(ADMIN, '/stats', {}, A_NAME);
  const t = s.queue().filter(x => x.to === ADMIN && /Участников/.test(x.text || '')).at(-1).text;
  assert.match(t, /Участников: 2/);
  assert.match(t, /за сутки: 2/);
});

test('/new: сборка, предпросмотр, рассылка копиями всем согласившимся и только раз', async () => {
  const s = setup();
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await s.join(GUEST, 'g'); await s.join(GUEST2, 'g2');
  await s.msg(GUEST, '/new', {}, 'g');                           // не админ: ничего
  assert.equal(await s.db.kvGet('np:' + GUEST), null);
  await s.msg(ADMIN, '/new', {}, A_NAME);
  await s.msg(ADMIN, 'Привет 🎉', { entities: [{ type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: '1' }] }, A_NAME);
  await s.msg(ADMIN, '', { photo: [{ file_id: 'f', file_size: 10 }], media_group_id: 'G1' }, A_NAME);
  await s.msg(ADMIN, '', { photo: [{ file_id: 'f2', file_size: 10 }], media_group_id: 'G1' }, A_NAME);
  const acks = s.queue().filter(x => x.to === ADMIN && /Добавил/.test(x.text || ''));
  assert.equal(acks.length, 2);                                   // альбом подтверждён один раз
  await s.cb(ADMIN, 'np:prev', A_NAME);
  assert.ok(tgCalls.some(c => c.m === 'copyMessages' && c.p.chat_id === ADMIN && c.p.message_ids.length === 3));
  await s.cb(GUEST, 'np:send', 'g');                              // чужая кнопка не работает
  assert.equal(s.queue().filter(x => x.method === 'copyMessages').length, 0);
  await s.cb(ADMIN, 'np:send', A_NAME);
  await s.cb(ADMIN, 'np:send', A_NAME);                           // повтор не дублирует
  const out = s.queue().filter(x => x.method === 'copyMessages');
  assert.deepEqual(out.map(x => x.to).sort(), [GUEST, GUEST2].sort());
  assert.equal(out[0].from_chat_id, ADMIN);
  assert.equal(out[0].message_ids.length, 3);
});

test('/feedback: отзыв доходит админу, ответ админа доходит автору', async () => {
  const s = setup();
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await s.join(GUEST, 'g');
  await s.msg(GUEST, '/feedback', {}, 'g');
  await s.msg(GUEST, 'Хочу тёмную тему', {}, 'g');
  const head = tgCalls.find(c => c.m === 'sendMessage' && c.p.chat_id === ADMIN && /Отзыв от N2 \(@g\)/.test(c.p.text));
  const copy = tgCalls.find(c => c.m === 'copyMessage' && c.p.chat_id === ADMIN && c.p.from_chat_id === GUEST);
  assert.ok(head && copy);
  assert.equal(await s.db.kvGet('fb:' + GUEST), null);           // режим выключился после отправки
  const copyId = Number(await (async () => { for (const id of [501, 502, 503, 504, 505, 506, 507, 508, 509, 510]) { if (await s.db.kvGet('fbmap:' + id)) { last = id; } } return last; })());
  await s.msg(ADMIN, 'Добавим!', { reply_to_message: { message_id: copyId } }, A_NAME);
  const q = s.queue().filter(x => x.to === GUEST);
  assert.ok(q.some(x => x.method === 'sendMessage' && /Ответ от создателя/.test(x.text)));
  assert.ok(q.some(x => x.method === 'copyMessage' && x.from_chat_id === ADMIN));
  await s.msg(GUEST, 'Просто текст без команды', {}, 'g');       // режим выключен: это не отзыв
  assert.equal(tgCalls.filter(c => c.m === 'copyMessage' && c.p.from_chat_id === GUEST).length, 1);
});
let last = 0;

test('аватарка: загрузка, выдача в state, сброс, не-JPEG отклоняется', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    assert.equal((await call(t, 'POST', '/api/consent', { body: {} })).status, 200);
    const state = async () => (await call(t, 'GET', '/api/state')).data;
    assert.equal((await state()).avatar, '');
    assert.equal((await call(t, 'PUT', '/api/avatar', { raw: Buffer.from('not a jpeg at all') })).status, 415);
    assert.equal((await call(t, 'PUT', '/api/avatar', { raw: Buffer.concat([JPEG, Buffer.alloc(70000)]) })).status, 413);
    assert.equal((await call(t, 'PUT', '/api/avatar', { raw: JPEG })).status, 200);
    assert.match((await state()).avatar, /^data:image\/jpeg;base64,/);
    assert.equal((await call(t, 'DELETE', '/api/avatar')).status, 200);
    assert.equal((await state()).avatar, '');
  } finally { await t.close(); }
});
