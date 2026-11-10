import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, call, item, JPEG, TOKEN } from './helpers.js';

const HTTPS = { 'x-forwarded-proto': 'https' };

test('/claim: код, токен через getMe, файл 0600, потом 404', async () => {
  const t = await startApp();
  try {
    let r = await fetch(t.base + '/health'); assert.equal((await r.json()).status, 'waiting-token');
    // по http токен не принимаем
    r = await fetch(t.base + '/claim'); assert.equal(r.status, 400);
    r = await fetch(t.base + '/claim', { headers: HTTPS }); assert.equal(r.status, 200);
    const form = (code, token) => fetch(t.base + '/claim', { method: 'POST', headers: { ...HTTPS, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, token }) });
    r = await form('wrong', TOKEN); assert.equal(r.status, 403);
    r = await form('code-12345', 'не-токен'); assert.equal(r.status, 400);
    r = await form('code-12345', '123456789:' + 'B'.repeat(35)); assert.equal(r.status, 400); // Telegram не принял
    assert.ok(!fs.existsSync(path.join(t.dir, 'bot.token')));
    r = await form('code-12345', TOKEN); assert.equal(r.status, 200);
    const f = path.join(t.dir, 'bot.token');
    assert.equal(fs.readFileSync(f, 'utf8'), TOKEN);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    r = await fetch(t.base + '/claim', { headers: HTTPS }); assert.equal(r.status, 404);
    r = await fetch(t.base + '/health'); assert.equal((await r.json()).status, 'ok');
  } finally { await t.close(); }
});

test('/claim: после 5 неверных кодов страница закрывается', async () => {
  const t = await startApp();
  try {
    for (let i = 0; i < 5; i++) await fetch(t.base + '/claim', { method: 'POST', headers: { ...HTTPS, 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=x&token=y' });
    const r = await fetch(t.base + '/claim', { headers: HTTPS }); assert.equal(r.status, 404);
  } finally { await t.close(); }
});

test('API: без подписи 401, чужая подпись 401, пока нет токена 503', async () => {
  const t = await startApp({}, { withToken: false });
  try {
    assert.equal((await call(t.base, 'GET', '/api/state')).status, 503);
  } finally { await t.close(); }
  const t2 = await startApp({}, { withToken: true });
  try {
    assert.equal((await call(t2.base, 'GET', '/api/state', { auth: '' })).status, 401);
    assert.equal((await call(t2.base, 'GET', '/api/state', { auth: 'tma hash=abc' })).status, 401);
    const other = (await import('../server/auth.js')).signInitData({ id: 1, first_name: 'x' }, '1:' + 'z'.repeat(35));
    assert.equal((await call(t2.base, 'GET', '/api/state', { auth: 'tma ' + other })).status, 401);
  } finally { await t2.close(); }
});

test('API: согласие обязательно, синхронизация, валидация, лимиты', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    let r = await call(t.base, 'GET', '/api/state');
    assert.equal(r.status, 200); assert.equal(r.data.consent, false); assert.equal(r.data.items, undefined);
    r = await call(t.base, 'POST', '/api/sync', { body: { upsert: [item()] } });
    assert.equal(r.status, 403); assert.equal(r.data.error, 'consent');
    assert.equal((await call(t.base, 'POST', '/api/consent')).status, 200);

    r = await call(t.base, 'POST', '/api/sync', { body: { upsert: [item(), item({ id: 12, name: 'Шкаф', price: 11500, saved: 4200, zone: 0 })], order: [11, 12] } });
    assert.equal(r.status, 200);
    r = await call(t.base, 'GET', '/api/state');
    assert.deepEqual(r.data.items.map(i => i.id), [11, 12]);
    assert.equal(r.data.items[1].saved, 4200);

    // плохая ссылка, нулевая цена, чужая зона
    assert.equal((await call(t.base, 'POST', '/api/sync', { body: { upsert: [item({ id: 13, link: 'javascript:alert(1)' })] } })).status, 400);
    assert.equal((await call(t.base, 'POST', '/api/sync', { body: { upsert: [item({ id: 13, price: 0 })] } })).status, 400);
    assert.equal((await call(t.base, 'POST', '/api/sync', { body: { upsert: [item({ id: 13, zone: 7 })] } })).status, 400);
    // не json
    assert.equal((await call(t.base, 'POST', '/api/sync', { headers: { 'content-type': 'text/plain' } })).status, 415);
    // удаление и порядок
    r = await call(t.base, 'POST', '/api/sync', { body: { remove: [11], order: [12] } });
    assert.equal((await call(t.base, 'GET', '/api/state')).data.items.length, 1);
    // история покупок
    await call(t.base, 'POST', '/api/sync', { body: { boughtAdd: [{ name: 'Лампа', price: 4300, icon: 'lamp', at: Date.now() }] } });
    assert.equal((await call(t.base, 'GET', '/api/state')).data.bought.length, 1);
    // лимит вещей
    const many = Array.from({ length: 60 }, (_, i) => item({ id: 100 + i, name: 'в' + i }));
    assert.equal((await call(t.base, 'POST', '/api/sync', { body: { upsert: many } })).status, 409);
    // настройки
    assert.equal((await call(t.base, 'POST', '/api/settings', { body: { digest: false, weekAmount: 3000 } })).status, 200);
    const s = (await call(t.base, 'GET', '/api/state')).data.settings;
    assert.deepEqual(s, { digest: false, weekAmount: 3000 });
    assert.equal((await call(t.base, 'POST', '/api/settings', { body: { weekAmount: -5 } })).status, 400);
  } finally { await t.close(); }
});

test('IDOR: чужие вещи и фото недоступны', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    for (const u of [1001, 2002]) await call(t.base, 'POST', '/api/consent', { user: u });
    await call(t.base, 'POST', '/api/sync', { user: 1001, body: { upsert: [item({ id: 77, name: 'Секрет' })] } });
    let r = await call(t.base, 'PUT', '/api/photo/77', { user: 1001, raw: JPEG });
    assert.equal(r.status, 200);
    const url = r.data.photo;
    // другой пользователь не видит вещь и не может залить фото
    assert.equal((await call(t.base, 'GET', '/api/state', { user: 2002 })).data.items.length, 0);
    assert.equal((await call(t.base, 'PUT', '/api/photo/77', { user: 2002, raw: JPEG })).status, 404);
    // запись с тем же id у другого человека не затирает чужую
    await call(t.base, 'POST', '/api/sync', { user: 2002, body: { upsert: [item({ id: 77, name: 'Моя' })] } });
    assert.equal((await call(t.base, 'GET', '/api/state', { user: 1001 })).data.items[0].name, 'Секрет');
    // фото по ссылке-ключу открывается, с подделанным ключом нет
    r = await fetch(t.base + url); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(t.base + url.slice(0, -4) + '0000')).status, 404);
    // не-JPEG не принимаем
    assert.equal((await call(t.base, 'PUT', '/api/photo/77', { user: 1001, raw: Buffer.from('<html>') })).status, 415);
    // слишком большое
    assert.equal((await call(t.base, 'PUT', '/api/photo/77', { user: 1001, raw: Buffer.concat([JPEG, Buffer.alloc(210000)]) })).status, 413);
    // удалили фото: ссылка перестаёт работать
    await call(t.base, 'DELETE', '/api/photo/77', { user: 1001 });
    assert.equal((await fetch(t.base + url)).status, 404);
  } finally { await t.close(); }
});

