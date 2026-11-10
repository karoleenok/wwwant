// Ежедневная копия базы: VACUUM INTO даёт целый согласованный файл. Храним 14 последних.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { makeConfig } from './config.js';

const cfg = makeConfig();
const outDir = process.env.BACKUP_DIR || '/var/backups/wwwant';
const keep = Number(process.env.BACKUP_KEEP || 14);
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const day = new Date().toISOString().slice(0, 10);
const dest = path.join(outDir, `wwwant-${day}.sqlite`);
if (fs.existsSync(dest)) fs.unlinkSync(dest);
const db = new DatabaseSync(path.join(cfg.dataDir, 'wwwant.sqlite'));
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
fs.chmodSync(dest, 0o600);
// проверка: копия открывается и в ней есть таблицы
const chk = new DatabaseSync(dest, { readOnly: true });
const n = chk.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
chk.close();
if (n < 4) { console.error('backup-check-failed'); process.exit(1); }
const files = fs.readdirSync(outDir).filter(f => /^wwwant-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort();
for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(outDir, f));
console.log('backup-ok', dest);
