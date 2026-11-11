import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../server/db.js';
import { makeBot, ADMIN_COMMANDS, USER_COMMANDS } from '../server/bot.js';
import { makeConfig } from '../server/config.js';
import { JPEG, d1Shim, startApp, authHeader, call, ORIGIN, TOKEN } from './helpers.js';

const ADMIN = 1, A_NAME = 'karolenok', GUEST = 2, GUEST2 = 3;
const tgCalls = [];
let failCopy = false;                                           // «исходные сообщения удалили»
const fakeTg = { call: async (m, p) => { tgCalls.push({ m, p }); if (failCopy && /^copyMessages?$/.test(m)) throw new Error('400'); return m === 'sendMessage' || m === 'copyMessage' ? { message_id: 500 + tgCalls.length } : true; }, download: async () => JPEG };

function setup() {
  tgCalls.length = 0; failCopy = false;
  const d1 = d1Shim(); const db = makeDb(d1);
  const bot = makeBot({ db, tg: fakeTg, cfg: makeConfig({ WEBAPP_URL: 'https://x.example' }) });
  const queue = () => d1.raw.prepare('SELECT tg_id,method,payload FROM outbox ORDER BY id').all().map(r => ({ to: r.tg_id, method: r.method, ...JSON.parse(r.payload) }));
  let mid = 100;
  const msg = (id, text, extra = {}, username) => bot.handleUpdate({ update_id: 1, message: { message_id: ++mid, chat: { id, type: 'private' }, from: { id, first_name: 'N' + id, ...(username ? { username } : {}) }, text, ...extra } });
  const cb = (id, data, username) => bot.handleUpdate({ update_id: 2, callback_query: { id: 'c', from: { id, first_name: 'N' + id, ...(username ? { username } : {}) }, data, message: { message_id: 9, chat: { id } } } });
  const join = async (id, username) => { await msg(id, '/start', {}, username); await cb(id, 'consent:yes', username); };
  return { db, queue, msg, cb, join, bot };
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


test('отзыв из приложения: доходит админу, ответ админа возвращается автору', async () => {
  const s = setup();
  assert.equal(await s.bot.submitFeedback({ from: GUEST, name: 'N2', username: 'g', text: 'x' }), 'no-admin');
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await s.join(GUEST, 'g');
  tgCalls.length = 0;
  assert.equal(await s.bot.submitFeedback({ from: GUEST, name: 'N2', username: 'g', text: 'Нужна тёмная тема' }), 'ok');
  const sent = tgCalls.find(c => c.m === 'sendMessage' && c.p.chat_id === ADMIN && /Отзыв из приложения от N2 \(@g\)/.test(c.p.text) && /Нужна тёмная тема/.test(c.p.text));
  assert.ok(sent);
  const id = 500 + tgCalls.indexOf(sent) + 1;
  assert.ok(await s.db.kvGet('fbmap:' + id));
  await s.msg(ADMIN, 'Добавим!', { reply_to_message: { message_id: id } }, A_NAME);
  assert.ok(s.queue().some(x => x.to === GUEST && x.method === 'sendMessage' && /Ответ от создателя/.test(x.text)));
});

test('POST /api/feedback: согласие, пустой и длинный текст, пауза, нет админа', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    const post = text => call(t, 'POST', '/api/feedback', { body: { text } });
    assert.equal((await post('привет')).status, 403);                  // без согласия
    assert.equal((await call(t, 'POST', '/api/consent', { body: {} })).status, 200);
    assert.equal((await post('   ')).status, 400);
    assert.equal((await post('я'.repeat(1001))).status, 400);
    assert.equal((await post('Идея')).status, 503);                    // админ ещё не привязан
    assert.equal((await post('Ещё идея')).status, 429);                // слишком часто
  } finally { await t.close(); }
});

/** Админ собирает пост из сообщений и доводит до выбора «Сделать приветственным». */
async function buildPost(s, msgs) {
  await s.msg(ADMIN, '/new', {}, A_NAME);
  for (const [text, extra] of msgs) await s.msg(ADMIN, text, extra || {}, A_NAME);
  await s.cb(ADMIN, 'np:prev', A_NAME);
}
const toGuest = s => s.queue().filter(x => x.to === GUEST);

