import type { AppContext } from '../context.ts';
import { tooMany } from './errors.ts';

/** Fixed-window limiter stored in the database. Throws 429 with a message the UI can show. */
export async function rateLimit(ctx: AppContext, key: string, limit: number, windowSeconds: number, message = 'Too many attempts. Wait a moment and try again.'): Promise<void> {
  if (!ctx.config.rateLimits) return;
  const now = ctx.now();
  const row = await ctx.db.get<{ window_start: string; count: number }>('SELECT window_start, count FROM rate_limits WHERE key = ?', [key]);
  if (!row || now.getTime() - new Date(row.window_start).getTime() >= windowSeconds * 1000) {
    await ctx.db.run(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = 1`,
      [key, now.toISOString()],
    );
    return;
  }
  if (row.count >= limit) throw tooMany(message);
  await ctx.db.run('UPDATE rate_limits SET count = count + 1 WHERE key = ?', [key]);
}

/**
 * For sign-in: only failures count, so someone who signs in often is never locked out by success.
 * Call failureLimit first, recordFailure when the attempt fails, clearFailures when it succeeds.
 */
export async function failureLimit(ctx: AppContext, key: string, limit: number, windowSeconds: number, message: string): Promise<void> {
  if (!ctx.config.rateLimits) return;
  const row = await ctx.db.get<{ window_start: string; count: number }>('SELECT window_start, count FROM rate_limits WHERE key = ?', [key]);
  if (row && row.count >= limit && ctx.now().getTime() - new Date(row.window_start).getTime() < windowSeconds * 1000) throw tooMany(message);
}

export async function recordFailure(ctx: AppContext, key: string, windowSeconds: number): Promise<void> {
  if (!ctx.config.rateLimits) return;
  const now = ctx.now();
  const row = await ctx.db.get<{ window_start: string }>('SELECT window_start FROM rate_limits WHERE key = ?', [key]);
  if (row && now.getTime() - new Date(row.window_start).getTime() < windowSeconds * 1000) {
    await ctx.db.run('UPDATE rate_limits SET count = count + 1 WHERE key = ?', [key]);
  } else {
    await ctx.db.run(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = 1`,
      [key, now.toISOString()],
    );
  }
}

export async function clearFailures(ctx: AppContext, key: string): Promise<void> {
  await ctx.db.run('DELETE FROM rate_limits WHERE key = ?', [key]);
}
