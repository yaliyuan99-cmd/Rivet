import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import type { AppContext, AppEnv, C, UserRow } from '../context.ts';
import { randomToken, sha256Hex } from './crypto.ts';
import { forbidden, unauthorized } from './errors.ts';
import { newId } from './ids.ts';

const COOKIE = 'rivet_session';

export async function createSession(c: C, userId: string): Promise<void> {
  const ctx = c.get('ctx');
  const token = randomToken();
  const now = ctx.now();
  const expires = new Date(now.getTime() + ctx.config.sessionDays * 86_400_000);
  await ctx.db.run('INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [newId(), sha256Hex(token), userId, now.toISOString(), expires.toISOString()]);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: ctx.config.publicUrl.startsWith('https://'),
    path: '/',
    expires,
  });
}

export async function destroySession(c: C): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await c.get('ctx').db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256Hex(token)]);
  deleteCookie(c, COOKIE, { path: '/' });
}

/** Ends every session a user holds, e.g. after a password reset. */
export async function destroyAllSessions(ctx: AppContext, userId: string): Promise<void> {
  await ctx.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

export const loadUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = c.get('ctx');
  let user: UserRow | null = null;
  const token = getCookie(c, COOKIE);
  if (token) {
    user =
      (await ctx.db.get<UserRow>(
        `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
        [sha256Hex(token), ctx.now().toISOString()],
      )) ?? null;
  }
  c.set('user', user);
  await next();
};

/**
 * Cross-site requests cannot set a custom header without a preflight this server never grants,
 * so requiring it on every write stops CSRF. The Origin check is a second layer.
 */
export const csrfProtection: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (c.req.header('x-rivet-request') !== '1') throw forbidden('This request is missing its Rivet request header.', 'csrf');
    const origin = c.req.header('origin');
    if (origin) {
      const host = c.req.header('host');
      const allowed = c.get('ctx').config.publicUrl;
      if (origin !== allowed && new URL(origin).host !== host) throw forbidden('This request came from another site.', 'csrf');
    }
  }
  await next();
};

export function requireUser(c: C): UserRow {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}

/** "Tasks, datasets and reports require a verified account." */
export function requireVerified(c: C): UserRow {
  const user = requireUser(c);
  if (!user.email_verified_at) throw forbidden('Verify your email address to continue.', 'email_unverified');
  return user;
}

export function requireAdmin(c: C): UserRow {
  const user = requireVerified(c);
  if (user.role !== 'admin') throw forbidden('Admin role required');
  return user;
}