test('приветствие: выбор после предпросмотра, с кнопкой, новичок получает его первым и один раз', async () => {
  const s = setup();
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await buildPost(s, [['Привет, это тропа']]);
  const prev = tgCalls.length;
  await s.cb(ADMIN, 'np:wel', A_NAME);                            // вопрос про кнопку, ничего не сохранено
  assert.equal(await s.db.kvGet('welcome'), null);
  await s.cb(ADMIN, 'np:wel:1', A_NAME);
  const w = JSON.parse(await s.db.kvGet('welcome'));
  assert.equal(w.from, ADMIN); assert.equal(w.btn, true); assert.equal(w.album, false); assert.equal(w.ids.length, 1);
  assert.equal(await s.db.kvGet('np:' + ADMIN), null);            // черновик рассылки закрыт
  const shown = tgCalls.slice(prev).find(c => c.m === 'copyMessage');
  assert.equal(shown.p.chat_id, ADMIN);                           // админ видит ровно то, что уйдёт новичкам
  assert.equal(shown.p.reply_markup.inline_keyboard[0][0].text, 'Выйти на тропу');
  assert.equal(shown.p.reply_markup.inline_keyboard[0][0].web_app.url, 'https://x.example');

  await s.msg(GUEST, '/start', {}, 'g');
  let q = toGuest(s);
  assert.equal(q[0].method, 'copyMessage');                       // приветствие раньше просьбы о согласии
  assert.equal(q[0].from_chat_id, ADMIN);
  assert.deepEqual(q[0].message_id, w.ids[0]);
  assert.equal(q[0].reply_markup.inline_keyboard[0][0].web_app.url, 'https://x.example');
  assert.equal(q[1].method, 'sendMessage');
  assert.match(q[1].text, /согласие/);
  assert.doesNotMatch(q[1].text, /Это тропа покупок/);            // приветствие уже всё объяснило: остаётся только про данные
  await s.msg(GUEST, '/start', {}, 'g');                          // второй /start до согласия: приветствие не дублируется
  q = toGuest(s);
  assert.equal(q.filter(x => x.method === 'copyMessage').length, 1);
  await s.cb(GUEST, 'consent:yes', 'g');
  await s.msg(GUEST, '/start', {}, 'g');                          // уже свой человек: обычная подсказка
  assert.equal(toGuest(s).filter(x => x.method === 'copyMessage').length, 1);
});

test('приветствие: без кнопки, несколько сообщений, альбом в конце', async () => {
  let s = setup();
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await buildPost(s, [['Раз'], ['Два']]);
  await s.cb(ADMIN, 'np:wel:0', A_NAME);
  await s.msg(GUEST, '/start', {}, 'g');
  let q = toGuest(s).filter(x => /^copy/.test(x.method));
  assert.equal(q.length, 1);                                       // без кнопки: одним альбомно-безопасным вызовом
  assert.equal(q[0].method, 'copyMessages');
  assert.equal(q[0].message_ids.length, 2);
  assert.equal(q[0].reply_markup, undefined);

  s = setup();                                                     // с кнопкой: кнопка на последнем сообщении
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await buildPost(s, [['Раз'], ['Два'], ['Три']]);
  await s.cb(ADMIN, 'np:wel:1', A_NAME);
  await s.msg(GUEST, '/start', {}, 'g');
  q = toGuest(s).filter(x => /^copy/.test(x.method));
  assert.equal(q[0].method, 'copyMessages'); assert.equal(q[0].message_ids.length, 2);
  assert.equal(q[1].method, 'copyMessage'); assert.ok(q[1].reply_markup);
  assert.ok(q[0].message_ids.at(-1) < q[1].message_id);

  s = setup();                                                     // альбом в конце: кнопку вешать не на что, она уходит отдельно
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await buildPost(s, [['', { photo: [{ file_id: 'a', file_size: 10 }], media_group_id: 'G' }], ['', { photo: [{ file_id: 'b', file_size: 10 }], media_group_id: 'G' }]]);
  await s.cb(ADMIN, 'np:wel:1', A_NAME);
  await s.msg(GUEST, '/start', {}, 'g');
  q = toGuest(s);
  assert.equal(q[0].method, 'copyMessages'); assert.equal(q[0].message_ids.length, 2);
  assert.equal(q[1].method, 'sendMessage'); assert.equal(q[1].reply_markup.inline_keyboard[0][0].text, 'Выйти на тропу');
});

