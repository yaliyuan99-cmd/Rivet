import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvidenceDetailResponse, FreezeResponse, FreezeResult, PinnedModel, RunDetailResponse, RunStartResponse, TaskBrowseResponse, TaskDetailResponse } from '../../shared/types/evaluation.ts';
import { ProviderTimeoutError, ProviderRejectedError, ProviderUnavailableError, type ModelAdapter } from '../../server/engine/adapters.ts';
import { demoAdapter } from '../../server/engine/demoAdapter.ts';
import { AUTHORED_CONSEQUENTIAL, AUTHORED_OUTPUTS } from '../../server/engine/demoStory.ts';
import { dropWorkers, overrideAdapter, recoverRuns, startEngine, waitForIdle, waitForRun } from '../../server/engine/runner.ts';
import { analyse, scoreText } from '../../server/engine/scorer.ts';
import { canonicalJson, sha256Hex } from '../../server/lib/crypto.ts';
import { STARTER_RUBRIC } from '../../server/lib/demoFixtures.ts';
import { Client, makeTestApp, makeUser, makeWorkspace, type TestApp } from '../helpers/app.ts';

let test: TestApp;

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const signedIn = (email: string) => new Client(test).signIn(email);
const maya = () => signedIn('maya@helixlab.example');

async function outsider() {
  const id = await makeUser(test, { name: 'Outside Olu', email: 'olu@outside.example' });
  await makeWorkspace(test, id, 'Outside Lab');
  return signedIn('olu@outside.example');
}

async function startRun(client: Client, task = 'BIO-042') {
  return (await json<RunStartResponse>(await client.post(`/api/tasks/${task}/runs`), 201)).code;
}

const runDetail = async (client: Client, code: string) => json<RunDetailResponse>(await client.get(`/api/runs/${code}`));

async function freeze(client: Client, code: string) {
  const preview = await json<FreezeResponse>(await client.post(`/api/tasks/${code}/scan`));
  return json<FreezeResult>(await client.post(`/api/tasks/${code}/freeze`, { scanCode: preview.scan?.code, acknowledgeFindings: true, acknowledgeRetention: true }), 201);
}

/** A demo adapter that can pause before a stage, fail at a stage, and counts what it was asked to do. */
function controlledAdapter(options: { holdAt?: string; failAt?: string; error?: () => Error } = {}) {
  const calls: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const step = async (name: string) => {
    calls.push(name);
    if (options.failAt === name && calls.filter((call) => call === name).length === 1) throw (options.error ?? (() => new ProviderTimeoutError()))();
    if (options.holdAt === name) {
      reached();
      await gate;
    }
  };
  const adapter: ModelAdapter = {
    paced: false,
    generate: async (input) => {
      await step(`${input.model.letter}:output`);
      return demoAdapter.generate(input);
    },
    score: async (input) => {
      await step(`${input.model.letter}:score`);
      return demoAdapter.score(input);
    },
  };
  return { adapter, calls, release, arrived };
}

const useAdapter = (adapter: ModelAdapter) => overrideAdapter(test.ctx, () => adapter);

const snapshotArtifacts = async (runCode: string) => {
  const run = await test.ctx.db.get<{ id: string }>('SELECT id FROM runs WHERE code = ?', [runCode]);
  return {
    outputs: await test.ctx.db.all('SELECT model_id, output_text, output_meta, scores, total_score, score_label FROM run_outputs WHERE run_id = ? ORDER BY model_id', [run?.id]),
    evidence: await test.ctx.db.all('SELECT id, code, sha256, captured_at, output_text FROM evidence WHERE run_id = ? ORDER BY code', [run?.id]),
    stages: await test.ctx.db.all(`SELECT seq, attempt, finished_at FROM run_stages WHERE run_id = ? AND status = 'done' ORDER BY seq`, [run?.id]),
    checkpoints: await test.ctx.db.all('SELECT code, stages_done, attempt, created_at FROM checkpoints WHERE run_id = ? ORDER BY stages_done', [run?.id]),
  };
};

beforeEach(async () => {
  test = await makeTestApp({ seed: true });
});
afterEach(async () => {
  overrideAdapter(test.ctx, null);
  await waitForIdle(test.ctx);
  test.close();
});

