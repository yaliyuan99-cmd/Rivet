import type { OAuthCredentials } from '../config.ts';
import type { AppContext } from '../context.ts';

/**
 * Config-driven OAuth 2 for identity only: Rivet reads who someone is, then throws the access token
 * away. Nothing here grants private-content access or reviewer credentials.
 *
 * Credentials come from ctx.config. Each provider's hosts can be replaced with
 * RIVET_OAUTH_<PROVIDER>_BASE_URL, so a test or a local run can point the whole flow at a mock.
 */

export type ProviderId = 'github' | 'linkedin' | 'huggingface';
/** signin creates or opens an account; connect adds an identity to the signed-in account. */
export type OAuthFlow = 'signin' | 'connect';

export interface ProviderIdentity {
  providerUserId: string;
  /** @login, or the display name where a provider exposes no handle. */
  handle: string;
  profileUrl: string | null;
  name: string | null;
  /** Only ever the primary address the provider itself marks verified. Read for sign-in only. */
  verifiedEmail: string | null;
}

/** The provider refused, or could not be reached. The message is for logs; pages show their own copy. */
export class OAuthFailure extends Error {}

type GetJson = <T>(path: string) => Promise<T>;

interface ProviderSpec {
  label: string;
  /** Shown beside a connected profile. */
  visibilityNote: string;
  webBase: string;
  apiBase: string;
  authorizePath: string;
  tokenPath: string;
  scopes: Record<OAuthFlow, string>;
  /** How this provider expects the client secret on the token request. */
  clientAuth: 'body' | 'basic';
  callbackPath: string;
  identity: (get: GetJson, flow: OAuthFlow, webBase: string) => Promise<ProviderIdentity>;
}

/** Links are rendered from these, so a provider can only ever hand back http(s). */
function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const clean = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null);

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  github: {
    label: 'GitHub',
    visibilityNote: 'Public identity',
    webBase: 'https://github.com',
    apiBase: 'https://api.github.com',
    authorizePath: '/login/oauth/authorize',
    tokenPath: '/login/oauth/access_token',
    scopes: { signin: 'read:user user:email', connect: 'read:user' },
    clientAuth: 'body',
    // A GitHub OAuth app registers a single callback, so both flows share the sign-in route.
    callbackPath: '/api/auth/github/callback',
    identity: async (get, flow) => {
      const user = await get<{ id?: number | string; login?: string; html_url?: string; name?: string | null }>('/user');
      const login = clean(user?.login);
      if (user?.id === undefined || user.id === null || !login) throw new OAuthFailure('GitHub returned no profile.');
      let verifiedEmail: string | null = null;
      if (flow === 'signin') {
        // A refused emails call means the address cannot be proven, not that sign-in may go ahead.
        const emails = await get<{ email?: string; primary?: boolean; verified?: boolean }[]>('/user/emails').catch(() => null);
        const primary = Array.isArray(emails) ? emails.find((entry) => entry.primary === true) : undefined;
        verifiedEmail = primary?.verified === true ? (clean(primary.email)?.toLowerCase() ?? null) : null;
      }
      return { providerUserId: String(user.id), handle: `@${login}`, profileUrl: safeUrl(user.html_url), name: clean(user.name), verifiedEmail };
    },
  },
  linkedin: {
    label: 'LinkedIn',
    visibilityNote: 'Public identity',
    webBase: 'https://www.linkedin.com',
    apiBase: 'https://api.linkedin.com',
    authorizePath: '/oauth/v2/authorization',
    tokenPath: '/oauth/v2/accessToken',
    scopes: { signin: 'openid profile', connect: 'openid profile' },
    clientAuth: 'body',
    callbackPath: '/api/profile/connections/linkedin/callback',
    identity: async (get) => {
      // LinkedIn's OpenID profile has no public handle or vanity URL, so the name stands in.
      const info = await get<{ sub?: string; name?: string; given_name?: string; family_name?: string }>('/v2/userinfo');
      const name = clean(info?.name) ?? clean([info?.given_name, info?.family_name].filter(Boolean).join(' '));
      if (!clean(info?.sub) || !name) throw new OAuthFailure('LinkedIn returned no profile.');
      return { providerUserId: String(info.sub), handle: name, profileUrl: null, name, verifiedEmail: null };
    },
  },
  huggingface: {
    label: 'Hugging Face',
    visibilityNote: 'Public profile only',
    webBase: 'https://huggingface.co',
    apiBase: 'https://huggingface.co',
    authorizePath: '/oauth/authorize',
    tokenPath: '/oauth/token',
    scopes: { signin: 'openid profile', connect: 'openid profile' },
    clientAuth: 'basic',
    callbackPath: '/api/profile/connections/huggingface/callback',
    identity: async (get, _flow, webBase) => {
      const info = await get<{ sub?: string; preferred_username?: string; name?: string; profile?: string }>('/oauth/userinfo');
      const username = clean(info?.preferred_username);
      if (!clean(info?.sub) || !username) throw new OAuthFailure('Hugging Face returned no profile.');
      return { providerUserId: String(info.sub), handle: `@${username}`, profileUrl: safeUrl(info.profile) ?? `${webBase}/${encodeURIComponent(username)}`, name: clean(info.name), verifiedEmail: null };
    },
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as string[]).includes(value);
}

