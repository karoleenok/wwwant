import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { verifyInitData } from './auth.js';
import { makeGate } from './limits.js';
import { cleanItem, cleanBought, isJpeg } from './validate.js';
import { makeTg, TgError } from './tg.js';
import { makeBot } from './bot.js';
import { outboxTick } from './outbox.js';
import { digestTick, inDigestWindow } from './digest.js';
import { policyPage } from './pages.js';
import { LimitError } from './db.js';

const MAX_JSON = 512 * 1024;
const MAX_PHOTO = 200 * 1024;
const MAX_UPDATE = 256 * 1024;
const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];

class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

/** Читаем тело с потолком: лишнее не копим в памяти, а сразу отвечаем 413. */
async function readBody(request, max) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > max) throw new HttpError(413, 'too-big');
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { try { await reader.cancel(); } catch { /* ok */ } throw new HttpError(413, 'too-big'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/**
 * Приложение целиком: handle(request, ctx) отвечает на запросы, tick() запускается по cron раз в минуту.
 * Ни Node-сервера, ни файлов: база приходит снаружи (D1), токен бота тоже.
 */
export function createApp({ cfg, db, token = '', fetchFn, indexHtml, limiters = {}, log = (...a) => console.log(...a) }) {
  const S = { botName: null, setupKey: '', baseLoaded: false, webhookSecret: null, photoSecret: null };
  const tg = makeTg({ bases: cfg.tgBases, getToken: () => token, fetchFn });
  const bot = makeBot({ db, tg, cfg, limiter: limiters.bot });
  const apiLimit = makeGate(limiters.api, 240, 60000);
  const ipLimit = makeGate(limiters.ip, 120, 60000);

  // ---------- CSP: хэши inline-скриптов считаем один раз ----------
  const csp = (() => {
    const hashes = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(m => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
    return [
      "default-src 'none'",
      `script-src 'self' https://telegram.org ${hashes.join(' ')}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://t.me",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://*.telegram.org",
      "base-uri 'none'", "form-action 'self'", "object-src 'none'"
    ].join('; ');
  })();

  const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
  const baseHeaders = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin'
  };
  const send = (status, body, type = 'text/plain; charset=utf-8', extra = {}) =>
    new Response(body, { status, headers: { ...baseHeaders, 'content-type': type, 'cache-control': 'no-store', ...extra } });
  const json = (status, obj) => send(status, JSON.stringify(obj), 'application/json; charset=utf-8');
  const html = (status, body) => send(status, body, 'text/html; charset=utf-8', { 'content-security-policy': PAGE_CSP });

  // ---------- адрес приложения и настройка бота ----------
  /** Адрес мини-аппки: из WEBAPP_URL, а если не задан, запоминаем тот, по которому впервые открыли Worker. */
  async function loadBase(origin = '') {
    if (cfg.webappUrl || S.baseLoaded) return;
    let v = await db.kvGet('origin');
    if (!v && origin) { await db.kvAdd('origin', origin); v = await db.kvGet('origin'); }
    if (v) { cfg.webappUrl = v; S.baseLoaded = true; }
  }

  /**
   * Как только у Worker есть токен и адрес, сам подключаем webhook, кнопку меню и команды.
   * Ничего вручную делать не нужно: срабатывает при первом заходе на страницу и по cron.
   */
  async function ensureSetup() {
    if (!token || !cfg.webappUrl) return;
    const fp = crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
    const key = `${cfg.webappUrl}|${fp}`;
    if (S.setupKey === key) return;
    try {
      const me = await tg.call('getMe', {}, { timeoutMs: 15000 });
      S.botName = me.username || '';
      if ((await db.kvGet('setup')) !== key) {
        await tg.call('setWebhook', { url: cfg.webappUrl + '/tg', secret_token: await webhookSecret(), allowed_updates: ALLOWED_UPDATES, max_connections: 20 });
        try { await tg.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Тропа', web_app: { url: cfg.webappUrl } } }); } catch { /* не критично */ }
        try {
          await tg.call('setMyCommands', { commands: [
            { command: 'start', description: 'Начать' }, { command: 'week', description: 'Сводка за неделю сейчас' },
            { command: 'digest_off', description: 'Выключить сводку' }, { command: 'delete_me', description: 'Удалить все мои данные' }] });
        } catch { /* не критично */ }
        await db.kvSet('setup', key);
        log('setup-done');
      }
      S.setupKey = key;
    } catch (e) { log('setup-failed', e instanceof TgError ? e.code : 'err'); }
  }

  const webhookSecret = async () => (S.webhookSecret ??= await db.secret('webhook'));
  const photoSecret = async () => (S.photoSecret ??= await db.secret('photo'));

  // ---------- фото: ссылка-ключ ----------
  const photoKey = (secret, tgId, id, ver) => crypto.createHmac('sha256', secret).update(`${tgId}:${id}:${ver}`).digest('hex').slice(0, 32);

  // ---------- API ----------
  async function authUser(request) {
    if (!token) throw new HttpError(503, 'starting');
    const h = String(request.headers.get('authorization') || '');
    if (!h.startsWith('tma ')) throw new HttpError(401, 'auth');
    const u = verifyInitData(h.slice(4), token, cfg.initDataMaxAge);
    if (!u) throw new HttpError(401, 'auth');
    if (!(await apiLimit('u' + u.id))) throw new HttpError(429, 'slow-down');
    return db.ensureUser(u.id, u.first_name);
  }
  const needConsent = u => { if (!u.consent_at) throw new HttpError(403, 'consent'); };

  async function stateOf(u) {
    const secret = await photoSecret();
    const url = i => `/p/${u.tg_id}/${i.id}/${i.photo_ver}/${photoKey(secret, u.tg_id, i.id, i.photo_ver)}`;
    const [items, bought] = await Promise.all([db.listItems(u.tg_id), db.listBought(u.tg_id, cfg.maxBought)]);
    return {
      consent: true,
      user: { name: u.first_name },
      settings: { digest: !!u.digest_on, weekAmount: u.week_amount || null },
      items: items.map(i => ({
        id: i.id, name: i.name, price: i.price, saved: i.saved, zone: i.zone, icon: i.icon, tint: i.tint,
        bg: i.bg, ln: i.ln, fit: i.fit, link: i.link, photo: i.has_photo ? url(i) : ''
      })),
      bought,
      limits: { items: cfg.maxItems }
    };
  }

  const asArr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  const asId = v => (Number.isSafeInteger(v) && v > 0 && v <= 2147483647 ? v : null);
  const parseJson = async (request, max) => {
    try { return JSON.parse((await readBody(request, max)).toString('utf8') || '{}'); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'json'); }
  };

  async function api(request, url) {
    const m = request.method;
    const p = url.pathname;
    const u = await authUser(request);

    if (m === 'GET' && p === '/api/state') {
      if (!u.consent_at) return json(200, { consent: false, policy: '/policy' });
      return json(200, await stateOf(u));
    }
    if (m === 'POST' && p === '/api/consent') {
      if (!u.consent_at) await db.setConsent(u.tg_id, 'app');
      return json(200, { ok: true });
    }
    if (m === 'POST' && p === '/api/delete_me') {
      await db.deleteUser(u.tg_id);
      return json(200, { ok: true });
    }
    needConsent(u);

    if (m === 'POST' && p === '/api/wipe') { await db.wipe(u.tg_id); return json(200, { ok: true }); }

    if (m === 'POST' && p === '/api/settings') {
      const b = await parseJson(request, 4096);
      const patch = {};
      if (typeof b.digest === 'boolean') patch.digest = b.digest;
      if (b.weekAmount === null) patch.weekAmount = null;
      else if (b.weekAmount !== undefined) {
        if (!Number.isSafeInteger(b.weekAmount) || b.weekAmount < 1 || b.weekAmount > 10000000) throw new HttpError(400, 'amount');
        patch.weekAmount = b.weekAmount;
      }
      await db.setSettings(u.tg_id, patch);
      return json(200, { ok: true });
    }

    if (m === 'POST' && p === '/api/sync') {
      if (!/^application\/json/i.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'type');
      let b;
      try { b = JSON.parse((await readBody(request, MAX_JSON)).toString('utf8')); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'json'); }
      if (!b || typeof b !== 'object') throw new HttpError(400, 'json');
      const clean = [];
      for (const raw of asArr(b.upsert, cfg.maxItems)) { const r = cleanItem(raw); if (r.err) throw new HttpError(400, 'item'); clean.push(r.v); }
      try {
        await db.applySync(u.tg_id, {
          remove: asArr(b.remove, 200).map(asId).filter(Boolean),
          upserts: clean,
          order: asArr(b.order, 200).map(asId).filter(Boolean),
          boughtAdd: asArr(b.boughtAdd, 20).map(cleanBought).filter(Boolean),
          boughtRemove: asArr(b.boughtRemove, 20).filter(Number.isSafeInteger),
          maxItems: cfg.maxItems,
          maxBought: cfg.maxBought
        });
      } catch (e) { if (e instanceof LimitError) throw new HttpError(409, 'limit'); throw e; }
      return json(200, { ok: true });
    }

    let mm;
    if ((mm = p.match(/^\/api\/photo\/(\d{1,10})$/))) {
      const id = Number(mm[1]);
      const it = await db.getItem(u.tg_id, id);
      if (!it) throw new HttpError(404, 'item');
      if (m === 'PUT') {
        const buf = await readBody(request, MAX_PHOTO);
        if (!isJpeg(buf)) throw new HttpError(415, 'jpeg');
        await db.setPhoto(u.tg_id, id, buf);
        const now = await db.getItem(u.tg_id, id);
        return json(200, { ok: true, photo: `/p/${u.tg_id}/${id}/${now.photo_ver}/${photoKey(await photoSecret(), u.tg_id, id, now.photo_ver)}` });
      }
      if (m === 'DELETE') { await db.clearPhoto(u.tg_id, id); return json(200, { ok: true }); }
    }
    throw new HttpError(404, 'not-found');
  }

  // ---------- маршруты ----------
  async function flush() {
    try { await outboxTick({ db, tg, log }); } catch (e) { log('outbox-error', e && e.message); }
  }

  async function route(request, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    // Вебхук Telegram приходит с малого числа адресов и проверяется секретом, его по IP не режем.
    if (p !== '/tg' && !(await ipLimit(ip))) return send(429, 'Too many requests');

    // Webhook от Telegram. Подлинность: секрет в заголовке, который мы сами задали в setWebhook.
    if (p === '/tg') {
      if (request.method !== 'POST') return send(405, 'Method not allowed');
      if (!token) return send(503, 'starting');
      if (!same(request.headers.get('x-telegram-bot-api-secret-token') || '', await webhookSecret())) return send(401, 'no');
      let upd;
      try { upd = JSON.parse((await readBody(request, MAX_UPDATE)).toString('utf8')); } catch (e) { if (e instanceof HttpError) throw e; return send(400, 'bad json'); }
      await loadBase();
      try { await bot.handleUpdate(upd); } catch (e) { log('update-error', e && e.message); }
      ctx.waitUntil(flush());
      return send(200, 'ok');
    }

    if (p === '/health') {
      await loadBase(url.origin);
      await ensureSetup();
      return json(200, { status: !token ? 'waiting-token' : S.setupKey ? 'ok' : 'setup-pending', bot: S.botName || null });
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && (p === '/' || p === '/index.html')) {
      await loadBase(url.origin);
      ctx.waitUntil(ensureSetup());
      return send(200, request.method === 'HEAD' ? null : indexHtml, 'text/html; charset=utf-8', { 'content-security-policy': csp });
    }
    if (request.method === 'GET' && p === '/policy') return html(200, policyPage(cfg));

    let mm;
    if (request.method === 'GET' && (mm = p.match(/^\/p\/(\d{1,15})\/(\d{1,10})\/(\d{1,10})\/([0-9a-f]{32})$/))) {
      const [tgId, id, ver, k] = [Number(mm[1]), Number(mm[2]), Number(mm[3]), mm[4]];
      if (!same(k, photoKey(await photoSecret(), tgId, id, ver))) return send(404, 'Not found');
      const it = await db.getItem(tgId, id);
      const buf = it && it.photo_ver === ver ? await db.getPhoto(tgId, id) : null;
      if (!buf) return send(404, 'Not found');
      return send(200, buf, 'image/jpeg', { 'cache-control': 'private, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'" });
    }
    if (p.startsWith('/api/')) return api(request, url);
    return send(404, 'Not found');
  }

  async function handle(request, ctx = { waitUntil() {} }) {
    const t0 = Date.now();
    let res;
    try { res = await route(request, ctx); }
    catch (e) {
      if (e instanceof HttpError) res = json(e.status, { error: e.code });
      else { log('error', e && e.message); res = json(500, { error: 'server' }); }
    }
    log(request.method, new URL(request.url).pathname.replace(/^\/p\/.*/, '/p/…'), res.status, Date.now() - t0 + 'ms');
    return res;
  }

  /** Раз в минуту (cron): повторить застрявшие сообщения, в окне сводки разослать её, раз в час прибраться. */
  async function tick() {
    if (!token) return;
    await loadBase();
    await ensureSetup();
    await outboxTick({ db, tg, log });
    const nowMs = Date.now();
    if (inDigestWindow(cfg, nowMs) && await digestTick({ db, cfg, nowMs })) await outboxTick({ db, tg, log });
    if (new Date(nowMs).getUTCMinutes() === 0) { await db.outboxPrune(); await db.kvPrune(); }
  }

  return { handle, tick, bot, tg, db, state: S, ensureSetup, loadBase };
}