describe('a full run', () => {
  it('commits every stage with a checkpoint, a log line and sealed evidence', async () => {
    const client = await maya();
    const code = await startRun(client);
    expect(code).toBe('RUN-1043');
    const settled = await waitForRun(test.ctx, code);
    expect(settled.status).toBe('complete');

    const run = await runDetail(client, code);
    expect(run).toMatchObject({ status: 'complete', stagesDone: 9, stagesTotal: 9, percent: 100, attempt: 1, checkpointCode: 'CP-009', sealedCount: 3, isOwner: true, ownerName: 'Maya Chen', quarantined: [] });
    expect(run.task).toMatchObject({ code: 'BIO-042', label: 'BIO-042 v1.0', sourcePack: 'DS-BIO-07 v1.0' });
    expect(run.models.map((model) => [model.displayName, model.score, model.scoreLabel, model.evidenceCode, model.evidenceVerified, model.execution])).toEqual([
      ['Aster 3.2', 86, 'demo', 'EV-1043-A', true, 'Output captured · Scored · EV-1043-A sealed'],
      ['Meridian 2.1', 81, 'demo', 'EV-1043-M', true, 'Output captured · Scored · EV-1043-M sealed'],
      ['Lumen 4 Mini', 74, 'demo', 'EV-1043-L', true, 'Output captured · Scored · EV-1043-L sealed'],
    ]);
    expect(run.rubric.map((row) => [row.short, row.points, row.scores])).toEqual([
      ['Mechanistic reasoning', 30, [28, 26, 24]],
      ['Evidence attribution', 30, [25, 23, 20]],
      ['Alternatives', 25, [20, 20, 18]],
      ['Calibration', 15, [13, 12, 12]],
    ]);
    expect(run.tamper).toMatchObject({ code: 'EV-1043-A', runCode: 'RUN-1043', taskLabel: 'BIO-042 v1.0', verified: true });
    expect(run.resultsNote).toBe('Synthetic demo scores. n = 1 task; no population confidence interval is estimated.');
    expect(run.consequentialDifference).toBe(AUTHORED_CONSEQUENTIAL);
    expect(run.settingsNotes).toEqual([]);

    const messages = run.log.map((line) => line.message);
    expect(messages[0]).toBe('Attempt 1 started on the frozen BIO-042 v1.0 contract');
    expect(messages).toContain('Aster output captured');
    expect(messages).toContain('Rubric scoring started');
    expect(messages).toContain('Aster rubric score committed');
    expect(messages).toContain('EV-1043-A hash verified');
    expect(messages).toContain('CP-006 committed');
    expect(messages[messages.length - 1]).toBe('CP-009 committed. Run complete');

    const db = await test.ctx.db.all<{ code: string; stages_done: number; attempt: number }>(`SELECT c.code, c.stages_done, c.attempt FROM checkpoints c JOIN runs r ON r.id = c.run_id WHERE r.code = ? ORDER BY c.stages_done`, [code]);
    expect(db.map((row) => row.code)).toEqual(['CP-001', 'CP-002', 'CP-003', 'CP-004', 'CP-005', 'CP-006', 'CP-007', 'CP-008', 'CP-009']);

    const audited = await test.ctx.db.all<{ action: string }>(`SELECT action FROM audit_log WHERE subject_code = ? ORDER BY created_at, rowid`, [code]);
    expect(audited.map((row) => row.action)).toEqual(['run.started', 'run.completed']);
  });

  it('reproduces the seeded story exactly on a re-run of the starter', async () => {
    const client = await maya();
    const code = await startRun(client);
    await waitForRun(test.ctx, code);
    const seeded = await test.ctx.db.all<{ model_id: string; output_text: string; scores: string; total_score: number }>(`SELECT e.model_id, e.output_text, e.scores, e.total_score FROM evidence e JOIN runs r ON r.id = e.run_id WHERE r.code = 'RUN-1042' ORDER BY e.model_id`);
    const rerun = await test.ctx.db.all<{ model_id: string; output_text: string; scores: string; total_score: number }>(`SELECT e.model_id, e.output_text, e.scores, e.total_score FROM evidence e JOIN runs r ON r.id = e.run_id WHERE r.code = ? ORDER BY e.model_id`, [code]);
    expect(rerun.map((row) => ({ ...row, scores: JSON.parse(row.scores) }))).toEqual(seeded.map((row) => ({ ...row, scores: JSON.parse(row.scores) })));
    // The fixture in the engine and the seed must not drift apart.
    for (const row of seeded) expect(AUTHORED_OUTPUTS[row.model_id]?.output).toBe(row.output_text);
  });

  it('writes a clearly synthetic answer per model for any other prompt, and scores the text', async () => {
    const client = await maya();
    await freeze(client, 'BIO-043');
    const code = await startRun(client, 'BIO-043');
    await waitForRun(test.ctx, code);
    const rows = await test.ctx.db.all<{ code: string; output_text: string; output_meta: string; scores: string; total_score: number; score_label: string }>(`SELECT e.code, e.output_text, e.output_meta, e.scores, e.total_score, e.score_label FROM evidence e JOIN runs r ON r.id = e.run_id WHERE r.code = ? ORDER BY e.total_score DESC`, [code]);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.score_label).toBe('demo');
      expect(row.output_text).toMatch(/^Synthetic demo response from /);
      expect(JSON.parse(row.output_meta)).toMatchObject({ adapter: 'demo', synthetic: true });
      for (const entry of JSON.parse(row.scores)) expect(entry.rationale).toBeTruthy();
    }
    expect(rows.map((row) => row.code)).toEqual(['EV-1043-A', 'EV-1043-M', 'EV-1043-L']);
    expect(rows[0]?.total_score).toBeGreaterThan(rows[1]?.total_score as number);
    expect(rows[1]?.total_score).toBeGreaterThan(rows[2]?.total_score as number);
    expect(rows[0]?.output_text).toContain('[E01]');

    const run = await runDetail(client, code);
    expect(run.consequentialDifference).toMatch(/^Aster scored highest at \d+ \/ 100 demo; Lumen scored lowest at \d+ \/ 100 demo\./);
    expect(run.consequentialDifference).toContain('The widest gap is');
    expect(run.consequentialDifference).not.toContain('−');
    // Careful, not flawless: no generated demo answer sweeps the rubric.
    expect(rows[0]?.total_score).toBeLessThan(100);
  });

  it('refuses a second run while one is active, and a run on a draft', async () => {
    const client = await maya();
    const control = controlledAdapter({ holdAt: 'A:output' });
    useAdapter(control.adapter);
    const code = await startRun(client);
    await control.arrived;
    const second = await client.post('/api/tasks/BIO-042/runs');
    expect(second.status).toBe(409);
    expect((await second.json()).error.message).toBe(`${code} is already running on this task.`);
    const task = await json<TaskDetailResponse>(await client.get('/api/tasks/BIO-042'));
    expect(task.verdicts.run).toEqual({ allowed: false, reason: `${code} is already running on this task.` });
    expect(task.activeRunCode).toBe(code);
    control.release();
    await waitForRun(test.ctx, code);

    const draft = await client.post('/api/tasks/BIO-043/runs');
    expect(draft.status).toBe(409);
    expect((await draft.json()).error.message).toBe('Freeze this draft before running it.');
  });

  it('refuses a new run when a pinned model was disabled, but keeps its evidence readable', async () => {
    const client = await maya();
    await test.ctx.db.run(`UPDATE models SET enabled = 0 WHERE id = 'lumen-4-mini'`);
    const res = await client.post('/api/tasks/BIO-042/runs');
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe('Lumen 4 Mini is unavailable for new runs.');
    expect((await client.get('/api/evidence/EV-1042-L')).status).toBe(200);
  });

  it('shows progress lines while running', async () => {
    const client = await maya();
    const control = controlledAdapter({ holdAt: 'M:score' });
    useAdapter(control.adapter);
    const code = await startRun(client);
    await control.arrived;
    const run = await runDetail(client, code);
    expect(run.status).toBe('running');
    expect(run.stagesDone).toBe(4);
    expect(run.percent).toBe(44);
    expect(run.checkpointCode).toBe('CP-004');
    expect(run.models.map((model) => model.execution)).toEqual(['Output captured · Scored · EV-1043-A sealed', 'Output captured · Scoring in progress', 'Queued · Waiting for worker']);
    expect(run.tamper?.code).toBe('EV-1043-A');
    expect(run.verdicts.stop).toEqual({ allowed: true });
    control.release();
    await waitForRun(test.ctx, code);
  });
});

