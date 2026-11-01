import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../server/lib/ids.ts';
import { Client, makeTestApp, makeUser, makeWorkspace, TEST_PASSWORD, type TestApp } from '../helpers/app.ts';

/** A stand-in for GitHub, LinkedIn and Hugging Face, reached over real HTTP. */
const mock = {
  server: null as Server | null,
  url: '',
  requests: [] as { method: string; path: string; body: string; authorization: string }[],
  github: { id: 4242 as number | undefined, login: 'ada-lane', name: 'Ada Lane' as string | null, html_url: 'https://github.com/ada-lane' },
  emails: [{ email: 'ada@lab.example', primary: true, verified: true }] as { email: string; primary: boolean; verified: boolean }[],
  emailsStatus: 200,
  linkedin: { sub: 'li-777', name: 'Ada Lane' },
  huggingface: { sub: 'hf-888', preferred_username: 'ada-hf', name: 'Ada Lane' },
  tokenBroken: false,
  reset() {
    this.requests.length = 0;
    this.github = { id: 4242, login: 'ada-lane', name: 'Ada Lane', html_url: 'https://github.com/ada-lane' };
    this.emails = [{ email: 'ada@lab.example', primary: true, verified: true }];
    this.emailsStatus = 200;
    this.linkedin = { sub: 'li-777', name: 'Ada Lane' };
    this.huggingface = { sub: 'hf-888', preferred_username: 'ada-hf', name: 'Ada Lane' };
    this.tokenBroken = false;
  },
};

const GOOD_CODE = 'one-time-code';
const SECRETS = { github: 'gh-secret', linkedin: 'li-secret', huggingface: 'hf-secret' };

beforeAll(async () => {
  mock.server = createServer(async (req, res) => {
    const url = new URL(req.url as string, 'http://mock');
    let body = '';
    for await (const chunk of req) body += chunk;
    const authorization = req.headers.authorization ?? '';
    mock.requests.push({ method: req.method as string, path: url.pathname, body, authorization });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const form = new URLSearchParams(body);
    const grant = (ok: boolean) => (mock.tokenBroken ? json(500, { error: 'server_error' }) : ok && form.get('code') === GOOD_CODE ? json(200, { access_token: 'mock-token', token_type: 'bearer' }) : json(200, { error: 'bad_verification_code' }));
    if (url.pathname === '/login/oauth/access_token') return grant(form.get('client_secret') === SECRETS.github);
    if (url.pathname === '/oauth/v2/accessToken') return grant(form.get('client_secret') === SECRETS.linkedin && form.get('grant_type') === 'authorization_code');
    if (url.pathname === '/oauth/token') return grant(authorization === `Basic ${Buffer.from(`hf-id:${SECRETS.huggingface}`).toString('base64')}`);
    if (authorization !== 'Bearer mock-token') return json(401, { message: 'Bad credentials' });
    if (url.pathname === '/user') return json(200, mock.github);
    if (url.pathname === '/user/emails') return json(mock.emailsStatus, mock.emails);
    if (url.pathname === '/v2/userinfo') return json(200, mock.linkedin);
    if (url.pathname === '/oauth/userinfo') return json(200, mock.huggingface);
    return json(404, {});
  });
  await new Promise<void>((resolve) => (mock.server as Server).listen(0, '127.0.0.1', resolve));
  mock.url = `http://127.0.0.1:${((mock.server as Server).address() as AddressInfo).port}`;
  process.env.RIVET_OAUTH_GITHUB_BASE_URL = mock.url;
  process.env.RIVET_OAUTH_LINKEDIN_BASE_URL = mock.url;
  process.env.RIVET_OAUTH_HUGGINGFACE_BASE_URL = mock.url;
});

afterAll(async () => {
  delete process.env.RIVET_OAUTH_GITHUB_BASE_URL;
  delete process.env.RIVET_OAUTH_LINKEDIN_BASE_URL;
  delete process.env.RIVET_OAUTH_HUGGINGFACE_BASE_URL;
  await new Promise((resolve) => (mock.server as Server).close(resolve));
});

const configured = { github: { clientId: 'gh-id', clientSecret: SECRETS.github }, linkedin: { clientId: 'li-id', clientSecret: SECRETS.linkedin }, huggingface: { clientId: 'hf-id', clientSecret: SECRETS.huggingface } };

let test: TestApp;

