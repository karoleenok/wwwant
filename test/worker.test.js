// Проверяем склейку для Cloudflare: server/worker.js целиком, с подменой D1 и импорта .html (как это делает Wrangler).
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { d1Shim, fakeTelegram, TOKEN } from './helpers.js';

register('data:text/javascript,' + encodeURIComponent(`
  import fs from 'node:fs';
  export async function load(url, ctx, next) {
    if (url.endsWith('.html')) return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(fs.readFileSync(new URL(url), 'utf8')) };
    return next(url, ctx);
  }`), import.meta.url);

const worker = (await import('../server/worker.js')).default;

test('worker.js: fetch и scheduled работают с env как в Cloudflare', async () => {
  const tgs = await fakeTelegram();
  const pending = [];
  const ctx = { waitUntil: p => pending.push(p) };
  const env = { DB: d1Shim(), BOT_TOKEN: ` ${TOKEN}\n`, TG_API_BASES: tgs.url, WEBAPP_URL: 'https://wwwant.example', HOSTING_NAME: 'Тест-хостинг' };
  try {
    const h = await (await worker.fetch(new Request('https://wwwant.example/health'), env, ctx)).json();
    assert.equal(h.status, 'ok');                                        // токен с пробелами и переводом строки обрезан
    const pol = await (await worker.fetch(new Request('https://wwwant.example/policy'), env, ctx)).text();
    assert.match(pol, /Тест-хостинг/);                                   // переменные из wrangler.toml доходят до политики
    const page = await worker.fetch(new Request('https://wwwant.example/'), env, ctx);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
    await worker.scheduled({ cron: '* * * * *' }, env, ctx);
    await Promise.all(pending);
  } finally { await tgs.close(); }
});