describe('stop and resume', () => {
  it('stops after the current commit and resumes without replacing artifacts', async () => {
    const client = await maya();
    const control = controlledAdapter({ holdAt: 'M:output' });
    useAdapter(control.adapter);
    const code = await startRun(client);
    await control.arrived;

    expect((await json<{ status: string }>(await client.post(`/api/runs/${code}/stop`))).status).toBe('stopping');
    const stopping = await runDetail(client, code);
    expect(stopping.status).toBe('stopping');
    expect(stopping.verdicts.stop).toEqual({ allowed: false, reason: 'This run stops after its current checkpoint.' });
    expect((await client.post(`/api/runs/${code}/stop`)).status).toBe(409);

    // The in-flight stage still commits; nothing after it starts.
    control.release();
    const interrupted = await waitForRun(test.ctx, code);
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.interrupt_reason).toBe('owner_stop');
    expect(interrupted.stages_done).toBe(4);
    expect(interrupted.last_checkpoint_code).toBe('CP-004');
    expect(control.calls).toEqual(['A:output', 'A:score', 'M:output']);

    const page = await runDetail(client, code);
    expect(page.interruptMessage).toMatch(/^Stopped by the owner at \d\d:\d\d UTC\. No evidence lost\. Resume only incomplete work\.$/);
    expect(page.models.map((model) => model.execution)).toEqual(['Output and score complete · EV-1043-A sealed', 'Output preserved · Scoring interrupted', 'Not started · Still queued']);
    expect(page.verdicts.resume).toEqual({ allowed: true });
    expect(page.log[page.log.length - 1]?.message).toBe('Stopped by the owner. Safe checkpoint at CP-004; owner can resume');

    const before = await snapshotArtifacts(code);
    const expectedEvidence = before.evidence;

    const resumed = await json<{ status: string; attempt: number }>(await client.post(`/api/runs/${code}/resume`));
    expect(resumed.attempt).toBe(2);
    const done = await waitForRun(test.ctx, code);
    expect(done.status).toBe('complete');
    expect(done.attempt).toBe(2);
    expect(done.interrupt_reason).toBeNull();

    // Only unfinished stages were retried.
    expect(control.calls).toEqual(['A:output', 'A:score', 'M:output', 'M:score', 'L:output', 'L:score']);

    const after = await snapshotArtifacts(code);
    expect(after.evidence.slice(0, expectedEvidence.length).filter((row) => expectedEvidence.some((old) => (old as { id: string }).id === (row as { id: string }).id))).toHaveLength(expectedEvidence.length);
    for (const old of expectedEvidence) expect(after.evidence).toContainEqual(old);
    for (const old of before.stages) expect(after.stages).toContainEqual(old);
    for (const old of before.checkpoints) expect(after.checkpoints).toContainEqual(old);
    expect(after.stages.filter((stage) => (stage as { attempt: number }).attempt === 1)).toHaveLength(4);
    expect(after.stages.filter((stage) => (stage as { attempt: number }).attempt === 2)).toHaveLength(5);
    for (const old of before.outputs) {
      const row = after.outputs.find((item) => (item as { model_id: string }).model_id === (old as { model_id: string }).model_id) as { output_text: string };
      expect(row.output_text).toBe((old as { output_text: string }).output_text);
    }

    const finalPage = await runDetail(client, code);
    expect(finalPage.log.map((line) => line.message)).toContain('Attempt 2 started from CP-004. Only unfinished stages are retried');
    const audited = await test.ctx.db.all<{ action: string; detail: string }>(`SELECT action, detail FROM audit_log WHERE subject_code = ? ORDER BY created_at, rowid`, [code]);
    expect(audited.map((row) => row.action)).toEqual(['run.started', 'run.stop_requested', 'run.interrupted', 'run.resumed', 'run.completed']);
    expect(JSON.parse(audited[3]?.detail as string)).toMatchObject({ attempt: 2, fromCheckpoint: 'CP-004', interruptedBy: 'owner_stop' });
  });

  it('only resumes an interrupted run, and only for the owner', async () => {
    const client = await maya();
    const res = await client.post('/api/runs/RUN-1042/resume');
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe('Only an interrupted run can resume.');
    expect((await client.post('/api/runs/RUN-1042/stop')).status).toBe(409);

    const control = controlledAdapter({ holdAt: 'A:output' });
    useAdapter(control.adapter);
    const code = await startRun(client);
    await control.arrived;

    const samira = await signedIn('samira@northbridge.example');
    const stop = await samira.post(`/api/runs/${code}/stop`);
    expect(stop.status).toBe(403);
    expect((await stop.json()).error.message).toBe('Only the task owner can stop a run.');
    const page = await runDetail(samira, code);
    expect(page.verdicts.stop).toEqual({ allowed: false, reason: 'Only the task owner can stop a run.' });

    await client.post(`/api/runs/${code}/stop`);
    control.release();
    await waitForRun(test.ctx, code);

    const resume = await samira.post(`/api/runs/${code}/resume`);
    expect(resume.status).toBe(403);
    expect((await resume.json()).error.message).toBe('Only the task owner can resume a run.');
    expect((await runDetail(samira, code)).verdicts.resume).toEqual({ allowed: false, reason: 'Only the task owner can resume a run.' });
  });
});

