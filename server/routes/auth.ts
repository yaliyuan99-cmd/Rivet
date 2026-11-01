import type { Hono } from 'hono';
import { z } from 'zod';
import type { Features, SessionResponse, SessionUser } from '../../shared/types/session.ts';
import { addMinutes, type AppContext, type AppEnv, type C, type UserRow } from '../context.ts';
import { audit } from '../lib/audit.ts';
import { createSession, destroyAllSessions, destroySession, requireUser } from '../lib/auth.ts';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../lib/crypto.ts';
import { badRequest, conflict, invalid, tooMany, unauthorized } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { sendMail } from '../lib/mail.ts';
import { clearFailures, failureLimit, rateLimit, recordFailure } from '../lib/rateLimit.ts';
import { readJson, trimmed } from '../lib/validate.ts';

export const VERIFY_LINK_MINUTES = 30;
export const RESET_LINK_MINUTES = 30;
export const RESEND_COOLDOWN_SECONDS = 60;

const email = z.string({ error: 'Enter your email address.' }).trim().toLowerCase().email('Enter a valid email address.').max(254);
const password = z.string({ error: 'Enter a password.' }).min(10, 'Use at least 10 characters.').max(200, 'Keep this under 200 characters.');

function clientKey(c: C): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
}

export function features(ctx: AppContext): Features {
  const { config } = ctx;
  return {
    github: Boolean(config.github),
    linkedin: Boolean(config.linkedin),
    huggingface: Boolean(config.huggingface),
    email: Boolean(config.resendKey),
    anthropic: Boolean(config.anthropicKey),
    devOutbox: config.allowDevOutbox,
  };
}

/** Workspaces and credentials read fresh on each request: losing one takes effect immediately. */
export async function sessionUser(ctx: AppContext, user: UserRow): Promise<SessionUser> {
  const workspaces = await ctx.db.all<{ id: string; code: string; name: string; slug: string; role: 'owner' | 'member'; default_visibility: 'private' | 'shared' }>(
    `SELECT w.id, w.code, w.name, w.slug, m.role, w.default_visibility
     FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ? AND m.status = 'active' ORDER BY m.created_at`,
    [user.id],
  );
  const credentials = await ctx.db.all<{ domain_id: string; name: string; granted_at: string }>(
    `SELECT c.domain_id, d.name, c.granted_at FROM credentials c JOIN domains d ON d.id = c.domain_id
     WHERE c.user_id = ? AND c.revoked_at IS NULL ORDER BY c.granted_at`,
    [user.id],
  );
  const openApplication = await ctx.db.get(`SELECT 1 AS ok FROM applications WHERE user_id = ? AND status IN ('pending', 'more_evidence') LIMIT 1`, [user.id]);
  const summaries = workspaces.map((w) => ({ id: w.id, code: w.code, name: w.name, slug: w.slug, role: w.role, defaultVisibility: w.default_visibility }));
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: Boolean(user.email_verified_at),
    role: user.role,
    bio: user.bio,
    workspace: summaries.find((w) => w.id === user.active_workspace_id) ?? summaries[0] ?? null,
    workspaces: summaries,
    credentials: credentials.map((row) => ({ domainId: row.domain_id, domainName: row.name, grantedAt: row.granted_at })),
    applicant: Boolean(openApplication),
  };
}

