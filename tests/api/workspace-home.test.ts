import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../server/lib/ids.ts';
import { Client, lastMail, makeTestApp, makeUser, makeWorkspace, type TestApp } from '../helpers/app.ts';

let test: TestApp;

beforeEach(async () => {
  test = await makeTestApp({ seed: true });
});
afterEach(() => test.close());

const homeOf = async (client: Client) => (await client.get('/api/home')).json();
const signIn = (email: string) => new Client(test).signIn(email);
const idOf = async (email: string) => (await test.ctx.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]))?.id as string;

describe('access', () => {
  it('is refused signed out and unverified', async () => {
    expect((await new Client(test).get('/api/home')).status).toBe(401);
    await makeUser(test, { email: 'new@lab.example', verified: false });
    expect((await (await signIn('new@lab.example')).get('/api/home')).status).toBe(403);
  });
});

describe('first run', () => {
  it('reads as the frame for a brand-new account, from real rows', async () => {
    await makeUser(test, { email: 'new@lab.example', name: 'Ada Lane' });
    const data = await homeOf(await signIn('new@lab.example'));
    expect(data.firstRun).toBe(true);
    expect(data.workspace).toBeNull();
    expect(data.starter).toEqual({ title: 'Assess evidence for an antibiotic resistance mechanism', domain: 'Biology / Microbiology', models: 'Aster 3.2 · Meridian 2.1 · Lumen 4 Mini' });
    expect(data.evaluations).toBe(0);
    expect(data.attention).toEqual([]);
    expect(data.reviewBiology).toEqual({ allowed: false, reason: 'Verified Biology credential required' });
  });

  it('knows when the workspace step is done', async () => {
    const id = await makeUser(test, { email: 'new@lab.example', name: 'Ada Lane' });
    await makeWorkspace(test, id, 'Ada Lab');
    const data = await homeOf(await signIn('new@lab.example'));
    expect(data.firstRun).toBe(true);
    expect(data.workspace).toEqual({ name: 'Ada Lab', role: 'owner', defaultVisibility: 'private' });
  });

  it('ends when the first task exists, even one someone else in the workspace made', async () => {
    const ownerId = await makeUser(test, { email: 'owner@lab.example', name: 'Olive Owner' });
    const workspaceId = await makeWorkspace(test, ownerId, 'Olive Lab');
    const client = await signIn('owner@lab.example');
    expect((await homeOf(client)).firstRun).toBe(true);

    const now = test.ctx.now().toISOString();
    await test.ctx.db.run(`INSERT INTO tasks (id, code, workspace_id, owner_id, domain_id, title, created_at, updated_at) VALUES (?, 'BIO-900', ?, ?, 'biology', '', ?, ?)`, [newId(), workspaceId, ownerId, now, now]);
    const data = await homeOf(client);
    expect(data.firstRun).toBe(false);
    expect(data.counts.tasks).toBe(1);
    expect(data.recentTasks[0]).toMatchObject({ code: 'BIO-900', title: 'Untitled draft', state: 'Draft 0.1', href: '/tasks/BIO-900', isSynthetic: false });
    expect(data.attention[0]).toMatchObject({ kind: 'draft', title: 'BIO-900 · Untitled draft', href: '/tasks/BIO-900/edit' });
    expect(data.recentReports).toEqual([]);
  });

  it('works on an instance with no demo models, without inventing any', async () => {
    const bare = await makeTestApp();
    await makeUser(bare, { email: 'new@lab.example' });
    const client = await new Client(bare).signIn('new@lab.example');
    const data = await homeOf(client);
    expect(data.firstRun).toBe(true);
    expect(data.starter.models).toBe('');
    bare.close();
  });

  it('still shows a pending application and a waiting invitation', async () => {
    const lena = await signIn('lena@northbridge.example');
    const maya = await signIn('maya@helixlab.example');
    const { id: helix } = (await (await maya.get('/api/session')).json()).user.workspace;
    await maya.post(`/api/workspaces/${helix}/invitations`, { email: 'lena@northbridge.example', role: 'member' });

    const data = await homeOf(lena);
    expect(data.firstRun).toBe(true);
    const application = data.attention.find((item: { kind: string }) => item.kind === 'application');
    expect(application).toMatchObject({ code: 'APP-029', title: 'APP-029 · Biology reviewer application', detail: 'Pending verification', atLabel: 'Submitted', href: '/review/application', action: 'View application' });
    const invitation = data.attention.find((item: { kind: string }) => item.kind === 'invitation');
    expect(invitation).toMatchObject({ title: 'Invitation to Helix Lab', href: null, action: null });
    expect(invitation.detail).toContain('Maya Chen');
    expect(invitation.detail).toContain('lena@northbridge.example');
    // The link must come from the email: Rivet cannot rebuild it, and Home does not pretend to.
    expect(JSON.stringify(data)).not.toContain(new URL((await lastMail(test, 'lena@northbridge.example'))?.link as string).pathname.split('/').pop());
  });
});

