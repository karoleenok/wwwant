import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from './db.js';
import { verifyInitData } from './auth.js';
import { makeLimiter } from './limits.js';
import { cleanItem, cleanBought, isJpeg } from './validate.js';
import { makeTg, TgError } from './tg.js';
import { makeBot, startPolling } from './bot.js';
import { outboxTick } from './outbox.js';
import { digestTick } from './digest.js';
import { policyPage, claimForm, claimDone } from './pages.js';

const MAX_JSON = 512 * 1024;
const MAX_PHOTO = 200 * 1024;
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;

class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    // лишнее дочитываем и выбрасываем, чтобы ответить 413, а не рвать соединение; совсем огромное обрываем
    req.on('data', c => { n += c.length; if (n > max * 8) req.destroy(); else if (n <= max) chunks.push(c); });
    req.on('end', () => (n > max ? reject(new HttpError(413, 'too-big')) : resolve(Buffer.concat(chunks))));
    req.on('error', () => reject(new HttpError(400, 'read')));
  });
}

export function createApp(cfg, { fetchFn } = {}) {
  const db = openDb(path.join(cfg.dataDir, 'wwwant.sqlite'));
  const S = { token: null, botName: null, startedAt: Date.now(), claimFails: 0, logs: [] };
  const tokenFile = path.join(cfg.dataDir, 'bot.token');
  const log = (...a) => { if (process.env.WW_QUIET !== '1') console.log(new Date().toISOString(), ...a); };
  const tg = makeTg({ bases: cfg.tgBases, getToken: () => S.token, fetchFn });
  const bot = makeBot({ db, tg, cfg });
  const photoSecret = db.secret('photo');
  const apiLimit = makeLimiter(240, 60000);
  const ipLimit = makeLimiter(120, 60000);
  const claimLimit = makeLimiter(20, 60000);

  // ---------- токен ----------
  async function adoptToken(tok) {
    const me = await tg.call('getMe', {}, { token: tok, timeoutMs: 15000 });
    S.token = tok; S.botName = me.username || '';
    return me;
  }
  async function tokenWatch() {
    if (S.token) return;
    let tok = '';
    try { tok = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return; }
    if (!TOKEN_RE.test(tok)) return;
    try { await adoptToken(tok); log('token-ok'); } catch (e) { log('token-check-failed', e instanceof TgError ? e.code : 'err'); }
  }

  // ---------- CSP ----------
  let indexHtml = null, csp = '';
  function loadIndex() {
    indexHtml = fs.readFileSync(path.join(cfg.webDir, 'index.html'));
    const html = indexHtml.toString('utf8');
    const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(m => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
    csp = [
      "default-src 'none'",
      `script-src 'self' https://telegram.org ${hashes.join(' ')}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://t.me",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://*.telegram.org",
      "base-uri 'none'", "form-action 'self'", "object-src 'none'"
    ].join('; ');
  }
  loadIndex();

  const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
  const baseHeaders = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin'
  };

  function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
    res.writeHead(status, { ...baseHeaders, 'content-type': type, 'cache-control': 'no-store', ...extra });
    res.end(body);
  }
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
  const html = (res, status, body, extra = {}) => send(res, status, body, 'text/html; charset=utf-8', { 'content-security-policy': PAGE_CSP, ...extra });

  const clientIp = req => {
    const ra = req.socket.remoteAddress || '';
    const local = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    const xf = local && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xf || ra;
  };
  const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

  // ---------- фото: ссылка-ключ ----------
  const photoKey = (tgId, id, ver) => crypto.createHmac('sha256', photoSecret).update(`${tgId}:${id}:${ver}`).digest('hex').slice(0, 32);
  const photoUrl = (tgId, it) => `/p/${tgId}/${it.id}/${it.photo_ver}/${photoKey(tgId, it.id, it.photo_ver)}`;

  // ---------- API ----------
  function authUser(req) {
    if (!S.token) throw new HttpError(503, 'starting');
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('tma ')) throw new HttpError(401, 'auth');
    const u = verifyInitData(h.slice(4), S.token, cfg.initDataMaxAge);
    if (!u) throw new HttpError(401, 'auth');
    if (!apiLimit('u' + u.id)) throw new HttpError(429, 'slow-down');
    return db.ensureUser(u.id, u.first_name);
  }
  const needConsent = u => { if (!u.consent_at) throw new HttpError(403, 'consent'); };

  function stateOf(u) {
    return {
      consent: true,
      user: { name: u.first_name },
      settings: { digest: !!u.digest_on, weekAmount: u.week_amount || null },
      items: db.listItems(u.tg_id).map(i => ({
        id: i.id, name: i.name, price: i.price, saved: i.saved, zone: i.zone, icon: i.icon, tint: i.tint,
        bg: i.bg, ln: i.ln, fit: i.fit, link: i.link, photo: i.has_photo ? photoUrl(u.tg_id, i) : ''
      })),
      bought: db.listBought(u.tg_id, cfg.maxBought),
      limits: { items: cfg.maxItems }
    };
  }

  const asArr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  const asId = v => (Number.isSafeInteger(v) && v > 0 && v <= 2147483647 ? v : null);

  async function api(req, res, url) {
    const m = req.method;
    const p = url.pathname;
    const u = authUser(req);

    if (m === 'GET' && p === '/api/state') {
      if (!u.consent_at) return json(res, 200, { consent: false, policy: '/policy' });
      return json(res, 200, stateOf(u));
    }
    if (m === 'POST' && p === '/api/consent') {
      if (!u.consent_at) db.setConsent(u.tg_id, 'app');
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/delete_me') {
      db.deleteUser(u.tg_id);
      return json(res, 200, { ok: true });
    }
    needConsent(u);

    if (m === 'POST' && p === '/api/wipe') { db.wipe(u.tg_id); return json(res, 200, { ok: true }); }

    if (m === 'POST' && p === '/api/settings') {
      const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
      const patch = {};
      if (typeof b.digest === 'boolean') patch.digest = b.digest;
      if (b.weekAmount === null) patch.weekAmount = null;
      else if (b.weekAmount !== undefined) {
        if (!Number.isSafeInteger(b.weekAmount) || b.weekAmount < 1 || b.weekAmount > 10000000) throw new HttpError(400, 'amount');
        patch.weekAmount = b.weekAmount;
      }
      db.setSettings(u.tg_id, patch);
      return json(res, 200, { ok: true });
    }

    if (m === 'POST' && p === '/api/sync') {
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'type');
      let b;
      try { b = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8')); } catch { throw new HttpError(400, 'json'); }
      const upsert = asArr(b.upsert, cfg.maxItems);
      const clean = [];
      for (const raw of upsert) { const r = cleanItem(raw); if (r.err) throw new HttpError(400, 'item'); clean.push(r.v); }
      db.tx(() => {
        const rem = asArr(b.remove, 200).map(asId).filter(Boolean);
        for (const id of rem) db.removeItem(u.tg_id, id);
        for (const it of clean) {
          if (!db.getItem(u.tg_id, it.id) && db.countItems(u.tg_id) >= cfg.maxItems) throw new HttpError(409, 'limit');
          db.upsertItem(u.tg_id, it);
        }
        const order = asArr(b.order, 200).map(asId).filter(Boolean);
        if (order.length) db.setOrder(u.tg_id, order);
        for (const raw of asArr(b.boughtAdd, 20)) { const bb = cleanBought(raw); if (bb) db.addBought(u.tg_id, bb); }
        for (const at of asArr(b.boughtRemove, 20)) if (Number.isSafeInteger(at)) db.removeBought(u.tg_id, at);
        db.trimBought(u.tg_id, cfg.maxBought);
      });
      return json(res, 200, { ok: true });
    }

    let mm;
    if ((mm = p.match(/^\/api\/photo\/(\d{1,10})$/))) {
      const id = Number(mm[1]);
      if (!db.getItem(u.tg_id, id)) throw new HttpError(404, 'item');
      if (m === 'PUT') {
        const buf = await readBody(req, MAX_PHOTO);
        if (!isJpeg(buf)) throw new HttpError(415, 'jpeg');
        db.setPhoto(u.tg_id, id, buf);
        return json(res, 200, { ok: true, photo: photoUrl(u.tg_id, db.getItem(u.tg_id, id)) });
      }
      if (m === 'DELETE') { db.clearPhoto(u.tg_id, id); return json(res, 200, { ok: true }); }
    }
    throw new HttpError(404, 'not-found');
  }

  // ---------- /claim ----------
  const claimOpen = () => !S.token && !fs.existsSync(tokenFile) && Date.now() - S.startedAt < cfg.claimMinutes * 60000 && !!cfg.claimCode && S.claimFails < 5;
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  async function claim(req, res, ip) {
    if (!claimOpen()) return send(res, 404, 'Not found');
    if (!isHttps(req) && !process.env.WW_ALLOW_HTTP_CLAIM) return send(res, 400, 'Открой страницу по https, иначе токен уйдёт открытым текстом.');
    if (!claimLimit('c' + ip)) return send(res, 429, 'Слишком часто');
    if (req.method === 'GET') return html(res, 200, claimForm());
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
    const body = new URLSearchParams((await readBody(req, 4096)).toString('utf8'));
    const code = body.get('code') || '', token = (body.get('token') || '').trim();
    if (!same(code, cfg.claimCode)) { S.claimFails++; return html(res, 403, claimForm({ error: 'Код не подошёл.' })); }
    if (!TOKEN_RE.test(token)) return html(res, 400, claimForm({ error: 'Токен выглядит неправильно. Нужен вид 123456789:AA…' }));
    let me;
    try { me = await adoptToken(token); } catch { return html(res, 400, claimForm({ error: 'Telegram не принял этот токен.' })); }
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    try { fs.chmodSync(tokenFile, 0o600); } catch { /* ok */ }
    if (cfg.webappUrl) {
      try { await tg.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Тропа', web_app: { url: cfg.webappUrl } } }); } catch { /* не критично */ }
      try { await tg.call('setMyCommands', { commands: [
        { command: 'start', description: 'Начать' }, { command: 'week', description: 'Сводка за неделю сейчас' },
        { command: 'digest_off', description: 'Выключить сводку' }, { command: 'delete_me', description: 'Удалить все мои данные' }] }); } catch { /* не критично */ }
    }
    log('claim-done');
    return html(res, 200, claimDone(me.username));
  }

  // ---------- сервер ----------
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    let status = 0;
    const origEnd = res.end.bind(res);
    res.end = (...a) => { status = res.statusCode; return origEnd(...a); };
    res.on('finish', () => log(req.method, new URL(req.url, 'http://x').pathname.replace(/^\/p\/.*/, '/p/…'), status, Date.now() - t0 + 'ms'));
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const ip = clientIp(req);
      if (!ipLimit(ip)) return send(res, 429, 'Too many requests');

      if (p === '/health') return json(res, 200, { status: S.token ? 'ok' : 'waiting-token', bot: S.botName || null, outbox: db.outboxStats() });
      if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html')) {
        return send(res, 200, req.method === 'HEAD' ? '' : indexHtml, 'text/html; charset=utf-8', { 'content-security-policy': csp });
      }
      if (req.method === 'GET' && p === '/policy') return html(res, 200, policyPage(cfg));
      if (p === '/claim') return await claim(req, res, ip);

      let mm;
      if (req.method === 'GET' && (mm = p.match(/^\/p\/(\d{1,15})\/(\d{1,10})\/(\d{1,10})\/([0-9a-f]{32})$/))) {
        const [tgId, id, ver, k] = [Number(mm[1]), Number(mm[2]), Number(mm[3]), mm[4]];
        const want = photoKey(tgId, id, ver);
        if (!crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want))) return send(res, 404, 'Not found');
        const it = db.getItem(tgId, id);
        const buf = it && it.photo_ver === ver ? db.getPhoto(tgId, id) : null;
        if (!buf) return send(res, 404, 'Not found');
        return send(res, 200, buf, 'image/jpeg', { 'cache-control': 'private, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'" });
      }
      if (p.startsWith('/api/')) return await api(req, res, url);
      return send(res, 404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.code });
      log('error', e && e.message);
      return json(res, 500, { error: 'server' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;

  // ---------- фоновые циклы ----------
  const timers = [];
  let polling = null;
  async function start() {
    await tokenWatch();
    timers.push(setInterval(() => { tokenWatch().catch(() => {}); }, 3000));
    timers.push(setInterval(() => { outboxTick({ db, tg, log }).catch(() => {}); }, 800));
    timers.push(setInterval(() => { try { digestTick({ db, cfg }); db.outboxPrune(); db.kvPrune(); } catch (e) { log('digest-error', e.message); } }, 60000));
    polling = startPolling({ db, tg, bot, getToken: () => S.token, log });
    await new Promise(r => server.listen(cfg.port, cfg.host, r));
    return server.address().port;
  }
  async function stop() {
    timers.forEach(clearInterval);
    if (polling) polling.stop();
    await new Promise(r => server.close(r));
    server.closeAllConnections?.();
    db.close();
  }
  return { server, db, bot, tg, state: S, start, stop, adoptToken, tokenWatch };
}
