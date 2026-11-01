import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, makeTestApp, makeUser, makeWorkspace, type TestApp } from '../helpers/app.ts';

let test: TestApp;

beforeEach(async () => {
  test = await makeTestApp();
});
afterEach(() => test.close());

const profileOf = async (client: Client) => (await client.get('/api/profile')).json();

describe('reading a profile', () => {
  it('is refused signed out and unverified', async () => {
    expect((await new Client(test).get('/api/profile')).status).toBe(401);
    await makeUser(test, { email: 'new@lab.example', verified: false });
    const client = await new Client(test).signIn('new@lab.example');
    expect((await client.get('/api/profile')).status).toBe(403);
    expect((await client.patch('/api/profile', { name: 'New', bio: '' })).status).toBe(403);
  });

  it('reports real data for a brand-new account', async () => {
    await makeUser(test, { email: 'new@lab.example', name: 'Ada Lane' });
    const client = await new Client(test).signIn('new@lab.example');
    const data = await profileOf(client);
    expect(data).toMatchObject({ name: 'Ada Lane', email: 'new@lab.example', emailVerified: true, accountRole: 'member', workspace: null, credentials: [], aiClients: [], reviewBiology: { allowed: false, reason: 'Verified Biology credential required' } });
    expect(data.connections.map((row: { provider: string; label: string; connected: boolean }) => [row.provider, row.label, row.connected])).toEqual([
      ['github', 'GitHub', false],
      ['linkedin', 'LinkedIn', false],
      ['huggingface', 'Hugging Face', false],
    ]);
  });

  it('reads as the seeded frame does', async () => {
    const seeded = await makeTestApp({ seed: true });
    const maya = await new Client(seeded).signIn('maya@helixlab.example');
    const data = await profileOf(maya);
    expect(data).toMatchObject({ name: 'Maya Chen', email: 'maya@helixlab.example', emailVerified: true, accountRole: 'member', workspace: { name: 'Helix Lab', role: 'owner' }, credentials: [] });
    expect(data.bio).toBe('Microbiology researcher exploring evidence-grounded AI evaluation at Helix Lab.');
    const byProvider = Object.fromEntries(data.connections.map((row: { provider: string }) => [row.provider, row]));
    expect(byProvider.github).toMatchObject({ connected: true, handle: '@mayachen-demo', visibilityNote: 'Public identity', isSynthetic: true, profileUrl: null });
    expect(byProvider.huggingface).toMatchObject({ connected: true, handle: '@maya-helix-demo', visibilityNote: 'Public profile only', isSynthetic: true });
    expect(byProvider.linkedin).toMatchObject({ connected: false, connect: { allowed: false, reason: 'LinkedIn connection is not configured on this server' }, connectHref: null });
    expect(data.reviewBiology).toEqual({ allowed: false, reason: 'Verified Biology credential required' });

    const samira = await new Client(seeded).signIn('samira@northbridge.example');
    const expert = await profileOf(samira);
    expect(expert.credentials.map((row: { domainName: string }) => row.domainName)).toEqual(['Biology']);
    expect(expert.reviewBiology).toEqual({ allowed: true });

    const alex = await new Client(seeded).signIn('alex@rivet.example');
    expect((await profileOf(alex)).accountRole).toBe('admin');
    seeded.close();
  });

  it('follows the active workspace and its role', async () => {
    const id = await makeUser(test, { email: 'owner@lab.example' });
    await makeWorkspace(test, id, 'Test Lab');
    const client = await new Client(test).signIn('owner@lab.example');
    expect((await profileOf(client)).workspace).toEqual({ name: 'Test Lab', role: 'owner' });
  });
});

