import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
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
);
CREATE TABLE IF NOT EXISTS items(
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
  photo BLOB,
  photo_ver INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(tg_id, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bought(
  tg_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  icon TEXT NOT NULL DEFAULT 'package',
  bg TEXT NOT NULL DEFAULT '',
  ln TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(tg_id, at)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_at);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

const ITEM_COLS = 'id,name,price,saved,zone,icon,tint,bg,ln,fit,link,pos,photo_ver,(photo IS NOT NULL) AS has_photo';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA);
  if (file !== ':memory:') { try { fs.chmodSync(file, 0o600); } catch { /* ok */ } }

  const cache = new Map();
  const st = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const now = () => Date.now();
  const plain = r => (r ? { ...r } : null);
  const rows = r => r.map(x => ({ ...x }));

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  const A = {
    raw: db,
    tx,
    close: () => db.close(),

    // ---- kv
    kvGet(k) { const r = st('SELECT v FROM kv WHERE k=?').get(k); return r ? r.v : null; },
    kvSet(k, v) { st('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)); },
    kvDel(k) { st('DELETE FROM kv WHERE k=?').run(k); },
    kvPrune() {
      st("DELETE FROM kv WHERE k LIKE 'undo:%' AND CAST(substr(v,1,instr(v,':')-1) AS INTEGER) < ?").run(now());
      st("DELETE FROM kv WHERE k LIKE 'draft:%' AND CAST(json_extract(v,'$.exp') AS INTEGER) < ?").run(now());
    },
    secret(name) {
      let v = A.kvGet('secret:' + name);
      if (!v) { v = crypto.randomBytes(32).toString('hex'); A.kvSet('secret:' + name, v); }
      return v;
    },

    // ---- users
    ensureUser(tg, firstName = '') {
      st('INSERT INTO users(tg_id,first_name,created_at) VALUES(?,?,?) ON CONFLICT(tg_id) DO UPDATE SET first_name=CASE WHEN excluded.first_name<>\'\' THEN excluded.first_name ELSE first_name END')
        .run(tg, String(firstName).slice(0, 40), now());
      return A.getUser(tg);
    },
    getUser(tg) { return plain(st('SELECT * FROM users WHERE tg_id=?').get(tg)); },
    setConsent(tg, src) { st('UPDATE users SET consent_at=?, consent_src=? WHERE tg_id=?').run(now(), src, tg); },
    setSettings(tg, { digest, weekAmount }) {
      if (digest !== undefined) st('UPDATE users SET digest_on=? WHERE tg_id=?').run(digest ? 1 : 0, tg);
      if (weekAmount !== undefined) st('UPDATE users SET week_amount=? WHERE tg_id=?').run(weekAmount, tg);
    },
    setBlocked(tg, v) { st('UPDATE users SET blocked=? WHERE tg_id=?').run(v ? 1 : 0, tg); },
    setMenuSet(tg) { st('UPDATE users SET menu_set=1 WHERE tg_id=?').run(tg); },
    setDigestSent(tg, t = now()) { st('UPDATE users SET last_digest_at=? WHERE tg_id=?').run(t, tg); },
    digestCandidates() {
      return rows(st('SELECT * FROM users WHERE consent_at IS NOT NULL AND digest_on=1 AND blocked=0').all());
    },

    // ---- items
    listItems(tg) {
      return rows(st(`SELECT ${ITEM_COLS} FROM items WHERE tg_id=? ORDER BY pos, id`).all(tg));
    },
    getItem(tg, id) { return plain(st(`SELECT ${ITEM_COLS} FROM items WHERE tg_id=? AND id=?`).get(tg, id)); },
    countItems(tg) { return st('SELECT COUNT(*) AS n FROM items WHERE tg_id=?').get(tg).n; },
    maxPos(tg) { return st('SELECT COALESCE(MAX(pos),-1) AS m FROM items WHERE tg_id=?').get(tg).m; },
    upsertItem(tg, it) {
      const t = now();
      st(`INSERT INTO items(tg_id,id,name,price,saved,zone,icon,tint,bg,ln,fit,link,pos,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(tg_id,id) DO UPDATE SET name=excluded.name,price=excluded.price,saved=excluded.saved,zone=excluded.zone,
            icon=excluded.icon,tint=excluded.tint,bg=excluded.bg,ln=excluded.ln,fit=excluded.fit,link=excluded.link,updated_at=excluded.updated_at`)
        .run(tg, it.id, it.name, it.price, it.saved, it.zone, it.icon, it.tint, it.bg, it.ln, it.fit, it.link, it.pos ?? A.maxPos(tg) + 1, t, t);
    },
    setItemZone(tg, id, zone) {
      st('UPDATE items SET zone=?, pos=?, updated_at=? WHERE tg_id=? AND id=?').run(zone, A.maxPos(tg) + 1, now(), tg, id);
    },
    setItemSaved(tg, id, saved) { st('UPDATE items SET saved=?, updated_at=? WHERE tg_id=? AND id=?').run(saved, now(), tg, id); },
    removeItem(tg, id) { st('DELETE FROM items WHERE tg_id=? AND id=?').run(tg, id); },
    setOrder(tg, ids) {
      const known = new Set(A.listItems(tg).map(x => x.id));
      let p = 0;
      for (const id of ids) if (known.delete(id)) st('UPDATE items SET pos=? WHERE tg_id=? AND id=?').run(p++, tg, id);
      for (const id of known) st('UPDATE items SET pos=? WHERE tg_id=? AND id=?').run(p++, tg, id);
    },
    setPhoto(tg, id, buf) {
      st('UPDATE items SET photo=?, photo_ver=photo_ver+1, updated_at=? WHERE tg_id=? AND id=?').run(buf, now(), tg, id);
    },
    clearPhoto(tg, id) {
      st('UPDATE items SET photo=NULL, photo_ver=photo_ver+1, updated_at=? WHERE tg_id=? AND id=?').run(now(), tg, id);
    },
    getPhoto(tg, id) {
      const r = st('SELECT photo FROM items WHERE tg_id=? AND id=?').get(tg, id);
      return r && r.photo ? Buffer.from(r.photo) : null;
    },

    // ---- bought
    listBought(tg, limit = 200) { return rows(st('SELECT at,name,price,icon,bg,ln FROM bought WHERE tg_id=? ORDER BY at DESC LIMIT ?').all(tg, limit)); },
    addBought(tg, b) {
      st('INSERT OR REPLACE INTO bought(tg_id,at,name,price,icon,bg,ln) VALUES(?,?,?,?,?,?,?)').run(tg, b.at, b.name, b.price, b.icon, b.bg, b.ln);
    },
    removeBought(tg, at) { st('DELETE FROM bought WHERE tg_id=? AND at=?').run(tg, at); },
    trimBought(tg, keep) {
      st('DELETE FROM bought WHERE tg_id=? AND at NOT IN (SELECT at FROM bought WHERE tg_id=? ORDER BY at DESC LIMIT ?)').run(tg, tg, keep);
    },

    // ---- стереть
    wipe(tg) {
      tx(() => {
        st('DELETE FROM items WHERE tg_id=?').run(tg);
        st('DELETE FROM bought WHERE tg_id=?').run(tg);
        st('DELETE FROM kv WHERE k IN (?,?)').run('draft:' + tg, 'await_amt:' + tg);
      });
    },
    deleteUser(tg) {
      tx(() => {
        st('DELETE FROM items WHERE tg_id=?').run(tg);
        st('DELETE FROM bought WHERE tg_id=?').run(tg);
        st('DELETE FROM outbox WHERE tg_id=?').run(tg);
        st('DELETE FROM kv WHERE k IN (?,?)').run('draft:' + tg, 'await_amt:' + tg);
        st('DELETE FROM users WHERE tg_id=?').run(tg);
      });
    },

    // ---- очередь исходящих
    enqueue(tg, method, payload, delayMs = 0) {
      st('INSERT INTO outbox(tg_id,method,payload,next_at,created_at) VALUES(?,?,?,?,?)').run(tg, method, JSON.stringify(payload), now() + delayMs, now());
    },
    dueOutbox(limit = 10) {
      return rows(st("SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY id LIMIT ?").all(now(), limit));
    },
    outboxSent(id) { st("UPDATE outbox SET status='sent', payload='{}' WHERE id=?").run(id); },
    outboxRetry(id, delayMs, err) { st("UPDATE outbox SET tries=tries+1, next_at=?, last_error=? WHERE id=?").run(now() + delayMs, String(err).slice(0, 200), id); },
    outboxFail(id, err) { st("UPDATE outbox SET status='failed', payload='{}', last_error=? WHERE id=?").run(String(err).slice(0, 200), id); },
    outboxPrune() {
      st("DELETE FROM outbox WHERE status<>'pending' AND created_at<?").run(now() - 7 * 86400000);
    },
    outboxStats() {
      return rows(st('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').all());
    }
  };
  return A;
}