describe('returning', () => {
  it('gives seeded Maya a useful page', async () => {
    const data = await homeOf(await signIn('maya@helixlab.example'));
    expect(data.firstRun).toBe(false);
    expect(data.workspace).toEqual({ name: 'Helix Lab', role: 'owner', defaultVisibility: 'private' });

    const draft = data.attention.find((item: { kind: string; code: string }) => item.kind === 'draft' && item.code === 'BIO-043');
    expect(draft).toMatchObject({ title: 'BIO-043 · Limits of inhibitor controls', detail: 'Draft 0.1', atLabel: 'Saved', href: '/tasks/BIO-043/edit', action: 'Continue draft' });

    expect(data.counts.tasks).toBeGreaterThanOrEqual(2);
    expect(data.counts.reports).toBeGreaterThanOrEqual(1);
    const task = data.recentTasks.find((row: { code: string }) => row.code === 'BIO-042');
    expect(task).toMatchObject({ title: 'Assess evidence for an antibiotic resistance mechanism', state: 'Frozen v1.0', isSynthetic: true, href: '/tasks/BIO-042' });
    expect(data.recentTasks.find((row: { code: string }) => row.code === 'BIO-043').state).toBe('Draft 0.1');

    const report = data.recentReports.find((row: { code: string }) => row.code === 'RPT-BIO-042');
    expect(report).toMatchObject({ version: '1.0', taskCode: 'BIO-042', isSynthetic: true, href: '/reports/RPT-BIO-042/v1.0' });
    expect(data.reviewBiology.allowed).toBe(false);
    expect(data.credentials).toEqual([]);
  });

  it('puts an interrupted run to resume first, and shows runs in progress', async () => {
    const maya = await signIn('maya@helixlab.example');
    const mayaId = await idOf('maya@helixlab.example');
    const task = (await test.ctx.db.get<{ id: string; latest_version_id: string }>(`SELECT id, latest_version_id FROM tasks WHERE code = 'BIO-042'`)) as { id: string; latest_version_id: string };
    const now = test.ctx.now().toISOString();
    const insertRun = (code: string, status: string, done: number, checkpoint: string | null, interruptedAt: string | null) =>
      test.ctx.db.run(`INSERT INTO runs (id, code, task_id, task_version_id, owner_id, status, stages_total, stages_done, last_checkpoint_code, interrupted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 9, ?, ?, ?, ?)`, [newId(), code, task.id, task.latest_version_id, mayaId, status, done, checkpoint, interruptedAt, now]);
    await insertRun('RUN-9001', 'running', 4, 'CP-004', null);
    await insertRun('RUN-9002', 'interrupted', 6, 'CP-006', now);
    await insertRun('RUN-9003', 'complete', 9, 'CP-009', null);

    const { attention } = await homeOf(maya);
    const runs = attention.filter((item: { kind: string }) => item.kind.endsWith('run'));
    expect(runs.map((item: { code: string }) => item.code).slice(0, 2)).toEqual(['RUN-9002', 'RUN-9001']);
    expect(runs[0]).toMatchObject({ kind: 'interrupted_run', detail: 'Interrupted at CP-006 · 6 / 9 stages committed', href: '/runs/RUN-9002', action: 'Resume run' });
    expect(runs[0].title).toContain('BIO-042');
    expect(runs[1]).toMatchObject({ kind: 'active_run', detail: 'Running · 4 / 9 stages committed', action: 'Open run' });
    expect(attention.find((item: { code: string }) => item.code === 'RUN-9003')).toBeUndefined();

    // Someone else's interrupted run is not theirs to resume.
    const samira = await homeOf(await signIn('samira@northbridge.example'));
    expect(samira.attention.find((item: { code: string }) => item.code === 'RUN-9002')).toBeUndefined();
  });

  it('shows a waiting review to a credentialed expert only, and never on their own task', async () => {
    const mayaId = await idOf('maya@helixlab.example');
    const task = (await test.ctx.db.get<{ id: string; latest_version_id: string }>(`SELECT id, latest_version_id FROM tasks WHERE code = 'BIO-042'`)) as { id: string; latest_version_id: string };
    const run = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM runs WHERE code = 'RUN-1042'`)) as { id: string };
    const code = 'REVIEW-9001';
    await test.ctx.db.run(`INSERT INTO reviews (id, code, task_id, task_version_id, run_id, requested_by, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)`, [newId(), code, task.id, task.latest_version_id, run.id, mayaId, test.ctx.now().toISOString()]);
    const find = (data: { attention: { code: string }[] }) => data.attention.find((item) => item.code === code);

    const samira = await homeOf(await signIn('samira@northbridge.example'));
    expect(find(samira)).toMatchObject({ kind: 'review', detail: 'Biology review waiting', href: `/review/${code}`, action: 'Open review' });
    expect(samira.reviewBiology).toEqual({ allowed: true });
    expect(samira.credentials.map((row: { domainName: string }) => row.domainName)).toEqual(['Biology']);

    expect(find(await homeOf(await signIn('maya@helixlab.example')))).toBeUndefined();
    expect(find(await homeOf(await signIn('alex@rivet.example')))).toBeUndefined();
    expect(find(await homeOf(await signIn('lena@northbridge.example')))).toBeUndefined();

    // Without the credential, the same request disappears.
    await test.ctx.db.run(`UPDATE credentials SET revoked_at = ? WHERE user_id = ?`, [test.ctx.now().toISOString(), await idOf('samira@northbridge.example')]);
    const revoked = await homeOf(await signIn('samira@northbridge.example'));
    expect(find(revoked)).toBeUndefined();
    expect(revoked.reviewBiology.allowed).toBe(false);
  });

  it('includes reports an expert reviewed, even outside their workspace', async () => {
    const samira = await homeOf(await signIn('samira@northbridge.example'));
    expect(samira.firstRun).toBe(false);
    expect(samira.recentReports.map((row: { code: string }) => row.code)).toContain('RPT-BIO-042');
    expect(samira.recentTasks.map((row: { code: string }) => row.code)).toContain('BIO-041');
    expect(samira.recentTasks.map((row: { code: string }) => row.code)).not.toContain('BIO-043');
  });

  it('never shows a stranger private tasks or reports', async () => {
    const id = await makeUser(test, { email: 'stranger@lab.example' });
    await makeWorkspace(test, id, 'Stranger Lab');
    const text = JSON.stringify(await homeOf(await signIn('stranger@lab.example')));
    for (const secret of ['BIO-042', 'BIO-043', 'RPT-BIO-042', 'RUN-1042']) expect(text).not.toContain(secret);
  });

  it('takes a workspace off Home as soon as the member is removed', async () => {
    const maya = await signIn('maya@helixlab.example');
    const { id: helix } = (await (await maya.get('/api/session')).json()).user.workspace;
    const memberId = await makeUser(test, { email: 'member@lab.example', name: 'Mo Member' });
    await maya.post(`/api/workspaces/${helix}/invitations`, { email: 'member@lab.example', role: 'member' });
    const token = new URL((await lastMail(test, 'member@lab.example'))?.link as string).pathname.split('/').pop();
    const member = await signIn('member@lab.example');
    await member.post(`/api/invitations/${token}/accept`);

    const joined = await homeOf(member);
    expect(joined.firstRun).toBe(false);
    expect(joined.recentTasks.map((row: { code: string }) => row.code)).toContain('BIO-042');

    await maya.post(`/api/workspaces/${helix}/members/${memberId}/remove`);
    const removed = await homeOf(member);
    expect(removed.firstRun).toBe(true);
    expect(removed.workspace).toBeNull();
    expect(removed.recentTasks).toEqual([]);
    expect(removed.recentReports).toEqual([]);
  });

  it('stays useful after switching to a workspace with no tasks yet', async () => {
    const maya = await signIn('maya@helixlab.example');
    const created = await maya.post('/api/workspaces', { name: 'Empty Lab', slug: 'empty-lab', researchFocus: '', defaultVisibility: 'private', keepPrivate: true });
    expect(created.status).toBe(201);
    const data = await homeOf(maya);
    expect(data.firstRun).toBe(false);
    expect(data.workspace.name).toBe('Empty Lab');
    expect(data.counts.tasks).toBe(0);
    expect(data.recentTasks).toEqual([]);
    expect(data.attention.find((item: { code: string }) => item.code === 'BIO-043')).toBeTruthy();
  });
});