export function providerCredentials(ctx: AppContext, id: ProviderId): OAuthCredentials | null {
  return ctx.config[id];
}

function bases(id: ProviderId): { web: string; api: string } {
  const override = process.env[`RIVET_OAUTH_${id.toUpperCase()}_BASE_URL`]?.replace(/\/$/, '');
  return { web: override || PROVIDERS[id].webBase, api: override || PROVIDERS[id].apiBase };
}

export function callbackUrl(ctx: AppContext, id: ProviderId): string {
  return `${ctx.config.publicUrl}${PROVIDERS[id].callbackPath}`;
}

function requireCredentials(ctx: AppContext, id: ProviderId): OAuthCredentials {
  const credentials = providerCredentials(ctx, id);
  if (!credentials) throw new OAuthFailure(`${PROVIDERS[id].label} is not configured.`);
  return credentials;
}

export function authorizationUrl(ctx: AppContext, id: ProviderId, flow: OAuthFlow, state: string): string {
  const spec = PROVIDERS[id];
  const url = new URL(`${bases(id).web}${spec.authorizePath}`);
  url.searchParams.set('client_id', requireCredentials(ctx, id).clientId);
  url.searchParams.set('redirect_uri', callbackUrl(ctx, id));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', spec.scopes[flow]);
  url.searchParams.set('state', state);
  return url.toString();
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new OAuthFailure(`Could not reach ${new URL(url).host}: ${error instanceof Error ? error.message : 'network error'}`);
  }
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new OAuthFailure(`${what} failed with HTTP ${res.status}.`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new OAuthFailure(`${what} returned something that is not JSON.`);
  }
}

/** Swaps the one-time code for an access token. Never call this inside a database transaction. */
export async function exchangeCode(ctx: AppContext, id: ProviderId, code: string): Promise<string> {
  const spec = PROVIDERS[id];
  const { clientId, clientSecret } = requireCredentials(ctx, id);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl(ctx, id), client_id: clientId });
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Rivet' };
  if (spec.clientAuth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  else body.set('client_secret', clientSecret);
  const res = await request(`${bases(id).web}${spec.tokenPath}`, { method: 'POST', headers, body });
  const result = await readJson<{ access_token?: unknown; error?: unknown }>(res, `${spec.label} code exchange`);
  if (typeof result.access_token !== 'string' || !result.access_token) throw new OAuthFailure(`${spec.label} refused the code${typeof result.error === 'string' ? `: ${result.error}` : ''}.`);
  return result.access_token;
}

export async function fetchIdentity(id: ProviderId, flow: OAuthFlow, accessToken: string): Promise<ProviderIdentity> {
  const spec = PROVIDERS[id];
  const { api, web } = bases(id);
  const get: GetJson = async <T>(path: string) => {
    const res = await request(`${api}${path}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Rivet' } });
    return readJson<T>(res, `${spec.label} ${path}`);
  };
  return spec.identity(get, flow, web);
}