beforeEach(async () => {
  mock.reset();
  test = await makeTestApp({ config: configured });
});
afterEach(() => test.close());

const location = (res: Response) => res.headers.get('location') as string;

async function startSignIn(client: Client, query = '') {
  const res = await client.get(`/api/auth/github/start${query}`);
  expect(res.status).toBe(302);
  return new URL(location(res)).searchParams.get('state') as string;
}

/** Runs the whole sign-in as a browser would. */
async function signInWithGithub(client: Client, query = '') {
  const state = await startSignIn(client, query);
  return client.get(`/api/auth/github/callback?code=${GOOD_CODE}&state=${state}`);
}

const sessionUser = async (client: Client) => (await (await client.get('/api/session')).json()).user;
const countUsers = async () => (await test.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users'))?.n;

describe('GitHub sign-in: start', () => {
  it('sends the browser to the provider with a state and an HttpOnly state cookie', async () => {
    const res = await new Client(test).get('/api/auth/github/start');
    expect(res.status).toBe(302);
    const url = new URL(location(res));
    expect(url.origin + url.pathname).toBe(`${mock.url}/login/oauth/authorize`);
    expect(url.searchParams.get('client_id')).toBe('gh-id');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/auth/github/callback');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    const state = url.searchParams.get('state') as string;
    expect(state.length).toBeGreaterThan(30);
    const cookie = res.headers.getSetCookie().find((value) => value.startsWith('rivet_oauth=')) as string;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api/);
    expect(cookie).not.toContain(state);
    expect(url.toString()).not.toContain(SECRETS.github);
  });

  it('refuses plainly when GitHub is not configured', async () => {
    const bare = await makeTestApp();
    const res = await new Client(bare).get('/api/auth/github/start');
    expect(res.status).toBe(302);
    expect(location(res)).toBe('/auth/github/failed?reason=not_configured');
    expect(res.headers.getSetCookie()).toEqual([]);
    const session = await (await new Client(bare).get('/api/session')).json();
    expect(session.features.github).toBe(false);
    bare.close();
  });
});

