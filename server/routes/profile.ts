import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AiClientRow, ConnectionRow, ProfileData } from '../../shared/types/workspace.ts';
import type { AppContext, AppEnv, C, UserRow } from '../context.ts';
import { audit } from '../lib/audit.ts';
import { createSession, destroyAllSessions, destroySession, requireVerified } from '../lib/auth.ts';
import { randomToken, sha256Hex } from '../lib/crypto.ts';
import { notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { authorizationUrl, exchangeCode, fetchIdentity, isProviderId, OAuthFailure, PROVIDER_IDS, PROVIDERS, providerCredentials, type OAuthFlow, type ProviderId, type ProviderIdentity } from '../lib/oauthProviders.ts';
import { rateLimit } from '../lib/rateLimit.ts';
import { readJson, trimmed } from '../lib/validate.ts';
import { activeWorkspace, reviewBiologyVerdict } from './workspaces.ts';

/* ---------- The state cookie ---------- */

const FLOW_COOKIE = 'rivet_oauth';
const FLOW_SECONDS = 600;

/** Only a path on this site, with nothing that could end a header or turn into another host. */
function safeNext(next: string | undefined | null): string {
  return next && /^\/(?!\/)[^\s\\]*$/.test(next) ? next : '/';
}

/** Ties the state to this flow and, for a connection, to the person who started it. */
const stateBinding = (state: string, flow: OAuthFlow, userId: string | undefined) => sha256Hex(`${state}:${flow === 'connect' ? (userId ?? '') : 'signin'}`);

function startFlow(c: C, provider: ProviderId, flow: OAuthFlow, userId: string | undefined, next = '/'): string {
  const state = randomToken();
  const encodedNext = Buffer.from(safeNext(next)).toString('base64url');
  setCookie(c, FLOW_COOKIE, [flow, provider, stateBinding(state, flow, userId), encodedNext].join('.'), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: c.get('ctx').config.publicUrl.startsWith('https://'),
    path: '/api',
    maxAge: FLOW_SECONDS,
  });
  return state;
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

interface FlowCheck {
  /** The flow this browser started, if the cookie says so, even when the state does not match. */
  flow: OAuthFlow | null;
  valid: boolean;
  next: string;
}

/** The cookie is single use: whatever the outcome, this callback spends it. */
function checkFlow(c: C, provider: ProviderId): FlowCheck {
  const raw = getCookie(c, FLOW_COOKIE) ?? '';
  deleteCookie(c, FLOW_COOKIE, { path: '/api' });
  const [flow, cookieProvider, binding, encodedNext] = raw.split('.');
  const knownFlow = flow === 'signin' || flow === 'connect' ? flow : null;
  if (!knownFlow || cookieProvider !== provider || !binding) return { flow: null, valid: false, next: '/' };
  const state = c.req.query('state') ?? '';
  const valid = Boolean(state) && sameText(binding, stateBinding(state, knownFlow, c.get('user')?.id));
  return { flow: knownFlow, valid, next: safeNext(Buffer.from(encodedNext ?? '', 'base64url').toString()) };
}

/* ---------- Where each outcome lands ---------- */

const signInFailed = (c: C, reason: string) => c.redirect(`/auth/github/failed?reason=${reason}`);
const connectFailed = (c: C, provider: ProviderId, reason: string) => c.redirect(`/profile?connection_error=${reason}&provider=${provider}`);

function clientKey(c: C): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
}

/* ---------- Sign in with GitHub ---------- */

