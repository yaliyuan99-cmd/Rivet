import { timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { ExternalAdvisorAnswer, ExternalReport, ExternalTask, OAuthClientInfo, OAuthRequestCreated, OAuthRequestStatus, OAuthRequestView, OAuthScope, OAuthTokenError, OAuthTokenResponse, OAuthTokenState } from '../../shared/types/external.ts';
import { addMinutes, type AppContext, type AppEnv, type C, type UserRow } from '../context.ts';
import { answerQuestion, type AdvisorTaskRow, type AdvisorVersionRow } from '../engine/advisor.ts';
import { audit } from '../lib/audit.ts';
import { requireVerified } from '../lib/auth.ts';
import { randomToken, sha256Base64Url, sha256Hex } from '../lib/crypto.ts';
import { conflict, forbidden, HttpError, notFound } from '../lib/errors.ts';
import { verifyEvidenceRow } from '../lib/evidence.ts';
import { newId, nextCounter, pad3 } from '../lib/ids.ts';
import { canReadDataset, canReadTask } from '../lib/permissions.ts';
import { rateLimit } from '../lib/rateLimit.ts';
import { readJson, trimmed } from '../lib/validate.ts';

export const OAUTH_SCOPES: readonly OAuthScope[] = ['tasks:read', 'reports:read', 'advisor:query'];
/** "Consent links are short-lived." */
export const REQUEST_MINUTES = 10;
/** One-time code lifetime. "Return to Atlas" mints a fresh one, so a slow reader is never stranded. */
export const CODE_MINUTES = 5;
/** How long after approval the user can still send Atlas a code. Past this the approval has lapsed. */
export const RETURN_WINDOW_MINUTES = 10;
export const TOKEN_SECONDS = 3600;

export interface ClientRow {
  id: string;
  client_id: string;
  name: string;
  developer: string;
  description: string;
  redirect_uri: string;
  is_synthetic: number;
  created_at: string;
}

export interface RequestRow {
  id: string;
  code: string;
  client_id: string;
  user_id: string;
  workspace_id: string | null;
  scopes: string;
  resource: string;
  task_id: string;
  task_version_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  status: OAuthRequestStatus;
  auth_code_hash: string | null;
  auth_code_expires_at: string | null;
  auth_code_used_at: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

export interface TokenRow {
  id: string;
  request_id: string;
  client_id: string;
  user_id: string;
  token_hash: string;
  scopes: string;
  task_version_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

/* ---------- Verification functions: pure, and exercised by the system checks too ---------- */

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** base64url(sha256(verifier)) is always 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[\x20-\x7e]{1,512}$/;
const RESOURCE = /^(?:task:)?([A-Za-z][A-Za-z0-9]*-\d+)$/;

export const isS256Challenge = (challenge: string) => CHALLENGE.test(challenge);
export const isWellFormedState = (state: string) => STATE.test(state);

/** RFC 7636 section 4.6: S256 only, compared in constant time. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier) || !CHALLENGE.test(challenge)) return false;
  const computed = Buffer.from(sha256Base64Url(verifier));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** Exact string comparison. No prefix, no trailing slash, no case folding. */
export const redirectMatches = (registered: string, presented: string | undefined) => presented === registered;

export interface AuthorizationParams {
  response_type?: string;
  scope?: string;
  resource?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

export type ValidatedParams =
  | { ok: true; scopes: OAuthScope[]; taskCode: string; resource: string; state: string; codeChallenge: string }
  | { ok: false; error: 'unsupported_response_type' | 'invalid_request' | 'invalid_scope' | 'invalid_target'; description: string };

/** Everything after the client and redirect are known good. A failure here may go back to the client. */
export function validateAuthorizationParams(params: AuthorizationParams): ValidatedParams {
  if (params.response_type !== 'code') return { ok: false, error: 'unsupported_response_type', description: 'Rivet only supports the authorization code flow (response_type=code).' };
  if (!params.state || !STATE.test(params.state)) return { ok: false, error: 'invalid_request', description: 'This request is missing its state value, so its response could not be verified.' };
  if (params.code_challenge_method !== 'S256') return { ok: false, error: 'invalid_request', description: 'Rivet only accepts PKCE with code_challenge_method=S256.' };
  if (!params.code_challenge || !CHALLENGE.test(params.code_challenge)) return { ok: false, error: 'invalid_request', description: 'This request is missing a valid S256 PKCE challenge.' };
  const requested = (params.scope ?? '').split(/\s+/).filter(Boolean);
  if (!requested.length) return { ok: false, error: 'invalid_scope', description: 'This request does not name any scopes.' };
  const unknown = requested.filter((scope) => !OAUTH_SCOPES.includes(scope as OAuthScope));
  if (unknown.length) return { ok: false, error: 'invalid_scope', description: `Rivet does not offer the scope ${unknown.join(', ')}.` };
  const match = RESOURCE.exec(params.resource ?? '');
  if (!match) return { ok: false, error: 'invalid_target', description: 'This request must name one task as its resource, for example task:BIO-042.' };
  const taskCode = (match[1] as string).toUpperCase();
  return { ok: true, scopes: OAUTH_SCOPES.filter((scope) => requested.includes(scope)), taskCode, resource: `task:${taskCode}`, state: params.state, codeChallenge: params.code_challenge };
}

/** The only way a redirect is ever built: from a registered URI, keeping any query it already has. */
export function authorizationRedirect(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/* ---------- Clients ---------- */

export const DEMO_CLIENT_ID = 'client_atlas_demo';
export const DEMO_CALLBACK_PATH = '/atlas-demo/callback';

/**
 * Registered clients are compared with what they registered. The demo client is registered against this
 * instance, so it follows the public URL when the same data folder is served from another address.
 */
export function registeredRedirect(ctx: AppContext, client: ClientRow): string {
  return client.client_id === DEMO_CLIENT_ID && client.is_synthetic ? `${ctx.config.publicUrl}${DEMO_CALLBACK_PATH}` : client.redirect_uri;
}

const parseScopes = (raw: string): OAuthScope[] => {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? (value.filter((scope) => OAUTH_SCOPES.includes(scope as OAuthScope)) as OAuthScope[]) : [];
  } catch {
    return [];
  }
};

/* ---------- Authorization codes and tokens ---------- */

/** Replaces any earlier code for this request, so only the newest one can be redeemed. */
export async function issueAuthorizationCode(ctx: AppContext, requestId: string): Promise<{ code: string; expiresAt: string }> {
  const code = randomToken();
  const expiresAt = addMinutes(ctx.now(), CODE_MINUTES).toISOString();
  await ctx.db.run(`UPDATE oauth_requests SET auth_code_hash = ?, auth_code_expires_at = ?, auth_code_used_at = NULL WHERE id = ?`, [sha256Hex(code), expiresAt, requestId]);
  return { code, expiresAt };
}

export type ExchangeResult =
  | { ok: true; accessToken: string; tokenId: string; expiresAt: string; scopes: OAuthScope[]; resource: string }
  | { ok: false; error: OAuthTokenError['error']; description: string };

const invalidGrant = (description: string): ExchangeResult => ({ ok: false, error: 'invalid_grant', description });

/**
 * RFC 6749 section 4.1.3 with PKCE. Single use: a second attempt fails and revokes what the first one
 * issued, because a replay means the code leaked. The user's permission is read again here.
 */
export async function exchangeAuthorizationCode(ctx: AppContext, input: { clientRowId: string; code: string; redirectUri: string; codeVerifier: string }): Promise<ExchangeResult> {
  return ctx.db.tx(async () => {
    const nowDate = ctx.now();
    const now = nowDate.toISOString();
    const row = await ctx.db.get<RequestRow>(`SELECT * FROM oauth_requests WHERE auth_code_hash = ? AND client_id = ?`, [sha256Hex(input.code), input.clientRowId]);
    if (!row || row.status !== 'approved') return invalidGrant('This authorization code is not valid.');

    if (row.auth_code_used_at) {
      await ctx.db.run(`UPDATE oauth_tokens SET revoked_at = ? WHERE request_id = ? AND revoked_at IS NULL`, [now, row.id]);
      await audit(ctx, { actorId: row.user_id, action: 'oauth.code_replayed', subjectType: 'oauth_request', subjectId: row.id, subjectCode: row.code, workspaceId: row.workspace_id, detail: { tokensRevoked: true } });
      return invalidGrant('This authorization code was already used. Access issued from it has been revoked.');
    }
    if (!row.auth_code_expires_at || row.auth_code_expires_at <= now) return invalidGrant('This authorization code has expired.');
    if (!redirectMatches(row.redirect_uri, input.redirectUri)) return invalidGrant('The redirect_uri does not match the authorization request.');
    if (!verifyPkce(input.codeVerifier, row.code_challenge)) return invalidGrant('The PKCE code_verifier does not match the challenge.');

    const user = await ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [row.user_id]);
    const task = await ctx.db.get<AdvisorTaskRow>('SELECT * FROM tasks WHERE id = ?', [row.task_id]);
    if (!user || !user.email_verified_at || !task || !(await canReadTask(ctx, user, task)).allowed) {
      return invalidGrant('The approving user can no longer read this task.');
    }

    const accessToken = `rvt_${randomToken()}`;
    const tokenId = newId();
    const expiresAt = new Date(nowDate.getTime() + TOKEN_SECONDS * 1000).toISOString();
    await ctx.db.run(`UPDATE oauth_requests SET auth_code_used_at = ? WHERE id = ?`, [now, row.id]);
    await ctx.db.run(
      `INSERT INTO oauth_tokens (id, request_id, client_id, user_id, token_hash, scopes, task_version_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tokenId, row.id, row.client_id, row.user_id, sha256Hex(accessToken), row.scopes, row.task_version_id, now, expiresAt],
    );
    await audit(ctx, { actorId: row.user_id, action: 'oauth.token_issued', subjectType: 'oauth_token', subjectId: tokenId, subjectCode: row.code, workspaceId: row.workspace_id, detail: { expiresAt } });
    return { ok: true, accessToken, tokenId, expiresAt, scopes: parseScopes(row.scopes), resource: row.resource };
  });
}

/* ---------- Consent requests ---------- */

/** A pending request past its deadline becomes expired the first time anything looks at it. */
async function settleExpiry(ctx: AppContext, row: RequestRow): Promise<RequestRow> {
  if (row.status !== 'pending' || row.expires_at > ctx.now().toISOString()) return row;
  await ctx.db.tx(async () => {
    const { changes } = await ctx.db.run(`UPDATE oauth_requests SET status = 'expired' WHERE id = ? AND status = 'pending'`, [row.id]);
    if (changes) await audit(ctx, { actorId: row.user_id, action: 'oauth.request_expired', subjectType: 'oauth_request', subjectId: row.id, subjectCode: row.code, workspaceId: row.workspace_id, detail: { expiresAt: row.expires_at } });
  });
  return { ...row, status: 'expired' };
}

const scopeDescription = (scope: OAuthScope, reportCode: string | null): string => {
  if (scope === 'tasks:read') return 'Read the frozen task definition; no workspace discovery.';
  if (scope === 'reports:read') return `Read ${reportCode ?? 'the frozen report'} and evidence metadata; no private source files.`;
  return 'Ask Audit Advisor within authorized task evidence.';
};

function redirectDisplay(redirectUri: string): string {
  const url = new URL(redirectUri);
  return `${url.host}${url.pathname}`;
}

async function buildView(ctx: AppContext, row: RequestRow): Promise<OAuthRequestView> {
  const { db } = ctx;
  const now = ctx.now();
  const client = (await db.get<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', [row.client_id])) as ClientRow;
  const account = await db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [row.user_id]);
  const workspace = row.workspace_id ? await db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [row.workspace_id]) : undefined;
  const version = (await db.get<{ version: string }>('SELECT version FROM task_versions WHERE id = ?', [row.task_version_id])) as { version: string };
  const task = (await db.get<{ code: string }>('SELECT code FROM tasks WHERE id = ?', [row.task_id])) as { code: string };
  const report = await db.get<{ code: string }>('SELECT code FROM reports WHERE task_version_id = ? ORDER BY frozen_at DESC LIMIT 1', [row.task_version_id]);
  const token = await db.get<TokenRow>('SELECT * FROM oauth_tokens WHERE request_id = ? ORDER BY issued_at DESC LIMIT 1', [row.id]);
  const others = await db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM oauth_tokens WHERE user_id = ? AND client_id = ? AND request_id <> ? AND revoked_at IS NULL AND expires_at > ?`,
    [row.user_id, row.client_id, row.id, now.toISOString()],
  );

  let tokenState: OAuthTokenState = 'not_issued';
  if (row.status === 'approved') {
    if (token) tokenState = token.revoked_at ? 'revoked' : token.expires_at <= now.toISOString() ? 'expired' : 'issued';
    else if (row.auth_code_used_at) tokenState = 'revoked';
    else tokenState = row.decided_at && addMinutes(new Date(row.decided_at), RETURN_WINDOW_MINUTES) <= now ? 'lapsed' : 'awaiting_exchange';
  }

  let canReturn: OAuthRequestView['canReturn'] = { allowed: false, reason: 'A decision is still required.' };
  if (row.status === 'approved') {
    canReturn =
      tokenState === 'awaiting_exchange'
        ? { allowed: true }
        : tokenState === 'lapsed'
          ? { allowed: false, reason: `${client.name} did not collect this approval in time. A fresh authorization is required.` }
          : { allowed: false, reason: `${client.name} already exchanged this authorization.` };
  }

  let returnUrl: string | null = null;
  if (row.status === 'denied') returnUrl = authorizationRedirect(row.redirect_uri, { error: 'access_denied', error_description: 'The user denied this request.', state: row.state });
  if (row.status === 'expired') returnUrl = authorizationRedirect(row.redirect_uri, { error: 'access_denied', error_description: 'The consent link expired before a decision was made.', state: row.state });

  return {
    code: row.code,
    status: row.status,
    client: { clientId: client.client_id, name: client.name, developer: client.developer, description: client.description, synthetic: Boolean(client.is_synthetic) },
    account: { name: account?.name ?? '', workspaceName: workspace?.name ?? null },
    scopes: parseScopes(row.scopes).map((scope) => ({ scope, description: scopeDescription(scope, report?.code ?? null) })),
    resource: { taskCode: task.code, version: version.version, label: `${task.code} v${version.version}` },
    redirectDisplay: redirectDisplay(row.redirect_uri),
    token: { state: tokenState, id: token?.id ?? null, expiresAt: token?.expires_at ?? null, revokedAt: token?.revoked_at ?? null },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    returnUrl,
    canReturn,
    otherActiveConnections: others?.count ?? 0,
    serverNow: now.toISOString(),
  };
}

/** Only the requesting user may see or act on a request. Anyone else gets the same 404 as a wrong code. */
async function loadOwnRequest(c: C, user: UserRow): Promise<RequestRow> {
  const ctx = c.get('ctx');
  const row = await ctx.db.get<RequestRow>('SELECT * FROM oauth_requests WHERE code = ?', [c.req.param('code') ?? '']);
  if (!row || row.user_id !== user.id) throw notFound();
  return settleExpiry(ctx, row);
}

/** The client and redirect checked out, so the client may hear about this error. The page offers the link. */
const refusedWithReturn = (status: number, code: string, message: string, redirectUri: string, state: string | undefined) =>
  new HttpError(status, code, message, {
    returnTo: authorizationRedirect(redirectUri, { error: code, error_description: message, ...(state ? { state } : {}) }),
  });

const requestSchema = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
});

/* ---------- Bearer API ---------- */

interface BearerContext {
  token: TokenRow;
  user: UserRow;
  task: AdvisorTaskRow;
  version: AdvisorVersionRow;
  request: RequestRow;
}

function bearerError(c: C, status: 401 | 403, code: string, message: string, header: string): HttpError {
  c.header('WWW-Authenticate', header);
  return new HttpError(status, code, message);
}

/** Scope, expiry and revocation here; the resource boundary and current permission in the callers below. */
async function requireBearer(c: C, scope: OAuthScope): Promise<BearerContext> {
  const ctx = c.get('ctx');
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(c.req.header('authorization') ?? '');
  if (!match) throw bearerError(c, 401, 'invalid_token', 'Send an access token in the Authorization header.', 'Bearer realm="rivet"');
  const invalid = (message: string) => bearerError(c, 401, 'invalid_token', message, `Bearer realm="rivet", error="invalid_token", error_description="${message}"`);

  const token = await ctx.db.get<TokenRow>('SELECT * FROM oauth_tokens WHERE token_hash = ?', [sha256Hex(match[1] as string)]);
  if (!token) throw invalid('This access token is not valid.');
  if (token.revoked_at) throw invalid('This access token was revoked.');
  if (token.expires_at <= ctx.now().toISOString()) throw invalid('This access token has expired.');
  if (!parseScopes(token.scopes).includes(scope)) {
    throw bearerError(c, 403, 'insufficient_scope', `This access token does not hold the ${scope} scope.`, `Bearer realm="rivet", error="insufficient_scope", scope="${scope}"`);
  }
  await rateLimit(ctx, `external:${token.id}`, 120, 60, 'Too many requests with this access token. Wait a moment and try again.');

  const user = await ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [token.user_id]);
  const version = await ctx.db.get<AdvisorVersionRow>('SELECT * FROM task_versions WHERE id = ?', [token.task_version_id]);
  const task = version ? await ctx.db.get<AdvisorTaskRow>('SELECT * FROM tasks WHERE id = ?', [version.task_id]) : undefined;
  const request = await ctx.db.get<RequestRow>('SELECT * FROM oauth_requests WHERE id = ?', [token.request_id]);
  if (!user || !user.email_verified_at || !version || !task || !request) throw invalid('This access token is not valid.');
  return { token, user, task, version, request };
}

const boundaryLabel = (bearer: BearerContext) => `${bearer.task.code} v${bearer.version.version}`;

async function refuseOutOfBoundary(c: C, bearer: BearerContext, attempted: string): Promise<HttpError> {
  await audit(c.get('ctx'), { actorId: bearer.user.id, action: 'oauth.api_refused', subjectType: 'oauth_token', subjectId: bearer.token.id, subjectCode: bearer.request.code, workspaceId: bearer.request.workspace_id, detail: { reason: 'out_of_boundary', attempted } });
  return bearerError(c, 403, 'out_of_boundary', `This access token is limited to ${boundaryLabel(bearer)}.`, `Bearer realm="rivet", error="insufficient_scope", error_description="Outside the resource boundary"`);
}

/** Reads memberships and reviews now, so removing someone stops their tokens on the next request. */
async function requireCurrentPermission(c: C, bearer: BearerContext): Promise<void> {
  const ctx = c.get('ctx');
  const verdict = await canReadTask(ctx, bearer.user, bearer.task);
  if (verdict.allowed) return;
  await audit(ctx, { actorId: bearer.user.id, action: 'oauth.api_refused', subjectType: 'oauth_token', subjectId: bearer.token.id, subjectCode: bearer.request.code, workspaceId: bearer.request.workspace_id, detail: { reason: 'permission_lost' } });
  throw bearerError(c, 403, 'access_revoked', verdict.reason, `Bearer realm="rivet", error="insufficient_scope", error_description="The approving user can no longer read this task"`);
}

const recordRead = (c: C, bearer: BearerContext, path: string) =>
  audit(c.get('ctx'), { actorId: bearer.user.id, action: 'oauth.api_read', subjectType: 'oauth_token', subjectId: bearer.token.id, subjectCode: bearer.request.code, workspaceId: bearer.request.workspace_id, detail: { path } });

/* ---------- Token endpoint errors ---------- */

function tokenError(c: Context<AppEnv>, status: 400 | 401, body: OAuthTokenError) {
  if (status === 401) c.header('WWW-Authenticate', 'Basic realm="rivet-oauth"');
  return c.json(body, status, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
}

export function registerExternal(app: Hono<AppEnv>) {
  /* ---------- Public client metadata: the demo page reads its registered redirect from here ---------- */

  app.get('/api/oauth/clients/:clientId', async (c) => {
    const ctx = c.get('ctx');
    const client = await ctx.db.get<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?', [c.req.param('clientId')]);
    if (!client) throw notFound('This client is not registered with Rivet.');
    const body: OAuthClientInfo = { clientId: client.client_id, name: client.name, developer: client.developer, description: client.description, redirectUri: registeredRedirect(ctx, client), synthetic: Boolean(client.is_synthetic), scopes: [...OAUTH_SCOPES] };
    return c.json(body);
  });

  /* ---------- Consent: cookie authenticated, for the requesting user only ---------- */

  app.post('/api/oauth/requests', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const input = await readJson(c, requestSchema);
    await rateLimit(ctx, `oauth-request:${user.id}`, 30, 60, 'Too many authorization requests. Wait a moment and try again.');

    // Nothing is ever sent to a client or redirect that does not check out: no returnTo on these two.
    const client = input.client_id ? await ctx.db.get<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?', [input.client_id]) : undefined;
    if (!client) throw new HttpError(400, 'invalid_client', 'This client is not registered with Rivet.');
    const redirectUri = registeredRedirect(ctx, client);
    if (!redirectMatches(redirectUri, input.redirect_uri)) throw new HttpError(400, 'invalid_redirect_uri', 'This redirect address is not registered for this client.');

    const validated = validateAuthorizationParams(input);
    if (!validated.ok) throw refusedWithReturn(400, validated.error, validated.description, redirectUri, input.state);

    const missingTask = 'This task does not exist or you do not have access to it.';
    const task = await ctx.db.get<AdvisorTaskRow>('SELECT * FROM tasks WHERE code = ?', [validated.taskCode]);
    if (!task || !(await canReadTask(ctx, user, task)).allowed) throw refusedWithReturn(404, 'invalid_target', missingTask, redirectUri, validated.state);
    if (!task.latest_version_id) throw refusedWithReturn(400, 'invalid_target', `${task.code} has no frozen version yet. Only a frozen task can be shared with an AI client.`, redirectUri, validated.state);

    // The same state and challenge mean the same attempt: a reload finds it, and it can never be reopened.
    const attempt = await ctx.db.get<RequestRow>(`SELECT * FROM oauth_requests WHERE client_id = ? AND user_id = ? AND state = ? AND code_challenge = ?`, [client.id, user.id, validated.state, validated.codeChallenge]);
    if (attempt) return c.json<OAuthRequestCreated>({ code: attempt.code, created: false });

    const now = ctx.now();
    const id = newId();
    const member = await ctx.db.get<{ ok: number }>(`SELECT 1 AS ok FROM memberships WHERE workspace_id = ? AND user_id = ? AND status = 'active'`, [task.workspace_id, user.id]);
    const workspaceId = member ? task.workspace_id : user.active_workspace_id;
    const code = await ctx.db.tx(async () => {
      const issued = `OAUTH-${pad3(await nextCounter(ctx.db, 'oauth'))}`;
      await ctx.db.run(
        `INSERT INTO oauth_requests (id, code, client_id, user_id, workspace_id, scopes, resource, task_id, task_version_id, redirect_uri, state, code_challenge, code_challenge_method, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'S256', 'pending', ?, ?)`,
        [id, issued, client.id, user.id, workspaceId, JSON.stringify(validated.scopes), validated.resource, task.id, task.latest_version_id, redirectUri, validated.state, validated.codeChallenge, now.toISOString(), addMinutes(now, REQUEST_MINUTES).toISOString()],
      );
      await audit(ctx, { actorId: user.id, action: 'oauth.request_created', subjectType: 'oauth_request', subjectId: id, subjectCode: issued, workspaceId, detail: { client: client.client_id, scopes: validated.scopes, resource: validated.resource } });
      return issued;
    });
    return c.json<OAuthRequestCreated>({ code, created: true }, 201);
  });

  app.get('/api/oauth/requests/:code', async (c) => {
    const user = requireVerified(c);
    const row = await loadOwnRequest(c, user);
    return c.json(await buildView(c.get('ctx'), row));
  });

  app.post('/api/oauth/requests/:code/approve', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const row = await loadOwnRequest(c, user);
    if (row.status === 'expired') {
      await audit(ctx, { actorId: user.id, action: 'oauth.approval_refused', subjectType: 'oauth_request', subjectId: row.id, subjectCode: row.code, workspaceId: row.workspace_id, detail: { reason: 'expired' } });
      throw conflict('A fresh authorization is required', 'request_expired');
    }
    if (row.status !== 'pending') throw conflict('This request has already been decided.', 'already_decided');
    const task = (await ctx.db.get<AdvisorTaskRow>('SELECT * FROM tasks WHERE id = ?', [row.task_id])) as AdvisorTaskRow;
    const verdict = await canReadTask(ctx, user, task);
    if (!verdict.allowed) throw forbidden(verdict.reason);

    const now = ctx.now().toISOString();
    const code = await ctx.db.tx(async () => {
      const { changes } = await ctx.db.run(`UPDATE oauth_requests SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending'`, [now, row.id]);
      if (!changes) throw conflict('This request has already been decided.', 'already_decided');
      const issued = await issueAuthorizationCode(ctx, row.id);
      await audit(ctx, { actorId: user.id, action: 'oauth.request_approved', subjectType: 'oauth_request', subjectId: row.id, subjectCode: row.code, workspaceId: row.workspace_id, detail: { scopes: parseScopes(row.scopes), resource: row.resource } });
      return issued.code;
    });
    const fresh = (await ctx.db.get<RequestRow>('SELECT * FROM oauth_requests WHERE id = ?', [row.id])) as RequestRow;
    return c.json({ request: await buildView(ctx, fresh), redirectTo: authorizationRedirect(row.redirect_uri, { code, state: row.state }) });
  });

  app.post('/api/oauth/requests/:code/deny', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const row = await loadOwnRequest(c, user);
    if (row.status === 'expired') throw conflict('A fresh authorization is required', 'request_expired');
    if (row.status !== 'pending') throw conflict('This request has already been decided.', 'already_decided');
    const now = ctx.now().toISOString();
    await ctx.db.tx(async () => {
      const { changes } = await ctx.db.run(`UPDATE oauth_requests SET status = 'denied', decided_at = ? WHERE id = ? AND status = 'pending'`, [now, row.id]);
      if (!changes) throw conflict('This request has already been decided.', 'already_decided');
      await audit(ctx, { actorId: user.id, action: 'oauth.request_denied', subjectType: 'oauth_request', subjectId: row.id, subjectCode: row.code, workspaceId: row.workspace_id, detail: { scopes: parseScopes(row.scopes), resource: row.resource } });
    });
    const fresh = (await ctx.db.get<RequestRow>('SELECT * FROM oauth_requests WHERE id = ?', [row.id])) as RequestRow;
    const view = await buildView(ctx, fresh);
    return c.json({ request: view, redirectTo: view.returnUrl });
  });

  /** "Return to Atlas" from an approved receipt: only the hash of a code is stored, so a fresh one is minted here. */
  app.post('/api/oauth/requests/:code/return', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const row = await loadOwnRequest(c, user);
    if (row.status !== 'approved') throw conflict('Only an approved request can send a code to the client.', 'not_approved');
    const view = await buildView(ctx, row);
    if (!view.canReturn.allowed) throw conflict(view.canReturn.reason, 'cannot_return');
    const code = await ctx.db.tx(async () => {
      const issued = await issueAuthorizationCode(ctx, row.id);
      await audit(ctx, { actorId: user.id, action: 'oauth.code_issued', subjectType: 'oauth_request', subjectId: row.id, subjectCode: row.code, workspaceId: row.workspace_id });
      return issued.code;
    });
    return c.json({ redirectTo: authorizationRedirect(row.redirect_uri, { code, state: row.state }) });
  });

  /* ---------- Token endpoint: form encoded, outside /api, so no CSRF header ---------- */

  app.post(
    '/oauth/token',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => tokenError(c, 400, { error: 'invalid_request', error_description: 'This request is too large.' }),
    }),
    async (c) => {
      const ctx = c.get('ctx');
      if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
        return tokenError(c, 400, { error: 'invalid_request', error_description: 'Send the token request as application/x-www-form-urlencoded.' });
      }
      const form = await c.req.parseBody();
      const field = (name: string) => {
        const value = form[name];
        return typeof value === 'string' && value ? value : undefined;
      };
      const grantType = field('grant_type');
      if (!grantType) return tokenError(c, 400, { error: 'invalid_request', error_description: 'grant_type is required.' });
      if (grantType !== 'authorization_code') return tokenError(c, 400, { error: 'unsupported_grant_type', error_description: 'Rivet only supports grant_type=authorization_code. There are no refresh tokens.' });

      const clientId = field('client_id');
      if (!clientId) return tokenError(c, 400, { error: 'invalid_request', error_description: 'client_id is required.' });
      const client = await ctx.db.get<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?', [clientId]);
      if (!client) return tokenError(c, 401, { error: 'invalid_client', error_description: 'This client is not registered with Rivet.' });

      const code = field('code');
      const redirectUri = field('redirect_uri');
      const codeVerifier = field('code_verifier');
      if (!code) return tokenError(c, 400, { error: 'invalid_request', error_description: 'code is required.' });
      if (!redirectUri) return tokenError(c, 400, { error: 'invalid_request', error_description: 'redirect_uri is required.' });
      if (!codeVerifier) return tokenError(c, 400, { error: 'invalid_request', error_description: 'code_verifier is required.' });

      const result = await exchangeAuthorizationCode(ctx, { clientRowId: client.id, code, redirectUri, codeVerifier });
      if (!result.ok) return tokenError(c, 400, { error: result.error, error_description: result.description });
      const body: OAuthTokenResponse = { access_token: result.accessToken, token_type: 'Bearer', expires_in: TOKEN_SECONDS, scope: result.scopes.join(' '), resource: result.resource };
      return c.json(body, 200, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    },
  );

  /* ---------- Revocation: cookie authenticated. The Profile page calls this. ---------- */

  app.post('/api/oauth/connections/:id/revoke', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const token = await ctx.db.get<TokenRow>('SELECT * FROM oauth_tokens WHERE id = ?', [c.req.param('id')]);
    if (!token || token.user_id !== user.id) throw notFound();
    if (token.revoked_at) return c.json({ id: token.id, revokedAt: token.revoked_at });
    const now = ctx.now().toISOString();
    const request = await ctx.db.get<RequestRow>('SELECT * FROM oauth_requests WHERE id = ?', [token.request_id]);
    await ctx.db.tx(async () => {
      await ctx.db.run(`UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [now, token.id]);
      await audit(ctx, { actorId: user.id, action: 'oauth.token_revoked', subjectType: 'oauth_token', subjectId: token.id, subjectCode: request?.code ?? null, workspaceId: request?.workspace_id ?? null });
    });
    return c.json({ id: token.id, revokedAt: now });
  });

  /* ---------- Bearer API: scope, expiry, revocation, boundary and current permission, on every request ---------- */

  app.get('/api/external/tasks/:code', async (c) => {
    const ctx = c.get('ctx');
    const bearer = await requireBearer(c, 'tasks:read');
    const code = c.req.param('code').toUpperCase();
    if (code !== bearer.task.code) throw await refuseOutOfBoundary(c, bearer, `task:${code}`);
    await requireCurrentPermission(c, bearer);

    const version = bearer.version as AdvisorVersionRow & { prompt: string; rubric: string; frozen_at: string };
    const domain = await ctx.db.get<{ name: string }>('SELECT name FROM domains WHERE id = ?', [bearer.task.domain_id]);
    const models = JSON.parse(version.models) as { displayName: string; revision: string }[];
    let sourcePack: ExternalTask['sourcePack'] = null;
    if (version.dataset_version_id) {
      const pack = await ctx.db.get<{ code: string; version: string; sha256: string; workspace_id: string; visibility: string; deleted_at: string | null }>(
        `SELECT d.code, dv.version, dv.sha256, d.workspace_id, d.visibility, d.deleted_at FROM dataset_versions dv JOIN datasets d ON d.id = dv.dataset_id WHERE dv.id = ?`,
        [version.dataset_version_id],
      );
      if (pack && (await canReadDataset(ctx, bearer.user, pack)).allowed) sourcePack = { code: pack.code, version: pack.version, sha256: pack.sha256 };
    }
    const report = parseScopes(bearer.token.scopes).includes('reports:read')
      ? await ctx.db.get<{ code: string; version: string }>('SELECT code, version FROM reports WHERE task_version_id = ? ORDER BY frozen_at DESC LIMIT 1', [version.id])
      : undefined;
    await recordRead(c, bearer, c.req.path);
    const body: ExternalTask = {
      code: bearer.task.code,
      version: version.version,
      title: version.title,
      prompt: version.prompt,
      rubric: JSON.parse(version.rubric),
      models: models.map((model) => ({ displayName: model.displayName, revision: model.revision })),
      domain: domain?.name ?? bearer.task.domain_id,
      sourcePack,
      sha256: version.sha256,
      frozenAt: version.frozen_at,
      report: report ? { code: report.code, version: report.version } : null,
      synthetic: Boolean(bearer.task.is_synthetic),
    };
    return c.json(body);
  });

  app.get('/api/external/reports/:code/:version', async (c) => {
    const ctx = c.get('ctx');
    const bearer = await requireBearer(c, 'reports:read');
    const code = c.req.param('code').toUpperCase();
    const reportVersion = c.req.param('version').replace(/^v/i, '');
    const row = await ctx.db.get<any>('SELECT * FROM reports WHERE code = ? AND version = ? AND task_version_id = ?', [code, reportVersion, bearer.token.task_version_id]);
    if (!row) {
      if (code === `RPT-${bearer.task.code}`) throw notFound('No report has been frozen for this version yet.');
      throw await refuseOutOfBoundary(c, bearer, `report:${code}`);
    }
    await requireCurrentPermission(c, bearer);

    const run = await ctx.db.get<{ code: string }>('SELECT code FROM runs WHERE id = ?', [row.run_id]);
    const review = await ctx.db.get<{ code: string }>('SELECT code FROM reviews WHERE id = ?', [row.review_id]);
    const evidenceRows = await ctx.db.all<any>('SELECT * FROM evidence WHERE run_id = ? ORDER BY captured_at, code', [row.run_id]);
    const evidence: ExternalReport['evidence'] = [];
    for (const item of evidenceRows) {
      evidence.push({ code: item.code, modelRevision: item.model_revision, totalScore: item.total_score, scoreLabel: item.score_label, sha256: item.sha256, capturedAt: item.captured_at, verified: await verifyEvidenceRow(ctx.db, item) });
    }
    await recordRead(c, bearer, c.req.path);
    const body: ExternalReport = {
      code: row.code,
      version: row.version,
      task: { code: bearer.task.code, version: bearer.version.version },
      headline: row.headline,
      summary: row.summary,
      limitations: row.limitations,
      scores: JSON.parse(row.scores),
      citation: row.citation,
      sha256: row.sha256,
      frozenAt: row.frozen_at,
      run: run?.code ?? '',
      review: review?.code ?? '',
      evidence,
      synthetic: Boolean(row.is_synthetic),
    };
    return c.json(body);
  });

  app.post('/api/external/advisor/query', async (c) => {
    const ctx = c.get('ctx');
    const bearer = await requireBearer(c, 'advisor:query');
    const input = await readJson(c, z.object({ question: trimmed('Enter a question to ask Audit Advisor.', 2000) }));
    await requireCurrentPermission(c, bearer);
    await rateLimit(ctx, `external-advisor:${bearer.token.id}`, 30, 60, 'Too many questions in a minute. Wait a moment and try again.');
    const outcome = await answerQuestion(ctx, bearer.user, bearer.task, bearer.version, input.question);
    await audit(ctx, {
      actorId: bearer.user.id,
      action: 'oauth.api_advisor_query',
      subjectType: 'oauth_token',
      subjectId: bearer.token.id,
      subjectCode: bearer.request.code,
      workspaceId: bearer.request.workspace_id,
      detail: { task: boundaryLabel(bearer), mode: outcome.mode, insufficient: outcome.insufficient, citations: outcome.citations.map((citation) => citation.label) },
    });
    const body: ExternalAdvisorAnswer = {
      task: boundaryLabel(bearer),
      answer: outcome.content,
      insufficient: outcome.insufficient,
      mode: outcome.mode,
      citations: outcome.citations.map((citation) => ({ ...citation, url: `${ctx.config.publicUrl}${citation.to}` })),
    };
    return c.json(body);
  });
}
