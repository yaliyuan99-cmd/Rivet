import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminModel, AdminModelsResponse, AdminSummary, ChecksResponse, CheckReceipt } from '../../shared/types/admin.ts';
import { checkArtifactHashes, checkDomainEnforcement, checkImmutability, checkOAuth, checkPrivateAccess, checkProviderTimeouts, IMMUTABLE_TABLES, realDependencies, runSystemChecks, summarizeReceipts } from '../../server/engine/checks.ts';
import { Client, makeTestApp, makeUser, type TestApp } from '../helpers/app.ts';

let test: TestApp;
let alex: Client;

beforeEach(async () => {
  test = await makeTestApp({ seed: true });
  alex = await new Client(test).signIn('alex@rivet.example');
});
afterEach(() => test.close());

const db = () => test.ctx.db;
const receipt = (data: ChecksResponse, key: string) => data.latest?.receipts.find((item) => item.key === key) as CheckReceipt;
const runChecks = async () => {
  const res = await alex.post('/api/admin/checks/run');
  expect(res.status).toBe(200);
  return (await res.json()) as ChecksResponse;
};

const ADMIN_READS = ['/api/admin/summary', '/api/admin/models', '/api/admin/checks', '/api/admin/checks/export'];

describe('access', () => {
  it('refuses everything to anyone who is not an administrator', async () => {
    const anonymous = new Client(test);
    await makeUser(test, { email: 'unverified@lab.example', role: 'admin', verified: false });
    const unverifiedAdmin = await new Client(test).signIn('unverified@lab.example');
    const maya = await new Client(test).signIn('maya@helixlab.example');
    const samira = await new Client(test).signIn('samira@northbridge.example');

    for (const path of ADMIN_READS) {
      expect((await anonymous.get(path)).status, path).toBe(401);
      expect((await unverifiedAdmin.get(path)).status, path).toBe(403);
      for (const member of [maya, samira]) {
        const res = await member.get(path);
        expect(res.status, path).toBe(403);
        expect((await res.json()).error.message).toBe('Admin role required');
      }
    }
    const body = { displayName: 'Hacked', cutoffDisclosure: 'x', enabled: false, rationale: 'x' };
    for (const member of [maya, samira]) {
      expect((await member.patch('/api/admin/models/aster-3.2', body)).status).toBe(403);
      expect((await member.post('/api/admin/checks/run')).status).toBe(403);
    }
    const stored = await db().get<any>(`SELECT display_name, enabled FROM models WHERE id = 'aster-3.2'`);
    expect(stored).toEqual({ display_name: 'Aster 3.2', enabled: 1 });
    expect((await db().get<{ count: number }>('SELECT COUNT(*) AS count FROM check_runs'))?.count).toBe(1);
  });

  it('needs the CSRF header on writes', async () => {
    const res = await test.app.request('/api/admin/checks/run', { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('csrf');
  });
});

describe('index', () => {
  it('reports real queue counts', async () => {
    const before = (await (await alex.get('/api/admin/summary')).json()) as AdminSummary;
    expect(before).toMatchObject({ pendingCredentials: 1, pendingAdjudications: 0, models: { total: 3, enabled: 3 }, operator: { name: 'Alex Rivera', role: 'Admin' } });
    expect(before.latestCheck).toMatchObject({ finishedAt: '2026-10-15T14:42:00.000Z', passed: 5, warnings: 1, failed: 0, tone: 'warning', message: 'Core integrity passed. One operational warning needs attention.' });

    await db().run(`UPDATE applications SET status = 'verified' WHERE code = 'APP-029'`);
    await db().run(`UPDATE reviews SET status = 'submitted' WHERE code = 'REVIEW-042'`);
    await db().run(`UPDATE models SET enabled = 0 WHERE id = 'lumen-4-mini'`);
    expect(await (await alex.get('/api/admin/summary')).json()).toMatchObject({ pendingCredentials: 0, pendingAdjudications: 1, models: { total: 3, enabled: 2 } });
  });
});

describe('model registry', () => {
  const edit = (overrides: Record<string, unknown> = {}, id = 'aster-3.2') => alex.patch(`/api/admin/models/${id}`, { displayName: 'Aster 3.2', cutoffDisclosure: 'Unknown / Not claimed', enabled: true, rationale: 'Clarify provenance.', ...overrides });

  it('lists the pinned revisions with their history', async () => {
    const data = (await (await alex.get('/api/admin/models')).json()) as AdminModelsResponse;
    expect(data.items.map((item) => `${item.displayName} ${item.revision} ${item.contextK}k/${item.outputK}k ${item.enabled}`)).toEqual(['Aster 3.2 aster-3.2-20261001 128k/8k true', 'Meridian 2.1 meridian-2.1-20260918 128k/8k true', 'Lumen 4 Mini lumen-4-mini-20261004 64k/8k true']);
    expect(data.items[0]).toMatchObject({ adapterLabel: 'Rivet Demo / Synthetic response adapter', cutoffDisclosure: 'Unknown / Not claimed', illustrative: true, shortName: 'Aster' });
    expect(data.items[0]?.history).toEqual([expect.objectContaining({ editor: 'Alex Rivera', rationale: 'Clarify provenance and cutoff disclosure. No change to the pinned revision.', changes: { cutoffDisclosure: { from: 'Not stated', to: 'Unknown / Not claimed' } } })]);
    expect(data.items[1]?.history).toEqual([]);
    expect(data.editor).toEqual({ name: 'Alex Rivera', role: 'Admin' });
  });

  it('saves a revision: updates the model and appends the from and to', async () => {
    test.setNow('2026-11-02T09:00:00.000Z');
    const res = await edit({ displayName: 'Aster 3.2 (fictional)', cutoffDisclosure: 'Not claimed', enabled: false, rationale: 'Retire from new evaluations.' });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as AdminModel;
    expect(updated).toMatchObject({ displayName: 'Aster 3.2 (fictional)', cutoffDisclosure: 'Not claimed', enabled: false, revision: 'aster-3.2-20261001', updatedAt: '2026-11-02T09:00:00.000Z' });
    expect(updated.history).toHaveLength(2);
    expect(updated.history[0]).toMatchObject({
      editor: 'Alex Rivera',
      rationale: 'Retire from new evaluations.',
      createdAt: '2026-11-02T09:00:00.000Z',
      changes: { displayName: { from: 'Aster 3.2', to: 'Aster 3.2 (fictional)' }, cutoffDisclosure: { from: 'Unknown / Not claimed', to: 'Not claimed' }, enabled: { from: true, to: false } },
    });
    expect(await db().get(`SELECT 1 AS ok FROM audit_log WHERE action = 'model.metadata_revised' AND subject_id = 'aster-3.2'`)).toBeTruthy();

    // Only what changed is recorded.
    const second = (await (await edit({ displayName: 'Aster 3.2 (fictional)', cutoffDisclosure: 'Not claimed', enabled: true, rationale: 'Available again.' })).json()) as AdminModel;
    expect(second.history[0]?.changes).toEqual({ enabled: { from: false, to: true } });
  });

  it('has no field for a pinned revision, or for anything else fixed', async () => {
    const before = await db().get<any>(`SELECT * FROM models WHERE id = 'aster-3.2'`);
    for (const extra of [{ revision: 'aster-9-tampered' }, { adapter: 'anthropic' }, { adapterLabel: 'Real provider' }, { contextK: 1 }, { shortName: 'X' }, { sort: 9 }]) {
      const res = await edit({ displayName: 'Changed', ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(422);
      const { error } = await res.json();
      expect(error.code).toBe('validation_failed');
      expect(error.fields.form).toBe('Only the display name, cutoff disclosure and availability can change. Pinned revisions and adapters cannot be edited.');
    }
    expect(await db().get(`SELECT * FROM models WHERE id = 'aster-3.2'`)).toEqual(before);
    expect((await db().get<{ count: number }>('SELECT COUNT(*) AS count FROM model_revisions'))?.count).toBe(1);
  });

  it('requires a rationale, a name and a real change', async () => {
    const noRationale = await edit({ displayName: 'New', rationale: '   ' });
    expect(noRationale.status).toBe(422);
    expect((await noRationale.json()).error.fields.rationale).toBe('Explain why this metadata is changing.');
    const missing = await alex.patch('/api/admin/models/aster-3.2', { displayName: 'New', cutoffDisclosure: 'x', enabled: true });
    expect((await missing.json()).error.fields.rationale).toBeTruthy();
    expect((await (await edit({ displayName: '' })).json()).error.fields.displayName).toBe('Enter a display name.');
    expect((await (await edit({ cutoffDisclosure: '  ' })).json()).error.fields.cutoffDisclosure).toBeTruthy();
    expect((await (await edit({ enabled: 'yes' })).json()).error.fields.enabled).toBeTruthy();

    const unchanged = await edit();
    expect(unchanged.status).toBe(422);
    expect((await unchanged.json()).error.fields.form).toMatch(/Nothing has changed/);
    expect((await edit({ displayName: 'New' }, 'no-such-model')).status).toBe(404);
    expect((await db().get<{ count: number }>('SELECT COUNT(*) AS count FROM model_revisions'))?.count).toBe(1);
  });

  it('keeps revisions append-only at the database', async () => {
    await expect(db().run(`UPDATE model_revisions SET rationale = 'rewritten'`)).rejects.toThrow(/append-only/);
    await expect(db().run(`DELETE FROM model_revisions`)).rejects.toThrow(/append-only/);
  });

  it('disabling stops new selection while frozen evidence keeps showing', async () => {
    const maya = await new Client(test).signIn('maya@helixlab.example');
    expect((await edit({ enabled: false, rationale: 'Pause new use.' })).status).toBe(200);

    const { options } = (await (await maya.get('/api/tasks/editor-options')).json()) as { options: { models: { id: string; available: boolean; reason: string | null }[] } };
    expect(options.models.find((item) => item.id === 'aster-3.2')).toMatchObject({ available: false, reason: 'Unavailable for new runs. Historical evidence remains.' });
    expect(options.models.find((item) => item.id === 'meridian-2.1')).toMatchObject({ available: true });
    const run = await maya.post('/api/tasks/BIO-042/runs');
    expect(run.status).toBe(409);
    expect((await run.json()).error.message).toMatch(/Aster 3\.2/);

    expect((await maya.get('/api/evidence/EV-1042-A')).status).toBe(200);
    expect((await maya.get('/api/reports/RPT-BIO-042/1.0')).status).toBe(200);
    const pinned = await db().get<any>(`SELECT model_revision FROM evidence WHERE code = 'EV-1042-A'`);
    expect(pinned.model_revision).toBe('aster-3.2-20261001');
  });
});

describe('system checks', () => {
  it('seeds real receipts numbered CHECK-291 to 296, on the story clock', async () => {
    const data = (await (await alex.get('/api/admin/checks')).json()) as ChecksResponse;
    expect(data.latest).toMatchObject({ finishedAt: '2026-10-15T14:42:00.000Z', operator: { name: 'Alex Rivera', role: 'Admin' }, tone: 'warning', message: 'Core integrity passed. One operational warning needs attention.' });
    expect(data.latest?.receipts.map((item) => `${item.code} / ${item.label}`)).toEqual([
      'CHECK-291 / Artifact hashes',
      'CHECK-292 / Immutability',
      'CHECK-293 / Private access',
      'CHECK-294 / OAuth state & PKCE',
      'CHECK-295 / Provider timeouts',
      'CHECK-296 / Domain enforcement',
    ]);
    expect(receipt(data, 'immutability').detail).toBe('Passed · No frozen-version mutation');
    expect(receipt(data, 'artifact_hashes').detail).toMatch(/^Passed · (\d+) of \1 verified$/);
    expect(receipt(data, 'private_access').detail).toMatch(/^Passed · (\d+) of \1 boundary cases$/);
    expect(receipt(data, 'oauth_pkce').detail).toMatch(/^Passed · (\d+) of \1 cases$/);
    expect(receipt(data, 'domain_enforcement').detail).toMatch(/^Passed · (\d+) of \1 cases$/);
  });

  it('computes the timeout rate from the run logs: one timeout over ten provider calls', async () => {
    const data = (await (await alex.get('/api/admin/checks')).json()) as ChecksResponse;
    const stages = (await db().get<{ count: number }>(`SELECT COUNT(*) AS count FROM run_stages WHERE status <> 'pending' OR attempt > 0`))?.count as number;
    const timeouts = (await db().get<{ count: number }>(`SELECT COUNT(*) AS count FROM run_log WHERE LOWER(message) LIKE '%provider timeout%'`))?.count as number;
    const percent = ((timeouts / (stages + timeouts)) * 100).toFixed(1);
    expect(receipt(data, 'provider_timeouts')).toMatchObject({ status: 'warning', detail: `Warning · ${percent}% demo / Threshold 3%` });
  });

  it('lists operational events from the run log and the audit log', async () => {
    const data = (await (await alex.get('/api/admin/checks')).json()) as ChecksResponse;
    expect(data.events.map((event) => `${event.subject} / ${event.at.slice(11, 16)} / ${event.message}`)).toEqual([
      'RUN-1042 / 14:34 / Safe checkpoint after provider timeout · Owner can resume',
      'DS-BIO-07 / 14:32 / Source manifest hash matched',
      'APP-028 / 13:40 / Biology credential verified / Dr. Samira Patel',
    ]);
  });

  it('runs for real on request: new receipts, and nothing else changes', async () => {
    test.setNow('2026-11-02T10:00:00.000Z');
    const tables = ['users', 'memberships', 'workspaces', 'tasks', 'task_versions', 'evidence', 'reports', 'datasets', 'credentials', 'oauth_clients', 'oauth_requests', 'oauth_tokens', 'domains', 'model_revisions'];
    const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, (await db().get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))?.count])));
    const before = await counts();

    const data = await runChecks();
    expect(data.latest?.receipts.map((item) => item.code)).toEqual(['CHECK-297', 'CHECK-298', 'CHECK-299', 'CHECK-300', 'CHECK-301', 'CHECK-302']);
    expect(data.latest).toMatchObject({ finishedAt: '2026-11-02T10:00:00.000Z', operator: { name: 'Alex Rivera' }, tone: 'warning' });
    expect(await counts()).toEqual(before);
    expect((await db().get<{ count: number }>('SELECT COUNT(*) AS count FROM check_runs'))?.count).toBe(2);
    expect(await db().get(`SELECT 1 AS ok FROM users WHERE email LIKE 'check-probe%'`)).toBeUndefined();
    expect(await db().get(`SELECT 1 AS ok FROM audit_log WHERE action = 'system_checks.run' AND created_at = '2026-11-02T10:00:00.000Z'`)).toBeTruthy();
  });

  it('exports a real file, and audits it', async () => {
    await runChecks();
    test.setNow('2026-11-02T10:05:00.000Z');
    const res = await alex.get('/api/admin/checks/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="rivet-check-log-20261102T1005Z.json"');
    expect(res.headers.get('content-type')).toContain('application/json');
    const file = JSON.parse(await res.text());
    expect(file).toMatchObject({ schema: 'rivet.check_log.v1', exportedAt: '2026-11-02T10:05:00.000Z', exportedBy: { name: 'Alex Rivera' }, synthetic: true });
    expect(file.note).toMatch(/computed for real over the synthetic fixtures/);
    expect(file.runs).toHaveLength(2);
    expect(file.runs[0].receipts).toHaveLength(6);
    expect(file.operationalEvents.length).toBeGreaterThanOrEqual(3);
    expect(await db().get(`SELECT 1 AS ok FROM audit_log WHERE action = 'system_checks.exported' AND actor_id = (SELECT id FROM users WHERE email = 'alex@rivet.example')`)).toBeTruthy();
  });
});

