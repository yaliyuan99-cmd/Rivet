import type { Hono } from 'hono';
import type { AppEnv } from '../context.ts';
import { notFound } from '../lib/errors.ts';

/** The outbox page stands in for an email provider while none is configured. Never served in production. */
export function registerDev(app: Hono<AppEnv>) {
  app.get('/api/dev/outbox', async (c) => {
    const ctx = c.get('ctx');
    if (!ctx.config.allowDevOutbox) throw notFound();
    const messages = await ctx.db.all(
      `SELECT id, to_email AS "to", subject, body_text AS body, link, purpose, created_at AS "createdAt"
       FROM outbox ORDER BY created_at DESC LIMIT 50`,
    );
    return c.json({ messages });
  });
}
