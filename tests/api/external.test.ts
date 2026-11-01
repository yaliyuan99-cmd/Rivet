import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OAuthRequestView } from '../../shared/types/external.ts';
import { authorizationRedirect, validateAuthorizationParams, verifyPkce } from '../../server/routes/external.ts';
import { Client, makeTestApp, makeUser, type TestApp } from '../helpers/app.ts';

const REDIRECT = 'http://localhost:8787/atlas-demo/callback';
const ALL_SCOPES = 'tasks:read reports:read advisor:query';

let test: TestApp;
let maya: Client;

beforeEach(async () => {
  test = await makeTestApp({ seed: true });
  maya = await new Client(test).signIn('maya@helixlab.example');
});
afterEach(() => test.close());

function newAttempt() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(16).toString('base64url') };
}

type Attempt = ReturnType<typeof newAttempt>;

const params = (attempt: Attempt, overrides: Record<string, string | undefined> = {}) => ({
  response_type: 'code',
  client_id: 'client_atlas_demo',
  redirect_uri: REDIRECT,
  scope: ALL_SCOPES,
  resource: 'task:BIO-042',
  state: attempt.state,
  code_challenge: attempt.challenge,
  code_challenge_method: 'S256',
  ...overrides,
});

async function startRequest(client: Client, attempt = newAttempt(), overrides: Record<string, string | undefined> = {}) {
  const res = await client.post('/api/oauth/requests', params(attempt, overrides));
  expect(res.status).toBe(201);
  const { code } = (await res.json()) as { code: string };
  return { code, attempt };
}

async function approve(client: Client, code: string) {
  const res = await client.post(`/api/oauth/requests/${code}/approve`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { redirectTo: string; request: OAuthRequestView };
  const url = new URL(body.redirectTo);
  return { url, code: url.searchParams.get('code') as string, state: url.searchParams.get('state') as string, view: body.request };
}

function tokenRequest(fields: Record<string, string | undefined>, headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.set(key, value);
  return test.app.request('/oauth/token', { method: 'POST', headers, body: body.toString() });
}

const exchange = (code: string, verifier: string, overrides: Record<string, string | undefined> = {}) =>
  tokenRequest({ grant_type: 'authorization_code', client_id: 'client_atlas_demo', code, redirect_uri: REDIRECT, code_verifier: verifier, ...overrides });

async function connect(client: Client = maya, overrides: Record<string, string | undefined> = {}) {
  const { code, attempt } = await startRequest(client, newAttempt(), overrides);
  const approved = await approve(client, code);
  const res = await exchange(approved.code, attempt.verifier);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { access_token: string };
  return { token: body.access_token, requestCode: code };
}

const bearer = (token: string, path: string, init: RequestInit = {}) =>
  test.app.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) } });

const ask = (token: string, question = 'What are the limitations of this evidence?') => bearer(token, '/api/external/advisor/query', { method: 'POST', body: JSON.stringify({ question }) });

