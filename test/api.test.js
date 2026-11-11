import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, call, item, JPEG, TOKEN, ORIGIN } from './helpers.js';
import { signInitData } from '../server/auth.js';

const post = (t, body, secret) => t.fetch('/tg', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(body) });
const startUpdate = { update_id: 1, message: { message_id: 1, chat: { id: 77, type: 'private' }, from: { id: 77, first_name: 'Каро' }, text: '/start' } };

test('первый заход: без токена ждём, с токеном сами подключаем webhook, кнопку и команды', async () => {
  const t0 = await startApp();
  try {
    const r = await t0.fetch('/health');
    assert.equal((await r.json()).status, 'waiting-token');
    assert.equal(t0.tgs.calls.length, 0);
  } finally { await t0.close(); }

  const t = await startApp({}, { withToken: true });
  try {
    let r = await t.fetch('/health');
    const h = await r.json();
    assert.equal(h.status, 'ok'); assert.equal(h.bot, 'wwwant_test_bot');
    const hook = t.tgs.calls.find(c => c.method === 'setWebhook');
    assert.equal(hook.params.url, ORIGIN + '/tg');
    assert.equal(hook.params.secret_token, await t.db.secret('webhook'));
    assert.deepEqual(hook.params.allowed_updates, ['message', 'callback_query', 'my_chat_member']);
    assert.ok(t.tgs.calls.some(c => c.method === 'setChatMenuButton'));
    assert.ok(t.tgs.calls.some(c => c.method === 'setMyCommands'));
    // повторный заход ничего не перенастраивает
    const n = t.tgs.calls.length;
    await t.fetch('/health');
    assert.equal(t.tgs.calls.length, n);
  } finally { await t.close(); }
});

test('адрес берётся из того, по которому открыли Worker, и запоминается', async () => {
  const t = await startApp({ WEBAPP_URL: '' }, { withToken: true });
  try {
    await t.fetch('/health');
    assert.equal(t.tgs.calls.find(c => c.method === 'setWebhook').params.url, ORIGIN + '/tg');
    assert.equal(await t.db.kvGet('origin'), ORIGIN);
  } finally { await t.close(); }
});

test('токен сменили (новый бот): webhook ставится заново', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    await t.fetch('/health');
    await t.db.kvSet('setup', 'old|deadbeef');           // как будто раньше был другой бот
    t.app.state.setupKey = '';
    await t.fetch('/health');
    assert.equal(t.tgs.calls.filter(c => c.method === 'setWebhook').length, 2);
  } finally { await t.close(); }
});

test('webhook: чужой секрет 401, верный принимает апдейт и отправляет ответ', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    assert.equal((await t.fetch('/tg')).status, 405);
    assert.equal((await post(t, startUpdate, 'wrong')).status, 401);
    assert.equal((await post(t, startUpdate, '')).status, 401);
    const secret = await t.db.secret('webhook');
    const r = await post(t, startUpdate, secret);
    assert.equal(r.status, 200);
    await t.settle();
    const msg = t.tgs.calls.find(c => c.method === 'sendMessage');
    assert.equal(msg.params.chat_id, 77);
    assert.match(msg.params.text, /согласие на обработку данных/);
    // кривой json не роняет сервис
    const bad = await t.fetch('/tg', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: '{' });
    assert.equal(bad.status, 400);
  } finally { await t.close(); }
});

test('webhook без токена: 503', async () => {
  const t = await startApp();
  try { assert.equal((await post(t, startUpdate, 'x')).status, 503); } finally { await t.close(); }
});

test('API: без подписи 401, чужая подпись 401, пока нет токена 503', async () => {
  const t = await startApp();
  try {
    assert.equal((await call(t, 'GET', '/api/state')).status, 503);
  } finally { await t.close(); }
  const t2 = await startApp({}, { withToken: true });
  try {
    assert.equal((await call(t2, 'GET', '/api/state', { auth: '' })).status, 401);
    assert.equal((await call(t2, 'GET', '/api/state', { auth: 'tma hash=abc' })).status, 401);
    const other = signInitData({ id: 1, first_name: 'x' }, '1:' + 'z'.repeat(35));
    assert.equal((await call(t2, 'GET', '/api/state', { auth: 'tma ' + other })).status, 401);
  } finally { await t2.close(); }
});

