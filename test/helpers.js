import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Buffer } from 'node:buffer';
import { makeConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { makeDb } from '../server/db.js';
import { signInitData } from '../server/auth.js';

export const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
export const INDEX = fs.readFileSync(path.resolve('web/index.html'), 'utf8');

/**
 * Обёртка над node:sqlite с тем же интерфейсом, что у Cloudflare D1: prepare().bind().first()/all()/run() и batch().
 * Так тесты гоняют ровно тот слой данных, который уйдёт в бой. batch атомарный, как в D1.
 */
export function d1Shim() {
  const db = new DatabaseSync(':memory:');
  const mk = sql => {
    const s = {
      sql, args: [],
      bind(...a) { s.args = a.map(x => (x === undefined ? null : x)); return s; },
      async first(col) { const r = db.prepare(sql).get(...s.args); if (!r) return null; return col ? r[col] : { ...r }; },
      async all() { return { success: true, meta: {}, results: db.prepare(sql).all(...s.args).map(r => ({ ...r })) }; },
      async run() { const i = db.prepare(sql).run(...s.args); return { success: true, meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid) } }; }
    };
    return s;
  };
  return {
    raw: db,
    prepare: mk,
    async batch(list) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of list) out.push(/^\s*(select|with)\b/i.test(s.sql) ? await s.all() : await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  };
}

/** Поддельный Telegram: записывает вызовы, отвечает ok. */
export async function fakeTelegram() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
      if (req.url.startsWith('/file/bot')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(JPEG); }
      if (!m) { res.writeHead(404); return res.end(); }
      if (m[1] !== TOKEN) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); }
      const method = m[2];
      const params = body ? JSON.parse(body) : {};
      calls.push({ method, params });
      const done = r => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: r })); };
      if (method === 'getMe') return done({ id: 123456789, username: 'wwwant_test_bot' });
      if (method === 'getFile') return done({ file_path: 'photos/file_1.jpg' });
      if (method === 'sendMessage' || method === 'copyMessage') return done({ message_id: 9000 + calls.length });
      if (method === 'copyMessages') return done([{ message_id: 9000 + calls.length }]);
      return done(true);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }) };
}

export const ORIGIN = 'https://wwwant.example';

export async function startApp(extraEnv = {}, { withToken = false } = {}) {
  const tgs = await fakeTelegram();
  const d1 = d1Shim();
  const cfg = makeConfig({ WEBAPP_URL: ORIGIN, TG_API_BASES: tgs.url, ...extraEnv });
  const app = createApp({ cfg, db: makeDb(d1), token: withToken ? TOKEN : '', indexHtml: INDEX, log: () => {} });
  const pending = [];
  const ctx = { waitUntil: p => pending.push(p) };
  const fetch = (p, init) => app.handle(new Request(ORIGIN + p, init), ctx);
  const settle = async () => { while (pending.length) await pending.shift(); };
  const close = async () => { await settle(); await tgs.close(); };
  return { app, cfg, d1, db: app.db, fetch, settle, tgs, close };
}

export function authHeader(userId = 1001, name = 'Тест', token = TOKEN) {
  return 'tma ' + signInitData({ id: userId, first_name: name }, token);
}

export async function call(t, method, p, { user = 1001, body, raw, headers = {}, auth } = {}) {
  const h = { authorization: auth ?? authHeader(user), ...headers };
  let b;
  if (raw) { h['content-type'] = 'image/jpeg'; b = raw; } else if (body !== undefined) { h['content-type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await t.fetch(p, { method, headers: h, body: b });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}

export const item = (o = {}) => ({ id: 11, name: 'Лампа', price: 4300, saved: 0, zone: 1, icon: 'lamp', tint: 0, bg: '', ln: '', fit: 'contain', link: '', ...o });
