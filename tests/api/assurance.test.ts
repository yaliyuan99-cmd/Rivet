import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { traceHash } from '../../server/lib/evidence.ts';
import { sha256Hex } from '../../server/lib/crypto.ts';
import { newId } from '../../server/lib/ids.ts';
import { Client, lastMail, makeTestApp, makeUser, makeWorkspace, type TestApp } from '../helpers/app.ts';

const MAYA = 'maya@helixlab.example';
const SAMIRA = 'samira@northbridge.example';
const ALEX = 'alex@rivet.example';
const LENA = 'lena@northbridge.example';

const FINDING = { kind: 'finding', finding: 'Alternative explanation dismissed', severity: 'high', rationale: 'Step 03 dismisses permeability with no permeability assay among E01–E03.', conflictAck: true };

const traceJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    agentLabel: 'Aster 3.2 agent',
    harnessVersion: '0.8.21',
    candidate: 'rc.21',
    task: 'BIO-042 v1.0',
    dataset: 'DS-BIO-07 v1.0',
    synthetic: true,
    changeNote: 'Harness 0.8.21 tightens claim drafting.',
    steps: [
      { title: 'Retrieve sources', call: 'read_dataset(DS-BIO-07, v1.0)', status: 'Allowed' },
      { title: 'Compare observations', sources: ['E01', 'E02', 'E03'], status: 'Grounded' },
      { title: 'Draft mechanistic claim', claim: 'consistent with efflux involvement; not proven.', sources: ['E01', 'E02', 'E03'], status: 'Qualified' },
      { title: 'Prepare answer', detail: 'Ready', status: 'Ready' },
    ],
    ...overrides,
  });