describe('GitHub sign-in: accounts', () => {
  it('creates a verified account from a verified primary email and signs in', async () => {
    const client = new Client(test);
    const res = await signInWithGithub(client);
    expect(res.status).toBe(302);
    expect(location(res)).toBe('/');

    const user = await sessionUser(client);
    expect(user).toMatchObject({ email: 'ada@lab.example', name: 'Ada Lane', emailVerified: true, role: 'member', workspace: null });

    const row = await test.ctx.db.get<{ password_hash: string | null; terms_accepted_at: string | null; email_verified_at: string | null }>('SELECT password_hash, terms_accepted_at, email_verified_at FROM users WHERE email = ?', ['ada@lab.example']);
    expect(row?.password_hash).toBeNull();
    expect(row?.terms_accepted_at).toBeNull();
    expect(row?.email_verified_at).toBeTruthy();

    const profile = await (await client.get('/api/profile')).json();
    expect(profile.connections[0]).toMatchObject({ provider: 'github', connected: true, handle: '@ada-lane', profileUrl: 'https://github.com/ada-lane', visibilityNote: 'Public identity', isSynthetic: false });
    expect(await test.ctx.db.get(`SELECT detail FROM audit_log WHERE action = 'account.created'`)).toEqual({ detail: JSON.stringify({ via: 'github' }) });
    // The provider token is used and dropped: nothing about it is stored anywhere.
    const stored = JSON.stringify(await test.ctx.db.all('SELECT * FROM connected_accounts'));
    expect(stored).not.toContain('mock-token');
  });

  it('falls back to the login when GitHub has no display name', async () => {
    mock.github.name = null;
    const client = new Client(test);
    await signInWithGithub(client);
    expect((await sessionUser(client)).name).toBe('ada-lane');
  });

  it('links to an existing verified account with that email, keeping its password', async () => {
    const id = await makeUser(test, { email: 'ada@lab.example', name: 'Ada From Before' });
    const client = new Client(test);
    await signInWithGithub(client);
    const user = await sessionUser(client);
    expect(user.id).toBe(id);
    expect(user.name).toBe('Ada From Before');
    expect(await countUsers()).toBe(1);
    expect((await new Client(test).post('/api/auth/signin', { email: 'ada@lab.example', password: TEST_PASSWORD })).status).toBe(200);
    expect((await (await client.get('/api/profile')).json()).connections[0].handle).toBe('@ada-lane');
  });

  it('takes over an unverified registration of that address without leaving its password or sessions working', async () => {
    const id = await makeUser(test, { email: 'ada@lab.example', name: 'Squatter', verified: false });
    const squatter = await new Client(test).signIn('ada@lab.example');
    const client = new Client(test);
    await signInWithGithub(client);

    const user = await sessionUser(client);
    expect(user.id).toBe(id);
    expect(user.emailVerified).toBe(true);
    expect(await sessionUser(squatter)).toBeNull();
    expect((await new Client(test).post('/api/auth/signin', { email: 'ada@lab.example', password: TEST_PASSWORD })).status).toBe(401);
  });

  it('signs a linked GitHub account back in even after its email changes', async () => {
    const client = new Client(test);
    await signInWithGithub(client);
    const { id } = await sessionUser(client);
    mock.emails = [{ email: 'ada-new@lab.example', primary: true, verified: true }];
    const again = new Client(test);
    await signInWithGithub(again);
    expect((await sessionUser(again)).id).toBe(id);
    expect(await countUsers()).toBe(1);
  });

  it('does not overwrite a different GitHub identity already on the account', async () => {
    const id = await makeUser(test, { email: 'ada@lab.example' });
    await test.ctx.db.run(`INSERT INTO connected_accounts (id, user_id, provider, provider_user_id, handle, connected_at) VALUES (?, ?, 'github', 'someone-else', '@someone-else', ?)`, [newId(), id, test.ctx.now().toISOString()]);
    const client = new Client(test);
    await signInWithGithub(client);
    expect((await sessionUser(client)).id).toBe(id);
    expect((await (await client.get('/api/profile')).json()).connections[0].handle).toBe('@someone-else');
  });

  it('honours a same-site next path and ignores anything else', async () => {
    const res = await signInWithGithub(new Client(test), `?next=${encodeURIComponent('/invitations/abc')}`);
    expect(location(res)).toBe('/invitations/abc');
    for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example', '/ok\r\nSet-Cookie: x=y', 'relative/path']) {
      expect(location(await signInWithGithub(new Client(test), `?next=${encodeURIComponent(evil)}`))).toBe('/');
    }
  });

  it('replaces a session the browser already held', async () => {
    await makeUser(test, { email: 'bo@lab.example' });
    const client = await new Client(test).signIn('bo@lab.example');
    await signInWithGithub(client);
    expect((await sessionUser(client)).email).toBe('ada@lab.example');
    expect((await test.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions'))?.n).toBe(1);
  });
});

describe('GitHub sign-in: refusals', () => {
  const failed = (res: Response, reason: string) => {
    expect(res.status).toBe(302);
    expect(location(res)).toBe(`/auth/github/failed?reason=${reason}`);
  };

  it('refuses a primary address GitHub has not verified, and never uses another address instead', async () => {
    mock.emails = [
      { email: 'ada@lab.example', primary: true, verified: false },
      { email: 'other@lab.example', primary: false, verified: true },
    ];
    const client = new Client(test);
    failed(await signInWithGithub(client), 'email');
    expect(await sessionUser(client)).toBeNull();
    expect(await countUsers()).toBe(0);
  });

  it('refuses when there is no primary address or the address list is refused', async () => {
    mock.emails = [{ email: 'other@lab.example', primary: false, verified: true }];
    failed(await signInWithGithub(new Client(test)), 'email');
    mock.emails = [{ email: 'ada@lab.example', primary: true, verified: true }];
    mock.emailsStatus = 403;
    failed(await signInWithGithub(new Client(test)), 'email');
    expect(await countUsers()).toBe(0);
  });

  it('does not let an unverified address reach an existing account', async () => {
    const id = await makeUser(test, { email: 'ada@lab.example' });
    mock.emails = [{ email: 'ada@lab.example', primary: true, verified: false }];
    const client = new Client(test);
    failed(await signInWithGithub(client), 'email');
    expect(await sessionUser(client)).toBeNull();
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM connected_accounts WHERE user_id = ?', [id])).toBeUndefined();
  });

  it('refuses a wrong or missing state and never contacts the provider', async () => {
    const client = new Client(test);
    await startSignIn(client);
    mock.requests.length = 0;
    failed(await client.get(`/api/auth/github/callback?code=${GOOD_CODE}&state=tampered`), 'state');

    const other = new Client(test);
    await startSignIn(other);
    failed(await other.get(`/api/auth/github/callback?code=${GOOD_CODE}`), 'state');

    const stranger = new Client(test);
    failed(await stranger.get(`/api/auth/github/callback?code=${GOOD_CODE}&state=anything`), 'state');

    expect(mock.requests).toEqual([]);
    expect(await countUsers()).toBe(0);
  });

  it('refuses a callback carrying a state from another browser', async () => {
    const state = await startSignIn(new Client(test));
    const stranger = new Client(test);
    failed(await stranger.get(`/api/auth/github/callback?code=${GOOD_CODE}&state=${state}`), 'state');
    expect(await sessionUser(stranger)).toBeNull();
  });

  it('spends the state: the same callback cannot be replayed', async () => {
    const client = new Client(test);
    const state = await startSignIn(client);
    expect(location(await client.get(`/api/auth/github/callback?code=${GOOD_CODE}&state=${state}`))).toBe('/');
    await client.post('/api/auth/signout');
    failed(await client.get(`/api/auth/github/callback?code=${GOOD_CODE}&state=${state}`), 'state');
    expect(await sessionUser(client)).toBeNull();
  });

  it('rate limits starting a sign-in, and says so', async () => {
    const client = new Client(test);
    for (let i = 0; i < 60; i++) expect((await client.get('/api/auth/github/start')).status).toBe(302);
    failed(await client.get('/api/auth/github/start'), 'rate_limited');
  });

  it('reports a person declining at the provider', async () => {
    const client = new Client(test);
    const state = await startSignIn(client);
    failed(await client.get(`/api/auth/github/callback?error=access_denied&state=${state}`), 'denied');
    expect(await sessionUser(client)).toBeNull();
  });

  it('reports a bad code, a broken provider and an unreachable provider without signing anyone in', async () => {
    const client = new Client(test);
    let state = await startSignIn(client);
    failed(await client.get(`/api/auth/github/callback?code=wrong&state=${state}`), 'unavailable');

    mock.tokenBroken = true;
    state = await startSignIn(client);
    failed(await client.get(`/api/auth/github/callback?code=${GOOD_CODE}&state=${state}`), 'unavailable');
    mock.tokenBroken = false;

    mock.github.id = undefined;
    state = await startSignIn(client);
    failed(await client.get(`/api/auth/github/callback?code=${GOOD_CODE}&state=${state}`), 'unavailable');
    mock.github.id = 4242;

    process.env.RIVET_OAUTH_GITHUB_BASE_URL = 'http://127.0.0.1:9';
    state = await startSignIn(client);
    failed(await client.get(`/api/auth/github/callback?code=${GOOD_CODE}&state=${state}`), 'unavailable');
    process.env.RIVET_OAUTH_GITHUB_BASE_URL = mock.url;

    expect(await sessionUser(client)).toBeNull();
    expect(await countUsers()).toBe(0);
  });
});

describe('connected profiles', () => {
  async function user(email = 'ada@lab.example') {
    const id = await makeUser(test, { email, name: 'Ada Lane' });
    return { id, client: await new Client(test).signIn(email) };
  }

  async function startConnect(client: Client, provider: string) {
    const res = await client.get(`/api/profile/connections/${provider}/start`);
    expect(res.status).toBe(302);
    return new URL(location(res));
  }

  const connectionOf = async (client: Client, provider: string) => (await (await client.get('/api/profile')).json()).connections.find((row: { provider: string }) => row.provider === provider);

  it('offers Connect only when the provider is configured', async () => {
    const { client } = await user();
    expect(await connectionOf(client, 'linkedin')).toMatchObject({ connect: { allowed: true }, connectHref: '/api/profile/connections/linkedin/start' });

    const bare = await makeTestApp();
    await makeUser(bare, { email: 'ada@lab.example' });
    const bareClient = await new Client(bare).signIn('ada@lab.example');
    const row = (await (await bareClient.get('/api/profile')).json()).connections;
    for (const [index, label] of ['GitHub', 'LinkedIn', 'Hugging Face'].entries()) {
      expect(row[index]).toMatchObject({ connected: false, connectHref: null, connect: { allowed: false, reason: `${label} connection is not configured on this server` } });
    }
    const res = await bareClient.get('/api/profile/connections/linkedin/start');
    expect(res.status).toBe(302);
    expect(location(res)).toBe('/profile?connection_error=not_configured&provider=linkedin');
    expect(await bare.ctx.db.get('SELECT 1 AS ok FROM connected_accounts')).toBeUndefined();
    bare.close();
  });

  it('connects LinkedIn through a body-authenticated code exchange', async () => {
    const { client } = await user();
    const url = await startConnect(client, 'linkedin');
    expect(url.origin + url.pathname).toBe(`${mock.url}/oauth/v2/authorization`);
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/profile/connections/linkedin/callback');
    const res = await client.get(`/api/profile/connections/linkedin/callback?code=${GOOD_CODE}&state=${url.searchParams.get('state')}`);
    expect(location(res)).toBe('/profile?connected=linkedin');
    expect(await connectionOf(client, 'linkedin')).toMatchObject({ connected: true, handle: 'Ada Lane', profileUrl: null, visibilityNote: 'Public identity' });
  });

  it('connects Hugging Face through a basic-authenticated code exchange', async () => {
    const { client } = await user();
    const url = await startConnect(client, 'huggingface');
    expect(url.pathname).toBe('/oauth/authorize');
    const res = await client.get(`/api/profile/connections/huggingface/callback?code=${GOOD_CODE}&state=${url.searchParams.get('state')}`);
    expect(location(res)).toBe('/profile?connected=huggingface');
    expect(await connectionOf(client, 'huggingface')).toMatchObject({ connected: true, handle: '@ada-hf', profileUrl: `${mock.url}/ada-hf`, visibilityNote: 'Public profile only' });
  });

  it('connects GitHub through the one callback GitHub allows, without asking for email access', async () => {
    const { client } = await user();
    const url = await startConnect(client, 'github');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/api/auth/github/callback');
    expect(url.searchParams.get('scope')).toBe('read:user');
    const res = await client.get(`/api/auth/github/callback?code=${GOOD_CODE}&state=${url.searchParams.get('state')}`);
    expect(location(res)).toBe('/profile?connected=github');
    expect(await connectionOf(client, 'github')).toMatchObject({ connected: true, handle: '@ada-lane' });
    expect(mock.requests.map((row) => row.path)).not.toContain('/user/emails');
  });

  it('never grants credentials, memberships or access, and audits the change', async () => {
    const { id, client } = await user();
    const url = await startConnect(client, 'huggingface');
    await client.get(`/api/profile/connections/huggingface/callback?code=${GOOD_CODE}&state=${url.searchParams.get('state')}`);
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM credentials WHERE user_id = ?', [id])).toBeUndefined();
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM memberships WHERE user_id = ?', [id])).toBeUndefined();
    const profile = await (await client.get('/api/profile')).json();
    expect(profile.credentials).toEqual([]);
    expect(profile.reviewBiology.allowed).toBe(false);
    expect((await test.ctx.db.get<{ action: string }>(`SELECT action FROM audit_log WHERE actor_id = ? AND action = 'profile.connection_added'`, [id]))?.action).toBe('profile.connection_added');
  });

  it('needs a signed-in, verified person to start', async () => {
    const out = await new Client(test).get('/api/profile/connections/linkedin/start');
    expect(location(out)).toBe('/signin?next=/profile');
    await makeUser(test, { email: 'new@lab.example', verified: false });
    const unverified = await new Client(test).signIn('new@lab.example');
    expect(location(await unverified.get('/api/profile/connections/linkedin/start'))).toBe('/verify');
    expect((await new Client(test).get('/api/profile/connections/twitter/start')).status).toBe(404);
  });

  it('refuses a callback finished by someone other than who started it', async () => {
    const { client } = await user();
    const url = await startConnect(client, 'linkedin');
    await client.post('/api/auth/signout');
    const { id: otherId } = await user('other@lab.example');
    await client.signIn('other@lab.example');
    mock.requests.length = 0;
    const res = await client.get(`/api/profile/connections/linkedin/callback?code=${GOOD_CODE}&state=${url.searchParams.get('state')}`);
    expect(location(res)).toBe('/profile?connection_error=state&provider=linkedin');
    expect(mock.requests).toEqual([]);
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM connected_accounts WHERE user_id = ?', [otherId])).toBeUndefined();
  });

  it('refuses a wrong state, and a state started for another provider', async () => {
    const { client } = await user();
    await startConnect(client, 'linkedin');
    expect(location(await client.get(`/api/profile/connections/linkedin/callback?code=${GOOD_CODE}&state=tampered`))).toBe('/profile?connection_error=state&provider=linkedin');
    const url = await startConnect(client, 'linkedin');
    expect(location(await client.get(`/api/profile/connections/huggingface/callback?code=${GOOD_CODE}&state=${url.searchParams.get('state')}`))).toBe('/profile?connection_error=state&provider=huggingface');
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM connected_accounts')).toBeUndefined();
  });

  it('reports a decline and a provider failure without connecting', async () => {
    const { client } = await user();
    let url = await startConnect(client, 'linkedin');
    expect(location(await client.get(`/api/profile/connections/linkedin/callback?error=user_cancelled_login&state=${url.searchParams.get('state')}`))).toBe('/profile?connection_error=denied&provider=linkedin');
    url = await startConnect(client, 'linkedin');
    expect(location(await client.get(`/api/profile/connections/linkedin/callback?code=wrong&state=${url.searchParams.get('state')}`))).toBe('/profile?connection_error=unavailable&provider=linkedin');
    expect((await connectionOf(client, 'linkedin')).connected).toBe(false);
  });

  it('refuses a provider account already connected to someone else', async () => {
    const first = await user();
    let url = await startConnect(first.client, 'huggingface');
    await first.client.get(`/api/profile/connections/huggingface/callback?code=${GOOD_CODE}&state=${url.searchParams.get('state')}`);

    const second = await user('second@lab.example');
    url = await startConnect(second.client, 'huggingface');
    const res = await second.client.get(`/api/profile/connections/huggingface/callback?code=${GOOD_CODE}&state=${url.searchParams.get('state')}`);
    expect(location(res)).toBe('/profile?connection_error=taken&provider=huggingface');
    expect((await connectionOf(second.client, 'huggingface')).connected).toBe(false);
    expect((await connectionOf(first.client, 'huggingface')).connected).toBe(true);
  });

  it('disconnects for real, for that person only, and can connect again', async () => {
    const first = await user();
    const second = await user('second@lab.example');
    let url = await startConnect(first.client, 'huggingface');
    await first.client.get(`/api/profile/connections/huggingface/callback?code=${GOOD_CODE}&state=${url.searchParams.get('state')}`);

    expect((await second.client.post('/api/profile/connections/huggingface/disconnect')).status).toBe(404);
    expect((await connectionOf(first.client, 'huggingface')).connected).toBe(true);

    expect((await first.client.post('/api/profile/connections/huggingface/disconnect')).status).toBe(200);
    expect((await connectionOf(first.client, 'huggingface')).connected).toBe(false);
    expect((await first.client.post('/api/profile/connections/huggingface/disconnect')).status).toBe(404);
    expect((await test.ctx.db.get<{ disconnected_at: string | null }>('SELECT disconnected_at FROM connected_accounts WHERE user_id = ?', [first.id]))?.disconnected_at).toBeTruthy();
    expect((await test.ctx.db.get<{ action: string }>(`SELECT action FROM audit_log WHERE actor_id = ? AND action = 'profile.connection_removed'`, [first.id]))?.action).toBeTruthy();

    url = await startConnect(first.client, 'huggingface');
    await first.client.get(`/api/profile/connections/huggingface/callback?code=${GOOD_CODE}&state=${url.searchParams.get('state')}`);
    expect((await connectionOf(first.client, 'huggingface')).connected).toBe(true);
  });

  it('refuses a disconnect signed out, unverified, without the request header, or for an unknown provider', async () => {
    const { client } = await user();
    expect((await new Client(test).post('/api/profile/connections/github/disconnect')).status).toBe(401);
    expect((await client.post('/api/profile/connections/twitter/disconnect')).status).toBe(404);
    expect((await test.app.request('/api/profile/connections/github/disconnect', { method: 'POST' })).status).toBe(403);
    await makeUser(test, { email: 'new@lab.example', verified: false });
    const unverified = await new Client(test).signIn('new@lab.example');
    expect((await unverified.post('/api/profile/connections/github/disconnect')).status).toBe(403);
  });
});

describe('the workspace a GitHub account lands in', () => {
  it('is none: signing in with GitHub grants no workspace access', async () => {
    const owner = await makeUser(test, { email: 'owner@lab.example' });
    await makeWorkspace(test, owner, 'Private Lab');
    const client = new Client(test);
    await signInWithGithub(client);
    expect((await sessionUser(client)).workspaces).toEqual([]);
  });
});
