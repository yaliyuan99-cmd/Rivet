import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, lastMail, makeTestApp, makeUser, type TestApp } from '../helpers/app.ts';

let test: TestApp;

beforeEach(async () => {
  test = await makeTestApp();
});
afterEach(() => test.close());

const signup = (client: Client, overrides: Record<string, unknown> = {}) =>
  client.post('/api/auth/signup', { name: 'Ada Lane', email: 'ada@lab.example', password: 'correct-horse-battery', acceptTerms: true, ...overrides });

const tokenFrom = (link: string | null | undefined) => new URL(link as string).searchParams.get('token') as string;

describe('sign up and verification', () => {
  it('creates an unverified account, mails a link, and unlocks on verification', async () => {
    const client = new Client(test);
    expect((await signup(client)).status).toBe(201);

    let session = await (await client.get('/api/session')).json();
    expect(session.user.emailVerified).toBe(false);

    const mail = await lastMail(test, 'ada@lab.example');
    expect(mail?.purpose).toBe('verify');

    const verified = await client.post('/api/auth/verify', { token: tokenFrom(mail?.link) });
    expect(verified.status).toBe(200);
    session = await (await client.get('/api/session')).json();
    expect(session.user.emailVerified).toBe(true);
  });

  it('reports each problem on its own field', async () => {
    const res = await signup(new Client(test), { name: '', email: 'nope', password: 'short', acceptTerms: false });
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(Object.keys(error.fields).sort()).toEqual(['acceptTerms', 'email', 'name', 'password']);
  });

  it('refuses a duplicate address', async () => {
    await signup(new Client(test));
    const res = await signup(new Client(test), { email: 'ADA@lab.example' });
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields.email).toMatch(/already exists/);
  });

  it('expires links after 30 minutes and refuses reuse', async () => {
    const client = new Client(test);
    test.setNow('2026-10-15T13:00:00Z');
    await signup(client);
    const token = tokenFrom((await lastMail(test, 'ada@lab.example'))?.link);

    test.setNow('2026-10-15T13:31:00Z');
    const expired = await client.post('/api/auth/verify', { token });
    expect((await expired.json()).error.code).toBe('link_expired');

    test.advance(61_000);
    await client.post('/api/auth/resend');
    const fresh = tokenFrom((await lastMail(test, 'ada@lab.example'))?.link);
    expect((await client.post('/api/auth/verify', { token: fresh })).status).toBe(200);
    const again = await client.post('/api/auth/verify', { token: fresh });
    expect((await again.json()).error.code).toBe('link_used');
  });

  it('enforces the resend cooldown', async () => {
    const client = new Client(test);
    test.setNow('2026-10-15T13:00:00Z');
    await signup(client);
    test.setNow('2026-10-15T13:00:30Z');
    expect((await client.post('/api/auth/resend')).status).toBe(429);
    test.setNow('2026-10-15T13:01:01Z');
    expect((await client.post('/api/auth/resend')).status).toBe(200);
  });

  it('changing email invalidates the old link', async () => {
    const client = new Client(test);
    await signup(client);
    const oldToken = tokenFrom((await lastMail(test, 'ada@lab.example'))?.link);
    expect((await client.post('/api/auth/change-email', { email: 'ada2@lab.example' })).status).toBe(200);
    expect((await client.post('/api/auth/verify', { token: oldToken })).status).toBe(400);
    const fresh = tokenFrom((await lastMail(test, 'ada2@lab.example'))?.link);
    expect((await client.post('/api/auth/verify', { token: fresh })).status).toBe(200);
  });
});