test('API: согласие обязательно, синхронизация, валидация, лимиты', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    let r = await call(t, 'GET', '/api/state');
    assert.equal(r.status, 200); assert.equal(r.data.consent, false); assert.equal(r.data.items, undefined);
    r = await call(t, 'POST', '/api/sync', { body: { upsert: [item()] } });
    assert.equal(r.status, 403); assert.equal(r.data.error, 'consent');
    assert.equal((await call(t, 'POST', '/api/consent')).status, 200);

    r = await call(t, 'POST', '/api/sync', { body: { upsert: [item(), item({ id: 12, name: 'Шкаф', price: 11500, saved: 4200, zone: 0 })], order: [11, 12] } });
    assert.equal(r.status, 200);
    r = await call(t, 'GET', '/api/state');
    assert.deepEqual(r.data.items.map(i => i.id), [11, 12]);
    assert.equal(r.data.items[1].saved, 4200);

    // плохая ссылка, нулевая цена, чужая зона
    assert.equal((await call(t, 'POST', '/api/sync', { body: { upsert: [item({ id: 13, link: 'javascript:alert(1)' })] } })).status, 400);
    assert.equal((await call(t, 'POST', '/api/sync', { body: { upsert: [item({ id: 13, price: 0 })] } })).status, 400);
    assert.equal((await call(t, 'POST', '/api/sync', { body: { upsert: [item({ id: 13, zone: 7 })] } })).status, 400);
    // не json
    assert.equal((await call(t, 'POST', '/api/sync', { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await call(t, 'POST', '/api/sync', { headers: { 'content-type': 'application/json' }, raw: undefined, body: undefined })).status, 400);
    // удаление и порядок
    r = await call(t, 'POST', '/api/sync', { body: { remove: [11], order: [12] } });
    assert.equal((await call(t, 'GET', '/api/state')).data.items.length, 1);
    // история покупок
    await call(t, 'POST', '/api/sync', { body: { boughtAdd: [{ name: 'Лампа', price: 4300, icon: 'lamp', at: Date.now() }] } });
    assert.equal((await call(t, 'GET', '/api/state')).data.bought.length, 1);
    // лимит вещей: 409 и ничего не записано (пакет атомарный)
    const many = Array.from({ length: 60 }, (_, i) => item({ id: 100 + i, name: 'в' + i }));
    assert.equal((await call(t, 'POST', '/api/sync', { body: { upsert: many } })).status, 409);
    assert.equal(await t.db.countItems(1001), 1);
    // настройки
    assert.equal((await call(t, 'POST', '/api/settings', { body: { digest: false, weekAmount: 3000 } })).status, 200);
    const s = (await call(t, 'GET', '/api/state')).data.settings;
    assert.deepEqual(s, { digest: false, weekAmount: 3000 });
    assert.equal((await call(t, 'POST', '/api/settings', { body: { weekAmount: -5 } })).status, 400);
  } finally { await t.close(); }
});

test('порядок и позиции: новые вещи встают в конец, order переставляет', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    await call(t, 'POST', '/api/consent');
    await call(t, 'POST', '/api/sync', { body: { upsert: [item({ id: 1, name: 'a' }), item({ id: 2, name: 'b' }), item({ id: 3, name: 'c' })] } });
    assert.deepEqual((await call(t, 'GET', '/api/state')).data.items.map(i => i.id), [1, 2, 3]);
    await call(t, 'POST', '/api/sync', { body: { order: [3, 1] } });            // 2 не названа, уходит в конец
    assert.deepEqual((await call(t, 'GET', '/api/state')).data.items.map(i => i.id), [3, 1, 2]);
    await call(t, 'POST', '/api/sync', { body: { upsert: [item({ id: 4, name: 'd' })] } });
    assert.deepEqual((await call(t, 'GET', '/api/state')).data.items.map(i => i.id), [3, 1, 2, 4]);
    // правка существующей не двигает её
    await call(t, 'POST', '/api/sync', { body: { upsert: [item({ id: 1, name: 'a2', price: 999 })] } });
    const it = (await call(t, 'GET', '/api/state')).data.items;
    assert.deepEqual(it.map(i => i.id), [3, 1, 2, 4]);
    assert.equal(it[1].name, 'a2');
  } finally { await t.close(); }
});