describe('provider failures', () => {
  it('interrupts safely on a timeout and resumes from the checkpoint', async () => {
    const client = await maya();
    test.setNow('2026-11-01T14:34:41Z');
    const control = controlledAdapter({ failAt: 'M:score' });
    useAdapter(control.adapter);
    const code = await startRun(client);
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('interrupted');
    expect(run.interrupt_reason).toBe('provider_timeout');

    const page = await runDetail(client, code);
    expect(page.interruptMessage).toBe('Provider timeout at 14:34 UTC. No evidence lost. Resume only incomplete work.');
    expect(page.stagesDone).toBe(4);
    expect(page.log[page.log.length - 1]?.message).toBe('Provider timeout. Safe checkpoint at CP-004; owner can resume');
    expect(page.models[1]?.execution).toBe('Output preserved · Scoring interrupted');
    expect(page.tamper?.verified).toBe(true);

    await json(await client.post(`/api/runs/${code}/resume`));
    const done = await waitForRun(test.ctx, code);
    expect(done.status).toBe('complete');
    // The timed-out stage is the only one tried twice.
    expect(control.calls.filter((call) => call === 'M:score')).toHaveLength(2);
    expect(control.calls.filter((call) => call === 'M:output')).toHaveLength(1);
    expect(control.calls.filter((call) => call === 'A:score')).toHaveLength(1);
  });

  it('treats other temporary failures the same way and says what happened', async () => {
    const client = await maya();
    test.setNow('2026-11-01T14:34:41Z');
    const control = controlledAdapter({ failAt: 'A:output', error: () => new ProviderUnavailableError('The provider is rate limiting requests.') });
    useAdapter(control.adapter);
    const code = await startRun(client);
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('interrupted');
    expect(run.stages_done).toBe(0);
    const page = await runDetail(client, code);
    expect(page.interruptMessage).toBe('Provider unavailable at 14:34 UTC. The provider is rate limiting requests. No evidence lost. Resume only incomplete work.');
    expect(page.log[page.log.length - 1]?.message).toBe('Provider unavailable. No stage had been committed; owner can resume');
    expect(page.tamper).toBeNull();
    expect(page.models[0]?.execution).toBe('Not started · Still queued');
  });

  it('fails a run the provider rejects, keeping what was sealed', async () => {
    const client = await maya();
    const control = controlledAdapter({ failAt: 'M:output', error: () => new ProviderRejectedError('The provider rejected this server’s API key.') });
    useAdapter(control.adapter);
    const code = await startRun(client);
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('failed');
    const page = await runDetail(client, code);
    expect(page.interruptMessage).toBe('The provider rejected this server’s API key.');
    expect(page.sealedCount).toBe(1);
    expect(page.verdicts.resume).toEqual({ allowed: false, reason: 'Only an interrupted run can resume.' });
  });

  it('marks an unexpected error as failed without pretending it worked', async () => {
    const client = await maya();
    useAdapter({ paced: false, generate: async () => { throw new Error('boom'); }, score: demoAdapter.score });
    const original = console.error;
    console.error = () => {};
    try {
      const code = await startRun(client);
      const run = await waitForRun(test.ctx, code);
      expect(run.status).toBe('failed');
      expect(run.interrupt_message).toContain('unexpected error');
    } finally {
      console.error = original;
    }
  });
});

