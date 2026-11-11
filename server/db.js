// Слой данных поверх Cloudflare D1. Работает только через API D1 (prepare/bind/first/all/run/batch),
// поэтому в тестах его подменяет тонкая обёртка над node:sqlite (см. test/helpers.js).
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

export class LimitError extends Error {}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(
    tg_id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    consent_at INTEGER,
    consent_src TEXT,
    digest_on INTEGER NOT NULL DEFAULT 1,
    week_amount INTEGER,
    last_digest_at INTEGER,
    blocked INTEGER NOT NULL DEFAULT 0,
    menu_set INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS items(
    tg_id INTEGER NOT NULL,
    id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    saved INTEGER NOT NULL DEFAULT 0,
    zone INTEGER NOT NULL,
    icon TEXT NOT NULL DEFAULT 'package',
    tint INTEGER NOT NULL DEFAULT 0,
    bg TEXT NOT NULL DEFAULT '',
    ln TEXT NOT NULL DEFAULT '',
    fit TEXT NOT NULL DEFAULT 'contain',
    link TEXT NOT NULL DEFAULT '',
    pos INTEGER NOT NULL DEFAULT 0,
    photo TEXT,
    photo_ver INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(tg_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS bought(
    tg_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    icon TEXT NOT NULL DEFAULT 'package',
    bg TEXT NOT NULL DEFAULT '',
    ln TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(tg_id, at)
  )`,
  `CREATE TABLE IF NOT EXISTS outbox(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL,
    method TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    tries INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_error TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_at)',
  'CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)'
];

// Фото лежит в базе как base64-текст: так не зависим от того, как D1 отдаёт BLOB.
const ITEM_COLS = 'id,name,price,saved,zone,icon,tint,bg,ln,fit,link,pos,photo_ver,(photo IS NOT NULL) AS has_photo';
const UPSERT_ITEM = `INSERT INTO items(tg_id,id,name,price,saved,zone,icon,tint,bg,ln,fit,link,pos,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(tg_id,id) DO UPDATE SET name=excluded.name,price=excluded.price,saved=excluded.saved,zone=excluded.zone,
    icon=excluded.icon,tint=excluded.tint,bg=excluded.bg,ln=excluded.ln,fit=excluded.fit,link=excluded.link,updated_at=excluded.updated_at`;
const LEASE_MS = 60000;

export function makeDb(d1) {
  let ready = null;
  const init = () => (ready ??= d1.batch(SCHEMA.map(s => d1.prepare(s))).catch(e => { ready = null; throw e; }));
  const now = () => Date.now();

  const run = async (sql, ...a) => { await init(); return d1.prepare(sql).bind(...a).run(); };
  const first = async (sql, ...a) => { await init(); return (await d1.prepare(sql).bind(...a).first()) ?? null; };
  const all = async (sql, ...a) => { await init(); return (await d1.prepare(sql).bind(...a).all()).results || []; };
  const batch = async list => { await init(); return d1.batch(list.map(([sql, a]) => d1.prepare(sql).bind(...a))); };

  const A = {
    // ---- kv
    async kvGet(k) { const r = await first('SELECT v FROM kv WHERE k=?', k); return r ? r.v : null; },
    kvSet(k, v) { return run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v)); },
    kvAdd(k, v) { return run('INSERT OR IGNORE INTO kv(k,v) VALUES(?,?)', k, String(v)); },
    kvDel(k) { return run('DELETE FROM kv WHERE k=?', k); },
    async kvPrune() {
      await batch([
        ["DELETE FROM kv WHERE k LIKE 'undo:%' AND CAST(substr(v,1,instr(v,':')-1) AS INTEGER) < ?", [now()]],
        ["DELETE FROM kv WHERE k LIKE 'draft:%' AND CAST(json_extract(v,'$.exp') AS INTEGER) < ?", [now()]],
        ["DELETE FROM kv WHERE k LIKE 'fbmap:%' AND CAST(substr(v,instr(v,':')+1) AS INTEGER) < ?", [now()]]
      ]);
    },
    // ---- админ-сторона
    async stats() {
      const n = async (sql, ...a) => (await first(sql, ...a)).n;
      const t = now();
      const o = Object.fromEntries((await A.outboxStats()).map(r => [r.status, r.n]));
      return {
        users: await n('SELECT COUNT(*) AS n FROM users'),
        consented: await n('SELECT COUNT(*) AS n FROM users WHERE consent_at IS NOT NULL'),
        blocked: await n('SELECT COUNT(*) AS n FROM users WHERE consent_at IS NOT NULL AND blocked=1'),
        d1: await n('SELECT COUNT(*) AS n FROM users WHERE consent_at>=?', t - 86400000),
        d7: await n('SELECT COUNT(*) AS n FROM users WHERE consent_at>=?', t - 7 * 86400000),
        items: await n('SELECT COUNT(*) AS n FROM items'),
        bought: await n('SELECT COUNT(*) AS n FROM bought'),
        digest: await n('SELECT COUNT(*) AS n FROM users WHERE consent_at IS NOT NULL AND digest_on=1 AND blocked=0'),
        pending: o.pending || 0, failed: o.failed || 0
      };
    },
    async consentedCount() { return (await first('SELECT COUNT(*) AS n FROM users WHERE consent_at IS NOT NULL')).n; },
    async recipients(exceptId) { return (await all('SELECT tg_id FROM users WHERE consent_at IS NOT NULL AND blocked=0 AND tg_id<>? ORDER BY tg_id', exceptId)).map(r => r.tg_id); },
    getAvatar(tg) { return A.kvGet('avatar:' + tg); },
    setAvatar(tg, buf) { return A.kvSet('avatar:' + tg, Buffer.from(buf).toString('base64')); },
    clearAvatar(tg) { return A.kvDel('avatar:' + tg); },
    async secret(name) {
      let v = await A.kvGet('secret:' + name);
      if (!v) {
        await A.kvAdd('secret:' + name, crypto.randomBytes(32).toString('hex'));
        v = await A.kvGet('secret:' + name);
      }
      return v;
    },

    // ---- users
    async ensureUser(tg, firstName = '') {
      const name = String(firstName).slice(0, 40);
      const u = await A.getUser(tg);
      if (u && (!name || u.first_name === name)) return u;     // лишних записей не делаем
      await run(`INSERT INTO users(tg_id,first_name,created_at) VALUES(?,?,?)
        ON CONFLICT(tg_id) DO UPDATE SET first_name=CASE WHEN excluded.first_name<>'' THEN excluded.first_name ELSE first_name END`, tg, name, now());
      return A.getUser(tg);
    },
    getUser(tg) { return first('SELECT * FROM users WHERE tg_id=?', tg); },
    setConsent(tg, src) { return run('UPDATE users SET consent_at=?, consent_src=? WHERE tg_id=?', now(), src, tg); },
    async setSettings(tg, { digest, weekAmount }) {
      const list = [];
      if (digest !== undefined) list.push(['UPDATE users SET digest_on=? WHERE tg_id=?', [digest ? 1 : 0, tg]]);
      if (weekAmount !== undefined) list.push(['UPDATE users SET week_amount=? WHERE tg_id=?', [weekAmount, tg]]);
      if (list.length) await batch(list);
    },
    setBlocked(tg, v) { return run('UPDATE users SET blocked=? WHERE tg_id=?', v ? 1 : 0, tg); },
    setMenuSet(tg) { return run('UPDATE users SET menu_set=1 WHERE tg_id=?', tg); },
    setDigestSent(tg, t = now()) { return run('UPDATE users SET last_digest_at=? WHERE tg_id=?', t, tg); },
    digestCandidates() { return all('SELECT * FROM users WHERE consent_at IS NOT NULL AND digest_on=1 AND blocked=0'); },

    // ---- items
    listItems(tg) { return all(`SELECT ${ITEM_COLS} FROM items WHERE tg_id=? ORDER BY pos, id`, tg); },
    getItem(tg, id) { return first(`SELECT ${ITEM_COLS} FROM items WHERE tg_id=? AND id=?`, tg, id); },
    async countItems(tg) { return (await first('SELECT COUNT(*) AS n FROM items WHERE tg_id=?', tg)).n; },
    async maxPos(tg) { return (await first('SELECT COALESCE(MAX(pos),-1) AS m FROM items WHERE tg_id=?', tg)).m; },
    async upsertItem(tg, it) {
      const t = now();
      const pos = it.pos ?? (await A.maxPos(tg)) + 1;
      await run(UPSERT_ITEM, tg, it.id, it.name, it.price, it.saved, it.zone, it.icon, it.tint, it.bg, it.ln, it.fit, it.link, pos, t, t);
    },
    async setItemZone(tg, id, zone) {
      const pos = (await A.maxPos(tg)) + 1;
      await run('UPDATE items SET zone=?, pos=?, updated_at=? WHERE tg_id=? AND id=?', zone, pos, now(), tg, id);
    },
    setItemSaved(tg, id, saved) { return run('UPDATE items SET saved=?, updated_at=? WHERE tg_id=? AND id=?', saved, now(), tg, id); },
    removeItem(tg, id) { return run('DELETE FROM items WHERE tg_id=? AND id=?', tg, id); },
    setPhoto(tg, id, buf) {
      return run('UPDATE items SET photo=?, photo_ver=photo_ver+1, updated_at=? WHERE tg_id=? AND id=?', Buffer.from(buf).toString('base64'), now(), tg, id);
    },
    clearPhoto(tg, id) {
      return run('UPDATE items SET photo=NULL, photo_ver=photo_ver+1, updated_at=? WHERE tg_id=? AND id=?', now(), tg, id);
    },
    async getPhoto(tg, id) {
      const r = await first('SELECT photo FROM items WHERE tg_id=? AND id=?', tg, id);
      return r && r.photo ? Buffer.from(r.photo, 'base64') : null;
    },

    /**
     * Синхронизация из приложения одним атомарным пакетом.
     * Сначала читаем и проверяем лимит, потом все записи уходят в одном batch: либо всё, либо ничего.
     */
    async applySync(tg, { remove = [], upserts = [], order = [], boughtAdd = [], boughtRemove = [], maxItems, maxBought }) {
      const ids = new Set((await all('SELECT id FROM items WHERE tg_id=?', tg)).map(r => r.id));
      let maxPos = await A.maxPos(tg);
      const t = now();
      const S = [];
      for (const id of remove) { ids.delete(id); S.push(['DELETE FROM items WHERE tg_id=? AND id=?', [tg, id]]); }
      for (const it of upserts) {
        let pos = 0;
        if (!ids.has(it.id)) {
          if (ids.size >= maxItems) throw new LimitError('limit');
          ids.add(it.id);
          pos = ++maxPos;
        }
        S.push([UPSERT_ITEM, [tg, it.id, it.name, it.price, it.saved, it.zone, it.icon, it.tint, it.bg, it.ln, it.fit, it.link, pos, t, t]]);
      }
      if (order.length) {
        const known = new Set(ids);
        let p = 0;
        for (const id of order) if (known.delete(id)) S.push(['UPDATE items SET pos=? WHERE tg_id=? AND id=?', [p++, tg, id]]);
        for (const id of known) S.push(['UPDATE items SET pos=? WHERE tg_id=? AND id=?', [p++, tg, id]]);
      }
      for (const b of boughtAdd) S.push(['INSERT OR REPLACE INTO bought(tg_id,at,name,price,icon,bg,ln) VALUES(?,?,?,?,?,?,?)', [tg, b.at, b.name, b.price, b.icon, b.bg, b.ln]]);
      for (const at of boughtRemove) S.push(['DELETE FROM bought WHERE tg_id=? AND at=?', [tg, at]]);
      S.push(['DELETE FROM bought WHERE tg_id=? AND at NOT IN (SELECT at FROM bought WHERE tg_id=? ORDER BY at DESC LIMIT ?)', [tg, tg, maxBought]]);
      await batch(S);
    },

    // ---- bought
    listBought(tg, limit = 200) { return all('SELECT at,name,price,icon,bg,ln FROM bought WHERE tg_id=? ORDER BY at DESC LIMIT ?', tg, limit); },

    // ---- стереть
    async wipe(tg) {
      await batch([
        ['DELETE FROM items WHERE tg_id=?', [tg]],
        ['DELETE FROM bought WHERE tg_id=?', [tg]],
        ['DELETE FROM kv WHERE k IN (?,?,?,?,?)', ['draft:' + tg, 'await_amt:' + tg, 'avatar:' + tg, 'fb:' + tg, 'np:' + tg]]
      ]);
    },
    async deleteUser(tg) {
      await batch([
        ['DELETE FROM items WHERE tg_id=?', [tg]],
        ['DELETE FROM bought WHERE tg_id=?', [tg]],
        ['DELETE FROM outbox WHERE tg_id=?', [tg]],
        ['DELETE FROM kv WHERE k IN (?,?,?,?,?)', ['draft:' + tg, 'await_amt:' + tg, 'avatar:' + tg, 'fb:' + tg, 'np:' + tg]],
        ['DELETE FROM users WHERE tg_id=?', [tg]]
      ]);
    },

    // ---- очередь исходящих
    enqueue(tg, method, payload, delayMs = 0) {
      return run('INSERT INTO outbox(tg_id,method,payload,next_at,created_at) VALUES(?,?,?,?,?)', tg, method, JSON.stringify(payload), now() + delayMs, now());
    },
    /** Берём пачку сообщений «в аренду» на минуту: два параллельных вызова не отправят одно и то же дважды. */
    async claimDue(limit = 10) {
      const t = now();
      const rows = await all("SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY id LIMIT ?", t, limit);
      const mine = [];
      for (const r of rows) {
        const res = await run("UPDATE outbox SET next_at=? WHERE id=? AND status='pending' AND next_at<=?", t + LEASE_MS, r.id, t);
        if (res.meta && res.meta.changes === 1) mine.push(r);
      }
      return mine;
    },
    outboxSent(id) { return run("UPDATE outbox SET status='sent', payload='{}' WHERE id=?", id); },
    outboxRetry(id, delayMs, err) { return run('UPDATE outbox SET tries=tries+1, next_at=?, last_error=? WHERE id=?', now() + delayMs, String(err).slice(0, 200), id); },
    outboxFail(id, err) { return run("UPDATE outbox SET status='failed', payload='{}', last_error=? WHERE id=?", String(err).slice(0, 200), id); },
    outboxPrune() { return run("DELETE FROM outbox WHERE status<>'pending' AND created_at<?", now() - 7 * 86400000); },
    outboxStats() { return all('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status'); }
  };
  return A;
}