describe('each check fails when its condition is broken', () => {
  describe('artifact hashes', () => {
    it('notices edited evidence', async () => {
      await db().exec('DROP TRIGGER evidence_no_update');
      await db().run(`UPDATE evidence SET total_score = 100 WHERE code = 'EV-1042-A'`);
      const outcome = await checkArtifactHashes(test.ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.detail).toMatch(/^Failed · (\d+) of (\d+) verified$/);
      expect(outcome.failures).toEqual([{ subject: 'EV-1042-A', reason: 'Evidence seal does not match its stored fields' }]);
    });

    it('notices an edited report: its manifest, or a column the manifest disagrees with', async () => {
      await db().exec('DROP TRIGGER reports_no_update');
      await db().run(`UPDATE reports SET headline = 'Causality established.' WHERE code = 'RPT-BIO-042'`);
      const column = await checkArtifactHashes(test.ctx);
      expect(column.failures).toEqual([{ subject: 'RPT-BIO-042 v1.0', reason: 'Report headline differs from its canonical manifest' }]);

      await db().run(`UPDATE reports SET headline = 'Efflux is supported; causality is not established.', canonical = canonical || ' ' WHERE code = 'RPT-BIO-042'`);
      const manifest = await checkArtifactHashes(test.ctx);
      expect(manifest.failures).toEqual([{ subject: 'RPT-BIO-042 v1.0', reason: 'Report hash does not match its canonical manifest' }]);
    });

    it('notices an edited frozen task version', async () => {
      await db().exec('DROP TRIGGER task_versions_no_update');
      await db().run(`UPDATE task_versions SET prompt = prompt || ' Changed later.' WHERE task_id = (SELECT id FROM tasks WHERE code = 'BIO-042')`);
      const outcome = await checkArtifactHashes(test.ctx);
      expect(outcome.failures.map((failure) => failure.subject)).toContain('BIO-042 v1.0');
    });

    it('notices an edited trace', async () => {
      const trace = await db().get<{ code: string }>('SELECT code FROM traces LIMIT 1');
      await db().exec('DROP TRIGGER traces_no_update');
      if (trace) await db().run(`UPDATE traces SET agent_label = 'Someone else' WHERE code = ?`, [trace.code]);
      else {
        await db().exec('PRAGMA foreign_keys = OFF');
        await db().run(`INSERT INTO traces (id, code, workspace_id, owner_id, domain_id, agent_label, harness_version, steps, sha256, created_at) VALUES ('t', 'TRACE-T', 'w', 'u', 'biology', 'a', '1', '[]', 'not-the-hash', 'now')`);
        await db().exec('PRAGMA foreign_keys = ON');
      }
      const outcome = await checkArtifactHashes(test.ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.failures[0]?.reason).toBe('Trace hash does not match its stored steps');
    });

    it('re-hashes the stored dataset bytes: changed, and missing', async () => {
      const row = (await db().get<{ sha256: string }>(`SELECT dv.sha256 FROM dataset_versions dv JOIN datasets d ON d.id = dv.dataset_id WHERE d.code = 'DS-BIO-09'`)) as { sha256: string };
      const file = path.join(test.ctx.config.dataDir, 'uploads', row.sha256);
      writeFileSync(file, 'source_id,observation,provenance\nN01,Changed after the fact,Nobody\n');
      const changed = await checkArtifactHashes(test.ctx);
      expect(changed.failures).toEqual([{ subject: 'DS-BIO-09 v0.2', reason: 'Stored bytes do not match the dataset hash' }]);

      const { rmSync } = await import('node:fs');
      rmSync(file);
      const missing = await checkArtifactHashes(test.ctx);
      expect(missing.failures).toEqual([{ subject: 'DS-BIO-09 v0.2', reason: 'Stored bytes are missing' }]);
    });

    it('shows the failure on the receipt and turns the alert to danger', async () => {
      await db().exec('DROP TRIGGER evidence_no_update');
      await db().run(`UPDATE evidence SET output_text = 'tampered' WHERE code = 'EV-1042-M'`);
      const data = await runChecks();
      // Dropping the trigger to make the tamper possible is itself caught.
      expect(data.latest).toMatchObject({ tone: 'danger', message: 'Core integrity failed. Two checks need attention: Artifact hashes, Immutability. Runs are blocked until the checks pass.' });
      expect(receipt(data, 'artifact_hashes')).toMatchObject({ status: 'failed', failures: [{ subject: 'EV-1042-M', reason: 'Evidence seal does not match its stored fields' }] });
      expect((await db().get<any>(`SELECT status FROM check_receipts WHERE code = 'CHECK-297'`)).status).toBe('failed');
    });
  });

  describe('immutability', () => {
    it('refuses every table on the seeded database, including ones with no rows yet', async () => {
      const outcome = await checkImmutability(test.ctx);
      expect(outcome.status).toBe('passed');
      const tables = outcome.data.tables as { table: string; update: string; delete: string }[];
      expect(tables.map((row) => row.table)).toEqual([...IMMUTABLE_TABLES]);
      expect(tables.every((row) => row.update === 'refused' && row.delete === 'refused')).toBe(true);
    });

    it('fails when any trigger is gone, and still rolls the attempt back', async () => {
      await db().exec('DROP TRIGGER task_versions_no_delete');
      const before = (await db().get<{ count: number }>('SELECT COUNT(*) AS count FROM task_versions'))?.count;
      const outcome = await checkImmutability(test.ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.detail).toBe('Failed · 1 frozen-table write not refused');
      expect(outcome.failures[0]).toMatchObject({ subject: 'task_versions DELETE' });
      expect((await db().get<{ count: number }>('SELECT COUNT(*) AS count FROM task_versions'))?.count).toBe(before);
    });

    it('catches a dropped trigger on an empty table through a probe row', async () => {
      const empty = await makeTestApp({ seed: false });
      await empty.ctx.db.exec('DROP TRIGGER gate_runs_no_update');
      const outcome = await checkImmutability(empty.ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.failures.map((failure) => failure.subject)).toEqual(['gate_runs UPDATE']);
      expect((await empty.ctx.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM gate_runs'))?.count).toBe(0);
      empty.close();
    });

    it('reports a table that vanished', async () => {
      const empty = await makeTestApp({ seed: false });
      await empty.ctx.db.exec('DROP TABLE trace_adjudications');
      const outcome = await checkImmutability(empty.ctx);
      expect(outcome.failures).toEqual([{ subject: 'trace_adjudications', reason: 'The table does not exist' }]);
      empty.close();
    });
  });

  describe('private access', () => {
    it('fails when a rule grants everyone a membership', async () => {
      // A rogue default: every new account joins every workspace. The probes must notice.
      await db().exec(`CREATE TRIGGER rogue_default_membership AFTER INSERT ON users BEGIN
        INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at) SELECT NEW.id || w.id, w.id, NEW.id, 'member', 'active', NEW.created_at FROM workspaces w;
      END`);
      const outcome = await checkPrivateAccess(test.ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.failures.some((failure) => failure.subject === 'BIO-042: non-member' && failure.reason === 'Allowed across a private boundary')).toBe(true);
      expect(outcome.failures.some((failure) => failure.subject === 'DS-BIO-07: non-member')).toBe(true);
    });

    it('fails when a private dataset is pinned into another workspace’s task', async () => {
      await db().run(`UPDATE tasks SET dataset_version_id = (SELECT dv.id FROM dataset_versions dv JOIN datasets d ON d.id = dv.dataset_id WHERE d.code = 'DS-BIO-07') WHERE code = 'BIO-041'`);
      const outcome = await checkPrivateAccess(test.ctx);
      expect(outcome.status).toBe('failed');
      expect(outcome.failures).toEqual([{ subject: 'BIO-041: pins DS-BIO-07', reason: 'A private dataset is pinned into a task of another workspace' }]);
    });

    it('fails when the permission functions stop refusing, or stop allowing', async () => {
      const allowEverything = await checkPrivateAccess(test.ctx, { ...realDependencies, canReadTask: async () => ({ allowed: true }), canReadDataset: async () => ({ allowed: true }) });
      expect(allowEverything.status).toBe('failed');
      expect(allowEverything.failures.every((failure) => failure.reason === 'Allowed across a private boundary')).toBe(true);
      const refuseEverything = await checkPrivateAccess(test.ctx, { ...realDependencies, canReadTask: async () => ({ allowed: false, reason: 'no' }) });
      expect(refuseEverything.status).toBe('failed');
      expect(refuseEverything.failures.every((failure) => failure.reason === 'Refused where access is required')).toBe(true);
    });

    it('counts real rows: another private task adds real cases', async () => {
      const before = await checkPrivateAccess(test.ctx);
      const owner = (await db().get<{ id: string }>(`SELECT id FROM users WHERE email = 'maya@helixlab.example'`)) as { id: string };
      const workspace = (await db().get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-HELIX'`)) as { id: string };
      await db().run(`INSERT INTO tasks (id, code, workspace_id, owner_id, domain_id, created_at, updated_at) VALUES ('t2', 'BIO-900', ?, ?, 'biology', 'now', 'now')`, [workspace.id, owner.id]);
      const after = await checkPrivateAccess(test.ctx);
      expect(after.data.total).toBe((before.data.total as number) + 3);
      expect(after.status).toBe('passed');
    });
  });

  describe('OAuth state and PKCE', () => {
    it('fails when the verification functions are wrong', async () => {
      const lax = await checkOAuth(test.ctx, { ...realDependencies, verifyPkce: () => true });
      expect(lax.status).toBe('failed');
      expect(lax.failures.map((failure) => failure.subject)).toEqual(expect.arrayContaining(['Wrong verifier refused', 'Short verifier refused']));

      const loose = await checkOAuth(test.ctx, { ...realDependencies, redirectMatches: (registered, presented) => Boolean(presented?.startsWith(registered)) });
      expect(loose.failures.map((failure) => failure.subject)).toContain('Redirect with a trailing slash refused');

      const noState = await checkOAuth(test.ctx, { ...realDependencies, validateAuthorizationParams: (params) => ({ ok: true, scopes: ['tasks:read'], taskCode: 'BIO-042', resource: 'task:BIO-042', state: params.state ?? '', codeChallenge: params.code_challenge ?? '' }) });
      expect(noState.failures.map((failure) => failure.subject)).toEqual(expect.arrayContaining(['Missing state refused', 'The plain PKCE method refused', 'Scope outside the allow-list refused']));

      const lostState = await checkOAuth(test.ctx, { ...realDependencies, authorizationRedirect: (uri, params) => realDependencies.authorizationRedirect(uri, { ...params, state: 'something-else' }) });
      expect(lostState.failures.map((failure) => failure.subject)).toContain('Approved redirect carries the code and the exact state');
    });

    it('fails when the exchange lets a replay through', async () => {
      const replayable = await checkOAuth(test.ctx, {
        ...realDependencies,
        exchangeAuthorizationCode: async () => ({ ok: true, accessToken: 'x', tokenId: 'y', expiresAt: 'z', scopes: [], resource: 'task:X' }),
      });
      expect(replayable.status).toBe('failed');
      expect(replayable.failures.map((failure) => failure.subject)).toEqual(expect.arrayContaining(['Live code refused with the wrong verifier', 'Live code refused the second time']));
    });

    it('fails when what is stored breaks the rules', async () => {
      const maya = await new Client(test).signIn('maya@helixlab.example');
      const { createHash, randomBytes } = await import('node:crypto');
      const verifier = randomBytes(32).toString('base64url');
      const created = await maya.post('/api/oauth/requests', { response_type: 'code', client_id: 'client_atlas_demo', redirect_uri: 'http://localhost:8787/atlas-demo/callback', scope: 'tasks:read', resource: 'task:BIO-042', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      const { code } = await created.json();
      expect((await checkOAuth(test.ctx)).status).toBe('passed');

      await db().run(`UPDATE oauth_requests SET code_challenge = 'not-a-challenge' WHERE code = ?`, [code]);
      const badChallenge = await checkOAuth(test.ctx);
      expect(badChallenge.failures).toEqual([{ subject: 'Every stored request has a state and an S256 challenge', reason: `Not well formed: ${code}` }]);

      await db().run(`UPDATE oauth_requests SET code_challenge = ?, auth_code_hash = 'plain-text-code' WHERE code = ?`, ['E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code]);
      const plainCode = await checkOAuth(test.ctx);
      expect(plainCode.failures.map((failure) => failure.subject)).toEqual(['Authorization codes are stored only as hashes, and only once approved']);

      await db().run(`UPDATE oauth_requests SET auth_code_hash = NULL WHERE code = ?`, [code]);
      const request = (await db().get<any>(`SELECT * FROM oauth_requests WHERE code = ?`, [code])) as any;
      await db().run(`INSERT INTO oauth_tokens (id, request_id, client_id, user_id, token_hash, scopes, task_version_id, issued_at, expires_at) VALUES ('tok', ?, ?, ?, 'rvt_raw_token', '[]', ?, 'now', 'later')`, [request.id, request.client_id, request.user_id, request.task_version_id]);
      const plainToken = await checkOAuth(test.ctx);
      expect(plainToken.failures.map((failure) => failure.subject)).toEqual(['Access tokens are stored only as hashes, and only from approved requests']);
    });
  });

  describe('provider timeouts', () => {
    it('warns only over the threshold, on the real rate', async () => {
      const run = (await db().get<{ id: string }>(`SELECT id FROM runs WHERE code = 'RUN-1042'`)) as { id: string };
      const addStages = async (count: number, from = 100) => {
        for (let index = 0; index < count; index += 1) await db().run(`INSERT INTO run_stages (id, run_id, model_id, seq, kind, status, attempt) VALUES (?, ?, 'aster-3.2', ?, 'output', 'done', 1)`, [`s${from + index}`, run.id, from + index]);
      };
      const addTimeout = (id: string) => db().run(`INSERT INTO run_log (id, run_id, at, message, seq) VALUES (?, ?, 'now', 'Provider timeout. Safe checkpoint at CP-001; owner can resume', ?)`, [id, run.id, 9000 + Number(id)]);
      const timeouts = async () => (await db().get<{ count: number }>(`SELECT COUNT(*) AS count FROM run_log WHERE LOWER(message) LIKE '%provider timeout%'`))?.count as number;
      const stages = async () => (await db().get<{ count: number }>(`SELECT COUNT(*) AS count FROM run_stages WHERE status <> 'pending' OR attempt > 0`))?.count as number;

      expect((await checkProviderTimeouts(test.ctx)).status).toBe('warning');

      // Exactly 3 timeouts in 100 provider calls: on the threshold, not over it, so it passes.
      while ((await timeouts()) < 3) await addTimeout(String(await timeouts()));
      await addStages(100 - (await timeouts()) - (await stages()));
      const exactly = await checkProviderTimeouts(test.ctx);
      expect(exactly).toMatchObject({ status: 'passed', detail: 'Passed · 3.0% demo / Threshold 3%', data: { timeouts: 3, calls: 100 } });

      // One more timeout tips it over.
      await addTimeout('50');
      const over = await checkProviderTimeouts(test.ctx);
      expect(over.status).toBe('warning');
      expect(over.detail).toBe('Warning · 4.0% demo / Threshold 3%');
    });

    it('counts a run left interrupted by a timeout that has no log line, and passes with no calls', async () => {
      const empty = await makeTestApp({ seed: false });
      expect(await checkProviderTimeouts(empty.ctx)).toMatchObject({ status: 'passed', detail: 'Passed · No provider calls yet / Threshold 3%' });
      empty.close();

      await db().run(`DELETE FROM run_log WHERE LOWER(message) LIKE '%provider timeout%'`);
      await db().run(`UPDATE runs SET interrupt_reason = 'provider_timeout' WHERE code = 'RUN-1042'`);
      expect((await checkProviderTimeouts(test.ctx)).status).toBe('warning');
    });

    it('labels the rate demo only on a demo instance', async () => {
      const live = await makeTestApp({ seed: true });
      expect((await checkProviderTimeouts({ ...live.ctx, config: { ...live.ctx.config, demo: false } })).detail).toMatch(/^Warning · [\d.]+% \/ Threshold 3%$/);
      live.close();
    });
  });

  describe('domain enforcement', () => {
    it('fails when the permission function is wrong', async () => {
      const open = await checkDomainEnforcement(test.ctx, { ...realDependencies, canReviewTask: async () => ({ allowed: true }) });
      expect(open.status).toBe('failed');
      expect(open.failures.map((failure) => failure.subject)).toEqual(expect.arrayContaining(['Biology: the owner cannot review their own task, even when credentialed', 'Biology: a Chemistry credential does not transfer', 'Biology: a revoked credential is refused']));
      const closed = await checkDomainEnforcement(test.ctx, { ...realDependencies, canReviewTask: async () => ({ allowed: false, reason: 'no' }) });
      expect(closed.failures.map((failure) => failure.subject)).toContain('Biology: verified expert in the domain');
    });

    it('fails when a review on file broke the rule', async () => {
      await db().run(`UPDATE reviews SET expert_id = (SELECT owner_id FROM tasks WHERE tasks.id = reviews.task_id) WHERE code = 'REVIEW-042'`);
      const selfReview = await checkDomainEnforcement(test.ctx);
      expect(selfReview.status).toBe('failed');
      expect(selfReview.failures).toEqual([{ subject: 'REVIEW-042: finalized by a credentialed non-owner', reason: 'The task owner reviewed their own task' }]);
    });

    it('fails when a reviewer never held the credential, but not when it lapsed after the work', async () => {
      const credential = 'UPDATE credentials SET revoked_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)';
      await db().run(credential, ['2026-11-01T00:00:00.000Z', 'samira@northbridge.example']);
      expect((await checkDomainEnforcement(test.ctx)).status).toBe('passed');

      await db().run(credential, ['2026-10-15T14:00:00.000Z', 'samira@northbridge.example']);
      const lapsedBefore = await checkDomainEnforcement(test.ctx);
      expect(lapsedBefore.failures).toEqual([{ subject: 'REVIEW-042: finalized by a credentialed non-owner', reason: 'The expert held no credential in this domain when the review was submitted' }]);
    });

    it('fails when an open review belongs to someone without the credential', async () => {
      await db().run(`UPDATE credentials SET revoked_at = '2026-10-15T14:00:00.000Z' WHERE user_id = (SELECT id FROM users WHERE email = 'samira@northbridge.example')`);
      await db().run(`UPDATE reviews SET status = 'draft' WHERE code = 'REVIEW-042'`);
      const outcome = await checkDomainEnforcement(test.ctx);
      expect(outcome.failures).toEqual([{ subject: 'REVIEW-042: assigned to a credentialed non-owner', reason: 'Verified Biology credential required' }]);
    });
  });
});

describe('integrity failures block runs', () => {
  const start = (client: Client) => client.post('/api/tasks/BIO-042/runs');

  it('refuses to start or resume a run while the latest check has an integrity failure', async () => {
    const { integrityBlockReason } = await import('../../server/engine/checks.ts');
    const maya = await new Client(test).signIn('maya@helixlab.example');
    expect(await integrityBlockReason(test.ctx)).toBeNull();

    // An interrupted run to resume later, and a tamper for the checks to find.
    const interrupted = '2026-11-02T10:00:00.000Z';
    await db().run(`UPDATE runs SET status = 'interrupted', interrupt_reason = 'owner_stop', interrupted_at = ? WHERE code = 'RUN-1042'`, [interrupted]);
    await db().exec('DROP TRIGGER evidence_no_update');
    await db().run(`UPDATE evidence SET output_text = 'tampered' WHERE code = 'EV-1042-A'`);
    expect((await runChecks()).latest?.tone).toBe('danger');
    expect(await integrityBlockReason(test.ctx)).toBe('CHECK-297 / Artifact hashes failed. Runs are blocked until the system checks pass.');

    const before = (await db().get<{ count: number }>('SELECT COUNT(*) AS count FROM runs'))?.count;
    const refused = await start(maya);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toBe('CHECK-297 / Artifact hashes failed. Runs are blocked until the system checks pass.');
    const resume = await maya.post('/api/runs/RUN-1042/resume');
    expect(resume.status).toBeGreaterThanOrEqual(400);
    expect((await resume.json()).error.message).toMatch(/Runs are blocked/);
    expect((await db().get<{ count: number }>('SELECT COUNT(*) AS count FROM runs'))?.count).toBe(before);
    await expect(db().run(`UPDATE runs SET status = 'queued' WHERE code = 'RUN-1042'`)).rejects.toThrow(/integrity_block/);

    // Repair the bytes and the trigger: the next passing check lifts the block.
    const original = await db().get<{ output_text: string }>(`SELECT output_text FROM run_outputs WHERE run_id = (SELECT id FROM runs WHERE code = 'RUN-1042') AND model_id = 'aster-3.2'`);
    await db().run(`UPDATE evidence SET output_text = ? WHERE code = 'EV-1042-A'`, [original?.output_text as string]);
    await db().exec(`CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END`);
    await db().run(`UPDATE runs SET status = 'complete', interrupt_reason = NULL WHERE code = 'RUN-1042'`);
    const clean = await runChecks();
    expect(clean.latest?.tone).toBe('warning');
    expect(await integrityBlockReason(test.ctx)).toBeNull();
    expect((await start(maya)).status).toBe(201);
  });

  it('is not triggered by a warning, or by a failure of another kind', async () => {
    const maya = await new Client(test).signIn('maya@helixlab.example');
    expect((await db().get<any>(`SELECT status FROM check_receipts WHERE code = 'CHECK-295'`)).status).toBe('warning');
    const adminId = (await db().get<{ id: string }>(`SELECT id FROM users WHERE email = 'alex@rivet.example'`))?.id as string;
    await runSystemChecks(test.ctx, adminId, { ...realDependencies, canReviewTask: async () => ({ allowed: true }) });
    expect((await start(maya)).status).toBe(201);
  });
});

describe('summary and empty instances', () => {
  it('computes the alert from the receipts', () => {
    const keys = ['artifact_hashes', 'immutability', 'private_access', 'oauth_pkce', 'provider_timeouts', 'domain_enforcement'];
    const labels = ['Artifact hashes', 'Immutability', 'Private access', 'OAuth state & PKCE', 'Provider timeouts', 'Domain enforcement'];
    const with_ = (...statuses: ('passed' | 'warning' | 'failed')[]) => statuses.map((status, index) => ({ key: keys[index] as string, status, label: labels[index] as string }));
    expect(summarizeReceipts(with_('passed', 'passed'))).toEqual({ message: 'Core integrity passed. No operational warnings.', tone: 'accent' });
    expect(summarizeReceipts(with_('passed', 'passed', 'passed', 'passed', 'warning'))).toEqual({ message: 'Core integrity passed. One operational warning needs attention.', tone: 'warning' });
    expect(summarizeReceipts(with_('warning', 'warning'))).toEqual({ message: 'Core integrity passed. Two operational warnings need attention.', tone: 'warning' });
    expect(summarizeReceipts(with_('failed', 'warning', 'failed'))).toEqual({ message: 'Core integrity failed. Two checks need attention: Artifact hashes, Private access. Runs are blocked until the checks pass.', tone: 'danger' });
    expect(summarizeReceipts(with_('passed', 'passed', 'failed', 'passed', 'warning'))).toEqual({ message: 'Core integrity passed, but one permission check failed: Private access.', tone: 'danger' });
  });

  it('runs on an instance with no data, and every check still does real work', async () => {
    const empty = await makeTestApp({ seed: false });
    const adminId = await makeUser(empty, { email: 'admin@lab.example', role: 'admin' });
    const admin = await new Client(empty).signIn('admin@lab.example');

    const before = await (await admin.get('/api/admin/checks')).json();
    expect(before).toMatchObject({ latest: null, events: [] });
    expect(await (await admin.get('/api/admin/summary')).json()).toMatchObject({ latestCheck: null, models: { total: 0, enabled: 0 }, pendingCredentials: 0 });
    expect(await (await admin.get('/api/admin/models')).json()).toMatchObject({ items: [] });

    const result = await runSystemChecks(empty.ctx, adminId);
    expect(result.outcomes.map((outcome) => outcome.code)).toEqual(['CHECK-001', 'CHECK-002', 'CHECK-003', 'CHECK-004', 'CHECK-005', 'CHECK-006']);
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed']);
    expect(result.outcomes[0]?.detail).toBe('Passed · 0 of 0 verified');
    expect((result.outcomes[2]?.data.total as number) > 0).toBe(true);
    expect((result.outcomes[5]?.data.total as number) > 0).toBe(true);
    expect((await (await admin.get('/api/admin/checks')).json()).latest.tone).toBe('accent');
    empty.close();
  });

  it('records a check that could not finish as a failure, not a pass', async () => {
    const adminId = (await db().get<{ id: string }>(`SELECT id FROM users WHERE email = 'alex@rivet.example'`))?.id as string;
    const result = await runSystemChecks(test.ctx, adminId, {
      ...realDependencies,
      canReviewTask: async () => {
        throw new Error('Permission service exploded');
      },
    });
    const domain = result.outcomes.find((outcome) => outcome.key === 'domain_enforcement');
    expect(domain).toMatchObject({ status: 'failed', detail: 'Failed · The check could not finish' });
    expect(domain?.failures[0]?.reason).toBe('Permission service exploded');
    expect(await db().get(`SELECT 1 AS ok FROM users WHERE email LIKE 'check-probe%'`)).toBeUndefined();
  });
});