describe('seeded client', () => {
  it('is registered against this instance and marked synthetic', async () => {
    const row = await test.ctx.db.get<any>(`SELECT * FROM oauth_clients WHERE client_id = 'client_atlas_demo'`);
    expect(row).toMatchObject({ name: 'Atlas Research Client', developer: 'Atlas Tools', description: 'Synthetic demo integration', redirect_uri: REDIRECT, is_synthetic: 1 });
    const res = await test.app.request('/api/oauth/clients/client_atlas_demo');
    expect(await res.json()).toMatchObject({ clientId: 'client_atlas_demo', redirectUri: REDIRECT, scopes: ['tasks:read', 'reports:read', 'advisor:query'], synthetic: true });
    expect((await test.app.request('/api/oauth/clients/nope')).status).toBe(404);
  });

  it('numbers the first live request OAUTH-042 and seeds no connection', async () => {
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM oauth_tokens`)).toBeUndefined();
    const { code } = await startRequest(maya);
    expect(code).toBe('OAUTH-042');
    expect((await startRequest(maya)).code).toBe('OAUTH-043');
  });
});

describe('the whole loop', () => {
  it('goes from request to consent to code to token to the bearer API', async () => {
    const attempt = newAttempt();
    const { code } = await startRequest(maya, attempt);

    const pending = (await (await maya.get(`/api/oauth/requests/${code}`)).json()) as OAuthRequestView;
    expect(pending).toMatchObject({
      code: 'OAUTH-042',
      status: 'pending',
      client: { clientId: 'client_atlas_demo', name: 'Atlas Research Client', developer: 'Atlas Tools', description: 'Synthetic demo integration' },
      account: { name: 'Maya Chen', workspaceName: 'Helix Lab' },
      resource: { taskCode: 'BIO-042', version: '1.0', label: 'BIO-042 v1.0' },
      redirectDisplay: 'localhost:8787/atlas-demo/callback',
      token: { state: 'not_issued' },
    });
    expect(pending.scopes).toEqual([
      { scope: 'tasks:read', description: 'Read the frozen task definition; no workspace discovery.' },
      { scope: 'reports:read', description: 'Read RPT-BIO-042 and evidence metadata; no private source files.' },
      { scope: 'advisor:query', description: 'Ask Audit Advisor within authorized task evidence.' },
    ]);

    const approved = await approve(maya, code);
    expect(approved.url.origin + approved.url.pathname).toBe(REDIRECT);
    expect(approved.state).toBe(attempt.state);
    expect(approved.view.status).toBe('approved');
    expect(approved.view.token.state).toBe('awaiting_exchange');

    const res = await exchange(approved.code, attempt.verifier);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const token = (await res.json()) as Record<string, unknown>;
    expect(token).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: ALL_SCOPES, resource: 'task:BIO-042' });
    expect(token).not.toHaveProperty('refresh_token');

    const receipt = (await (await maya.get(`/api/oauth/requests/${code}`)).json()) as OAuthRequestView;
    expect(receipt.token.state).toBe('issued');
    const issued = await test.ctx.db.get<any>('SELECT * FROM oauth_tokens');
    expect(new Date(issued.expires_at).getTime() - new Date(issued.issued_at).getTime()).toBe(3_600_000);
    expect(receipt.token.expiresAt).toBe(issued.expires_at);

    const accessToken = token.access_token as string;
    const task = await bearer(accessToken, '/api/external/tasks/BIO-042');
    expect(task.status).toBe(200);
    expect(await task.json()).toMatchObject({ code: 'BIO-042', version: '1.0', report: { code: 'RPT-BIO-042', version: '1.0' }, synthetic: true });

    const report = await bearer(accessToken, '/api/external/reports/RPT-BIO-042/1.0');
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({ code: 'RPT-BIO-042', version: '1.0', task: { code: 'BIO-042', version: '1.0' }, run: 'RUN-1042', review: 'REVIEW-042' });
    expect((await bearer(accessToken, '/api/external/reports/RPT-BIO-042/v1.0')).status).toBe(200);

    const answer = await ask(accessToken);
    expect(answer.status).toBe(200);
    const advisor = (await answer.json()) as { insufficient: boolean; mode: string; citations: { label: string; url: string }[] };
    expect(advisor.insufficient).toBe(false);
    expect(advisor.mode).toBe('retrieval');
    expect(advisor.citations[0]?.url).toMatch(/^http:\/\/localhost:8787\//);

    // The boundary: a task Maya can read herself is still out of this token's reach.
    expect((await maya.get('/api/tasks/BIO-041')).status).toBe(200);
    const other = await bearer(accessToken, '/api/external/tasks/BIO-041');
    expect(other.status).toBe(403);
    expect((await other.json()).error).toMatchObject({ code: 'out_of_boundary', message: 'This access token is limited to BIO-042 v1.0.' });
  });

  it('stores only hashes of codes and tokens', async () => {
    const attempt = newAttempt();
    const { code } = await startRequest(maya, attempt);
    const approved = await approve(maya, code);
    const row = await test.ctx.db.get<any>('SELECT * FROM oauth_requests WHERE code = ?', [code]);
    expect(row.auth_code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(approved.code);
    const token = ((await (await exchange(approved.code, attempt.verifier)).json()) as { access_token: string }).access_token;
    const stored = await test.ctx.db.get<any>('SELECT * FROM oauth_tokens');
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(await test.ctx.db.all('SELECT detail FROM audit_log'))).not.toContain(token);
  });

  it('audits every decision', async () => {
    const approvedFlow = await connect();
    const denied = await startRequest(maya);
    await maya.post(`/api/oauth/requests/${denied.code}/deny`);
    const actions = await test.ctx.db.all<{ action: string; subject_code: string }>(`SELECT action, subject_code FROM audit_log WHERE action LIKE 'oauth.%'`);
    expect(actions).toEqual(
      expect.arrayContaining([
        { action: 'oauth.request_created', subject_code: approvedFlow.requestCode },
        { action: 'oauth.request_approved', subject_code: approvedFlow.requestCode },
        { action: 'oauth.token_issued', subject_code: approvedFlow.requestCode },
        { action: 'oauth.request_denied', subject_code: denied.code },
      ]),
    );
  });
});

describe('POST /oauth/token', () => {
  it('refuses a wrong verifier, and the right one still works afterwards', async () => {
    const attempt = newAttempt();
    const { code } = await startRequest(maya, attempt);
    const approved = await approve(maya, code);
    const wrong = await exchange(approved.code, newAttempt().verifier);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('code_verifier') });
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM oauth_tokens')).toBeUndefined();
    expect((await exchange(approved.code, attempt.verifier)).status).toBe(200);
  });

  it('refuses a reused code and revokes what it issued', async () => {
    const attempt = newAttempt();
    const { code } = await startRequest(maya, attempt);
    const approved = await approve(maya, code);
    const first = (await (await exchange(approved.code, attempt.verifier)).json()) as { access_token: string };
    expect((await bearer(first.access_token, '/api/external/tasks/BIO-042')).status).toBe(200);

    const second = await exchange(approved.code, attempt.verifier);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') });

    const after = await bearer(first.access_token, '/api/external/tasks/BIO-042');
    expect(after.status).toBe(401);
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'oauth.code_replayed'`)).toBeTruthy();
  });

  it('refuses a redirect that is not an exact match', async () => {
    const attempt = newAttempt();
    const { code } = await startRequest(maya, attempt);
    const approved = await approve(maya, code);
    for (const redirect of [`${REDIRECT}/`, `${REDIRECT}?x=1`, REDIRECT.replace('localhost', '127.0.0.1')]) {
      const res = await exchange(approved.code, attempt.verifier, { redirect_uri: redirect });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_grant');
    }
  });

  it('refuses an expired code, and Return to Atlas mints a working one', async () => {
    const attempt = newAttempt();
    const { code } = await startRequest(maya, attempt);
    const approved = await approve(maya, code);
    test.advance(5 * 60_000 + 1000);
    const expired = await exchange(approved.code, attempt.verifier);
    expect(await expired.json()).toMatchObject({ error: 'invalid_grant', error_description: 'This authorization code has expired.' });

    const back = await maya.post(`/api/oauth/requests/${code}/return`);
    expect(back.status).toBe(200);
    const fresh = new URL(((await back.json()) as { redirectTo: string }).redirectTo);
    expect(fresh.searchParams.get('state')).toBe(attempt.state);
    expect((await exchange(fresh.searchParams.get('code') as string, attempt.verifier)).status).toBe(200);
    // The earlier code stays dead, and a second return has nothing left to send.
    expect((await exchange(approved.code, attempt.verifier)).status).toBe(400);
    expect((await maya.post(`/api/oauth/requests/${code}/return`)).status).toBe(409);
  });

  it('lapses an approval nobody collects', async () => {
    const { code } = await startRequest(maya);
    await approve(maya, code);
    test.advance(10 * 60_000 + 1000);
    const view = (await (await maya.get(`/api/oauth/requests/${code}`)).json()) as OAuthRequestView;
    expect(view.status).toBe('approved');
    expect(view.token.state).toBe('lapsed');
    expect(view.canReturn.allowed).toBe(false);
    expect((await maya.post(`/api/oauth/requests/${code}/return`)).status).toBe(409);
  });

  it('answers RFC 6749 errors, without needing a CSRF header', async () => {
    const attempt = newAttempt();
    const { code } = await startRequest(maya, attempt);
    const approved = await approve(maya, code);
    const base = { grant_type: 'authorization_code', client_id: 'client_atlas_demo', code: approved.code, redirect_uri: REDIRECT, code_verifier: attempt.verifier };

    const cases: [Record<string, string | undefined>, number, string][] = [
      [{ ...base, grant_type: undefined }, 400, 'invalid_request'],
      [{ ...base, grant_type: 'refresh_token' }, 400, 'unsupported_grant_type'],
      [{ ...base, grant_type: 'client_credentials' }, 400, 'unsupported_grant_type'],
      [{ ...base, client_id: undefined }, 400, 'invalid_request'],
      [{ ...base, client_id: 'client_unknown' }, 401, 'invalid_client'],
      [{ ...base, code: undefined }, 400, 'invalid_request'],
      [{ ...base, redirect_uri: undefined }, 400, 'invalid_request'],
      [{ ...base, code_verifier: undefined }, 400, 'invalid_request'],
      [{ ...base, code: 'not-a-real-code' }, 400, 'invalid_grant'],
    ];
    for (const [fields, status, error] of cases) {
      const res = await tokenRequest(fields);
      expect(res.status, JSON.stringify(fields)).toBe(status);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body.error, JSON.stringify(fields)).toBe(error);
      expect(typeof body.error_description).toBe('string');
    }
    const json = await test.app.request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base) });
    expect(json.status).toBe(400);
    expect((await json.json()).error).toBe('invalid_request');

    // Everything above was refused, so the code still works. No X-Rivet-Request anywhere.
    expect((await tokenRequest(base)).status).toBe(200);
  });

  it('refuses when the approving user has since lost the task', async () => {
    const memberId = await makeUser(test, { email: 'lab@helix.example', name: 'Lab Member' });
    await test.ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) SELECT 'm-lab', id, ?, 'member', ? FROM workspaces WHERE code = 'WS-HELIX'`, [memberId, test.ctx.now().toISOString()]);
    const member = await new Client(test).signIn('lab@helix.example');
    const attempt = newAttempt();
    const { code } = await startRequest(member, attempt);
    const approved = await approve(member, code);
    await test.ctx.db.run(`UPDATE memberships SET status = 'removed', removed_at = ? WHERE user_id = ?`, [test.ctx.now().toISOString(), memberId]);
    const res = await exchange(approved.code, attempt.verifier);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });
});

describe('POST /api/oauth/requests validation', () => {
  const refuse = async (overrides: Record<string, string | undefined>, status: number, code: string) => {
    const res = await maya.post('/api/oauth/requests', params(newAttempt(), overrides));
    expect(res.status, JSON.stringify(overrides)).toBe(status);
    return (await res.json()).error as { code: string; message: string; fields?: Record<string, string> };
  };

  it('never offers a way back for an unknown client or a wrong redirect', async () => {
    for (const [overrides, code] of [
      [{ client_id: 'client_evil' }, 'invalid_client'],
      [{ client_id: undefined }, 'invalid_client'],
      [{ redirect_uri: 'https://evil.example/callback' }, 'invalid_redirect_uri'],
      [{ redirect_uri: `${REDIRECT}/` }, 'invalid_redirect_uri'],
      [{ redirect_uri: undefined }, 'invalid_redirect_uri'],
    ] as const) {
      const error = await refuse(overrides, 400, code);
      expect(error.code).toBe(code);
      expect(error.fields?.returnTo).toBeUndefined();
    }
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM oauth_requests')).toBeUndefined();
  });

  it('refuses a missing state, a missing or plain challenge, and unknown scopes, sending the error to the registered client', async () => {
    const state = 'keep & this/state';
    const cases: [Record<string, string | undefined>, string][] = [
      [{ state: undefined }, 'invalid_request'],
      [{ state: 'x'.repeat(513) }, 'invalid_request'],
      [{ state, code_challenge: undefined }, 'invalid_request'],
      [{ state, code_challenge: 'too-short' }, 'invalid_request'],
      [{ state, code_challenge_method: 'plain' }, 'invalid_request'],
      [{ state, code_challenge_method: undefined }, 'invalid_request'],
      [{ state, response_type: 'token' }, 'unsupported_response_type'],
      [{ state, scope: undefined }, 'invalid_scope'],
      [{ state, scope: 'tasks:read tasks:write' }, 'invalid_scope'],
      [{ state, scope: 'openid' }, 'invalid_scope'],
      [{ state, resource: undefined }, 'invalid_target'],
      [{ state, resource: 'https://evil.example' }, 'invalid_target'],
    ];
    for (const [overrides, code] of cases) {
      const error = await refuse(overrides, 400, code);
      expect(error.code, JSON.stringify(overrides)).toBe(code);
      const back = new URL(error.fields?.returnTo as string);
      expect(back.origin + back.pathname).toBe(REDIRECT);
      expect(back.searchParams.get('error')).toBe(code);
      if (overrides.state === state) expect(back.searchParams.get('state')).toBe(state);
    }
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM oauth_requests')).toBeUndefined();
  });

  it('requires a verified sign-in', async () => {
    expect((await new Client(test).post('/api/oauth/requests', params(newAttempt()))).status).toBe(401);
    await makeUser(test, { email: 'new@lab.example', verified: false });
    const unverified = await new Client(test).signIn('new@lab.example');
    const res = await unverified.post('/api/oauth/requests', params(newAttempt()));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('email_unverified');
  });

  it('refuses a task the user cannot read, and a task with no frozen version', async () => {
    await makeUser(test, { email: 'outsider@lab.example' });
    const outsider = await new Client(test).signIn('outsider@lab.example');
    const refused = await outsider.post('/api/oauth/requests', params(newAttempt()));
    expect(refused.status).toBe(404);
    expect((await refused.json()).error.code).toBe('invalid_target');
    const unknown = await refuse({ resource: 'task:BIO-999' }, 404, 'invalid_target');
    expect(unknown.message).toBe('This task does not exist or you do not have access to it.');
    const draft = await refuse({ resource: 'task:BIO-043' }, 400, 'invalid_target');
    expect(draft.message).toContain('no frozen version');
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM oauth_requests')).toBeUndefined();
  });

  it('lets a verified reader of a shared task request it, and pins the frozen version', async () => {
    const { code } = await startRequest(maya, newAttempt(), { resource: 'BIO-041' });
    const view = (await (await maya.get(`/api/oauth/requests/${code}`)).json()) as OAuthRequestView;
    expect(view.resource.label).toBe('BIO-041 v1.0');
    // Maya is not in Northbridge: the receipt names her own workspace rather than inventing a membership.
    expect(view.account.workspaceName).toBe('Helix Lab');
    expect(view.scopes[1]?.description).toBe('Read the frozen report and evidence metadata; no private source files.');
  });

  it('treats the same state and challenge as the same attempt', async () => {
    const attempt = newAttempt();
    const first = await startRequest(maya, attempt);
    const again = await maya.post('/api/oauth/requests', params(attempt));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ code: first.code, created: false });
    await approve(maya, first.code);
    // A reload after approving finds the decided request; it cannot open a second consent.
    expect(await (await maya.post('/api/oauth/requests', params(attempt))).json()).toEqual({ code: first.code, created: false });
    expect((await test.ctx.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM oauth_requests'))?.count).toBe(1);
  });
});

describe('consent states', () => {
  it('is visible only to the requesting user', async () => {
    const { code } = await startRequest(maya);
    const samira = await new Client(test).signIn('samira@northbridge.example');
    const alex = await new Client(test).signIn('alex@rivet.example');
    for (const other of [samira, alex]) {
      expect((await other.get(`/api/oauth/requests/${code}`)).status).toBe(404);
      expect((await other.post(`/api/oauth/requests/${code}/approve`)).status).toBe(404);
      expect((await other.post(`/api/oauth/requests/${code}/deny`)).status).toBe(404);
      expect((await other.post(`/api/oauth/requests/${code}/return`)).status).toBe(404);
    }
    expect((await new Client(test).get(`/api/oauth/requests/${code}`)).status).toBe(401);
    expect(((await (await maya.get(`/api/oauth/requests/${code}`)).json()) as OAuthRequestView).status).toBe('pending');
  });

  it('expires after ten minutes: the server refuses, and audits it', async () => {
    test.setNow('2026-11-02T14:35:00.000Z');
    const attempt = newAttempt();
    const { code } = await startRequest(maya, attempt);
    test.setNow('2026-11-02T14:44:59.000Z');
    expect(((await (await maya.get(`/api/oauth/requests/${code}`)).json()) as OAuthRequestView).status).toBe('pending');

    test.setNow('2026-11-02T14:45:00.000Z');
    const refused = await maya.post(`/api/oauth/requests/${code}/approve`);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatchObject({ code: 'request_expired', message: 'A fresh authorization is required' });
    expect((await maya.post(`/api/oauth/requests/${code}/deny`)).status).toBe(409);
    expect((await maya.post(`/api/oauth/requests/${code}/return`)).status).toBe(409);

    const view = (await (await maya.get(`/api/oauth/requests/${code}`)).json()) as OAuthRequestView;
    expect(view).toMatchObject({ status: 'expired', expiresAt: '2026-11-02T14:45:00.000Z', token: { state: 'not_issued' } });
    const back = new URL(view.returnUrl as string);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe(attempt.state);
    expect(back.searchParams.get('code')).toBeNull();

    const actions = (await test.ctx.db.all<{ action: string }>(`SELECT action FROM audit_log WHERE subject_code = ?`, [code])).map((row) => row.action);
    expect(actions).toContain('oauth.request_expired');
    expect(actions).toContain('oauth.approval_refused');
    expect(actions.filter((action) => action === 'oauth.request_expired')).toHaveLength(1);
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM oauth_tokens')).toBeUndefined();
  });

  it('records a denial, sends access_denied back, and issues nothing', async () => {
    const attempt = newAttempt();
    const { code } = await startRequest(maya, attempt);
    const res = await maya.post(`/api/oauth/requests/${code}/deny`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirectTo: string; request: OAuthRequestView };
    const back = new URL(body.redirectTo);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe(attempt.state);
    expect(body.request).toMatchObject({ status: 'denied', token: { state: 'not_issued' } });
    const row = await test.ctx.db.get<any>('SELECT * FROM oauth_requests WHERE code = ?', [code]);
    expect(row.auth_code_hash).toBeNull();
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'oauth.request_denied' AND subject_code = ?`, [code])).toBeTruthy();

    expect((await maya.post(`/api/oauth/requests/${code}/approve`)).status).toBe(409);
    expect((await maya.post(`/api/oauth/requests/${code}/return`)).status).toBe(409);
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM oauth_tokens')).toBeUndefined();
  });

  it('decides only once', async () => {
    const { code } = await startRequest(maya);
    await approve(maya, code);
    const deny = await maya.post(`/api/oauth/requests/${code}/deny`);
    expect(deny.status).toBe(409);
    expect((await deny.json()).error.code).toBe('already_decided');
    expect((await maya.post(`/api/oauth/requests/${code}/approve`)).status).toBe(409);
  });

  it('refuses approval once the user can no longer read the task', async () => {
    const memberId = await makeUser(test, { email: 'lab@helix.example' });
    await test.ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) SELECT 'm-lab', id, ?, 'member', ? FROM workspaces WHERE code = 'WS-HELIX'`, [memberId, test.ctx.now().toISOString()]);
    const member = await new Client(test).signIn('lab@helix.example');
    const { code } = await startRequest(member);
    await test.ctx.db.run(`UPDATE memberships SET status = 'removed' WHERE user_id = ?`, [memberId]);
    const res = await member.post(`/api/oauth/requests/${code}/approve`);
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('Only workspace members and explicitly authorized reviewers can access this task.');
  });

  it('says so when an earlier connection is still live', async () => {
    await connect();
    const { code } = await startRequest(maya);
    await maya.post(`/api/oauth/requests/${code}/deny`);
    expect(((await (await maya.get(`/api/oauth/requests/${code}`)).json()) as OAuthRequestView).otherActiveConnections).toBe(1);
  });
});

describe('bearer API', () => {
  it('needs a real bearer token: cookies do nothing here', async () => {
    const none = await maya.get('/api/external/tasks/BIO-042');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Bearer');
    const junk = await bearer('rvt_not-a-token', '/api/external/tasks/BIO-042');
    expect(junk.status).toBe(401);
    expect(junk.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect((await junk.json()).error.code).toBe('invalid_token');
  });

  it('stops working when the token expires', async () => {
    const { token } = await connect();
    test.advance(3600 * 1000 - 1000);
    expect((await bearer(token, '/api/external/tasks/BIO-042')).status).toBe(200);
    test.advance(1000);
    const res = await bearer(token, '/api/external/tasks/BIO-042');
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe('This access token has expired.');
    expect((await ask(token)).status).toBe(401);
  });

  it('stops working when revoked, and only the token owner can revoke', async () => {
    const { token } = await connect();
    const { id } = (await test.ctx.db.get<{ id: string }>('SELECT id FROM oauth_tokens')) as { id: string };

    const samira = await new Client(test).signIn('samira@northbridge.example');
    expect((await samira.post(`/api/oauth/connections/${id}/revoke`)).status).toBe(404);
    expect((await new Client(test).post(`/api/oauth/connections/${id}/revoke`)).status).toBe(401);
    const csrf = await test.app.request(`/api/oauth/connections/${id}/revoke`, { method: 'POST' });
    expect(csrf.status).toBe(403);
    expect((await bearer(token, '/api/external/tasks/BIO-042')).status).toBe(200);

    const res = await maya.post(`/api/oauth/connections/${id}/revoke`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, revokedAt: expect.any(String) });
    const refused = await bearer(token, '/api/external/tasks/BIO-042');
    expect(refused.status).toBe(401);
    expect((await refused.json()).error.message).toBe('This access token was revoked.');
    expect((await ask(token)).status).toBe(401);
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'oauth.token_revoked' AND subject_id = ?`, [id])).toBeTruthy();
    expect((await maya.post(`/api/oauth/connections/${id}/revoke`)).status).toBe(200);
  });

  it('holds only the scopes that were granted', async () => {
    const tasksOnly = await connect(maya, { scope: 'tasks:read' });
    expect((await bearer(tasksOnly.token, '/api/external/tasks/BIO-042')).status).toBe(200);
    const report = await bearer(tasksOnly.token, '/api/external/reports/RPT-BIO-042/1.0');
    expect(report.status).toBe(403);
    expect(report.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(report.headers.get('www-authenticate')).toContain('scope="reports:read"');
    expect((await report.json()).error.code).toBe('insufficient_scope');
    expect((await ask(tasksOnly.token)).status).toBe(403);
    // The task read does not advertise a report the token cannot open.
    expect(((await (await bearer(tasksOnly.token, '/api/external/tasks/BIO-042')).json()) as { report: unknown }).report).toBeNull();

    const advisorOnly = await connect(maya, { scope: 'advisor:query' });
    expect((await ask(advisorOnly.token)).status).toBe(200);
    expect((await bearer(advisorOnly.token, '/api/external/tasks/BIO-042')).status).toBe(403);
    expect((await bearer(advisorOnly.token, '/api/external/reports/RPT-BIO-042/1.0')).status).toBe(403);
  });

  it('stays inside the resource boundary', async () => {
    const { token } = await connect();
    for (const path of ['/api/external/tasks/BIO-041', '/api/external/tasks/BIO-043', '/api/external/tasks/BIO-999', '/api/external/reports/RPT-BIO-041/1.0']) {
      const res = await bearer(token, path);
      expect(res.status, path).toBe(403);
      expect((await res.json()).error.code).toBe('out_of_boundary');
    }
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'oauth.api_refused'`)).toBeTruthy();
    // The right report code at a version that does not exist is simply not there.
    expect((await bearer(token, '/api/external/reports/RPT-BIO-042/9.9')).status).toBe(404);
  });

  it('stops immediately when workspace membership is removed mid-token', async () => {
    const memberId = await makeUser(test, { email: 'lab@helix.example', name: 'Lab Member' });
    const workspace = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-HELIX'`)) as { id: string };
    await test.ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m-lab', ?, ?, 'member', ?)`, [workspace.id, memberId, test.ctx.now().toISOString()]);
    const member = await new Client(test).signIn('lab@helix.example');
    const { token } = await connect(member);
    expect((await bearer(token, '/api/external/tasks/BIO-042')).status).toBe(200);
    expect((await ask(token)).status).toBe(200);

    const removal = await maya.post(`/api/workspaces/${workspace.id}/members/${memberId}/remove`);
    expect(removal.status).toBe(200);

    for (const res of [await bearer(token, '/api/external/tasks/BIO-042'), await bearer(token, '/api/external/reports/RPT-BIO-042/1.0'), await ask(token)]) {
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatchObject({ code: 'access_revoked', message: 'Only workspace members and explicitly authorized reviewers can access this task.' });
    }
    // Restoring the membership restores access, so the check really is against current state.
    await test.ctx.db.run(`UPDATE memberships SET status = 'active', removed_at = NULL WHERE user_id = ?`, [memberId]);
    expect((await bearer(token, '/api/external/tasks/BIO-042')).status).toBe(200);
  });

  it('returns metadata only: no workspace, no private files, no output text', async () => {
    const { token } = await connect();
    const task = await (await bearer(token, '/api/external/tasks/BIO-042')).json();
    // The frozen definition, and not the dataset rows behind it or the workspace around it.
    expect(JSON.stringify(task)).not.toMatch(/workspace|Helix|acrB transcript|Partial MIC reversal/i);
    expect(task.sourcePack).toMatchObject({ code: 'DS-BIO-07', version: '1.0', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const report = await (await bearer(token, '/api/external/reports/RPT-BIO-042/1.0')).json();
    expect(report).not.toHaveProperty('canonical');
    expect(report.evidence).toHaveLength(3);
    for (const evidence of report.evidence) {
      expect(Object.keys(evidence).sort()).toEqual(['capturedAt', 'code', 'modelRevision', 'scoreLabel', 'sha256', 'totalScore', 'verified']);
      expect(evidence.verified).toBe(true);
    }
    expect(JSON.stringify(report)).not.toContain('The fourfold MIC shift');
    expect(JSON.stringify(report)).not.toContain('uploads');
  });

  it('withholds the source pack pin from a reader who cannot read the dataset', async () => {
    await test.ctx.db.run(`INSERT INTO credentials (id, user_id, domain_id, rationale, granted_at) SELECT 'c-alex', id, 'biology', 'x', ? FROM users WHERE email = 'alex@rivet.example'`, [test.ctx.now().toISOString()]);
    const alex = await new Client(test).signIn('alex@rivet.example');
    const { token } = await connect(alex);
    expect(((await (await bearer(token, '/api/external/tasks/BIO-042')).json()) as { sourcePack: unknown }).sourcePack).toBeNull();
  });

  it('validates the advisor question', async () => {
    const { token } = await connect();
    const res = await bearer(token, '/api/external/advisor/query', { method: 'POST', body: JSON.stringify({ question: '  ' }) });
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields.question).toBe('Enter a question to ask Audit Advisor.');
  });

  it('answers the external advisor from the same authorized records', async () => {
    const { token } = await connect();
    const insufficient = await (await ask(token, 'Does efflux cause the resistance?')).json();
    expect(insufficient).toMatchObject({ insufficient: true, citations: [], answer: 'The authorized evidence does not include causal controls. I cannot establish that claim.' });
    // External questions do not land in Maya's own thread; they are audited instead.
    const thread = await (await maya.get('/api/advisor/thread?task=BIO-042')).json();
    expect(thread.messages).toHaveLength(2);
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'oauth.api_advisor_query'`)).toBeTruthy();
  });
});

describe('verification functions', () => {
  it('match the RFC 7636 test vector', () => {
    expect(verifyPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(verifyPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXA', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
    expect(verifyPkce('short', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
    expect(verifyPkce(`${'a'.repeat(42)}!`, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
  });

  it('normalise the resource and keep only known scopes in order', () => {
    const result = validateAuthorizationParams({ response_type: 'code', scope: 'advisor:query tasks:read', resource: 'bio-042', state: 's', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' });
    expect(result).toMatchObject({ ok: true, scopes: ['tasks:read', 'advisor:query'], taskCode: 'BIO-042', resource: 'task:BIO-042' });
  });

  it('build redirects without losing what the registered address already has', () => {
    const url = new URL(authorizationRedirect('https://atlas.example/cb?tenant=a', { code: 'c', state: 'a b&c' }));
    expect(url.searchParams.get('tenant')).toBe('a');
    expect(url.searchParams.get('state')).toBe('a b&c');
  });
});

describe('demo client address', () => {
  it('follows the public URL when the same data is served from another address', async () => {
    const other = await makeTestApp({ seed: true, config: { publicUrl: 'http://localhost:5185' } });
    await other.ctx.db.run(`UPDATE oauth_clients SET redirect_uri = 'http://localhost:9999/atlas-demo/callback' WHERE client_id = 'client_atlas_demo'`);
    const client = await new Client(other).signIn('maya@helixlab.example');
    const attempt = newAttempt();
    const res = await client.post('/api/oauth/requests', params(attempt, { redirect_uri: 'http://localhost:5185/atlas-demo/callback' }));
    expect(res.status).toBe(201);
    const stale = await client.post('/api/oauth/requests', params(newAttempt(), { redirect_uri: 'http://localhost:9999/atlas-demo/callback' }));
    expect(stale.status).toBe(400);
    other.close();
  });

  it('holds any other client to exactly what it registered', async () => {
    await test.ctx.db.run(`INSERT INTO oauth_clients (id, client_id, name, developer, description, redirect_uri, is_synthetic, created_at) VALUES ('c2', 'client_other', 'Other', 'Other', 'Other', 'https://other.example/cb', 0, ?)`, [test.ctx.now().toISOString()]);
    expect((await maya.post('/api/oauth/requests', params(newAttempt(), { client_id: 'client_other', redirect_uri: 'https://other.example/cb' }))).status).toBe(201);
    expect((await maya.post('/api/oauth/requests', params(newAttempt(), { client_id: 'client_other', redirect_uri: REDIRECT }))).status).toBe(400);
  });
});
