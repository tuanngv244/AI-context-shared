import { buildApp } from './app.js';
import { pool, closeDatabase } from '../../../packages/db/src/index.js';
const app = buildApp();
await app.listen({
  host: process.env.API_HOST ?? '127.0.0.1',
  port: Number(process.env.API_PORT ?? 8787),
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    await closeDatabase();
    process.exit(0);
  });
