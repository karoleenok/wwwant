// Точка входа Cloudflare Workers. Здесь только склейка: база D1, секрет BOT_TOKEN и страница приложения.
import indexHtml from '../web/index.html';
import { createApp } from './app.js';
import { makeConfig } from './config.js';
import { makeDb } from './db.js';

let app = null;
const get = env => (app ??= createApp({
  cfg: makeConfig(env),
  db: makeDb(env.DB),
  token: String(env.BOT_TOKEN || '').trim(),
  indexHtml,
  // Лимитеры Cloudflare из wrangler.toml. Нет привязки: работает счётчик в памяти.
  limiters: { api: env.RL_API, ip: env.RL_IP, bot: env.RL_BOT }
}));

export default {
  fetch(request, env, ctx) { return get(env).handle(request, ctx); },
  scheduled(event, env, ctx) { ctx.waitUntil(get(env).tick()); }
};