describe('saving a profile', () => {
  it('saves display name and bio for real, and audits it', async () => {
    const id = await makeUser(test, { email: 'bo@lab.example', name: 'Bo' });
    const client = await new Client(test).signIn('bo@lab.example');
    const res = await client.patch('/api/profile', { name: '  Bo Lindqvist  ', bio: ' Studies efflux. ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Bo Lindqvist', bio: 'Studies efflux.' });
    expect(await profileOf(client)).toMatchObject({ name: 'Bo Lindqvist', bio: 'Studies efflux.' });
    expect((await (await client.get('/api/session')).json()).user.name).toBe('Bo Lindqvist');
    expect(await test.ctx.db.get(`SELECT detail FROM audit_log WHERE action = 'profile.updated' AND actor_id = ?`, [id])).toEqual({ detail: JSON.stringify({ nameChanged: true, bioChanged: true }) });
  });

  it('refuses an empty name and an oversized bio, on their fields, and changes nothing', async () => {
    await makeUser(test, { email: 'bo@lab.example', name: 'Bo' });
    const client = await new Client(test).signIn('bo@lab.example');
    const res = await client.patch('/api/profile', { name: '  ', bio: 'x'.repeat(1001) });
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(Object.keys(error.fields).sort()).toEqual(['bio', 'name']);
    expect((await profileOf(client)).name).toBe('Bo');
  });

  it('cannot change an email address', async () => {
    await makeUser(test, { email: 'bo@lab.example', name: 'Bo' });
    const client = await new Client(test).signIn('bo@lab.example');
    await client.patch('/api/profile', { name: 'Bo', bio: '', email: 'attacker@lab.example', role: 'admin' });
    expect(await profileOf(client)).toMatchObject({ email: 'bo@lab.example', accountRole: 'member' });
  });
});

describe('authorized AI clients', () => {
  async function seededToken(app: TestApp, overrides: { userEmail?: string; expiresAt?: string; revokedAt?: string | null } = {}) {
    const user = (await app.ctx.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [overrides.userEmail ?? 'maya@helixlab.example'])) as { id: string };
    const version = (await app.ctx.db.get<{ id: string; task_id: string }>(`SELECT tv.id, tv.task_id FROM task_versions tv JOIN tasks t ON t.id = tv.task_id WHERE t.code = 'BIO-042'`)) as { id: string; task_id: string };
    const suffix = Math.random().toString(36).slice(2);
    const clientId = `client-${suffix}`;
    const now = app.ctx.now().toISOString();
    const scopes = JSON.stringify(['tasks:read', 'reports:read', 'advisor:query']);
    await app.ctx.db.run(`INSERT INTO oauth_clients (id, client_id, name, developer, description, redirect_uri, created_at) VALUES (?, ?, 'Test Research Client', 'Test Tools', 'For this test.', 'http://localhost/cb', ?)`, [clientId, clientId, now]);
    await app.ctx.db.run(
      `INSERT INTO oauth_requests (id, code, client_id, user_id, scopes, resource, task_id, task_version_id, redirect_uri, state, code_challenge, code_challenge_method, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'task:BIO-042', ?, ?, 'http://localhost/cb', ?, 'c', 'S256', 'approved', ?, ?)`,
      [`req-${suffix}`, `OAUTH-${suffix}`, clientId, user.id, scopes, version.task_id, version.id, `s-${suffix}`, now, now],
    );
    const tokenId = `token-${suffix}`;
    await app.ctx.db.run(
      `INSERT INTO oauth_tokens (id, request_id, client_id, user_id, token_hash, scopes, task_version_id, issued_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tokenId, `req-${suffix}`, clientId, user.id, `hash-${suffix}`, scopes, version.id, now, overrides.expiresAt ?? new Date(app.ctx.now().getTime() + 3_600_000).toISOString(), overrides.revokedAt ?? null],
    );
    return tokenId;
  }

  it('lists live tokens as the frame prints them, and never revoked or expired ones', async () => {
    const seeded = await makeTestApp({ seed: true });
    const maya = await new Client(seeded).signIn('maya@helixlab.example');
    const before = (await profileOf(maya)).aiClients.length;
    const live = await seededToken(seeded);
    await seededToken(seeded, { revokedAt: seeded.ctx.now().toISOString() });
    await seededToken(seeded, { expiresAt: new Date(seeded.ctx.now().getTime() - 1000).toISOString() });
    const clients = (await profileOf(maya)).aiClients;
    expect(clients).toHaveLength(before + 1);
    expect(clients.find((row: { id: string }) => row.id === live)).toMatchObject({ clientName: 'Test Research Client', resource: 'BIO-042 only', access: 'Read/query', scopes: ['tasks:read', 'reports:read', 'advisor:query'] });

    const samira = await new Client(seeded).signIn('samira@northbridge.example');
    expect((await profileOf(samira)).aiClients.find((row: { id: string }) => row.id === live)).toBeUndefined();
    seeded.close();
  });
});