describe('restart recovery', () => {
  it('marks a run left running as interrupted and lets the owner finish it', async () => {
    const client = await maya();
    test.setNow('2026-11-01T14:34:41Z');
    const control = controlledAdapter({ holdAt: 'L:output' });
    useAdapter(control.adapter);
    const code = await startRun(client);
    await control.arrived;

    // The process dies mid-stage: nothing in memory survives, and the database says "running".
    dropWorkers(test.ctx);
    const left = await test.ctx.db.get<{ status: string }>('SELECT status FROM runs WHERE code = ?', [code]);
    expect(left?.status).toBe('running');

    await startEngine(test.ctx);
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('interrupted');
    expect(run.interrupt_reason).toBe('server_restart');
    expect(run.stages_done).toBe(6);

    const page = await runDetail(client, code);
    expect(page.interruptMessage).toBe('Server restart at 14:34 UTC. No evidence lost. Resume only incomplete work.');
    expect(page.log[page.log.length - 1]?.message).toBe('Server restarted. Safe checkpoint at CP-006; owner can resume');
    expect(page.models.map((model) => model.stagesDone)).toEqual([3, 3, 0]);
    const stage = await test.ctx.db.get<{ status: string }>(`SELECT s.status FROM run_stages s JOIN runs r ON r.id = s.run_id WHERE r.code = ? AND s.seq = 7`, [code]);
    expect(stage?.status).toBe('pending');

    overrideAdapter(test.ctx, null);
    await json(await client.post(`/api/runs/${code}/resume`));
    const done = await waitForRun(test.ctx, code);
    expect(done.status).toBe('complete');
    expect(done.attempt).toBe(2);
    const evidence = await test.ctx.db.all(`SELECT e.code FROM evidence e JOIN runs r ON r.id = e.run_id WHERE r.code = ?`, [code]);
    expect(evidence).toHaveLength(3);

    // The worker from before the crash wakes up late: it must not write anything.
    const before = await snapshotArtifacts(code);
    control.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await snapshotArtifacts(code)).toEqual(before);
  });

  it('leaves queued runs for the worker, and completed runs alone', async () => {
    const client = await maya();
    await recoverRuns(test.ctx);
    const seeded = await test.ctx.db.get<{ status: string }>(`SELECT status FROM runs WHERE code = 'RUN-1042'`);
    expect(seeded?.status).toBe('complete');

    const control = controlledAdapter({ holdAt: 'A:output' });
    useAdapter(control.adapter);
    const code = await startRun(client);
    await control.arrived;
    await client.post(`/api/runs/${code}/stop`);
    control.release();
    await waitForRun(test.ctx, code);
    await json(await client.post(`/api/runs/${code}/resume`));
    await waitForRun(test.ctx, code);
    expect((await test.ctx.db.get<{ status: string }>('SELECT status FROM runs WHERE code = ?', [code]))?.status).toBe('complete');
  });
});