async function linkConnection(ctx: AppContext, userId: string, provider: ProviderId, identity: ProviderIdentity, now: string, via: string): Promise<void> {
  await ctx.db.run(
    `INSERT INTO connected_accounts (id, user_id, provider, provider_user_id, handle, profile_url, visibility_note, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), userId, provider, identity.providerUserId, identity.handle, identity.profileUrl, PROVIDERS[provider].visibilityNote, now],
  );
  await audit(ctx, { actorId: userId, action: 'profile.connection_added', subjectType: 'connected_account', subjectId: userId, detail: { provider, handle: identity.handle, via } });
}

/**
 * Existing link first, then the same verified address, then a new account.
 * Reached only with a verified primary address, which is what proves ownership here.
 */
async function githubAccount(ctx: AppContext, identity: ProviderIdentity, email: string): Promise<string> {
  return ctx.db.tx(async () => {
    const linked = await ctx.db.get<{ user_id: string }>(`SELECT user_id FROM connected_accounts WHERE provider = 'github' AND provider_user_id = ? AND disconnected_at IS NULL`, [identity.providerUserId]);
    if (linked) return linked.user_id;

    const now = ctx.now().toISOString();
    const existing = await ctx.db.get<UserRow>('SELECT * FROM users WHERE email = ?', [email]);
    if (existing) {
      if (!existing.email_verified_at) {
        // Someone registered this address without ever proving it. GitHub has now proved it for
        // the real owner, so whoever set that password must not keep a way in.
        await ctx.db.run('UPDATE users SET password_hash = NULL, email_verified_at = ?, updated_at = ? WHERE id = ?', [now, now, existing.id]);
        await destroyAllSessions(ctx, existing.id);
        await audit(ctx, { actorId: existing.id, action: 'account.email_verified', subjectType: 'user', subjectId: existing.id, detail: { via: 'github', unprovenPasswordCleared: true } });
      }
      const current = await ctx.db.get(`SELECT 1 AS ok FROM connected_accounts WHERE user_id = ? AND provider = 'github' AND disconnected_at IS NULL`, [existing.id]);
      if (!current) await linkConnection(ctx, existing.id, 'github', identity, now, 'signin');
      return existing.id;
    }

    const id = newId();
    // terms_accepted_at stays NULL: nobody ticked a box on this path. See docs/assumptions/workspace.md.
    await ctx.db.run(`INSERT INTO users (id, email, name, password_hash, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)`, [id, email, identity.name ?? identity.handle.replace(/^@/, ''), now, now, now]);
    await audit(ctx, { actorId: id, action: 'account.created', subjectType: 'user', subjectId: id, detail: { via: 'github' } });
    await linkConnection(ctx, id, 'github', identity, now, 'signin');
    return id;
  });
}

async function finishSignIn(c: C, code: string, next: string) {
  const ctx = c.get('ctx');
  const accessToken = await exchangeCode(ctx, 'github', code);
  const identity = await fetchIdentity('github', 'signin', accessToken);
  if (!identity.verifiedEmail) return signInFailed(c, 'email');
  const userId = await githubAccount(ctx, identity, identity.verifiedEmail);
  await destroySession(c);
  await createSession(c, userId);
  return c.redirect(next);
}

/* ---------- Connected profiles ---------- */

async function finishConnect(c: C, provider: ProviderId, code: string) {
  const ctx = c.get('ctx');
  const user = c.get('user') as UserRow;
  const accessToken = await exchangeCode(ctx, provider, code);
  const identity = await fetchIdentity(provider, 'connect', accessToken);
  const other = await ctx.db.get(`SELECT 1 AS ok FROM connected_accounts WHERE provider = ? AND provider_user_id = ? AND disconnected_at IS NULL AND user_id <> ?`, [provider, identity.providerUserId, user.id]);
  if (other) return connectFailed(c, provider, 'taken');
  await ctx.db.tx(async () => {
    const now = ctx.now().toISOString();
    await ctx.db.run(`UPDATE connected_accounts SET disconnected_at = ? WHERE user_id = ? AND provider = ? AND disconnected_at IS NULL`, [now, user.id, provider]);
    await linkConnection(ctx, user.id, provider, identity, now, 'profile');
  });
  return c.redirect(`/profile?connected=${provider}`);
}

async function handleCallback(c: C, provider: ProviderId, check: FlowCheck) {
  const flow: OAuthFlow = check.flow ?? (provider === 'github' ? 'signin' : 'connect');
  const fail = (reason: string) => (flow === 'signin' ? signInFailed(c, reason) : connectFailed(c, provider, reason));
  if (!check.valid) return fail('state');
  if (flow === 'connect' && !c.get('user')?.email_verified_at) return fail('state');
  if (!providerCredentials(c.get('ctx'), provider)) return fail('not_configured');
  // State matched, so this really is the answer to the request this browser made.
  if (c.req.query('error')) return fail('denied');
  const code = c.req.query('code');
  if (!code) return fail('unavailable');
  try {
    return flow === 'signin' ? await finishSignIn(c, code, check.next) : await finishConnect(c, provider, code);
  } catch (error) {
    if (error instanceof OAuthFailure) {
      console.warn(`[oauth ${provider}]`, error.message);
      return fail('unavailable');
    }
    throw error;
  }
}

/* ---------- AI clients ---------- */

const uniqueScopeWords = (scopes: string[]) => [...new Set(scopes.map((scope) => scope.split(':')[1] ?? scope))];

/** ["tasks:read", "reports:read", "advisor:query"] reads as "Read/query". */
function accessSummary(scopes: string[]): string {
  const words = uniqueScopeWords(scopes);
  return words.map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join('/');
}

function parseScopes(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === 'string') : [];
  } catch {
    return [];
  }
}

export function registerProfile(app: Hono<AppEnv>) {
  /* ---------- Profile ---------- */

  app.get('/api/profile', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const now = ctx.now().toISOString();
    const workspace = await activeWorkspace(ctx, user);
    const credentials = await ctx.db.all<{ domain_id: string; name: string; granted_at: string }>(
      `SELECT c.domain_id, d.name, c.granted_at FROM credentials c JOIN domains d ON d.id = c.domain_id WHERE c.user_id = ? AND c.revoked_at IS NULL ORDER BY c.granted_at`,
      [user.id],
    );
    const connectedRows = await ctx.db.all<{ provider: ProviderId; handle: string; profile_url: string | null; visibility_note: string; is_synthetic: number; connected_at: string }>(
      `SELECT provider, handle, profile_url, visibility_note, is_synthetic, connected_at FROM connected_accounts WHERE user_id = ? AND disconnected_at IS NULL`,
      [user.id],
    );
    const connections: ConnectionRow[] = PROVIDER_IDS.map((provider) => {
      const row = connectedRows.find((candidate) => candidate.provider === provider);
      const label = PROVIDERS[provider].label;
      const configured = Boolean(providerCredentials(ctx, provider));
      return {
        provider,
        label,
        connected: Boolean(row),
        handle: row?.handle ?? null,
        profileUrl: row?.profile_url ?? null,
        visibilityNote: row?.visibility_note ?? null,
        isSynthetic: Boolean(row?.is_synthetic),
        connectedAt: row?.connected_at ?? null,
        connect: configured ? { allowed: true } : { allowed: false, reason: `${label} connection is not configured on this server` },
        connectHref: configured ? `/api/profile/connections/${provider}/start` : null,
      };
    });
    const clientRows = await ctx.db.all<{ id: string; scopes: string; issued_at: string; expires_at: string; client_name: string; task_code: string }>(
      `SELECT tk.id, tk.scopes, tk.issued_at, tk.expires_at, oc.name AS client_name, t.code AS task_code
       FROM oauth_tokens tk
       JOIN oauth_clients oc ON oc.id = tk.client_id
       JOIN task_versions tv ON tv.id = tk.task_version_id
       JOIN tasks t ON t.id = tv.task_id
       WHERE tk.user_id = ? AND tk.revoked_at IS NULL AND tk.expires_at > ?
       ORDER BY tk.issued_at DESC`,
      [user.id, now],
    );
    const aiClients: AiClientRow[] = clientRows.map((row) => {
      const scopes = parseScopes(row.scopes);
      return { id: row.id, clientName: row.client_name, resource: `${row.task_code} only`, access: accessSummary(scopes), scopes, issuedAt: row.issued_at, expiresAt: row.expires_at };
    });
    const body: ProfileData = {
      name: user.name,
      email: user.email,
      emailVerified: Boolean(user.email_verified_at),
      bio: user.bio,
      accountRole: user.role,
      workspace: workspace ? { name: workspace.name, role: workspace.role } : null,
      credentials: credentials.map((row) => ({ domainId: row.domain_id, domainName: row.name, grantedAt: row.granted_at })),
      connections,
      aiClients,
      reviewBiology: await reviewBiologyVerdict(ctx, user),
      serverNow: now,
    };
    return c.json(body);
  });

  app.patch('/api/profile', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const input = await readJson(
      c,
      z.object({
        name: trimmed('Enter your display name.', 120),
        bio: z.string({ error: 'Enter a bio, or leave it empty.' }).trim().max(1000, 'Keep this under 1000 characters.'),
      }),
    );
    await ctx.db.run('UPDATE users SET name = ?, bio = ?, updated_at = ? WHERE id = ?', [input.name, input.bio, ctx.now().toISOString(), user.id]);
    await audit(ctx, { actorId: user.id, action: 'profile.updated', subjectType: 'user', subjectId: user.id, detail: { nameChanged: input.name !== user.name, bioChanged: input.bio !== user.bio } });
    return c.json({ name: input.name, bio: input.bio });
  });

  /* ---------- Sign in with GitHub ---------- */

  app.get('/api/auth/github/start', async (c) => {
    const ctx = c.get('ctx');
    if (!providerCredentials(ctx, 'github')) return signInFailed(c, 'not_configured');
    try {
      await rateLimit(ctx, `github-start:${clientKey(c)}`, 60, 600);
    } catch {
      return signInFailed(c, 'rate_limited');
    }
    const state = startFlow(c, 'github', 'signin', undefined, c.req.query('next'));
    return c.redirect(authorizationUrl(ctx, 'github', 'signin', state));
  });

  /** GitHub registers one callback, so this also finishes a connection started from Profile. */
  app.get('/api/auth/github/callback', (c) => handleCallback(c, 'github', checkFlow(c, 'github')));

  /* ---------- Connected profiles ---------- */

  app.get('/api/profile/connections/:provider/start', async (c) => {
    const ctx = c.get('ctx');
    const provider = c.req.param('provider');
    if (!isProviderId(provider)) throw notFound();
    const user = c.get('user');
    if (!user) return c.redirect('/signin?next=/profile');
    if (!user.email_verified_at) return c.redirect('/verify');
    if (!providerCredentials(ctx, provider)) return connectFailed(c, provider, 'not_configured');
    const state = startFlow(c, provider, 'connect', user.id);
    return c.redirect(authorizationUrl(ctx, provider, 'connect', state));
  });

  app.get('/api/profile/connections/:provider/callback', (c) => {
    const provider = c.req.param('provider');
    if (!isProviderId(provider)) throw notFound();
    return handleCallback(c, provider, checkFlow(c, provider));
  });

  app.post('/api/profile/connections/:provider/disconnect', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const provider = c.req.param('provider');
    if (!isProviderId(provider)) throw notFound();
    const result = await ctx.db.run(`UPDATE connected_accounts SET disconnected_at = ? WHERE user_id = ? AND provider = ? AND disconnected_at IS NULL`, [ctx.now().toISOString(), user.id, provider]);
    if (result.changes === 0) throw notFound('This profile is not connected.');
    await audit(ctx, { actorId: user.id, action: 'profile.connection_removed', subjectType: 'connected_account', subjectId: user.id, detail: { provider } });
    return c.json({ ok: true });
  });
}
