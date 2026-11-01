import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canCreateInWorkspace, canReadTask, workspaceRole } from '../../server/lib/permissions.ts';
import type { UserRow } from '../../server/context.ts';
import { Client, lastMail, makeTestApp, makeUser, makeWorkspace, type TestApp } from '../helpers/app.ts';

let test: TestApp;

beforeEach(async () => {
  test = await makeTestApp();
});
afterEach(() => test.close());

const createBody = (overrides: Record<string, unknown> = {}) => ({ name: 'Helix Lab', slug: 'helix-lab', researchFocus: 'Evidence-grounded evaluation.', defaultVisibility: 'private', keepPrivate: true, ...overrides });

async function signedIn(email: string, spec: { name?: string; role?: 'member' | 'admin'; verified?: boolean } = {}) {
  const id = await makeUser(test, { email, ...spec });
  return { id, client: await new Client(test).signIn(email) };
}

const auditActions = async (app: TestApp, workspaceId: string) => (await app.ctx.db.all<{ action: string }>('SELECT action FROM audit_log WHERE workspace_id = ? ORDER BY created_at, rowid', [workspaceId])).map((row) => row.action);

const tokenFromMail = async (app: TestApp, email: string) => {
  const mail = await lastMail(app, email);
  return new URL(mail?.link as string).pathname.split('/').pop() as string;
};

/** Owner plus a sent invitation; returns what the tests need. */
async function invited(email = 'invitee@lab.example', role = 'member') {
  const owner = await signedIn('owner@lab.example', { name: 'Olive Owner' });
  const workspaceId = await makeWorkspace(test, owner.id, 'Test Lab');
  const res = await owner.client.post(`/api/workspaces/${workspaceId}/invitations`, { email, role });
  expect(res.status).toBe(201);
  const invitation = await res.json();
  return { owner, workspaceId, invitation, token: await tokenFromMail(test, email.toLowerCase()) };
}

const sessionOf = async (client: Client) => (await (await client.get('/api/session')).json()).user;
const currentOf = async (client: Client) => (await client.get('/api/workspaces/current')).json();