describe('sign in and sessions', () => {
  it('signs in, reads the session, signs out', async () => {
    await makeUser(test, { email: 'bo@lab.example' });
    const client = await new Client(test).signIn('bo@lab.example');
    expect((await (await client.get('/api/session')).json()).user.email).toBe('bo@lab.example');
    await client.post('/api/auth/signout');
    expect((await (await client.get('/api/session')).json()).user).toBeNull();
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    await makeUser(test, { email: 'bo@lab.example' });
    const client = new Client(test);
    const wrong = await client.post('/api/auth/signin', { email: 'bo@lab.example', password: 'wrong-password-1' });
    const unknown = await client.post('/api/auth/signin', { email: 'nobody@lab.example', password: 'wrong-password-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await wrong.json()).error.message).toBe((await unknown.json()).error.message);
  });

  it('rate limits repeated failed sign-ins per account', async () => {
    const client = new Client(test);
    for (let i = 0; i < 10; i++) await client.post('/api/auth/signin', { email: 'bo@lab.example', password: 'wrong-password-1' });
    expect((await client.post('/api/auth/signin', { email: 'bo@lab.example', password: 'wrong-password-1' })).status).toBe(429);
  });

  it('never locks out someone who signs in successfully, and a success clears earlier failures', async () => {
    await makeUser(test, { email: 'bo@lab.example' });
    const client = new Client(test);
    for (let i = 0; i < 15; i++) await client.signIn('bo@lab.example');
    for (let i = 0; i < 9; i++) await client.post('/api/auth/signin', { email: 'bo@lab.example', password: 'wrong-password-1' });
    await client.signIn('bo@lab.example');
    for (let i = 0; i < 9; i++) await client.post('/api/auth/signin', { email: 'bo@lab.example', password: 'wrong-password-1' });
    await client.signIn('bo@lab.example');
  });

  it('rejects writes without the request header', async () => {
    const res = await test.app.request('/api/auth/signout', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('rejects writes from another origin', async () => {
    const res = await test.app.request('/api/auth/signout', { method: 'POST', headers: { 'X-Rivet-Request': '1', Origin: 'https://evil.example', Host: 'localhost:8787' } });
    expect(res.status).toBe(403);
  });
});

describe('password reset', () => {
  it('resets the password and ends every session', async () => {
    await makeUser(test, { email: 'bo@lab.example' });
    const device = await new Client(test).signIn('bo@lab.example');
    const client = new Client(test);
    expect((await client.post('/api/auth/forgot', { email: 'bo@lab.example' })).status).toBe(200);
    const token = tokenFrom((await lastMail(test, 'bo@lab.example'))?.link);
    expect((await client.post('/api/auth/reset', { token, password: 'a-brand-new-password' })).status).toBe(200);

    expect((await (await device.get('/api/session')).json()).user).toBeNull();
    expect((await client.post('/api/auth/signin', { email: 'bo@lab.example', password: 'a-brand-new-password' })).status).toBe(200);
  });

  it('does not reveal whether an account exists', async () => {
    const res = await new Client(test).post('/api/auth/forgot', { email: 'nobody@lab.example' });
    expect(res.status).toBe(200);
    expect(await lastMail(test, 'nobody@lab.example')).toBeUndefined();
  });
});

describe('dev outbox', () => {
  it('is refused when not allowed', async () => {
    const locked = await makeTestApp({ config: { allowDevOutbox: false } });
    expect((await locked.app.request('/api/dev/outbox')).status).toBe(404);
    locked.close();
  });
});

describe('seeded demo story', () => {
  it('loads the backbone and every evidence seal verifies', async () => {
    const seeded = await makeTestApp({ seed: true });
    const { verifyEvidenceRow } = await import('../../server/lib/evidence.ts');
    const rows = await seeded.ctx.db.all<any>('SELECT * FROM evidence');
    expect(rows.map((row) => row.code).sort()).toEqual(['EV-1042-A', 'EV-1042-L', 'EV-1042-M']);
    for (const row of rows) expect(await verifyEvidenceRow(seeded.ctx.db, row)).toBe(true);
    await expect(seeded.ctx.db.run(`UPDATE evidence SET total_score = 100`)).rejects.toThrow(/immutable/);
    await expect(seeded.ctx.db.run(`DELETE FROM reports`)).rejects.toThrow(/immutable/);
    const maya = await new Client(seeded).signIn('maya@helixlab.example');
    const session = await (await maya.get('/api/session')).json();
    expect(session.user.workspace.name).toBe('Helix Lab');
    seeded.close();
  });
});