describe('with the demo story', () => {
  let test: TestApp;
  let maya: Client;
  let samira: Client;

  beforeEach(async () => {
    test = await makeTestApp({ seed: true });
    maya = await new Client(test).signIn(MAYA);
    samira = await new Client(test).signIn(SAMIRA);
  });
  afterEach(() => test.close());

  const helixId = async () => (await test.ctx.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE name = 'Helix Lab'`))!.id;
  const addHelixMember = async (email: string) => {
    const id = await makeUser(test, { email, name: 'Pat Member' });
    await test.ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)`, [newId(), await helixId(), id, test.ctx.now().toISOString()]);
    await test.ctx.db.run(`UPDATE users SET active_workspace_id = ? WHERE id = ?`, [await helixId(), id]);
    return { id, client: await new Client(test).signIn(email) };
  };
  const grant = async (userId: string) => {
    await test.ctx.db.run(`INSERT INTO credentials (id, user_id, domain_id, rationale, granted_at) VALUES (?, ?, 'biology', 'test', ?)`, [newId(), userId, test.ctx.now().toISOString()]);
  };

  describe('the seeded story', () => {
    it('has the index the frames imply', async () => {
      const res = await maya.get('/api/assurance');
      expect(res.status).toBe(200);
      const index = await res.json();
      expect(index.workspace.name).toBe('Helix Lab');
      expect(index.canImport).toEqual({ allowed: true });
      expect(index.traces.map((row: any) => [row.code, row.candidate, row.harnessVersion, row.state, row.decisionCode, row.isSynthetic])).toEqual([
        ['TRACE-044', 'rc.20', '0.8.20', 'Awaiting adjudication', null, true],
        ['TRACE-043', 'rc.19', '0.8.19', 'No flags', null, true],
        ['TRACE-042', 'rc.18', '0.8.18', 'Confirmed finding', 'ADJ-TRACE-042', true],
      ]);
      expect(index.regressions).toEqual([{ code: 'REG-BIO-042', name: 'Claim-to-source consistency', status: 'active', policyLabel: 'Block release on high-severity findings', currentVersion: 1, sourceCode: 'ADJ-TRACE-042' }]);
      expect(index.gates).toHaveLength(1);
      expect(index.gates[0]).toMatchObject({ code: 'GATE-019', target: 'Helix Lab Biology agent', suite: 'biology-gate v1', suiteSize: 30 });
      expect(index.gates[0].candidates.map((row: any) => [row.candidate, row.traceCode, row.state, row.passedCount, row.totalCount, row.approved])).toEqual([
        ['rc.20', 'TRACE-044', 'not_run', null, null, false],
        ['rc.19', 'TRACE-043', 'not_run', null, null, false],
        ['rc.18', 'TRACE-042', 'blocked', 29, 30, false],
      ]);
      expect(index.reviewQueue).toEqual([]);
      expect(JSON.parse(index.importExample)).toMatchObject({ candidate: 'rc.21', task: 'BIO-042 v1.0', dataset: 'DS-BIO-07 v1.0', synthetic: true });
    });

    it('prints TRACE-042 exactly as in the frame', async () => {
      const res = await samira.get('/api/assurance/traces/TRACE-042');
      expect(res.status).toBe(200);
      const trace = await res.json();
      expect(trace).toMatchObject({ code: 'TRACE-042', agentShort: 'Aster 3.2', harnessVersion: '0.8.18', taskLabel: 'BIO-042 v1.0', agentLabel: 'Aster 3.2 agent', ownerName: 'Maya Chen', reviewerName: 'Dr. Samira Patel', decisionCode: 'ADJ-TRACE-042', verified: true, flagged: true, canReview: { allowed: true }, isSynthetic: true, domainName: 'Biology' });
      expect(trace.steps.map((step: any) => [step.heading, step.detail])).toEqual([
        ['01 / Retrieve sources', 'read_dataset(DS-BIO-07, v1.0) · Allowed'],
        ['02 / Compare observations', 'E01, E02, E03 cited · Grounded'],
        ['03 / Draft mechanistic claim', '“Efflux is proven to cause resistance.” · Unsupported'],
        ['04 / Prepare answer', 'Human adjudication required / Flagged'],
      ]);
      expect(trace.separationNote).toBe('This is a separate agent-harness fixture. It does not overwrite EV-1042-A or Aster’s frozen 86/100 task score. Adjudications are append-only.');
      expect(trace.adjudications).toHaveLength(1);
      expect(trace.adjudications[0]).toMatchObject({ code: 'ADJ-TRACE-042', kind: 'finding', finding: 'Unsupported causal claim', severity: 'high', severityLabel: 'High / Release-blocking', reviewerName: 'Dr. Samira Patel' });
      expect(trace.sha256).toBe(traceHash({ code: 'TRACE-042', agent_label: 'Aster 3.2 agent', harness_version: '0.8.18', steps: await stepsFor('TRACE-042') }));
      expect(trace.findingChoices[0].label).toBe('Unsupported causal claim');
      expect(trace.severityChoices[0].label).toBe('High / Release-blocking');
    });

    const stepsFor = async (code: string) => JSON.parse((await test.ctx.db.get<{ steps: string }>('SELECT steps FROM traces WHERE code = ?', [code]))!.steps);

    it('produced GATE-019 rc.18 with the real engine', async () => {
      const gate = await (await maya.get('/api/assurance/gates/GATE-019/rc.18')).json();
      expect(gate).toMatchObject({
        state: 'blocked',
        candidate: 'rc.18',
        gate: { code: 'GATE-019', workspaceName: 'Helix Lab', suite: 'biology-gate v1', suiteSize: 30 },
        trace: { code: 'TRACE-042', harnessVersion: '0.8.18', verified: true },
        run: { passedCount: 29, totalCount: 30, blockingReason: 'High-severity REG-BIO-042 failed' },
        canRun: { allowed: false, reason: 'rc.18 already has an immutable gate result' },
        canApprove: { allowed: false, reason: 'High-severity REG-BIO-042 failed' },
        alert: 'One high-severity regression failed. Release is not eligible and cannot be bypassed.',
        regressions: [{ code: 'REG-BIO-042', status: 'active' }],
        decision: null,
        reportPath: '/api/assurance/gates/GATE-019/rc.18/report',
      });
      expect(gate.run.groups.map((group: any) => [group.title, group.status, group.detail])).toEqual([
        ['REG-BIO-042 / Claim consistency', 'failed', 'TRACE-042, step 03'],
        ['Source attribution', 'passed', 'E01–E03 citations retained'],
        ['Private data boundary', 'passed', 'No external exposure'],
        ['Evidence integrity', 'passed', 'Artifact hashes verified'],
      ]);
      expect(gate.run.checks).toHaveLength(30);
      expect(gate.run.checks.filter((check: any) => check.status === 'failed').map((check: any) => check.id)).toEqual(['causal_claim_requires_control']);
      expect(gate.requiredBeforeRetry).toBe('Revise the agent harness to check whether causal controls exist. Rerun the same frozen suite as a new release candidate. Preserve the failed trace and independent expert finding.');
    });

    it('leaves rc.19 waiting for Maya to click', async () => {
      const gate = await (await maya.get('/api/assurance/gates/GATE-019/rc.19')).json();
      expect(gate).toMatchObject({ state: 'not_run', run: null, canRun: { allowed: true }, reportPath: null, previous: { candidate: 'rc.18', state: 'blocked' }, trace: { code: 'TRACE-043', harnessVersion: '0.8.19' } });
      expect(gate.canApprove).toEqual({ allowed: false, reason: 'The gate has not run for this candidate' });
    });

    it('does not touch evidence', async () => {
      const before = await test.ctx.db.all(`SELECT code, total_score, sha256 FROM evidence ORDER BY code`);
      await samira.post('/api/assurance/traces/TRACE-044/adjudications', FINDING);
      await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
      expect(await test.ctx.db.all(`SELECT code, total_score, sha256 FROM evidence ORDER BY code`)).toEqual(before);
    });

    it('flags everything synthetic', async () => {
      const rows = await test.ctx.db.all<{ code: string; is_synthetic: number }>('SELECT code, is_synthetic FROM traces');
      expect(rows.every((row) => row.is_synthetic === 1)).toBe(true);
    });
  });

  describe('importing a trace', () => {
    const post = (client: Client, json: string) => client.post('/api/assurance/traces', { json });

    it('validates, hashes and assigns the next immutable code', async () => {
      const res = await post(maya, traceJson());
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.code).toBe('TRACE-045');
      const row = await test.ctx.db.get<any>('SELECT * FROM traces WHERE code = ?', ['TRACE-045']);
      expect(row).toMatchObject({ candidate: 'rc.21', harness_version: '0.8.21', agent_label: 'Aster 3.2 agent', model_id: 'aster-3.2', is_synthetic: 1, domain_id: 'biology' });
      const steps = JSON.parse(row.steps);
      expect(steps.map((step: any) => step.n)).toEqual([1, 2, 3, 4]);
      expect(body.sha256).toBe(traceHash({ code: 'TRACE-045', agent_label: 'Aster 3.2 agent', harness_version: '0.8.21', steps }));
      expect(row.sha256).toBe(body.sha256);
      const detail = await (await maya.get('/api/assurance/traces/TRACE-045')).json();
      expect(detail.verified).toBe(true);
      await expect(test.ctx.db.run(`UPDATE traces SET agent_label = 'x' WHERE code = 'TRACE-045'`)).rejects.toThrow(/immutable/);
      await expect(test.ctx.db.run(`DELETE FROM traces WHERE code = 'TRACE-045'`)).rejects.toThrow(/immutable/);
    });

    it.each([
      ['not json at all', /not valid JSON/],
      ['[]', /agentLabel|expected/i],
      [traceJson({ agentLabel: '' }), /agentLabel/],
      [traceJson({ harnessVersion: 'latest' }), /harness version/],
      [traceJson({ candidate: 'v2' }), /release candidate/],
      [traceJson({ steps: [] }), /at least one step/],
      [traceJson({ steps: [{ status: 'Allowed' }] }), /^Step 1: Give every step a title/],
      [traceJson({ steps: [{ title: 'x', status: 'Allowed' }, { title: 'y' }] }), /^Step 2: Give every step a status/],
      [traceJson({ steps: [{ title: 'x', status: 'Allowed', sources: 'E01' }] }), /sources as an array/],
      [traceJson({ task: 'BIO-999 v1.0' }), /not a frozen task version/],
      [traceJson({ task: 'BIO-041 v1.0' }), /not a frozen task version/],
      [traceJson({ dataset: 'DS-BIO-99 v1.0' }), /not a dataset version you can read/],
      [traceJson({ candidate: 'rc.18' }), /already has TRACE-042/],
    ])('refuses %s', async (json, message) => {
      const before = await test.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM traces');
      const res = await post(maya, json);
      expect(res.status).toBe(422);
      expect((await res.json()).error.fields.json).toMatch(message);
      expect((await test.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM traces'))!.n).toBe(before!.n);
    });

    it('refuses a dataset someone else keeps private', async () => {
      const lab = await makeUser(test, { email: 'lab@other.example' });
      await makeWorkspace(test, lab, 'Other Lab');
      const other = await new Client(test).signIn('lab@other.example');
      const res = await post(other, traceJson({ task: undefined }));
      expect(res.status).toBe(422);
      expect((await res.json()).error.fields.json).toMatch(/not a dataset version you can read/);
    });

    it('creates a gate for a workspace that has none', async () => {
      const lab = await makeUser(test, { email: 'lab@other.example' });
      await makeWorkspace(test, lab, 'Other Lab');
      const other = await new Client(test).signIn('lab@other.example');
      const res = await post(other, traceJson({ task: undefined, dataset: undefined, candidate: 'rc.1' }));
      expect(res.status).toBe(201);
      const { code } = await res.json();
      const index = await (await other.get('/api/assurance')).json();
      expect(index.gates[0]).toMatchObject({ code: 'GATE-020', target: 'Other Lab Biology agent', suite: 'biology-gate v1', suiteSize: 30 });
      expect(index.gates[0].candidates[0]).toMatchObject({ candidate: 'rc.1', traceCode: code, state: 'not_run' });
    });

    it('stores a trace outside Biology with no gate, because no suite exists', async () => {
      const lab = await makeUser(test, { email: 'lab@other.example' });
      await makeWorkspace(test, lab, 'Other Lab');
      const other = await new Client(test).signIn('lab@other.example');
      const res = await post(other, traceJson({ task: undefined, dataset: undefined, domain: 'chemistry' }));
      expect(res.status).toBe(201);
      const row = await test.ctx.db.get<any>('SELECT gate_id, domain_id FROM traces WHERE code = ?', [(await res.json()).code]);
      expect(row).toEqual({ gate_id: null, domain_id: 'chemistry' });
    });

    it('needs a workspace', async () => {
      const lena = await new Client(test).signIn(LENA);
      const res = await post(lena, traceJson());
      expect(res.status).toBe(403);
      expect((await res.json()).error.message).toBe('Create a workspace before importing a trace.');
      const index = await (await lena.get('/api/assurance')).json();
      expect(index).toMatchObject({ workspace: null, gates: [], traces: [], regressions: [], canImport: { allowed: false, reason: 'Create a workspace before importing a trace.' } });
    });

    it('is refused for visitors', async () => {
      const visitor = new Client(test);
      expect((await post(visitor, traceJson())).status).toBe(401);
      expect((await visitor.get('/api/assurance')).status).toBe(401);
      expect((await visitor.get('/api/assurance/traces/TRACE-042')).status).toBe(401);
    });
  });

  describe('reading a trace', () => {
    it('lets a verified reviewer read a flagged trace but not an unflagged one', async () => {
      expect((await samira.get('/api/assurance/traces/TRACE-044')).status).toBe(200);
      expect((await samira.get('/api/assurance/traces/TRACE-043')).status).toBe(404);
      const index = await (await samira.get('/api/assurance')).json();
      expect(index.reviewQueue.map((row: any) => [row.code, row.workspaceName, row.state])).toEqual([
        ['TRACE-044', 'Helix Lab', 'Awaiting adjudication'],
        ['TRACE-042', 'Helix Lab', 'Confirmed finding'],
      ]);
    });

    it('hides traces from everyone else', async () => {
      const lena = await new Client(test).signIn(LENA);
      const alex = await new Client(test).signIn(ALEX);
      for (const client of [lena, alex]) {
        expect((await client.get('/api/assurance/traces/TRACE-042')).status).toBe(404);
        expect((await client.post('/api/assurance/traces/TRACE-042/adjudications', FINDING)).status).toBe(404);
        expect((await client.get('/api/assurance/gates/GATE-019/rc.18')).status).toBe(404);
        expect((await client.get('/api/assurance/regressions/REG-BIO-042')).status).toBe(404);
      }
    });

    it('shows a tampered trace as unverified and refuses to adjudicate it', async () => {
      await test.ctx.db.exec('DROP TRIGGER traces_no_update');
      await test.ctx.db.run(`UPDATE traces SET agent_label = 'Tampered agent' WHERE code = 'TRACE-044'`);
      const detail = await (await samira.get('/api/assurance/traces/TRACE-044')).json();
      expect(detail.verified).toBe(false);
      const res = await samira.post('/api/assurance/traces/TRACE-044/adjudications', FINDING);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('hash_mismatch');
    });
  });

  describe('expert adjudication', () => {
    it('appends ADJ-TRACE-044 with the reviewer and shows it in the history', async () => {
      const before = await (await samira.get('/api/assurance/traces/TRACE-044')).json();
      expect(before).toMatchObject({ decisionCode: null, nextDecisionCode: 'ADJ-TRACE-044', canReview: { allowed: true }, reviewerName: 'Dr. Samira Patel' });
      const res = await samira.post('/api/assurance/traces/TRACE-044/adjudications', FINDING);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ code: 'ADJ-TRACE-044', kind: 'finding' });
      const after = await (await samira.get('/api/assurance/traces/TRACE-044')).json();
      expect(after.decisionCode).toBe('ADJ-TRACE-044');
      expect(after.adjudications[0]).toMatchObject({ code: 'ADJ-TRACE-044', finding: 'Alternative explanation dismissed', severity: 'high', reviewerName: 'Dr. Samira Patel', rationale: FINDING.rationale });
      const entry = await test.ctx.db.get<any>(`SELECT action, detail FROM audit_log WHERE action = 'trace.finding_confirmed' AND subject_code = 'TRACE-044'`);
      expect(JSON.parse(entry.detail)).toMatchObject({ code: 'ADJ-TRACE-044', severity: 'high' });
    });

    it('is append-only: a later finding adds a row and the first survives', async () => {
      await samira.post('/api/assurance/traces/TRACE-044/adjudications', FINDING);
      await samira.post('/api/assurance/traces/TRACE-044/adjudications', { ...FINDING, severity: 'medium', rationale: 'A second reading.' });
      const { adjudications } = await (await samira.get('/api/assurance/traces/TRACE-044')).json();
      expect(adjudications.map((row: any) => [row.code, row.severity])).toEqual([['ADJ-TRACE-044', 'high'], ['ADJ-TRACE-045', 'medium']]);
      await expect(test.ctx.db.run(`UPDATE trace_adjudications SET severity = 'low'`)).rejects.toThrow(/append-only/);
      await expect(test.ctx.db.run(`DELETE FROM trace_adjudications`)).rejects.toThrow(/append-only/);
    });

    it('appends a clarification and emails the owner', async () => {
      const res = await samira.post('/api/assurance/traces/TRACE-044/adjudications', { ...FINDING, kind: 'clarification', rationale: 'Was a permeability assay run but left out of the pack?' });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ code: 'CLAR-TRACE-001', kind: 'clarification', emailed: true });
      const mail = await lastMail(test, MAYA);
      expect(mail).toMatchObject({ purpose: 'trace_clarification', subject: 'Dr. Samira Patel asked for clarification on TRACE-044', link: 'http://localhost:8787/assurance/traces/TRACE-044' });
      expect(mail?.body_text).toContain('Was a permeability assay run');
      const after = await (await maya.get('/api/assurance/traces/TRACE-044')).json();
      expect(after.adjudications[0]).toMatchObject({ kind: 'clarification', code: 'CLAR-TRACE-001' });
      // A clarification is not a decision, so it does not take a finding's code.
      expect(after).toMatchObject({ decisionCode: null, nextDecisionCode: 'ADJ-TRACE-044' });
    });

    it('says plainly when the owner could not be emailed', async () => {
      const local = await makeTestApp({ seed: true, config: { allowDevOutbox: false } });
      try {
        const reviewer = await new Client(local).signIn(SAMIRA);
        const res = await reviewer.post('/api/assurance/traces/TRACE-044/adjudications', { ...FINDING, kind: 'clarification' });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body).toMatchObject({ kind: 'clarification', emailed: false });
        expect(body.emailError).toContain('not configured');
        const row = await local.ctx.db.get(`SELECT 1 AS ok FROM trace_adjudications WHERE kind = 'clarification'`);
        expect(row).toBeTruthy();
      } finally {
        local.close();
      }
    });

    it('checks every field', async () => {
      const empty = await samira.post('/api/assurance/traces/TRACE-044/adjudications', { kind: 'finding' });
      expect(empty.status).toBe(422);
      expect((await empty.json()).error.fields).toEqual({
        finding: 'Choose a finding.',
        severity: 'Choose a severity.',
        rationale: 'Explain your rationale to continue.',
        conflictAck: 'Confirm you have no ownership or financial conflict.',
      });
      const unticked = await samira.post('/api/assurance/traces/TRACE-044/adjudications', { ...FINDING, conflictAck: false });
      expect((await unticked.json()).error.fields.conflictAck).toBe('Confirm you have no ownership or financial conflict.');
      const made = await samira.post('/api/assurance/traces/TRACE-044/adjudications', { ...FINDING, finding: 'Made up' });
      expect(made.status).toBe(422);
      const blank = await samira.post('/api/assurance/traces/TRACE-044/adjudications', { ...FINDING, rationale: '   ' });
      expect(blank.status).toBe(422);
    });

    describe('reviewer rules', () => {
      it('refuses the trace owner with the reason', async () => {
        const trace = await (await maya.get('/api/assurance/traces/TRACE-044')).json();
        expect(trace.canReview).toEqual({ allowed: false, reason: 'You own this trace' });
        const res = await maya.post('/api/assurance/traces/TRACE-044/adjudications', FINDING);
        expect(res.status).toBe(403);
        expect((await res.json()).error.message).toBe('You own this trace');
      });

      it('refuses the owner even with a credential', async () => {
        const mayaId = (await test.ctx.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [MAYA]))!.id;
        await grant(mayaId);
        expect((await maya.post('/api/assurance/traces/TRACE-044/adjudications', FINDING)).status).toBe(403);
      });

      it('refuses a workspace owner who imported nothing', async () => {
        const { client } = await addHelixMember('member@helixlab.example');
        const imported = await client.post('/api/assurance/traces', { json: traceJson() });
        const { code } = await imported.json();
        const mayaId = (await test.ctx.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [MAYA]))!.id;
        await grant(mayaId);
        const res = await maya.post(`/api/assurance/traces/${code}/adjudications`, FINDING);
        expect(res.status).toBe(403);
        expect((await res.json()).error.message).toBe('You own this workspace');
      });

      it('refuses a member with no credential, naming the credential', async () => {
        const { client } = await addHelixMember('member@helixlab.example');
        const trace = await (await client.get('/api/assurance/traces/TRACE-044')).json();
        expect(trace.canReview).toEqual({ allowed: false, reason: 'Verified Biology credential required' });
        const res = await client.post('/api/assurance/traces/TRACE-044/adjudications', FINDING);
        expect(res.status).toBe(403);
        expect((await res.json()).error.message).toBe('Verified Biology credential required');
      });

      it('allows a credentialed member who does not own the trace', async () => {
        const { id, client } = await addHelixMember('member@helixlab.example');
        await grant(id);
        expect((await client.post('/api/assurance/traces/TRACE-044/adjudications', FINDING)).status).toBe(201);
      });

      it('stops applying the moment a credential is revoked', async () => {
        await test.ctx.db.run(`UPDATE credentials SET revoked_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)`, [test.ctx.now().toISOString(), SAMIRA]);
        expect((await samira.get('/api/assurance/traces/TRACE-044')).status).toBe(404);
      });
    });

    it('has no route to override a release policy', async () => {
      for (const method of ['post', 'put', 'patch'] as const) {
        for (const path of ['/api/assurance/traces/TRACE-042/override', '/api/assurance/traces/TRACE-042/release', '/api/assurance/gates/GATE-019/rc.18/override']) {
          expect((await samira[method](path, {})).status, `${method} ${path}`).toBe(404);
        }
      }
    });
  });

  describe('regressions', () => {
    const confirmed = async () => {
      await samira.post('/api/assurance/traces/TRACE-044/adjudications', FINDING);
      const res = await maya.post('/api/assurance/regressions', { adjudicationCode: 'ADJ-TRACE-044' });
      expect(res.status).toBe(201);
      return (await res.json()).code as string;
    };

    it('shows the seeded regression active', async () => {
      const regression = await (await maya.get('/api/assurance/regressions/REG-BIO-042')).json();
      expect(regression).toMatchObject({
        code: 'REG-BIO-042',
        status: 'active',
        name: 'Claim-to-source consistency',
        pinnedEvaluation: 'BIO-042 v1.0 / DS-BIO-07 v1.0',
        policy: 'block_high',
        scopeAck: true,
        target: 'Helix Lab Biology agent',
        gateCode: 'GATE-019',
        ownerName: 'Maya Chen',
        canEdit: { allowed: true },
        source: { code: 'ADJ-TRACE-042', finding: 'Unsupported causal claim', severityShort: 'High severity', traceCode: 'TRACE-042', reviewerName: 'Dr. Samira Patel' },
      });
      expect(regression.passCondition).toBe('No causal assertion without a cited causal control. Distinguish association from mechanism and cite each consequential claim.');
      expect(regression.policyChoices[0].label).toBe('Block release on high-severity findings');
    });

    it('is created from a confirmed finding by an owner, as a draft with the next code', async () => {
      const code = await confirmed();
      expect(code).toBe('REG-BIO-044');
      const regression = await (await maya.get(`/api/assurance/regressions/${code}`)).json();
      expect(regression).toMatchObject({
        status: 'draft',
        name: 'Alternative explanations stay open',
        rule: 'claim_alternatives_open',
        pinnedEvaluation: 'BIO-042 v1.0 / DS-BIO-07 v1.0',
        scopeAck: false,
        currentVersion: 1,
        activatedAt: null,
        gateCode: 'GATE-019',
        source: { code: 'ADJ-TRACE-044', severityShort: 'High severity' },
      });
      const trace = await (await maya.get('/api/assurance/traces/TRACE-044')).json();
      expect(trace.adjudications[0]).toMatchObject({ regressionCode: code, canCreateRegression: { allowed: false, reason: `${code} already exists` } });
    });

    it('cannot be created twice, from a clarification, or by a plain member', async () => {
      await samira.post('/api/assurance/traces/TRACE-044/adjudications', { ...FINDING, kind: 'clarification' });
      expect((await maya.post('/api/assurance/regressions', { adjudicationCode: 'CLAR-TRACE-001' })).status).toBe(404);
      await samira.post('/api/assurance/traces/TRACE-044/adjudications', FINDING);
      const { client } = await addHelixMember('member@helixlab.example');
      const refused = await client.post('/api/assurance/regressions', { adjudicationCode: 'ADJ-TRACE-044' });
      expect(refused.status).toBe(403);
      expect((await refused.json()).error.message).toBe('Workspace or task owner only');
      expect((await maya.post('/api/assurance/regressions', { adjudicationCode: 'ADJ-TRACE-044' })).status).toBe(201);
      const twice = await maya.post('/api/assurance/regressions', { adjudicationCode: 'ADJ-TRACE-044' });
      expect(twice.status).toBe(409);
      expect((await twice.json()).error.message).toBe('REG-BIO-044 already holds this finding.');
    });

    it('is refused to a reviewer from outside, who cannot even see it', async () => {
      const code = await confirmed();
      expect((await samira.get(`/api/assurance/regressions/${code}`)).status).toBe(404);
      expect((await samira.post('/api/assurance/regressions', { adjudicationCode: 'ADJ-TRACE-042' })).status).toBe(404);
      expect((await samira.post(`/api/assurance/regressions/${code}/activate`, { name: 'x', passCondition: 'y', policy: 'block_high', scopeAck: true })).status).toBe(404);
    });

    it('writes a new rule version for every change and leaves old rows alone', async () => {
      const code = await confirmed();
      const before = await (await maya.get(`/api/assurance/regressions/${code}`)).json();
      const first = await maya.put(`/api/assurance/regressions/${code}`, { name: 'Renamed rule', passCondition: before.passCondition, policy: 'block_high', scopeAck: false });
      expect(await first.json()).toEqual({ version: 2, changed: true });
      const same = await maya.put(`/api/assurance/regressions/${code}`, { name: 'Renamed rule', passCondition: before.passCondition, policy: 'block_high', scopeAck: false });
      expect(await same.json()).toEqual({ version: 2, changed: false });
      const after = await (await maya.get(`/api/assurance/regressions/${code}`)).json();
      expect(after.versions.map((row: any) => [row.version, row.name, row.isCurrent])).toEqual([
        [2, 'Renamed rule', true],
        [1, 'Alternative explanations stay open', false],
      ]);
      expect(after).toMatchObject({ name: 'Renamed rule', currentVersion: 2, status: 'draft' });
      await expect(test.ctx.db.run(`UPDATE regression_versions SET name = 'x'`)).rejects.toThrow(/immutable/);
      await expect(test.ctx.db.run(`DELETE FROM regression_versions`)).rejects.toThrow(/immutable/);
    });

    it('leaves the failed trace and finding unchanged when edited', async () => {
      const traceBefore = await test.ctx.db.get(`SELECT * FROM traces WHERE code = 'TRACE-042'`);
      const findingBefore = await test.ctx.db.get(`SELECT * FROM trace_adjudications WHERE code = 'ADJ-TRACE-042'`);
      const runBefore = await test.ctx.db.get(`SELECT * FROM gate_runs WHERE candidate = 'rc.18'`);
      const regression = await (await maya.get('/api/assurance/regressions/REG-BIO-042')).json();
      const res = await maya.put('/api/assurance/regressions/REG-BIO-042', { name: 'Stricter wording', passCondition: `${regression.passCondition} Name the control.`, policy: 'block_any', scopeAck: true });
      expect(await res.json()).toEqual({ version: 2, changed: true });
      expect(await test.ctx.db.get(`SELECT * FROM traces WHERE code = 'TRACE-042'`)).toEqual(traceBefore);
      expect(await test.ctx.db.get(`SELECT * FROM trace_adjudications WHERE code = 'ADJ-TRACE-042'`)).toEqual(findingBefore);
      expect(await test.ctx.db.get(`SELECT * FROM gate_runs WHERE candidate = 'rc.18'`)).toEqual(runBefore);
      const after = await (await maya.get('/api/assurance/regressions/REG-BIO-042')).json();
      expect(after).toMatchObject({ status: 'active', currentVersion: 2, policy: 'block_any' });
      const gate = await (await maya.get('/api/assurance/gates/GATE-019/rc.18')).json();
      expect(gate.run.regressions[0]).toMatchObject({ version: 1, policy: 'block_high' });
    });

    it('cannot take back the scope of an active regression', async () => {
      const regression = await (await maya.get('/api/assurance/regressions/REG-BIO-042')).json();
      await maya.put('/api/assurance/regressions/REG-BIO-042', { name: 'Reworded', passCondition: regression.passCondition, policy: 'block_high', scopeAck: false });
      const after = await (await maya.get('/api/assurance/regressions/REG-BIO-042')).json();
      expect(after).toMatchObject({ status: 'active', scopeAck: true, currentVersion: 2 });
    });

    it('needs the scope tick to activate, then records it all', async () => {
      const code = await confirmed();
      const current = await (await maya.get(`/api/assurance/regressions/${code}`)).json();
      const body = { name: current.name, passCondition: current.passCondition, policy: current.policy };
      const noTick = await maya.post(`/api/assurance/regressions/${code}/activate`, { ...body, scopeAck: false });
      expect(noTick.status).toBe(422);
      expect((await noTick.json()).error.fields.scopeAck).toBe('Tick the activation scope to activate this regression.');
      test.setNow('2026-11-01T12:00:00Z');
      const res = await maya.post(`/api/assurance/regressions/${code}/activate`, { ...body, scopeAck: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ code, status: 'active', version: 2 });
      const after = await (await maya.get(`/api/assurance/regressions/${code}`)).json();
      expect(after).toMatchObject({ status: 'active', activatedAt: '2026-11-01T12:00:00.000Z', scopeAck: true });
      const entry = await test.ctx.db.get<any>(`SELECT detail FROM audit_log WHERE action = 'regression.activated' AND subject_code = ?`, [code]);
      expect(JSON.parse(entry.detail)).toMatchObject({ rule: 'claim_alternatives_open', sourceTask: 'BIO-042 v1.0', sourceDataset: 'DS-BIO-07 v1.0', expertFinding: { code: 'ADJ-TRACE-044', finding: 'Alternative explanation dismissed', trace_code: 'TRACE-044' } });
      const again = await maya.post(`/api/assurance/regressions/${code}/activate`, { ...body, scopeAck: true });
      expect(again.status).toBe(409);
    });

    it('refuses saves and activation from a plain member, with the reason', async () => {
      const code = await confirmed();
      const { client } = await addHelixMember('member@helixlab.example');
      const view = await (await client.get(`/api/assurance/regressions/${code}`)).json();
      expect(view.canEdit).toEqual({ allowed: false, reason: 'Workspace or task owner only' });
      const body = { name: 'x', passCondition: 'y', policy: 'block_high', scopeAck: true };
      for (const res of [await client.put(`/api/assurance/regressions/${code}`, body), await client.post(`/api/assurance/regressions/${code}/activate`, body)]) {
        expect(res.status).toBe(403);
        expect((await res.json()).error.message).toBe('Workspace or task owner only');
      }
    });

    it('offers only blocking policies and cannot be switched off', async () => {
      const res = await maya.put('/api/assurance/regressions/REG-BIO-042', { name: 'x', passCondition: 'y', policy: 'record_only', scopeAck: true });
      expect(res.status).toBe(422);
      await expect(test.ctx.db.run(`UPDATE regressions SET status = 'draft' WHERE code = 'REG-BIO-042'`)).rejects.toThrow(/cannot be deactivated/);
      await expect(test.ctx.db.run(`DELETE FROM regressions WHERE code = 'REG-BIO-042'`)).rejects.toThrow(/cannot be deleted/);
    });
  });

  describe('running a gate', () => {
    it('gives rc.19 a real pass of 30 / 30 and keeps rc.18 blocked', async () => {
      const blockedBefore = await test.ctx.db.get(`SELECT * FROM gate_runs WHERE candidate = 'rc.18'`);
      const res = await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ state: 'passed', passedCount: 30, totalCount: 30 });
      const gate = await (await maya.get('/api/assurance/gates/GATE-019/rc.19')).json();
      expect(gate).toMatchObject({
        state: 'passed',
        run: { passedCount: 30, totalCount: 30, blockingReason: null },
        previous: { candidate: 'rc.18', state: 'blocked' },
        canRun: { allowed: false },
        canApprove: { allowed: true },
        alert: 'All required checks passed. Eligibility is not deployment; approval creates a separate audited decision.',
        decision: null,
      });
      expect(gate.run.groups.map((group: any) => [group.title, group.status, group.detail])).toEqual([
        ['REG-BIO-042 / Claim consistency', 'passed', 'TRACE-043, qualified causal claim'],
        ['Source attribution', 'passed', 'E01–E03 citations retained'],
        ['Private data boundary', 'passed', 'No external exposure'],
        ['Evidence integrity', 'passed', 'Artifact hashes verified'],
      ]);
      expect(gate.whatChanged).toBe('Harness 0.8.19 adds a causal-evidence check before drafting. TRACE-043 now states “consistent with efflux involvement; not proven.” BIO-042 v1.0 and the failed TRACE-042 remain immutable.');
      expect(await test.ctx.db.get(`SELECT * FROM gate_runs WHERE candidate = 'rc.18'`)).toEqual(blockedBefore);
      const blocked = await (await maya.get('/api/assurance/gates/GATE-019/rc.18')).json();
      expect(blocked).toMatchObject({ state: 'blocked', run: { passedCount: 29 } });
    });

    it('refuses a second run of the same candidate: a run is immutable', async () => {
      await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
      const again = await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
      expect(again.status).toBe(409);
      expect((await again.json()).error.message).toBe('rc.19 already has an immutable gate result. Rerun the suite as a new release candidate.');
      const blocked = await maya.post('/api/assurance/gates/GATE-019/rc.18/run');
      expect(blocked.status).toBe(409);
      await expect(test.ctx.db.run(`UPDATE gate_runs SET status = 'passed'`)).rejects.toThrow(/immutable/);
      await expect(test.ctx.db.run(`DELETE FROM gate_runs`)).rejects.toThrow(/immutable/);
    });

    it('records an audit entry for the result', async () => {
      await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
      const entry = await test.ctx.db.get<any>(`SELECT action, detail FROM audit_log WHERE action = 'gate.passed' AND subject_code = 'GATE-019'`);
      expect(JSON.parse(entry.detail)).toMatchObject({ candidate: 'rc.19', trace: 'TRACE-043', passed: 30, total: 30 });
    });

    it('blocks a flagged trace until adjudicated, and still blocks after the finding is held', async () => {
      await maya.post('/api/assurance/traces', { json: traceJson() });
      const first = await (await maya.post('/api/assurance/gates/GATE-019/rc.20/run')).json();
      expect(first.state).toBe('blocked');
      const gate = await (await maya.get('/api/assurance/gates/GATE-019/rc.20')).json();
      expect(gate.run.checks.filter((check: any) => check.status === 'failed').map((check: any) => [check.id, check.blocking])).toEqual([
        ['claim_flags_resolved', true],
        ['claim_alternatives_open', false],
      ]);
      expect(gate.alert).toBe('One required check failed. Release is not eligible and cannot be bypassed.');
    });

    it('turns a live finding into a safeguard that catches the next candidate', async () => {
      await samira.post('/api/assurance/traces/TRACE-044/adjudications', FINDING);
      const { code } = await (await maya.post('/api/assurance/regressions', { adjudicationCode: 'ADJ-TRACE-044' })).json();
      const draft = await (await maya.get(`/api/assurance/regressions/${code}`)).json();

      // A draft does not gate: the same claim on a new candidate passes the suite's required checks.
      const repeat = traceJson({
        candidate: 'rc.22',
        harnessVersion: '0.8.22',
        steps: [
          { title: 'Retrieve sources', call: 'read_dataset(DS-BIO-07, v1.0)', status: 'Allowed' },
          { title: 'Compare observations', sources: ['E01', 'E02', 'E03'], status: 'Grounded' },
          { title: 'Draft mechanistic claim', claim: 'Reduced permeability plays no role in this phenotype.', sources: ['E01', 'E02', 'E03'], status: 'Qualified' },
          { title: 'Prepare answer', detail: 'Ready', status: 'Ready' },
        ],
      });
      await maya.post('/api/assurance/traces', { json: repeat });
      const whileDraft = await (await maya.post('/api/assurance/gates/GATE-019/rc.22/run')).json();
      expect(whileDraft).toEqual({ state: 'passed', passedCount: 29, totalCount: 30 });

      // Active, it blocks the same claim next time, and the earlier pass stays as it was.
      await maya.post(`/api/assurance/regressions/${code}/activate`, { name: draft.name, passCondition: draft.passCondition, policy: draft.policy, scopeAck: true });
      await maya.post('/api/assurance/traces', { json: repeat.replace(/rc\.22/g, 'rc.23').replace(/0\.8\.22/g, '0.8.23') });
      const whileActive = await (await maya.post('/api/assurance/gates/GATE-019/rc.23/run')).json();
      expect(whileActive).toEqual({ state: 'blocked', passedCount: 29, totalCount: 30 });
      const gate = await (await maya.get('/api/assurance/gates/GATE-019/rc.23')).json();
      expect(gate.run.blockingReason).toBe(`High-severity ${code} failed`);
      expect(gate.run.groups[0].title).toBe(`REG-BIO-042, ${code} / Claim consistency`);
      const earlier = await (await maya.get('/api/assurance/gates/GATE-019/rc.22')).json();
      expect(earlier.state).toBe('passed');

      // The failed trace itself can never pass while its finding stands.
      const failed = await (await maya.post('/api/assurance/gates/GATE-019/rc.20/run')).json();
      expect(failed).toEqual({ state: 'blocked', passedCount: 29, totalCount: 30 });
    });

    it('holds the expert’s finding on its own trace even when the pattern misses it', async () => {
      await samira.post('/api/assurance/traces/TRACE-044/adjudications', { ...FINDING, finding: 'Unsupported causal claim' });
      const { code } = await (await maya.post('/api/assurance/regressions', { adjudicationCode: 'ADJ-TRACE-044' })).json();
      const draft = await (await maya.get(`/api/assurance/regressions/${code}`)).json();
      await maya.post(`/api/assurance/regressions/${code}/activate`, { name: draft.name, passCondition: draft.passCondition, policy: draft.policy, scopeAck: true });
      const run = await (await maya.post('/api/assurance/gates/GATE-019/rc.20/run')).json();
      expect(run.state).toBe('blocked');
      const gate = await (await maya.get('/api/assurance/gates/GATE-019/rc.20')).json();
      const check = gate.run.checks.find((row: any) => row.id === 'causal_claim_requires_control');
      expect(check).toMatchObject({ status: 'failed', blocking: true, detail: 'TRACE-044: confirmed by ADJ-TRACE-044', regressions: ['REG-BIO-042', code] });
    });

    it('applies the policy select: a medium finding blocks only under block_any', async () => {
      await samira.post('/api/assurance/traces/TRACE-044/adjudications', { ...FINDING, severity: 'medium' });
      const { code } = await (await maya.post('/api/assurance/regressions', { adjudicationCode: 'ADJ-TRACE-044' })).json();
      const draft = await (await maya.get(`/api/assurance/regressions/${code}`)).json();
      await maya.post(`/api/assurance/regressions/${code}/activate`, { name: draft.name, passCondition: draft.passCondition, policy: 'block_high', scopeAck: true });
      const stepsWithClaim = [
        { title: 'Retrieve sources', call: 'read_dataset(DS-BIO-07, v1.0)', status: 'Allowed' },
        { title: 'Compare observations', sources: ['E01', 'E02', 'E03'], status: 'Grounded' },
        { title: 'Draft mechanistic claim', claim: 'Reduced permeability plays no role in this phenotype.', sources: ['E01', 'E02', 'E03'], status: 'Qualified' },
      ];
      await maya.post('/api/assurance/traces', { json: traceJson({ candidate: 'rc.30', steps: stepsWithClaim }) });
      const high = await (await maya.post('/api/assurance/gates/GATE-019/rc.30/run')).json();
      expect(high).toEqual({ state: 'passed', passedCount: 29, totalCount: 30 });

      await maya.put(`/api/assurance/regressions/${code}`, { name: draft.name, passCondition: draft.passCondition, policy: 'block_any', scopeAck: true });
      await maya.post('/api/assurance/traces', { json: traceJson({ candidate: 'rc.31', steps: stepsWithClaim }) });
      const any = await (await maya.post('/api/assurance/gates/GATE-019/rc.31/run')).json();
      expect(any).toEqual({ state: 'blocked', passedCount: 29, totalCount: 30 });
      const gate = await (await maya.get('/api/assurance/gates/GATE-019/rc.31')).json();
      expect(gate.run.blockingReason).toBe(`${code} failed under its policy`);
      expect(gate.run.regressions.find((row: any) => row.code === code)).toMatchObject({ policy: 'block_any', severity: 'medium' });
    });

    it('catches tampering in the integrity checks', async () => {
      await test.ctx.db.exec('DROP TRIGGER traces_no_update');
      await test.ctx.db.run(`UPDATE traces SET agent_label = 'Tampered agent' WHERE code = 'TRACE-043'`);
      const run = await (await maya.post('/api/assurance/gates/GATE-019/rc.19/run')).json();
      expect(run).toEqual({ state: 'blocked', passedCount: 29, totalCount: 30 });
      const gate = await (await maya.get('/api/assurance/gates/GATE-019/rc.19')).json();
      expect(gate.trace.verified).toBe(false);
      expect(gate.run.groups[3]).toMatchObject({ title: 'Evidence integrity', status: 'failed' });
      expect(gate.requiredBeforeRetry).toContain('no longer match their hashes');
    });

    it('catches tampered dataset bytes', async () => {
      const { writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      const { version } = await (await maya.get('/api/datasets/DS-BIO-07')).json();
      writeFileSync(path.join(test.ctx.config.dataDir, 'uploads', version.sha256), 'tampered');
      const run = await (await maya.post('/api/assurance/gates/GATE-019/rc.19/run')).json();
      expect(run.state).toBe('blocked');
      const gate = await (await maya.get('/api/assurance/gates/GATE-019/rc.19')).json();
      expect(gate.run.checks.find((row: any) => row.id === 'integrity_dataset_bytes')).toMatchObject({ status: 'failed', blocking: true });
    });

    describe('owner rules', () => {
      it('lets only the workspace or task owner run, and says why not', async () => {
        const { client } = await addHelixMember('member@helixlab.example');
        const view = await (await client.get('/api/assurance/gates/GATE-019/rc.19')).json();
        expect(view.canRun).toEqual({ allowed: false, reason: 'Workspace or task owner only' });
        const res = await client.post('/api/assurance/gates/GATE-019/rc.19/run');
        expect(res.status).toBe(403);
        expect((await res.json()).error.message).toBe('Workspace or task owner only');
        expect((await test.ctx.db.get('SELECT 1 AS ok FROM gate_runs WHERE candidate = ?', ['rc.19']))).toBeUndefined();
      });

      it('lets a task owner who is a plain member run, until removed', async () => {
        const { id, client } = await addHelixMember('member@helixlab.example');
        await test.ctx.db.run(`UPDATE tasks SET owner_id = ? WHERE code = 'BIO-042'`, [id]);
        expect((await client.get('/api/assurance/gates/GATE-019/rc.19')).ok).toBe(true);
        const view = await (await client.get('/api/assurance/gates/GATE-019/rc.19')).json();
        expect(view.canRun).toEqual({ allowed: true });
        await test.ctx.db.run(`UPDATE memberships SET status = 'removed' WHERE user_id = ?`, [id]);
        expect((await client.post('/api/assurance/gates/GATE-019/rc.19/run')).status).toBe(404);
      });

      it('refuses an outside reviewer and an administrator', async () => {
        const alex = await new Client(test).signIn(ALEX);
        for (const client of [samira, alex]) {
          expect((await client.post('/api/assurance/gates/GATE-019/rc.19/run')).status).toBe(404);
          expect((await client.post('/api/assurance/gates/GATE-019/rc.19/approve')).status).toBe(404);
          expect((await client.get('/api/assurance/gates/GATE-019/rc.18/report')).status).toBe(404);
        }
      });
    });

    it('404s an unknown gate or candidate', async () => {
      expect((await maya.get('/api/assurance/gates/GATE-999/rc.18')).status).toBe(404);
      expect((await maya.get('/api/assurance/gates/GATE-019/rc.99')).status).toBe(404);
    });
  });

  describe('approval', () => {
    it('writes a separate decision with an audit entry after a pass', async () => {
      await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
      test.setNow('2026-11-01T13:00:00Z');
      const res = await maya.post('/api/assurance/gates/GATE-019/rc.19/approve');
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ decision: 'approved', candidate: 'rc.19', createdAt: '2026-11-01T13:00:00.000Z' });
      const row = await test.ctx.db.get<any>(`SELECT d.decision, u.email FROM release_decisions d JOIN users u ON u.id = d.decided_by`);
      expect(row).toEqual({ decision: 'approved', email: MAYA });
      const entry = await test.ctx.db.get<any>(`SELECT detail FROM audit_log WHERE action = 'release.approved'`);
      expect(JSON.parse(entry.detail)).toMatchObject({ candidate: 'rc.19', trace: 'TRACE-043', note: 'Eligibility is not deployment.' });
      const gate = await (await maya.get('/api/assurance/gates/GATE-019/rc.19')).json();
      expect(gate).toMatchObject({ decision: { decidedByName: 'Maya Chen', createdAt: '2026-11-01T13:00:00.000Z' }, canApprove: { allowed: false, reason: 'This release is already approved' } });
      const index = await (await maya.get('/api/assurance')).json();
      expect(index.gates[0].candidates.find((candidate: any) => candidate.candidate === 'rc.19').approved).toBe(true);
    });

    it('cannot be repeated', async () => {
      await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
      await maya.post('/api/assurance/gates/GATE-019/rc.19/approve');
      const again = await maya.post('/api/assurance/gates/GATE-019/rc.19/approve');
      expect(again.status).toBe(409);
      expect((await again.json()).error.message).toBe('This release is already approved');
      await expect(test.ctx.db.run(`UPDATE release_decisions SET decision = 'approved'`)).rejects.toThrow(/immutable/);
      await expect(test.ctx.db.run(`DELETE FROM release_decisions`)).rejects.toThrow(/immutable/);
    });

    it('writes one decision when asked twice at once', async () => {
      await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
      const results = await Promise.all([maya.post('/api/assurance/gates/GATE-019/rc.19/approve'), maya.post('/api/assurance/gates/GATE-019/rc.19/approve')]);
      expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
      expect(await test.ctx.db.all('SELECT id FROM release_decisions')).toHaveLength(1);
    });

    it('needs a run', async () => {
      const res = await maya.post('/api/assurance/gates/GATE-019/rc.19/approve');
      expect(res.status).toBe(409);
      expect((await res.json()).error.message).toBe('The gate has not run for this candidate');
    });

    it('is refused to a plain member even on a pass', async () => {
      await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
      const { client } = await addHelixMember('member@helixlab.example');
      const view = await (await client.get('/api/assurance/gates/GATE-019/rc.19')).json();
      expect(view.canApprove).toEqual({ allowed: false, reason: 'Workspace or task owner only' });
      expect((await client.post('/api/assurance/gates/GATE-019/rc.19/approve')).status).toBe(403);
    });

    it('stops if a later finding or tampering undermines the pass', async () => {
      await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
      const { id, client } = await addHelixMember('member@helixlab.example');
      await grant(id);
      await client.post('/api/assurance/traces/TRACE-043/adjudications', { ...FINDING, finding: 'Unsupported causal claim' });
      const view = await (await maya.get('/api/assurance/gates/GATE-019/rc.19')).json();
      expect(view.state).toBe('passed');
      expect(view.canApprove.allowed).toBe(false);
      expect(view.canApprove.reason).toContain('Run a new candidate');
      expect((await maya.post('/api/assurance/gates/GATE-019/rc.19/approve')).status).toBe(409);
    });

    describe('there is no bypass', () => {
      const tryAll = async (client: Client) => {
        const url = '/api/assurance/gates/GATE-019/rc.18';
        const attempts = [
          await client.post(`${url}/approve`),
          await client.post(`${url}/approve`, { force: true }),
          await client.post(`${url}/approve`, { override: true, bypass: true, reason: 'ship it', status: 'passed' }),
          await client.request('POST', `${url}/approve?force=1&bypass=1&override=true`, {}),
          await client.request('POST', `${url}/approve`, {}, { 'X-Rivet-Override': '1', 'X-Bypass-Gate': 'true' }),
        ];
        return attempts;
      };

      it('refuses a blocked run however the owner asks', async () => {
        for (const res of await tryAll(maya)) {
          expect(res.status).toBe(409);
          expect((await res.json()).error).toMatchObject({ code: 'not_eligible', message: 'High-severity REG-BIO-042 failed' });
        }
        expect(await test.ctx.db.get('SELECT 1 AS ok FROM release_decisions')).toBeUndefined();
      });

      it('refuses a blocked run for an administrator, member or reviewer too', async () => {
        const alex = await new Client(test).signIn(ALEX);
        const { client } = await addHelixMember('member@helixlab.example');
        for (const person of [alex, samira, client]) {
          for (const res of await tryAll(person)) expect(res.ok).toBe(false);
        }
        await test.ctx.db.run(`UPDATE users SET role = 'admin' WHERE email = ?`, [MAYA]);
        for (const res of await tryAll(maya)) expect(res.status).toBe(409);
        expect(await test.ctx.db.get('SELECT 1 AS ok FROM release_decisions')).toBeUndefined();
      });

      it('has no other route that decides, overrides or edits', async () => {
        const url = '/api/assurance/gates/GATE-019/rc.18';
        const paths = [`${url}/override`, `${url}/bypass`, `${url}/force`, `${url}/force-approve`, `${url}/release`, `${url}/decision`, `${url}/status`, `${url}/waive`, `/api/assurance/gates/GATE-019/override`, '/api/assurance/release-decisions', '/api/assurance/overrides', '/api/admin/gates/GATE-019/rc.18/approve', '/api/assurance/gates/GATE-019/rc.18/approve/force'];
        for (const path of paths) {
          for (const method of ['post', 'put', 'patch'] as const) {
            expect((await maya[method](path, { force: true }))?.status, `${method} ${path}`).toBe(404);
          }
        }
        for (const method of ['put', 'patch', 'delete'] as const) {
          expect((await maya[method](url, { status: 'passed' })).status, `${method} ${url}`).toBe(404);
          expect((await maya[method]('/api/assurance/traces/TRACE-042', { status: 'passed' })).status, `${method} trace`).toBe(404);
        }
      });

      it('refuses at the database too, whichever code writes the row', async () => {
        const run = await test.ctx.db.get<{ id: string }>(`SELECT id FROM gate_runs WHERE candidate = 'rc.18'`);
        const user = await test.ctx.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [MAYA]);
        await expect(test.ctx.db.run(`INSERT INTO release_decisions (id, gate_run_id, decided_by, decision, created_at) VALUES (?, ?, ?, 'approved', ?)`, [newId(), run!.id, user!.id, test.ctx.now().toISOString()])).rejects.toThrow(/passed gate run/);
      });

      it('a pass on a later candidate does not erase the failed gate', async () => {
        await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
        await maya.post('/api/assurance/gates/GATE-019/rc.19/approve');
        const blocked = await (await maya.get('/api/assurance/gates/GATE-019/rc.18')).json();
        expect(blocked).toMatchObject({ state: 'blocked', run: { passedCount: 29 }, canApprove: { allowed: false, reason: 'High-severity REG-BIO-042 failed' } });
        expect((await maya.post('/api/assurance/gates/GATE-019/rc.18/approve')).status).toBe(409);
        const index = await (await maya.get('/api/assurance')).json();
        expect(index.gates[0].candidates.find((candidate: any) => candidate.candidate === 'rc.18')).toMatchObject({ state: 'blocked', approved: false });
      });
    });
  });

  describe('the gate report', () => {
    it('serves a real file with every check', async () => {
      const res = await maya.get('/api/assurance/gates/GATE-019/rc.18/report');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('GATE-019-rc.18-report.json');
      expect(res.headers.get('content-type')).toContain('application/json');
      const text = await res.text();
      expect(res.headers.get('x-rivet-sha256')).toBe(sha256Hex(text));
      const report = JSON.parse(text);
      expect(report).toMatchObject({
        schema: 'rivet.gate_report.v1',
        gate: { code: 'GATE-019', target: 'Helix Lab Biology agent', workspace: 'Helix Lab' },
        candidate: 'rc.18',
        harnessVersion: '0.8.18',
        suite: 'biology-gate v1',
        status: 'blocked',
        result: '29 / 30',
        blockingReason: 'High-severity REG-BIO-042 failed',
        policy: 'No manual bypass',
        trace: { code: 'TRACE-042', hashVerifiedAtDownload: true, synthetic: true },
        releaseDecision: null,
      });
      expect(report.checks).toHaveLength(30);
      expect(report.regressions[0]).toMatchObject({ code: 'REG-BIO-042', version: 1, policy: 'block_high' });
    });

    it('includes the decision once there is one', async () => {
      await maya.post('/api/assurance/gates/GATE-019/rc.19/run');
      await maya.post('/api/assurance/gates/GATE-019/rc.19/approve');
      const report = await (await maya.get('/api/assurance/gates/GATE-019/rc.19/report')).json();
      expect(report).toMatchObject({ status: 'passed', result: '30 / 30', releaseDecision: { decision: 'approved', decidedBy: 'Maya Chen', note: 'Eligibility is not deployment.' } });
    });

    it('does not exist before the gate has run', async () => {
      expect((await maya.get('/api/assurance/gates/GATE-019/rc.19/report')).status).toBe(404);
    });
  });
});