test('IDOR: чужие вещи и фото недоступны', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    for (const u of [1001, 2002]) await call(t, 'POST', '/api/consent', { user: u });
    await call(t, 'POST', '/api/sync', { user: 1001, body: { upsert: [item({ id: 77, name: 'Секрет' })] } });
    let r = await call(t, 'PUT', '/api/photo/77', { user: 1001, raw: JPEG });
    assert.equal(r.status, 200);
    const url = r.data.photo;
    // другой пользователь не видит вещь и не может залить фото
    assert.equal((await call(t, 'GET', '/api/state', { user: 2002 })).data.items.length, 0);
    assert.equal((await call(t, 'PUT', '/api/photo/77', { user: 2002, raw: JPEG })).status, 404);
    // запись с тем же id у другого человека не затирает чужую
    await call(t, 'POST', '/api/sync', { user: 2002, body: { upsert: [item({ id: 77, name: 'Моя' })] } });
    assert.equal((await call(t, 'GET', '/api/state', { user: 1001 })).data.items[0].name, 'Секрет');
    // фото по ссылке-ключу открывается и совпадает с загруженным, с подделанным ключом нет
    r = await t.fetch(url); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), JPEG);
    assert.equal((await t.fetch(url.slice(0, -4) + '0000')).status, 404);
    // не-JPEG не принимаем
    assert.equal((await call(t, 'PUT', '/api/photo/77', { user: 1001, raw: Buffer.from('<html>') })).status, 415);
    // слишком большое
    assert.equal((await call(t, 'PUT', '/api/photo/77', { user: 1001, raw: Buffer.concat([JPEG, Buffer.alloc(210000)]) })).status, 413);
    // удалили фото: ссылка перестаёт работать
    await call(t, 'DELETE', '/api/photo/77', { user: 1001 });
    assert.equal((await t.fetch(url)).status, 404);
  } finally { await t.close(); }
});

test('wipe и delete_me', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    await call(t, 'POST', '/api/consent');
    await call(t, 'POST', '/api/sync', { body: { upsert: [item()], boughtAdd: [{ name: 'x', price: 1, icon: 'a', at: Date.now() }] } });
    await call(t, 'POST', '/api/wipe');
    let s = (await call(t, 'GET', '/api/state')).data;
    assert.equal(s.items.length, 0); assert.equal(s.bought.length, 0); assert.equal(s.consent, true);
    await call(t, 'POST', '/api/sync', { body: { upsert: [item()] } });
    await call(t, 'POST', '/api/delete_me');
    assert.equal(await t.db.getUser(1001), null);
    assert.equal(await t.db.countItems(1001), 0);
    s = (await call(t, 'GET', '/api/state')).data;
    assert.equal(s.consent, false); // учётка создаётся заново без согласия
  } finally { await t.close(); }
});

test('заголовки: CSP с хэшем скрипта, frame-ancestors, nosniff; /policy открыт; лишнего не отдаём', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    const r = await t.fetch('/');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' https:\/\/telegram\.org 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /frame-ancestors https:\/\/web\.telegram\.org/);
    assert.ok(!/unsafe-inline.*script|script-src[^;]*unsafe/.test(csp));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    const html = await r.text();
    // хэш из заголовка совпадает с реальным inline-скриптом
    const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
    const h = 'sha256-' + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
    assert.ok(csp.includes(h));
    const p = await t.fetch('/policy'); assert.equal(p.status, 200);
    const ptxt = await p.text();
    assert.match(ptxt, /Политика обработки данных/);
    assert.ok(!/в России/.test(ptxt));                      // не обещаем размещение, которого нет
    assert.equal((await t.fetch('/server/db.js')).status, 404);
    assert.equal((await t.fetch('/claim')).status, 404);    // страницы токена больше нет: токен только в секретах
    assert.equal((await t.fetch('/..%2f..%2fetc/passwd')).status, 404);
    assert.equal((await t.fetch('/', { method: 'HEAD' })).status, 200);
  } finally { await t.close(); }
});

test('PWA: манифест и иконки отдаются, CSP разрешает манифест', async () => {
  const { fetch, close } = await startApp();
  try {
    const m = await fetch('/manifest.webmanifest');
    assert.equal(m.status, 200);
    const j = await m.json();
    assert.equal(j.display, 'standalone');
    for (const n of [180, 192, 512]) {
      const r = await fetch(`/icon-${n}.png`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'image/png');
      const b = new Uint8Array(await r.arrayBuffer());
      assert.deepEqual([...b.slice(1, 4)], [0x50, 0x4e, 0x47]);
    }
    const page = await fetch('/');
    assert.match(page.headers.get('content-security-policy'), /manifest-src 'self'/);
  } finally { await close(); }
});