async function issueEmailToken(ctx: AppContext, user: Pick<UserRow, 'id' | 'email'>, purpose: 'verify' | 'reset', minutes: number): Promise<string> {
  const token = randomToken();
  const now = ctx.now();
  await ctx.db.run(`UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL`, [now.toISOString(), user.id, purpose]);
  await ctx.db.run(
    `INSERT INTO email_tokens (id, token_hash, user_id, purpose, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId(), sha256Hex(token), user.id, purpose, user.email, now.toISOString(), addMinutes(now, minutes).toISOString()],
  );
  return token;
}

async function sendVerification(ctx: AppContext, user: Pick<UserRow, 'id' | 'email' | 'name'>): Promise<void> {
  const token = await issueEmailToken(ctx, user, 'verify', VERIFY_LINK_MINUTES);
  const link = `${ctx.config.publicUrl}/auth/verify?token=${token}`;
  await sendMail(ctx, {
    to: user.email,
    subject: 'Verify your Rivet email address',
    text: `Hello ${user.name},\n\nOpen this link on the device you signed up with to verify your email address. It expires in ${VERIFY_LINK_MINUTES} minutes.\n\n${link}\n\nRivet never asks for a password by email. If you did not create this account, ignore this message.`,
    link,
    purpose: 'verify',
  });
}

/** Consumes a one-time token, or throws with the reason the link no longer works. */
async function consumeToken(ctx: AppContext, token: string, purpose: 'verify' | 'reset') {
  const row = await ctx.db.get<{ id: string; user_id: string; email: string; expires_at: string; used_at: string | null }>(
    'SELECT id, user_id, email, expires_at, used_at FROM email_tokens WHERE token_hash = ? AND purpose = ?',
    [sha256Hex(token), purpose],
  );
  if (!row) throw badRequest('This link is not valid. Request a fresh one.', 'link_invalid');
  if (row.used_at) throw badRequest('This link has already been used. Request a fresh one.', 'link_used');
  if (row.expires_at <= ctx.now().toISOString()) throw badRequest('This link has expired. Request a fresh one.', 'link_expired');
  await ctx.db.run('UPDATE email_tokens SET used_at = ? WHERE id = ?', [ctx.now().toISOString(), row.id]);
  return row;
}

export function registerAuth(app: Hono<AppEnv>) {
  app.get('/api/session', async (c) => {
    const ctx = c.get('ctx');
    const user = c.get('user');
    const body: SessionResponse = {
      demo: ctx.config.demo,
      user: user ? await sessionUser(ctx, user) : null,
      features: features(ctx),
    };
    return c.json(body);
  });

  app.post('/api/auth/signup', async (c) => {
    const ctx = c.get('ctx');
    await rateLimit(ctx, `signup:${clientKey(c)}`, 20, 600, 'Too many sign-up attempts. Wait a few minutes and try again.');
    const input = await readJson(
      c,
      z.object({
        name: trimmed('Enter your full name.', 120),
        email,
        password,
        acceptTerms: z.literal(true, { error: 'Accept the Terms of Service and Privacy Policy to continue.' }),
      }),
    );
    if (await ctx.db.get('SELECT 1 AS ok FROM users WHERE email = ?', [input.email])) {
      throw invalid({ email: 'An account with this email already exists. Sign in instead.' });
    }
    const id = newId();
    const now = ctx.now().toISOString();
    await ctx.db.run(
      `INSERT INTO users (id, email, name, password_hash, terms_accepted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.email, input.name, await hashPassword(input.password), now, now, now],
    );
    await audit(ctx, { actorId: id, action: 'account.created', subjectType: 'user', subjectId: id });
    await sendVerification(ctx, { id, email: input.email, name: input.name });
    await createSession(c, id);
    return c.json({ ok: true }, 201);
  });

  app.post('/api/auth/signin', async (c) => {
    const ctx = c.get('ctx');
    const input = await readJson(c, z.object({ email, password: z.string({ error: 'Enter your password.' }).min(1, 'Enter your password.') }));
    const limitKey = `signin:${input.email}`;
    await failureLimit(ctx, limitKey, 10, 600, 'Too many failed sign-in attempts for this account. Wait a few minutes and try again.');
    const user = await ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ?', [input.email]);
    if (!user || !(await verifyPassword(input.password, user.password_hash))) {
      await recordFailure(ctx, limitKey, 600);
      throw unauthorized('That email and password do not match an account.');
    }
    await clearFailures(ctx, limitKey);
    await createSession(c, user.id);
    return c.json({ emailVerified: Boolean(user.email_verified_at) });
  });

  app.post('/api/auth/signout', async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  });

  /** What the "Check your inbox" page shows. */
  app.get('/api/auth/verification', async (c) => {
    const ctx = c.get('ctx');
    const user = requireUser(c);
    const token = await ctx.db.get<{ created_at: string; expires_at: string }>(
      `SELECT created_at, expires_at FROM email_tokens WHERE user_id = ? AND purpose = 'verify' ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    );
    const requestedAt = token?.created_at ?? null;
    const resendAvailableAt = requestedAt ? new Date(new Date(requestedAt).getTime() + RESEND_COOLDOWN_SECONDS * 1000).toISOString() : ctx.now().toISOString();
    return c.json({
      email: user.email,
      verified: Boolean(user.email_verified_at),
      requestedAt,
      expiresAt: token?.expires_at ?? null,
      resendAvailableAt,
      serverNow: ctx.now().toISOString(),
    });
  });

  app.post('/api/auth/resend', async (c) => {
    const ctx = c.get('ctx');
    const user = requireUser(c);
    if (user.email_verified_at) throw conflict('This email address is already verified.');
    const last = await ctx.db.get<{ created_at: string }>(`SELECT created_at FROM email_tokens WHERE user_id = ? AND purpose = 'verify' ORDER BY created_at DESC LIMIT 1`, [user.id]);
    if (last && ctx.now().getTime() - new Date(last.created_at).getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
      throw tooMany('Wait for the cooldown to finish before requesting another link.');
    }
    await sendVerification(ctx, user);
    return c.json({ ok: true });
  });

  app.post('/api/auth/change-email', async (c) => {
    const ctx = c.get('ctx');
    const user = requireUser(c);
    if (user.email_verified_at) throw conflict('This email address is already verified.');
    const input = await readJson(c, z.object({ email }));
    if (input.email !== user.email) {
      if (await ctx.db.get('SELECT 1 AS ok FROM users WHERE email = ?', [input.email])) {
        throw invalid({ email: 'An account with this email already exists.' });
      }
      await ctx.db.run('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', [input.email, ctx.now().toISOString(), user.id]);
      await audit(ctx, { actorId: user.id, action: 'account.email_changed', subjectType: 'user', subjectId: user.id });
    }
    await sendVerification(ctx, { ...user, email: input.email });
    return c.json({ ok: true });
  });

  /** The email link lands here. Signs the person in on this device, so it works from any browser. */
  app.post('/api/auth/verify', async (c) => {
    const ctx = c.get('ctx');
    const input = await readJson(c, z.object({ token: z.string().min(1, 'This link is not valid.') }));
    const row = await consumeToken(ctx, input.token, 'verify');
    const user = await ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [row.user_id]);
    if (!user || user.email !== row.email) throw badRequest('This link was issued for a different email address. Request a fresh one.', 'link_invalid');
    if (!user.email_verified_at) {
      await ctx.db.run('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?', [ctx.now().toISOString(), ctx.now().toISOString(), user.id]);
      await audit(ctx, { actorId: user.id, action: 'account.email_verified', subjectType: 'user', subjectId: user.id });
    }
    if (c.get('user')?.id !== user.id) await createSession(c, user.id);
    return c.json({ ok: true });
  });

  /** Always the same answer, so the form does not reveal who has an account. */
  app.post('/api/auth/forgot', async (c) => {
    const ctx = c.get('ctx');
    const input = await readJson(c, z.object({ email }));
    await rateLimit(ctx, `forgot:${input.email}`, 5, 900, 'Too many reset requests for this address. Wait a few minutes and try again.');
    const user = await ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ?', [input.email]);
    if (user) {
      const token = await issueEmailToken(ctx, user, 'reset', RESET_LINK_MINUTES);
      const link = `${ctx.config.publicUrl}/reset?token=${token}`;
      await sendMail(ctx, {
        to: user.email,
        subject: 'Reset your Rivet password',
        text: `Open this link to choose a new password. It expires in ${RESET_LINK_MINUTES} minutes.\n\n${link}\n\nIf you did not ask for this, ignore this message. Your password has not changed.`,
        link,
        purpose: 'reset',
      });
    }
    return c.json({ ok: true });
  });

  app.post('/api/auth/reset', async (c) => {
    const ctx = c.get('ctx');
    const input = await readJson(c, z.object({ token: z.string().min(1, 'This link is not valid.'), password }));
    const row = await consumeToken(ctx, input.token, 'reset');
    const now = ctx.now().toISOString();
    // Reaching this link proves control of the address, so it also verifies it.
    await ctx.db.run('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?', [await hashPassword(input.password), now, now, row.user_id]);
    await destroyAllSessions(ctx, row.user_id);
    await audit(ctx, { actorId: row.user_id, action: 'account.password_reset', subjectType: 'user', subjectId: row.user_id });
    return c.json({ ok: true });
  });
}