describe('results and the seeded run', () => {
  it('reads RUN-1042 as the frames do, with its review and report', async () => {
    const client = await maya();
    const run = await runDetail(client, 'RUN-1042');
    expect(run.status).toBe('complete');
    expect(run.attempt).toBe(2);
    expect(run.elapsedMs).toBe(283_000);
    expect(run.models.map((model) => [model.displayName, model.score, model.evidenceCode, model.evidenceVerified])).toEqual([
      ['Aster 3.2', 86, 'EV-1042-A', true],
      ['Meridian 2.1', 81, 'EV-1042-M', true],
      ['Lumen 4 Mini', 74, 'EV-1042-L', true],
    ]);
    expect(run.consequentialDifference).toBe(AUTHORED_CONSEQUENTIAL);
    expect(run.review).toEqual({ code: 'REVIEW-042', status: 'finalized', label: 'Expert review finalized', href: '/review/REVIEW-042' });
    expect(run.report).toEqual({ code: 'RPT-BIO-042', version: '1.0', label: 'RPT-BIO-042 v1.0', href: '/reports/RPT-BIO-042/v1.0' });
    expect(run.verdicts.requestReview).toEqual({ allowed: false, reason: 'BIO-042 v1.0 already has a finalized review (REVIEW-042). Revise the task to review a new version.' });
    expect(run.reviewAction).toEqual({ label: 'Review this task', verdict: { allowed: false, reason: 'You own this task' }, href: null });
  });

  it('shows a later run of a reviewed version whose review that is', async () => {
    const client = await maya();
    const code = await startRun(client);
    await waitForRun(test.ctx, code);
    const run = await runDetail(client, code);
    expect(run.review).toEqual({ code: 'REVIEW-042', status: 'finalized', label: 'Expert review finalized on RUN-1042', href: '/review/REVIEW-042' });
    expect(run.report).toBeNull();
    const refused = await client.post('/api/reviews', { runCode: code });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toBe(run.verdicts.requestReview.reason);
  });

  it('reports the matching state for each review status', async () => {
    const client = await maya();
    await freeze(client, 'BIO-043');
    const code = await startRun(client, 'BIO-043');
    await waitForRun(test.ctx, code);
    let run = await runDetail(client, code);
    expect(run.review).toBeNull();
    expect(run.verdicts.requestReview).toEqual({ allowed: true });

    const samira = await signedIn('samira@northbridge.example');
    expect((await runDetail(samira, 'RUN-1042')).verdicts.requestReview).toEqual({ allowed: false, reason: 'Only the task owner can request expert review.' });

    // The button's verdict and the expert slice's route agree.
    const requested = await json<{ code: string; href: string }>(await client.post('/api/reviews', { runCode: code }), 201);
    expect(requested.code).toBe('REVIEW-043');
    run = await runDetail(client, code);
    expect(run.review).toMatchObject({ code: 'REVIEW-043', label: 'Expert review requested', href: '/review/REVIEW-043' });
    expect(run.verdicts.requestReview).toEqual({ allowed: false, reason: 'REVIEW-043 is already open for BIO-043 v1.0.' });
    expect((await (await client.post('/api/reviews', { runCode: code })).json()).error.message).toBe(run.verdicts.requestReview.reason);

    await test.ctx.db.run(`UPDATE reviews SET status = 'submitted' WHERE code = 'REVIEW-043'`);
    expect((await runDetail(client, code)).review?.label).toBe('Awaiting adjudication');
  });

  it('tells a credentialed outsider whether there is anything to review', async () => {
    const client = await maya();
    await json(await client.patch('/api/tasks/BIO-042/visibility', { visibility: 'shared' }));
    const code = await startRun(client);
    await waitForRun(test.ctx, code);
    const lena = await makeUser(test, { name: 'Credentialed Cy', email: 'cy@lab.example' });
    await test.ctx.db.run(`INSERT INTO credentials (id, user_id, domain_id, rationale, granted_at) VALUES ('c-cy', ?, 'biology', 'test', ?)`, [lena, new Date().toISOString()]);
    const cy = await signedIn('cy@lab.example');
    // BIO-042 v1.0 already has REVIEW-042, so this run points at it.
    expect((await runDetail(cy, code)).reviewAction).toEqual({ label: 'Review this task', verdict: { allowed: true }, href: '/review/REVIEW-042' });
    const browse = await json<TaskBrowseResponse>(await cy.get('/api/tasks'));
    expect(browse.featured?.reviewAction.verdict.allowed).toBe(true);

    const samira = await signedIn('samira@northbridge.example');
    await json(await samira.post('/api/tasks/BIO-041/revise'), 201);
    const preview = await json<FreezeResponse>(await samira.post('/api/tasks/BIO-041/scan'));
    await json(await samira.post('/api/tasks/BIO-041/freeze', { scanCode: preview.scan?.code, acknowledgeFindings: true, acknowledgeRetention: true }), 201);
    const fresh = await startRun(samira, 'BIO-041');
    await waitForRun(test.ctx, fresh);
    expect((await runDetail(cy, fresh)).reviewAction).toEqual({ label: 'Review this task', verdict: { allowed: false, reason: 'No expert review has been requested for this version.' }, href: null });
  });
});

