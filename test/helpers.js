import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { signInitData } from '../server/auth.js';

process.env.WW_QUIET = '1';
export const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);

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
      if (method === 'getUpdates') return setTimeout(() => done([]), 150);
      if (method === 'getFile') return done({ file_path: 'photos/file_1.jpg' });
      return done(true);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }) };
}

export async function startApp(extraEnv = {}, { withToken = false } = {}) {
  const tgs = await fakeTelegram();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-'));
  const cfg = makeConfig({
    PORT: '0', DATA_DIR: dir, WEB_DIR: path.resolve('web'), CLAIM_CODE: 'code-12345', WEBAPP_URL: 'https://wwwant.example',
    TG_API_BASES: tgs.url, ...extraEnv
  });
  if (withToken) fs.writeFileSync(path.join(dir, 'bot.token'), TOKEN, { mode: 0o600 });
  const app = createApp(cfg);
  const port = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const close = async () => { await app.stop(); await tgs.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { app, cfg, base, dir, tgs, close };
}

export function authHeader(userId = 1001, name = 'Тест', token = TOKEN) {
  return 'tma ' + signInitData({ id: userId, first_name: name }, token);
}

export async function call(base, method, p, { user = 1001, body, raw, headers = {}, auth } = {}) {
  const h = { authorization: auth ?? authHeader(user), ...headers };
  let b;
  if (raw) { h['content-type'] = 'image/jpeg'; b = raw; } else if (body !== undefined) { h['content-type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await fetch(base + p, { method, headers: h, body: b });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}

export const item = (o = {}) => ({ id: 11, name: 'Лампа', price: 4300, saved: 0, zone: 1, icon: 'lamp', tint: 0, bg: '', ln: '', fit: 'contain', link: '', ...o });
