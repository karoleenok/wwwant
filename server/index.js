import { makeConfig } from './config.js';
import { createApp } from './app.js';

const cfg = makeConfig();
const app = createApp(cfg);
const port = await app.start();
console.log(`wwwant слушает ${cfg.host}:${port}`);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { await app.stop(); process.exit(0); });
}