test('wipe и delete_me', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    await call(t.base, 'POST', '/api/consent');
    await call(t.base, 'POST', '/api/sync', { body: { upsert: [item()], boughtAdd: [{ name: 'x', price: 1, icon: 'a', at: Date.now() }] } });
    await call(t.base, 'POST', '/api/wipe');
    let s = (await call(t.base, 'GET', '/api/state')).data;
    assert.equal(s.items.length, 0); assert.equal(s.bought.length, 0); assert.equal(s.consent, true);
    await call(t.base, 'POST', '/api/sync', { body: { upsert: [item()] } });
    await call(t.base, 'POST', '/api/delete_me');
    assert.equal(t.app.db.getUser(1001), null);
    assert.equal(t.app.db.countItems(1001), 0);
    s = (await call(t.base, 'GET', '/api/state')).data;
    assert.equal(s.consent, false); // учётка создаётся заново без согласия
  } finally { await t.close(); }
});

test('заголовки: CSP с хэшем скрипта, frame-ancestors, nosniff; /policy открыт', async () => {
  const t = await startApp({}, { withToken: true });
  try {
    const r = await fetch(t.base + '/');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' https:\/\/telegram\.org 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /frame-ancestors https:\/\/web\.telegram\.org/);
    assert.ok(!/unsafe-inline.*script|script-src[^;]*unsafe/.test(csp));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    const html = await r.text();
    // хэш из заголовка совпадает с реальным inline-скриптом
    const crypto = await import('node:crypto');
    const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
    const h = 'sha256-' + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
    assert.ok(csp.includes(h));
    const p = await fetch(t.base + '/policy'); assert.equal(p.status, 200);
    assert.match(await p.text(), /Политика обработки данных/);
    assert.equal((await fetch(t.base + '/server/db.js')).status, 404);
    assert.equal((await fetch(t.base + '/..%2f..%2fetc/passwd')).status, 404);
  } finally { await t.close(); }
});