test('приветствие: /start с feedback его не получает, чужие кнопки и /welcome не работают', async () => {
  const s = setup();
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await buildPost(s, [['Привет']]);
  await s.cb(GUEST, 'np:wel:1', 'g');                              // не админ
  await s.cb(GUEST, 'wel:off', 'g');
  assert.equal(await s.db.kvGet('welcome'), null);
  await s.cb(ADMIN, 'np:wel:1', A_NAME);
  await s.cb(GUEST, 'wel:off', 'g');                               // чужая кнопка не убирает приветствие
  assert.ok(await s.db.kvGet('welcome'));
  await s.msg(GUEST, '/welcome', {}, 'g');
  assert.ok(!tgCalls.some(c => c.p.chat_id === GUEST && c.m === 'copyMessage'));
  await s.msg(GUEST, '/start feedback', {}, 'g');
  assert.equal(toGuest(s).filter(x => x.method === 'copyMessage').length, 0);
});

test('/welcome: показать, добавить и убрать кнопку, убрать приветствие', async () => {
  const s = setup();
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await s.msg(ADMIN, '/welcome', {}, A_NAME);
  assert.ok(s.queue().some(x => x.to === ADMIN && /пока нет/.test(x.text || '')));
  await buildPost(s, [['Привет']]);
  await s.cb(ADMIN, 'np:wel:0', A_NAME);
  const at = JSON.parse(await s.db.kvGet('welcome')).at;
  await s.cb(ADMIN, 'wel:btn', A_NAME);
  let w = JSON.parse(await s.db.kvGet('welcome'));
  assert.equal(w.btn, true); assert.equal(w.at, at);               // версия не меняется: кто уже видел, второй раз не получит
  await s.cb(ADMIN, 'wel:btn', A_NAME);
  assert.equal(JSON.parse(await s.db.kvGet('welcome')).btn, false);
  await s.cb(ADMIN, 'wel:off', A_NAME);
  assert.equal(await s.db.kvGet('welcome'), null);
  await s.msg(GUEST, '/start', {}, 'g');
  assert.equal(toGuest(s).filter(x => /^copy/.test(x.method)).length, 0);   // приветствия нет, только согласие
  assert.ok(toGuest(s).some(x => x.method === 'sendMessage' && /согласие/.test(x.text) && /Это тропа покупок/.test(x.text)));   // без поста вступление на месте
});

test('приветствие: исходные сообщения удалены, админ узнаёт сразу; /delete_me даёт новое приветствие', async () => {
  const s = setup();
  await s.msg(ADMIN, '/start', {}, A_NAME);
  await buildPost(s, [['Привет']]);
  failCopy = true;
  await s.cb(ADMIN, 'np:wel:1', A_NAME);                           // копия не получилась: ничего не сохраняем
  assert.equal(await s.db.kvGet('welcome'), null);
  assert.ok(s.queue().some(x => x.to === ADMIN && /Не получилось собрать приветствие/.test(x.text || '')));
  failCopy = false;
  await s.cb(ADMIN, 'np:wel:1', A_NAME);
  assert.ok(await s.db.kvGet('welcome'));
  failCopy = true;
  await s.msg(ADMIN, '/welcome', {}, A_NAME);
  assert.ok(s.queue().some(x => x.to === ADMIN && /исходные сообщения, похоже, удалили/.test(x.text || '')));
  failCopy = false;

  await s.msg(GUEST, '/start', {}, 'g');
  assert.ok(await s.db.kvGet('wel:' + GUEST));
  await s.cb(GUEST, 'delme:yes', 'g');
  assert.equal(await s.db.kvGet('wel:' + GUEST), null);            // метка стёрта вместе с остальными данными
  await s.msg(GUEST, '/start', {}, 'g');
  assert.equal(toGuest(s).filter(x => x.method === 'copyMessage').length, 1);
});

test('меню команд админа содержит /welcome, у обычных людей его нет', () => {
  assert.ok(ADMIN_COMMANDS.some(c => c.command === 'welcome'));
  assert.ok(!USER_COMMANDS.some(c => c.command === 'welcome'));
});
