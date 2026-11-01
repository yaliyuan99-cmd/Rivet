import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { migrate, openDb } from './db/index.ts';
import { seedIfEmpty } from './db/seed/index.ts';
import { startEngine } from './engine/runner.ts';
import { localStorage } from './lib/storage.ts';

const config = loadConfig();
const db = openDb(path.join(config.dataDir, 'rivet.db'));
await migrate(db);

const ctx: AppContext = { db, config, storage: localStorage(config.dataDir), now: () => new Date() };
await seedIfEmpty(ctx);
await startEngine(ctx);

const app = createApp(ctx);

const distDir = path.resolve('dist');
if (existsSync(path.join(distDir, 'index.html'))) {
  const indexHtml = readFileSync(path.join(distDir, 'index.html'), 'utf8');
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('*', serveStatic({ root: './dist' }));
  // Client-side routes all resolve to the app; API paths keep their JSON 404.
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    return c.html(indexHtml);
  });
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Rivet API listening on http://localhost:${info.port}${config.demo ? ' (synthetic demo)' : ''}`);
});