describe('creating a workspace', () => {
  it('makes the creator owner, makes it active, derives the code and records it', async () => {
    const { id, client } = await signedIn('maya@lab.example', { name: 'Maya Chen' });
    const res = await client.post('/api/workspaces', createBody());
    expect(res.status).toBe(201);
    const { workspace } = await res.json();
    expect(workspace).toMatchObject({ code: 'WS-HELIX', name: 'Helix Lab', slug: 'helix-lab', url: 'localhost:8787/w/helix-lab', defaultVisibility: 'private', ownerName: 'Maya Chen' });

    expect(await workspaceRole(test.ctx, id, workspace.id)).toBe('owner');
    const session = await sessionOf(client);
    expect(session.workspace).toMatchObject({ id: workspace.id, code: 'WS-HELIX', role: 'owner' });
    expect(await auditActions(test, workspace.id)).toEqual(['workspace.created']);
  });

  it('refuses a signed-out visitor and an unverified account', async () => {
    expect((await new Client(test).post('/api/workspaces', createBody())).status).toBe(401);
    const { client } = await signedIn('new@lab.example', { verified: false });
    const res = await client.post('/api/workspaces', createBody());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('email_unverified');
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM workspaces')).toBeUndefined();
  });

  it('checks slug availability live, using the configured host', async () => {
    const { client } = await signedIn('maya@lab.example');
    const check = async (slug: string) => (await client.get(`/api/workspaces/slug-check?slug=${encodeURIComponent(slug)}`)).json();

    expect(await check('')).toMatchObject({ status: 'empty', host: 'localhost:8787', code: null });
    expect(await check('helix-lab')).toMatchObject({ status: 'available', host: 'localhost:8787', code: 'WS-HELIX', reason: null });
    for (const bad of ['ab', 'has space', 'UPPER_case!', '-leading', 'trailing-', 'double--hyphen', 'a'.repeat(49)]) {
      expect((await check(bad)).status).toBe('invalid');
    }

    await client.post('/api/workspaces', createBody());
    const taken = await check('helix-lab');
    expect(taken.status).toBe('taken');
    expect(taken.reason).toMatch(/taken/);
    expect(await new Client(test).get('/api/workspaces/slug-check?slug=helix-lab').then((res) => res.status)).toBe(401);
  });

  it('refuses a slug collision on the field and leaves everything unchanged', async () => {
    const first = await signedIn('maya@lab.example');
    await first.client.post('/api/workspaces', createBody());
    const second = await signedIn('other@lab.example');
    const res = await second.client.post('/api/workspaces', createBody({ name: 'Another Helix' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields.slug).toMatch(/taken/);
    expect((await test.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces'))?.n).toBe(1);
    expect((await sessionOf(second.client)).workspace).toBeNull();
  });

  it('falls back to a longer code when the short one is in use', async () => {
    const { client } = await signedIn('maya@lab.example');
    const code = async (slug: string) => (await (await client.post('/api/workspaces', createBody({ slug }))).json()).workspace.code;
    expect(await code('helix-lab')).toBe('WS-HELIX');
    expect(await code('helix-bio')).toBe('WS-HELIX-BIO');
    expect(await code('helix')).toBe('WS-HELIX-2');
  });

  it('reports each problem on its own field', async () => {
    const { client } = await signedIn('maya@lab.example');
    const res = await client.post('/api/workspaces', { name: ' ', slug: 'No Good', researchFocus: 'x'.repeat(501), defaultVisibility: 'everyone' });
    expect(res.status).toBe(422);
    expect(Object.keys((await res.json()).error.fields).sort()).toEqual(['defaultVisibility', 'name', 'researchFocus', 'slug']);
  });

  it('never stores shared while the privacy box is ticked, and stores it when unticked', async () => {
    const { client } = await signedIn('maya@lab.example');
    const refused = await client.post('/api/workspaces', createBody({ defaultVisibility: 'shared', keepPrivate: true }));
    expect(refused.status).toBe(422);
    expect((await refused.json()).error.fields.keepPrivate).toBeTruthy();

    const res = await client.post('/api/workspaces', createBody({ defaultVisibility: 'shared', keepPrivate: false }));
    expect(res.status).toBe(201);
    expect((await res.json()).workspace.defaultVisibility).toBe('shared');
  });
});

describe('switching workspace', () => {
  it('moves the active workspace to one the person belongs to', async () => {
    const { id, client } = await signedIn('maya@lab.example');
    const first = await makeWorkspace(test, id, 'First Lab');
    const second = await makeWorkspace(test, id, 'Second Lab');
    expect((await sessionOf(client)).workspace.id).toBe(second);
    const res = await client.post('/api/workspaces/switch', { workspaceId: first });
    expect(res.status).toBe(200);
    expect((await sessionOf(client)).workspace.id).toBe(first);
    expect((await currentOf(client)).workspace.name).toBe('First Lab');
  });

  it('gives the same refusal for a stranger, an unknown id and a removed member', async () => {
    const owner = await signedIn('owner@lab.example');
    const workspaceId = await makeWorkspace(test, owner.id);
    const { id: strangerId, client: stranger } = await signedIn('stranger@lab.example');
    const before = await sessionOf(stranger);

    const notMine = await stranger.post('/api/workspaces/switch', { workspaceId });
    const unknown = await stranger.post('/api/workspaces/switch', { workspaceId: 'no-such-workspace' });
    expect(notMine.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect((await notMine.json()).error.message).toBe((await unknown.json()).error.message);

    await test.ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, removed_at) VALUES ('m1', ?, ?, 'member', 'removed', ?, ?)`, [workspaceId, strangerId, test.ctx.now().toISOString(), test.ctx.now().toISOString()]);
    expect((await stranger.post('/api/workspaces/switch', { workspaceId })).status).toBe(403);
    expect((await sessionOf(stranger)).workspace).toEqual(before.workspace);
    expect((await stranger.post('/api/workspaces/switch', {})).status).toBe(422);
    expect((await new Client(test).post('/api/workspaces/switch', { workspaceId })).status).toBe(401);
  });
});

describe('workspace URLs', () => {
  it('opens for members and reads as not found for everyone else', async () => {
    const owner = await signedIn('owner@lab.example');
    await owner.client.post('/api/workspaces', createBody());
    const ok = await owner.client.get('/api/workspaces/by-slug/helix-lab');
    expect(ok.status).toBe(200);
    expect((await ok.json()).code).toBe('WS-HELIX');

    const { client: stranger } = await signedIn('stranger@lab.example');
    const mine = await stranger.get('/api/workspaces/by-slug/helix-lab');
    const none = await stranger.get('/api/workspaces/by-slug/no-such-lab');
    expect(mine.status).toBe(404);
    expect(none.status).toBe(404);
    expect((await mine.json()).error.message).toBe((await none.json()).error.message);
  });
});

describe('the members page', () => {
  it('shows an owner what they can do', async () => {
    const { owner, workspaceId } = await invited();
    const data = await currentOf(owner.client);
    expect(data.workspace.id).toBe(workspaceId);
    expect(data.viewerRole).toBe('owner');
    expect(data.manage).toEqual({ allowed: true });
    expect(data.members).toHaveLength(1);
    expect(data.members[0]).toMatchObject({ name: 'Olive Owner', role: 'owner', email: 'owner@lab.example', isSelf: true, remove: { allowed: false, reason: 'You cannot remove yourself' } });
    expect(data.invitations).toHaveLength(1);
    expect(data.invitations[0]).toMatchObject({ email: 'invitee@lab.example', role: 'member', state: 'sent', invitedBy: 'Olive Owner', revoke: { allowed: true } });
  });

  it('is read-only with the reason for a member', async () => {
    const { token } = await invited();
    const { client } = await signedIn('invitee@lab.example');
    expect((await client.post(`/api/invitations/${token}/accept`)).status).toBe(200);
    const data = await currentOf(client);
    expect(data.viewerRole).toBe('member');
    expect(data.manage).toEqual({ allowed: false, reason: 'Workspace owner only' });
    for (const row of data.members) expect(row.remove.allowed).toBe(false);
    expect(data.members.find((row: { isSelf: boolean }) => !row.isSelf).remove.reason).toBe('Workspace owner only');
  });

  it('has a state for someone with no workspace', async () => {
    const { client } = await signedIn('alone@lab.example');
    expect(await currentOf(client)).toEqual({ workspace: null, viewerRole: null, manage: { allowed: false, reason: 'Workspace owner only' }, members: [], invitations: [] });
  });

  it('is refused signed out and unverified', async () => {
    expect((await new Client(test).get('/api/workspaces/current')).status).toBe(401);
    const { client } = await signedIn('new@lab.example', { verified: false });
    expect((await client.get('/api/workspaces/current')).status).toBe(403);
  });
});

describe('sending invitations', () => {
  it('stores only the hash, mails a one-time link and audits the send', async () => {
    const { workspaceId, invitation, token } = await invited('Invitee@Lab.Example');
    expect(invitation).toMatchObject({ email: 'invitee@lab.example', role: 'member' });

    const row = await test.ctx.db.get<{ token_hash: string; status: string; expires_at: string; email: string }>('SELECT token_hash, status, expires_at, email FROM invitations WHERE id = ?', [invitation.id]);
    expect(row?.status).toBe('sent');
    expect(row?.email).toBe('invitee@lab.example');
    expect(row?.token_hash).not.toContain(token);
    const days = (new Date(row?.expires_at as string).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    const mail = await lastMail(test, 'invitee@lab.example');
    expect(mail?.purpose).toBe('invitation');
    expect(mail?.subject).toContain('Test Lab');
    expect(mail?.link).toBe(`http://localhost:8787/invitations/${token}`);
    expect(mail?.body_text).toContain(mail?.link);
    expect(await auditActions(test, workspaceId)).toEqual(['workspace.invitation_sent']);
  });

  it('refuses a member who is not an owner, a stranger and an admin outside the workspace', async () => {
    const { workspaceId, token } = await invited();
    const { client: member } = await signedIn('invitee@lab.example');
    await member.post(`/api/invitations/${token}/accept`);
    const { client: stranger } = await signedIn('stranger@lab.example');
    const { client: admin } = await signedIn('admin@lab.example', { role: 'admin' });

    for (const client of [member, stranger, admin]) {
      const res = await client.post(`/api/workspaces/${workspaceId}/invitations`, { email: 'friend@lab.example', role: 'member' });
      expect(res.status).toBe(403);
      expect((await res.json()).error.message).toBe('Workspace owner only');
    }
    expect(await lastMail(test, 'friend@lab.example')).toBeUndefined();
    expect((await test.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invitations WHERE email = 'friend@lab.example'`))?.n).toBe(0);
    expect((await new Client(test).post(`/api/workspaces/${workspaceId}/invitations`, { email: 'friend@lab.example', role: 'member' })).status).toBe(401);
  });

  it('refuses an address already in the workspace or already invited', async () => {
    const { owner, workspaceId } = await invited();
    const again = await owner.client.post(`/api/workspaces/${workspaceId}/invitations`, { email: 'invitee@lab.example', role: 'member' });
    expect(again.status).toBe(422);
    expect((await again.json()).error.fields.email).toMatch(/already pending/);
    const self = await owner.client.post(`/api/workspaces/${workspaceId}/invitations`, { email: 'owner@lab.example', role: 'member' });
    expect(self.status).toBe(422);
    expect((await self.json()).error.fields.email).toMatch(/already a member/);
  });

  it('validates the address and the role', async () => {
    const { owner, workspaceId } = await invited();
    const res = await owner.client.post(`/api/workspaces/${workspaceId}/invitations`, { email: 'nope', role: 'admin' });
    expect(res.status).toBe(422);
    expect(Object.keys((await res.json()).error.fields).sort()).toEqual(['email', 'role']);
  });

  it('lets a lapsed invitation be replaced', async () => {
    test.setNow('2026-10-15T13:00:00Z');
    const { owner, workspaceId, token } = await invited();
    test.setNow('2026-10-23T13:00:00Z');
    expect((await currentOf(owner.client)).invitations[0].state).toBe('expired');
    const res = await owner.client.post(`/api/workspaces/${workspaceId}/invitations`, { email: 'invitee@lab.example', role: 'member' });
    expect(res.status).toBe(201);
    const rows = (await currentOf(owner.client)).invitations;
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('sent');
    expect(await tokenFromMail(test, 'invitee@lab.example')).not.toBe(token);
  });

  it('does not report success when the mail cannot be delivered', async () => {
    const locked = await makeTestApp({ config: { allowDevOutbox: false } });
    const ownerId = await makeUser(locked, { email: 'owner@lab.example' });
    const workspaceId = await makeWorkspace(locked, ownerId);
    const client = await new Client(locked).signIn('owner@lab.example');
    const res = await client.post(`/api/workspaces/${workspaceId}/invitations`, { email: 'invitee@lab.example', role: 'member' });
    expect(res.status).toBe(503);
    expect((await (await client.get('/api/workspaces/current')).json()).invitations).toEqual([]);
    expect((await locked.ctx.db.get<{ status: string }>('SELECT status FROM invitations'))?.status).toBe('revoked');
    expect(await auditActions(locked, workspaceId)).toEqual(['workspace.invitation_sent', 'workspace.invitation_failed']);
    locked.close();
  });

  it('previews what the form would do, for owners only', async () => {
    const seeded = await makeTestApp({ seed: true });
    const maya = await new Client(seeded).signIn('maya@helixlab.example');
    const { id: workspaceId } = (await (await maya.get('/api/session')).json()).user.workspace;
    const preview = async (client: Client, email: string) => client.post(`/api/workspaces/${workspaceId}/invitations/preview`, { email });

    expect(await (await preview(maya, 'SAMIRA@northbridge.example')).json()).toEqual({ email: 'samira@northbridge.example', name: 'Dr. Samira Patel', credentials: ['Biology'], state: 'new' });
    expect(await (await preview(maya, 'nobody@lab.example')).json()).toEqual({ email: 'nobody@lab.example', name: null, credentials: [], state: 'new' });
    expect((await (await preview(maya, 'maya@helixlab.example')).json()).state).toBe('member');

    // An account that never proved its address must not be named through this form.
    await makeUser(seeded, { email: 'unproven@lab.example', name: 'Unproven Person', verified: false });
    expect((await (await preview(maya, 'unproven@lab.example')).json()).name).toBeNull();

    const samira = await new Client(seeded).signIn('samira@northbridge.example');
    const refused = await preview(samira, 'alex@rivet.example');
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).not.toContain('Alex');
    expect((await preview(new Client(seeded), 'alex@rivet.example')).status).toBe(401);

    await maya.post(`/api/workspaces/${workspaceId}/invitations`, { email: 'samira@northbridge.example', role: 'member' });
    expect((await (await preview(maya, 'samira@northbridge.example')).json()).state).toBe('pending');
    seeded.close();
  });

  it('rate limits lookups', async () => {
    const owner = await signedIn('owner@lab.example');
    const workspaceId = await makeWorkspace(test, owner.id);
    for (let i = 0; i < 60; i++) await owner.client.post(`/api/workspaces/${workspaceId}/invitations/preview`, { email: `person${i}@lab.example` });
    expect((await owner.client.post(`/api/workspaces/${workspaceId}/invitations/preview`, { email: 'one-more@lab.example' })).status).toBe(429);
  });
});

describe('revoking invitations', () => {
  it('stops the link working', async () => {
    const { owner, workspaceId, invitation, token } = await invited();
    const res = await owner.client.post(`/api/workspaces/${workspaceId}/invitations/${invitation.id}/revoke`);
    expect(res.status).toBe(200);
    expect((await currentOf(owner.client)).invitations).toEqual([]);
    expect(await auditActions(test, workspaceId)).toContain('workspace.invitation_revoked');

    const { id, client } = await signedIn('invitee@lab.example');
    const accepted = await client.post(`/api/invitations/${token}/accept`);
    expect(accepted.status).toBe(400);
    expect((await accepted.json()).error.code).toBe('invitation_revoked');
    expect(await workspaceRole(test.ctx, id, workspaceId)).toBeNull();
    expect((await (await client.get(`/api/invitations/${token}`)).json()).state).toBe('revoked');
  });

  it('is owner only, and only for this workspace and an open invitation', async () => {
    const { owner, workspaceId, invitation, token } = await invited();
    const { client: stranger } = await signedIn('stranger@lab.example');
    expect((await stranger.post(`/api/workspaces/${workspaceId}/invitations/${invitation.id}/revoke`)).status).toBe(403);

    const otherWorkspace = await makeWorkspace(test, owner.id, 'Other Lab');
    expect((await owner.client.post(`/api/workspaces/${otherWorkspace}/invitations/${invitation.id}/revoke`)).status).toBe(404);

    const { client: invitee } = await signedIn('invitee@lab.example');
    await invitee.post(`/api/invitations/${token}/accept`);
    const closed = await owner.client.post(`/api/workspaces/${workspaceId}/invitations/${invitation.id}/revoke`);
    expect(closed.status).toBe(400);
    expect((await closed.json()).error.code).toBe('invitation_closed');
  });
});

describe('accepting invitations', () => {
  it('shows anyone holding the link what it is, without changing anything', async () => {
    const { token, invitation } = await invited();
    const view = await (await new Client(test).get(`/api/invitations/${token}`)).json();
    expect(view).toMatchObject({ state: 'valid', workspaceName: 'Test Lab', invitedBy: 'Olive Owner', email: 'invitee@lab.example', role: 'member', viewer: { signedIn: false, email: null, emailMatches: false } });
    expect(view.accept.allowed).toBe(false);
    expect(view.accept.reason).toMatch(/Sign in/);
    expect((await test.ctx.db.get<{ status: string }>('SELECT status FROM invitations WHERE id = ?', [invitation.id]))?.status).toBe('sent');
    expect((await new Client(test).get('/api/invitations/not-a-real-token')).status).toBe(404);
  });

  it('creates the membership for a verified account with that exact address', async () => {
    const { workspaceId, token, invitation } = await invited();
    const { id, client } = await signedIn('invitee@lab.example');
    const view = await (await client.get(`/api/invitations/${token}`)).json();
    expect(view.accept).toEqual({ allowed: true });
    expect(view.viewer).toEqual({ signedIn: true, email: 'invitee@lab.example', emailVerified: true, emailMatches: true });

    const res = await client.post(`/api/invitations/${token}/accept`);
    expect(res.status).toBe(200);
    expect(await workspaceRole(test.ctx, id, workspaceId)).toBe('member');
    expect((await sessionOf(client)).workspace.id).toBe(workspaceId);
    expect(await test.ctx.db.get('SELECT status, accepted_by FROM invitations WHERE id = ?', [invitation.id])).toEqual({ status: 'accepted', accepted_by: id });
    expect(await auditActions(test, workspaceId)).toEqual(['workspace.invitation_sent', 'workspace.invitation_accepted', 'workspace.member_added']);
    expect((await canCreateInWorkspace(test.ctx, (await test.ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [id])) as UserRow, workspaceId)).allowed).toBe(true);
  });

  it('refuses a different email, records it, and leaves the link usable by the right person', async () => {
    const { workspaceId, token } = await invited();
    const wrong = await signedIn('someone-else@lab.example');
    const view = await (await wrong.client.get(`/api/invitations/${token}`)).json();
    expect(view.accept.allowed).toBe(false);
    expect(view.accept.reason).toMatch(/different email/);
    expect(view.viewer.emailMatches).toBe(false);

    const res = await wrong.client.post(`/api/invitations/${token}/accept`);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('wrong_email');
    expect(await workspaceRole(test.ctx, wrong.id, workspaceId)).toBeNull();
    expect((await sessionOf(wrong.client)).workspace).toBeNull();
    expect(await auditActions(test, workspaceId)).toContain('workspace.invitation_refused');

    const right = await signedIn('invitee@lab.example');
    expect((await right.client.post(`/api/invitations/${token}/accept`)).status).toBe(200);
  });

  it('refuses an unverified account with the right address until it is verified', async () => {
    const { workspaceId, token } = await invited();
    const { id, client } = await signedIn('invitee@lab.example', { verified: false });
    expect((await (await client.get(`/api/invitations/${token}`)).json()).accept.reason).toMatch(/Verify/);
    const res = await client.post(`/api/invitations/${token}/accept`);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('email_unverified');
    expect(await workspaceRole(test.ctx, id, workspaceId)).toBeNull();

    await test.ctx.db.run('UPDATE users SET email_verified_at = ? WHERE id = ?', [test.ctx.now().toISOString(), id]);
    expect((await client.post(`/api/invitations/${token}/accept`)).status).toBe(200);
  });

  it('refuses a signed-out visitor', async () => {
    const { token } = await invited();
    expect((await new Client(test).post(`/api/invitations/${token}/accept`)).status).toBe(401);
  });

  it('expires after seven days, to the second', async () => {
    test.setNow('2026-10-15T13:00:00Z');
    const { workspaceId, token } = await invited();
    const { id, client } = await signedIn('invitee@lab.example');

    test.setNow('2026-10-22T13:00:00Z');
    const view = await (await client.get(`/api/invitations/${token}`)).json();
    expect(view.state).toBe('expired');
    expect(view.accept.reason).toMatch(/expired/);
    const res = await client.post(`/api/invitations/${token}/accept`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invitation_expired');
    expect(await workspaceRole(test.ctx, id, workspaceId)).toBeNull();

    test.setNow('2026-10-22T12:59:59Z');
    expect((await client.post(`/api/invitations/${token}/accept`)).status).toBe(200);
  });

  it('works once', async () => {
    const { token } = await invited();
    const { client } = await signedIn('invitee@lab.example');
    expect((await client.post(`/api/invitations/${token}/accept`)).status).toBe(200);
    const again = await client.post(`/api/invitations/${token}/accept`);
    expect(again.status).toBe(400);
    expect((await again.json()).error.code).toBe('invitation_used');
    expect((await (await client.get(`/api/invitations/${token}`)).json()).state).toBe('accepted');
  });

  it('grants the invited role, so an invited owner can manage members', async () => {
    const { workspaceId, token } = await invited('coowner@lab.example', 'owner');
    const { client } = await signedIn('coowner@lab.example');
    await client.post(`/api/invitations/${token}/accept`);
    const data = await currentOf(client);
    expect(data.viewerRole).toBe('owner');
    expect(data.manage).toEqual({ allowed: true });
    expect((await client.post(`/api/workspaces/${workspaceId}/invitations`, { email: 'friend@lab.example', role: 'member' })).status).toBe(201);
  });
});

describe('removing a member', () => {
  async function withMember() {
    const context = await invited();
    const member = await signedIn('invitee@lab.example', { name: 'Ivy Invitee' });
    expect((await member.client.post(`/api/invitations/${context.token}/accept`)).status).toBe(200);
    return { ...context, member };
  }

  it('revokes access on the very next request', async () => {
    const { owner, workspaceId, member } = await withMember();
    const memberRow = await test.ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [member.id]);
    const taskId = 'task-private';
    const now = test.ctx.now().toISOString();
    await test.ctx.db.run(`INSERT INTO tasks (id, code, workspace_id, owner_id, domain_id, title, visibility, status, created_at, updated_at) VALUES (?, 'BIO-900', ?, ?, 'biology', 'Private task', 'private', 'draft', ?, ?)`, [taskId, workspaceId, owner.id, now, now]);
    const task = { id: taskId, code: 'BIO-900', workspace_id: workspaceId, owner_id: owner.id, domain_id: 'biology', visibility: 'private' as const, status: 'draft' as const };
    expect((await canReadTask(test.ctx, memberRow as UserRow, task)).allowed).toBe(true);
    expect((await currentOf(member.client)).workspace.id).toBe(workspaceId);

    const res = await owner.client.post(`/api/workspaces/${workspaceId}/members/${member.id}/remove`);
    expect(res.status).toBe(200);

    // The member's existing session is untouched; only their access is gone.
    const data = await currentOf(member.client);
    expect(data.workspace).toBeNull();
    expect((await sessionOf(member.client)).workspaces).toEqual([]);
    expect((await member.client.post('/api/workspaces/switch', { workspaceId })).status).toBe(403);
    expect((await member.client.post(`/api/workspaces/${workspaceId}/invitations`, { email: 'x@lab.example', role: 'member' })).status).toBe(403);
    const fresh = (await test.ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [member.id])) as UserRow;
    expect(fresh.active_workspace_id).toBeNull();
    expect((await canReadTask(test.ctx, fresh, task)).allowed).toBe(false);
    expect((await canCreateInWorkspace(test.ctx, fresh, workspaceId)).allowed).toBe(false);

    expect((await currentOf(owner.client)).members.map((row: { userId: string }) => row.userId)).toEqual([owner.id]);
    expect(await auditActions(test, workspaceId)).toContain('workspace.member_removed');
    const status = await test.ctx.db.get<{ status: string; removed_at: string | null }>('SELECT status, removed_at FROM memberships WHERE workspace_id = ? AND user_id = ?', [workspaceId, member.id]);
    expect(status?.status).toBe('removed');
    expect(status?.removed_at).toBeTruthy();
  });

  it('moves a removed member to their other workspace', async () => {
    const { owner, workspaceId, member } = await withMember();
    const own = await makeWorkspace(test, member.id, 'Own Lab');
    await member.client.post('/api/workspaces/switch', { workspaceId });
    await owner.client.post(`/api/workspaces/${workspaceId}/members/${member.id}/remove`);
    expect((await sessionOf(member.client)).workspace.id).toBe(own);
    expect((await currentOf(member.client)).workspace.name).toBe('Own Lab');
  });

  it('is refused for non-owners, for yourself, for the creator and for strangers to the workspace', async () => {
    const { owner, workspaceId, member } = await withMember();
    const refused = await member.client.post(`/api/workspaces/${workspaceId}/members/${owner.id}/remove`);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.message).toBe('Workspace owner only');
    expect((await member.client.post(`/api/workspaces/${workspaceId}/members/${member.id}/remove`)).status).toBe(403);

    const self = await owner.client.post(`/api/workspaces/${workspaceId}/members/${owner.id}/remove`);
    expect(self.status).toBe(403);
    expect((await self.json()).error.message).toMatch(/yourself/);

    const co = await owner.client.post(`/api/workspaces/${workspaceId}/invitations`, { email: 'co@lab.example', role: 'owner' });
    expect(co.status).toBe(201);
    const coOwner = await signedIn('co@lab.example');
    await coOwner.client.post(`/api/invitations/${await tokenFromMail(test, 'co@lab.example')}/accept`);
    const creator = await coOwner.client.post(`/api/workspaces/${workspaceId}/members/${owner.id}/remove`);
    expect(creator.status).toBe(403);
    expect((await creator.json()).error.message).toMatch(/creator/);
    expect(await workspaceRole(test.ctx, owner.id, workspaceId)).toBe('owner');

    const { id: outsiderId } = await signedIn('outsider@lab.example');
    expect((await owner.client.post(`/api/workspaces/${workspaceId}/members/${outsiderId}/remove`)).status).toBe(404);
    expect(await workspaceRole(test.ctx, member.id, workspaceId)).toBe('member');
  });

  it('does not let the old link back in, but a new invitation does', async () => {
    const { owner, workspaceId, member, token } = await withMember();
    await owner.client.post(`/api/workspaces/${workspaceId}/members/${member.id}/remove`);
    const old = await member.client.post(`/api/invitations/${token}/accept`);
    expect(old.status).toBe(400);
    expect(await workspaceRole(test.ctx, member.id, workspaceId)).toBeNull();

    await owner.client.post(`/api/workspaces/${workspaceId}/invitations`, { email: 'invitee@lab.example', role: 'member' });
    const fresh = await tokenFromMail(test, 'invitee@lab.example');
    expect((await member.client.post(`/api/invitations/${fresh}/accept`)).status).toBe(200);
    expect(await workspaceRole(test.ctx, member.id, workspaceId)).toBe('member');
    expect((await test.ctx.db.get<{ removed_at: string | null }>('SELECT removed_at FROM memberships WHERE workspace_id = ? AND user_id = ?', [workspaceId, member.id]))?.removed_at).toBeNull();
  });
});

describe('removal against the routes that hold private work', () => {
  it('a member reads Helix Lab private tasks and datasets until the moment they are removed', async () => {
    const seeded = await makeTestApp({ seed: true });
    const maya = await new Client(seeded).signIn('maya@helixlab.example');
    const { id: helix } = (await (await maya.get('/api/session')).json()).user.workspace;
    const memberId = await makeUser(seeded, { email: 'member@lab.example', name: 'Mo Member' });
    const member = await new Client(seeded).signIn('member@lab.example');

    // Nothing before joining.
    expect((await member.get('/api/tasks/BIO-043')).status).toBe(404);
    expect((await member.get('/api/datasets/DS-BIO-07')).status).toBe(404);

    await maya.post(`/api/workspaces/${helix}/invitations`, { email: 'member@lab.example', role: 'member' });
    const token = await tokenFromMail(seeded, 'member@lab.example');
    expect((await member.post(`/api/invitations/${token}/accept`)).status).toBe(200);
    expect((await member.get('/api/tasks/BIO-043')).status).toBe(200);
    expect((await member.get('/api/datasets/DS-BIO-07')).status).toBe(200);

    expect((await maya.post(`/api/workspaces/${helix}/members/${memberId}/remove`)).status).toBe(200);
    expect((await member.get('/api/tasks/BIO-043')).status).toBe(404);
    expect((await member.get('/api/datasets/DS-BIO-07')).status).toBe(404);
    seeded.close();
  });
});

describe('the seeded members frame', () => {
  it('reads as the frame does, with nothing sent to Dr. Patel yet', async () => {
    const seeded = await makeTestApp({ seed: true });
    const maya = await new Client(seeded).signIn('maya@helixlab.example');
    const data = await (await maya.get('/api/workspaces/current')).json();
    expect(data.workspace).toMatchObject({ name: 'Helix Lab', code: 'WS-HELIX', ownerName: 'Maya Chen', slug: 'helix-lab' });
    expect(data.viewerRole).toBe('owner');
    expect(data.members.map((row: { name: string; role: string; email: string }) => [row.name, row.role, row.email])).toEqual([['Maya Chen', 'owner', 'maya@helixlab.example']]);
    expect(data.invitations).toEqual([]);
    expect(await seeded.ctx.db.get(`SELECT 1 AS ok FROM invitations WHERE email = 'samira@northbridge.example'`)).toBeUndefined();
    seeded.close();
  });
});