describe('evidence', () => {
  it('shows the answer, the pinned sources, the annotation and a recomputed seal', async () => {
    const client = await maya();
    const evidence = await json<EvidenceDetailResponse>(await client.get('/api/evidence/EV-1042-A'));
    expect(evidence).toMatchObject({
      code: 'EV-1042-A',
      runCode: 'RUN-1042',
      totalScore: 86,
      scoreLabel: 'demo',
      synthetic: true,
      task: { label: 'BIO-042 v1.0' },
      model: { displayName: 'Aster 3.2', revision: 'aster-3.2-20261001' },
    });
    expect(evidence.outputText).toContain('The fourfold MIC shift');
    expect(evidence.scores).toHaveLength(4);
    expect(evidence.sources).toMatchObject({ state: 'visible', label: 'DS-BIO-07 v1.0', note: null });
    expect(evidence.sources.records).toEqual([
      { id: 'E01', label: 'MIC assay', observation: '0.25 → 1.00 µg/mL ciprofloxacin' },
      { id: 'E02', label: 'Expression', observation: 'acrB transcript 3.1× control' },
      { id: 'E03', label: 'Inhibitor assay', observation: 'Partial MIC reversal; specificity unknown' },
    ]);
    expect(evidence.annotation?.text).toMatch(/^Attribution 25\/30: E03 is not pump-specific causal evidence/);
    expect(evidence.annotation?.reviewCode).toBe('REVIEW-042');
    expect(evidence.tamper).toMatchObject({ verified: true, code: 'EV-1042-A', runCode: 'RUN-1042', taskLabel: 'BIO-042 v1.0' });
    expect(evidence.tamper.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('gives an honest empty state before any submitted review', async () => {
    const client = await maya();
    const code = await startRun(client);
    await waitForRun(test.ctx, code);
    const evidence = await json<EvidenceDetailResponse>(await client.get('/api/evidence/EV-1043-A'));
    expect(evidence.annotation).toBeNull();
    expect(evidence.annotationEmpty).toBe('No expert has reviewed this output yet. An annotation appears here once a review is submitted.');

    const row = await test.ctx.db.get<{ id: string; task_id: string; task_version_id: string; owner_id: string }>('SELECT id, task_id, task_version_id, owner_id FROM runs WHERE code = ?', [code]);
    await test.ctx.db.run(`INSERT INTO reviews (id, code, task_id, task_version_id, run_id, requested_by, status, recommendations, created_at) VALUES ('r1', 'REVIEW-999', ?, ?, ?, ?, 'draft', ?, ?)`, [row?.task_id, row?.task_version_id, row?.id, row?.owner_id, JSON.stringify({ 'EV-1043-A': { annotation: 'A draft note the owner should not see yet.' } }), new Date().toISOString()]);
    const draft = await json<EvidenceDetailResponse>(await client.get('/api/evidence/EV-1043-A'));
    expect(draft.annotation).toBeNull();
    expect(draft.annotationEmpty).toContain('REVIEW-999 has not been submitted');

    await test.ctx.db.run(`UPDATE reviews SET status = 'submitted' WHERE id = 'r1'`);
    const submitted = await json<EvidenceDetailResponse>(await client.get('/api/evidence/EV-1043-A'));
    expect(submitted.annotation?.text).toBe('A draft note the owner should not see yet.');
  });

  it('serves a real manifest whose hash anyone can recompute', async () => {
    const client = await maya();
    const res = await client.get('/api/evidence/EV-1042-M/download');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="EV-1042-M.json"');
    expect(res.headers.get('content-type')).toContain('application/json');
    const file = (await res.json()) as { manifest: unknown; sha256: string; verification: { verified: boolean }; taskVersion: { label: string }; sources: { records: unknown[] } };
    expect(sha256Hex(canonicalJson(file.manifest))).toBe(file.sha256);
    expect(file.verification.verified).toBe(true);
    expect(file.taskVersion.label).toBe('BIO-042 v1.0');
    expect(file.sources.records).toHaveLength(3);
    const audited = await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'evidence.downloaded' AND subject_code = 'EV-1042-M'`);
    expect(audited).toBeTruthy();
    expect((await new Client(test).get('/api/evidence/EV-1042-M/download')).status).toBe(401);
  });

  it('does not open a private source pack through a shared task', async () => {
    const client = await maya();
    await json(await client.patch('/api/tasks/BIO-042/visibility', { visibility: 'shared' }));
    const olu = await outsider();
    const evidence = await json<EvidenceDetailResponse>(await olu.get('/api/evidence/EV-1042-A'));
    expect(evidence.sources).toMatchObject({ state: 'hidden', label: 'DS-BIO-07 v1.0', records: [] });
    expect(evidence.sources.note).toBe('These source records are private to Helix Lab. Sharing a task does not open its source pack.');
    const file = (await (await olu.get('/api/evidence/EV-1042-A/download')).json()) as { sources: { state: string; records: unknown[] } };
    expect(file.sources).toMatchObject({ state: 'hidden', records: [] });

    // An assigned reviewer does see them.
    const samira = await signedIn('samira@northbridge.example');
    expect((await json<EvidenceDetailResponse>(await samira.get('/api/evidence/EV-1042-A'))).sources.state).toBe('visible');
  });

  it('keeps a deleted dataset’s frozen snapshot and says so', async () => {
    const client = await maya();
    await test.ctx.db.run(`UPDATE datasets SET deleted_at = ? WHERE code = 'DS-BIO-07'`, [new Date().toISOString()]);
    const evidence = await json<EvidenceDetailResponse>(await client.get('/api/evidence/EV-1042-A'));
    expect(evidence.sources.state).toBe('visible');
    expect(evidence.sources.note).toBe('This dataset was removed from the library. The frozen snapshot is retained for audit.');
  });

  it('refuses to edit sealed evidence, and detects a tampered row', async () => {
    const client = await maya();
    await expect(test.ctx.db.run(`UPDATE evidence SET total_score = 100 WHERE code = 'EV-1042-A'`)).rejects.toThrow(/immutable/);

    // Simulate someone with database access going around the trigger.
    await test.ctx.db.exec('DROP TRIGGER evidence_no_update');
    await test.ctx.db.run(`UPDATE evidence SET output_text = output_text || ' And it definitely proves causation.' WHERE code = 'EV-1042-A'`);

    const evidence = await json<EvidenceDetailResponse>(await client.get('/api/evidence/EV-1042-A'));
    expect(evidence.tamper.verified).toBe(false);

    const untouched = await json<EvidenceDetailResponse>(await client.get('/api/evidence/EV-1042-M'));
    expect(untouched.tamper.verified).toBe(true);

    const run = await runDetail(client, 'RUN-1042');
    expect(run.quarantined).toEqual(['EV-1042-A']);
    expect(run.tamper).toMatchObject({ code: 'EV-1042-A', verified: false });
    expect(run.models.find((model) => model.evidenceCode === 'EV-1042-A')?.evidenceVerified).toBe(false);
    // Nothing on the page may still read as verified for this artifact.
    const messages = run.log.map((line) => line.message);
    expect(messages).not.toContain('EV-1042-A hash verified');
    expect(messages).toContain('EV-1042-A sealed. Its stored bytes no longer match this seal');
    expect(messages).toContain('EV-1042-M hash verified');

    const task = await json<TaskDetailResponse>(await client.get('/api/tasks/BIO-042'));
    expect(task.tamper?.verified).toBe(false);

    const file = (await (await client.get('/api/evidence/EV-1042-A/download')).json()) as { manifest: unknown; sha256: string; verification: { verified: boolean; statement: string } };
    expect(file.verification.verified).toBe(false);
    expect(file.verification.statement).toMatch(/^Hash mismatch/);
    expect(sha256Hex(canonicalJson(file.manifest))).not.toBe(file.sha256);
  });

  it('does not offer review of a quarantined run', async () => {
    const client = await maya();
    await freeze(client, 'BIO-043');
    const code = await startRun(client, 'BIO-043');
    await waitForRun(test.ctx, code);
    await test.ctx.db.exec('DROP TRIGGER evidence_no_update');
    await test.ctx.db.run(`UPDATE evidence SET output_text = 'Swapped.' WHERE code = 'EV-1043-M'`);
    const run = await runDetail(client, code);
    expect(run.verdicts.requestReview).toEqual({ allowed: false, reason: 'Hash mismatch. Evidence from this run is quarantined, so it cannot go to review.' });
    const refused = await client.post('/api/reviews', { runCode: code });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toBe(run.verdicts.requestReview.reason);
  });

  it('counts unreadable sealed JSON as a mismatch rather than crashing', async () => {
    const client = await maya();
    await test.ctx.db.exec('DROP TRIGGER evidence_no_update');
    await test.ctx.db.run(`UPDATE evidence SET output_meta = 'not json' WHERE code = 'EV-1042-L'`);
    const evidence = await json<EvidenceDetailResponse>(await client.get('/api/evidence/EV-1042-L'));
    expect(evidence.tamper.verified).toBe(false);
  });
});

describe('the demo scorer', () => {
  const records = [
    { id: 'E01', label: 'MIC assay', observation: '0.25 → 1.00', raw: {} },
    { id: 'E02', label: 'Expression', observation: 'acrB 3.1×', raw: {} },
    { id: 'E03', label: 'Inhibitor', observation: 'Partial reversal', raw: {} },
  ];
  const model = (letter: string): PinnedModel => ({ id: `m-${letter}`, displayName: `Model ${letter}`, shortName: letter, letter, revision: `r-${letter}`, adapter: 'demo', contextK: 8, outputK: 8 });

  it('reads citations, causal language, alternatives and experiments from the text', () => {
    const features = analyse('Consistent with E01 [E02] and [E77]. This does not establish a mechanism. Permeability has not been excluded. A controlled deletion would discriminate.', records);
    expect(features.citedReal).toEqual(['E01', 'E02']);
    expect(features.uncited).toEqual(['E03']);
    expect(features.citedUnknown).toEqual(['E77']);
    expect(features.negatedCausal).toBe(true);
    expect(features.causal).toEqual([]);
    expect(features.specificAlternatives).toContain('permeability');
    expect(features.unresolved).toBe(true);
    expect(features.specificExperiments).toContain('deletion');
    expect(features.discriminating).toBe(true);
    expect(analyse('This proves the mechanism is driven by efflux.', records).causal).toEqual(['proves', 'driven by']);
  });

  it('explains every deduction, and the rationale accounts for the missing points', () => {
    const { scores, total } = scoreText(STARTER_RUBRIC, records, 'The phenotype is caused by efflux. [E99]');
    expect(total).toBe(scores.reduce((sum, entry) => sum + entry.score, 0));
    for (const entry of scores) {
      const deducted = [...entry.rationale.matchAll(/−(\d+):/g)].reduce((sum, match) => sum + Number(match[1]), 0);
      expect(deducted, entry.rationale).toBe(entry.points - entry.score);
      expect(entry.points - entry.score).toBeGreaterThan(0);
    }
    expect(scores[0]?.rationale).toContain('caused by');
    expect(scores[1]?.rationale).toContain('E01–E03');
    expect(scores[1]?.rationale).toContain('E99');
    expect(scores[2]?.rationale).toContain('alternative');
  });

  it('awards full points only when nothing is missing', () => {
    const good = 'These results [E01, E02, E03] are consistent with the hypothesis but do not establish it, and their limits apply. Permeability is an alternative explanation that has not been excluded. A controlled deletion experiment would discriminate. It remains uncertain.';
    const { scores, total } = scoreText(STARTER_RUBRIC, records, good);
    expect(total).toBe(100);
    for (const entry of scores) expect(entry.rationale).toMatch(/^No deduction:/);
  });

  it('is deterministic, and ranks the generated profiles by quality', async () => {
    const task = { code: 'T-1', version: '1.0', title: 'A question', prompt: 'A different prompt from the starter.', rubric: STARTER_RUBRIC, settings: { temperature: 0.2, seed: 42, maxOutputK: 8 } };
    const totals: number[] = [];
    for (const letter of ['A', 'M', 'L']) {
      const input = { task, model: model(letter), records };
      const first = await demoAdapter.generate(input);
      const second = await demoAdapter.generate(input);
      expect(second.text).toBe(first.text);
      expect(first.meta).toMatchObject({ adapter: 'demo', synthetic: true });
      const scored = await demoAdapter.score({ ...input, output: first.text });
      expect(scored.label).toBe('demo');
      totals.push(scored.total);
    }
    expect(totals[0]).toBeGreaterThan(totals[1] as number);
    expect(totals[1]).toBeGreaterThan(totals[2] as number);
  });

  it('marks down citations when no source pack exists', () => {
    const { scores } = scoreText(STARTER_RUBRIC, [], 'Consistent with [E01] and [E02].');
    expect(scores[1]?.rationale).toContain('no source records are pinned');
  });
});
