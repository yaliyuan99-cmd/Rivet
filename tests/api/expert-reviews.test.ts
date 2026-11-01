import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForIdle, waitForRun } from '../../server/engine/runner.ts';
import { sha256Hex } from '../../server/lib/crypto.ts';
import { newId } from '../../server/lib/ids.ts';
import { Client, lastMail, makeTestApp, makeUser, makeWorkspace, type TestApp } from '../helpers/app.ts';
import { applicationBody, frozenRun, grantCredential, member, reviewBody, signedIn, uploadFile, type FrozenRun } from './expertFixtures.ts';

let test: TestApp;
let maya: Client;
let samira: Client;
let alex: Client;
let mayaId: string;
let helixId: string;

const json = (res: Response) => res.json() as Promise<any>;

beforeEach(async () => {
  test = await makeTestApp({ seed: true });
  maya = await signedIn(test, 'maya@helixlab.example');
  samira = await signedIn(test, 'samira@northbridge.example');
  alex = await signedIn(test, 'alex@rivet.example');
  mayaId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'maya@helixlab.example'`))?.id as string;
  helixId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-HELIX'`))?.id as string;
});
afterEach(() => test.close());

const mayaRun = (overrides: Partial<Parameters<typeof frozenRun>[1]> = {}) => frozenRun(test, { ownerId: mayaId, workspaceId: helixId, ...overrides });

async function requested(run?: FrozenRun): Promise<{ code: string; run: FrozenRun }> {
  const target = run ?? (await mayaRun());
  const res = await maya.post('/api/reviews', { runCode: target.runCode });
  expect(res.status).toBe(201);
  return { code: (await json(res)).code, run: target };
}

async function claimed(): Promise<{ code: string; run: FrozenRun }> {
  const made = await requested();
  expect((await samira.post(`/api/reviews/${made.code}/claim`)).status).toBe(200);
  return made;
}

async function submitted(): Promise<{ code: string; run: FrozenRun }> {
  const made = await claimed();
  const res = await samira.post(`/api/reviews/${made.code}/submit`, reviewBody(made.run.evidenceCodes));
  expect(res.status).toBe(200);
  return made;
}

const finalize = (code: string, rationale = 'Uphold the expert’s scores and keep every limit in the report.') => alex.post(`/api/admin/adjudications/${code}`, { decision: 'accept', rationale, checksAck: true });

describe('with the real run engine', () => {
  it('takes a run the engine sealed through review to a verified report', async () => {
    const preview = await json(await maya.post('/api/tasks/BIO-043/scan'));
    expect((await maya.post('/api/tasks/BIO-043/freeze', { scanCode: preview.scan?.code, acknowledgeFindings: true, acknowledgeRetention: true })).status).toBe(201);
    const { code: runCode } = await json(await maya.post('/api/tasks/BIO-043/runs'));
    expect((await waitForRun(test.ctx, runCode)).status).toBe('complete');

    const { code } = await json(await maya.post('/api/reviews', { runCode }));
    await samira.post(`/api/reviews/${code}/claim`);
    const detail = await json(await samira.get(`/api/reviews/${code}`));
    expect(detail.evidenceVerified).toBe(true);
    expect(detail.task).toMatchObject({ code: 'BIO-043', label: 'BIO-043 v1.0' });
    expect(detail.task.rubric.map((criterion: any) => criterion.points)).toEqual([40, 30, 30]);

    // Uphold what the engine scored: the expert's totals match the sealed ones.
    const body = reviewBody(detail.evidence.map((item: any) => item.code));
    for (const item of detail.evidence) {
      body.recommendations[item.code] = { annotation: `Annotation for ${item.code}: the limits are stated.`, criteria: item.scores.map((score: any) => ({ score: score.score, note: score.rationale || 'Upheld.' })) };
    }
    expect((await samira.post(`/api/reviews/${code}/submit`, body)).status).toBe(200);
    expect((await finalize(code)).status).toBe(200);

    const report = await json(await maya.get('/api/reports/RPT-BIO-043/v1.0'));
    expect(report).toMatchObject({ verified: true, taskCode: 'BIO-043', canReadSources: true, isSynthetic: true });
    expect(report.evidence.verified).toBe(true);
    expect(report.scores.map((score: any) => score.evidenceCode)).toEqual(detail.evidence.map((item: any) => item.code));
    for (const score of report.scores) expect(score.sealedScore).toBeUndefined();
    expect(report.limitations).toContain('n = 1 task. No population confidence interval.');
    expect(report.limitations).toMatch(new RegExp(`[Cc]ontamination scan ${preview.scan.code}`));
    expect(report.limitations).toContain('Model training exposure remains unknown.');
    expect((await maya.get(report.downloadUrl)).status).toBe(200);

    // The results page sees the same state through its own reads.
    const run = await json(await maya.get(`/api/runs/${runCode}`));
    expect(run.report).toMatchObject({ code: 'RPT-BIO-043', version: '1.0' });
    await waitForIdle(test.ctx);
  });
});

describe('an instance without the demo seed', () => {
  it('starts every code at 001 and reads as empty, not as demo data', async () => {
    const empty = await makeTestApp();
    try {
      const ownerId = await makeUser(empty, { email: 'owner@lab.example', name: 'Olive Owner' });
      const expertId = await makeUser(empty, { email: 'expert@lab.example', name: 'Ed Expert' });
      await makeUser(empty, { email: 'admin@lab.example', name: 'Ada Admin', role: 'admin' });
      await grantCredential(empty, expertId);
      const workspaceId = await makeWorkspace(empty, ownerId, 'Owner Lab');
      const run = await frozenRun(empty, { ownerId, workspaceId, label: 'judge', synthetic: false, withScan: false });
      const owner = await signedIn(empty, 'owner@lab.example');
      const expert = await signedIn(empty, 'expert@lab.example');
      const admin = await signedIn(empty, 'admin@lab.example');

      const before = await json(await owner.get('/api/leaderboards'));
      expect(before).toMatchObject({ empty: true, included: null, rows: [] });
      expect((await json(await owner.get('/api/reports'))).total).toBe(0);
      expect((await json(await owner.get('/api/admin/credentials')).catch(() => null))?.error?.message).toBe('Admin role required');
      expect(await json(await admin.get('/api/admin/credentials'))).toEqual({ awaiting: [], decided: [] });
      expect(await json(await admin.get('/api/admin/adjudications'))).toEqual({ awaiting: [], returned: [], inProgress: [], finalized: [] });

      const { code } = await json(await owner.post('/api/reviews', { runCode: run.runCode }));
      expect(code).toBe('REVIEW-001');
      await expert.post(`/api/reviews/${code}/claim`);
      await expert.post(`/api/reviews/${code}/submit`, reviewBody(run.evidenceCodes));
      expect((await json(await admin.get(`/api/admin/adjudications/${code}`))).adjudicationCode).toBe('ADJ-001');
      const done = await json(await admin.post(`/api/admin/adjudications/${code}`, { decision: 'accept', rationale: 'Uphold the expert’s scores for this task.', checksAck: true }));
      expect(done.adjudicationCode).toBe('ADJ-001');

      const report = await empty.ctx.db.get<any>('SELECT * FROM reports');
      expect(report.is_synthetic).toBe(0);
      expect(report.citation).not.toContain('Synthetic');
      expect(report.summary).not.toContain('synthetic');
      const after = await json(await owner.get('/api/leaderboards'));
      expect(after.sample.synthetic).toBe(false);
      expect(after.rows[0]).toMatchObject({ displayName: 'aster-3.2', summary: '80.0 · no interval · n=1' });

      const upload = await json(await uploadFile(expert));
      const draft = await json(await expert.post('/api/applications', { ...applicationBody(upload.id), domainId: 'chemistry' }));
      expect((await json(await expert.post(`/api/applications/${draft.code}/submit`))).code).toBe('APP-001');
    } finally {
      empty.close();
    }
  });
});

describe('requesting a review', () => {
  it('creates the next REVIEW-n for the owner of a complete run', async () => {
    const run = await mayaRun();
    const res = await maya.post('/api/reviews', { runCode: run.runCode });
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ code: 'REVIEW-043', status: 'requested', href: '/review/REVIEW-043' });
    const row = await test.ctx.db.get<any>(`SELECT * FROM reviews WHERE code = 'REVIEW-043'`);
    expect(row).toMatchObject({ status: 'requested', expert_id: null, requested_by: mayaId, run_id: run.runId });
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'review.requested' AND subject_code = 'REVIEW-043'`)).toBeTruthy();
  });

  it('refuses anyone but the owner', async () => {
    const run = await mayaRun({ visibility: 'shared' });
    const res = await samira.post('/api/reviews', { runCode: run.runCode });
    expect(res.status).toBe(403);
    expect((await json(res)).error.message).toBe('Only the task owner can request expert review.');
    const privateRun = await mayaRun();
    expect((await samira.post('/api/reviews', { runCode: privateRun.runCode })).status).toBe(404);
    expect((await new Client(test).post('/api/reviews', { runCode: run.runCode })).status).toBe(401);
  });

  it('refuses a run that is not complete', async () => {
    const run = await mayaRun({ runStatus: 'running' });
    const res = await maya.post('/api/reviews', { runCode: run.runCode });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('run_not_complete');
  });

  it('allows one open review per task version', async () => {
    const { run, code } = await requested();
    const res = await maya.post('/api/reviews', { runCode: run.runCode });
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toBe(`${code} is already open for ${run.label}.`);
    await expect(
      test.ctx.db.run(`INSERT INTO reviews (id, code, task_id, task_version_id, run_id, requested_by, status, created_at) SELECT 'x', 'REVIEW-999', task_id, task_version_id, run_id, requested_by, 'requested', created_at FROM reviews WHERE code = ?`, [code]),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('refuses a version that is already finalized', async () => {
    const res = await maya.post('/api/reviews', { runCode: 'RUN-1042' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('review_finalized');
  });

  it('refuses a run whose evidence fails its seal', async () => {
    const run = await mayaRun();
    await test.ctx.db.exec('DROP TRIGGER evidence_no_update');
    await test.ctx.db.run(`UPDATE evidence SET output_text = 'edited' WHERE code = ?`, [run.evidenceCodes[0]]);
    const res = await maya.post('/api/reviews', { runCode: run.runCode });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('hash_mismatch');
  });
});

describe('the review queue', () => {
  it('shows requested reviews in credentialed domains, excluding your own tasks', async () => {
    const { code, run } = await requested();
    const samiraWorkspace = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-NORTHBRIDGE'`))?.id as string;
    const samiraId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'samira@northbridge.example'`))?.id as string;
    const own = await frozenRun(test, { ownerId: samiraId, workspaceId: samiraWorkspace });
    const ownRequest = await json(await samira.post('/api/reviews', { runCode: own.runCode }));
    const chemistry = await mayaRun({ domainId: 'chemistry', taskCode: 'CHEM-001' });
    const chemRequest = await json(await maya.post('/api/reviews', { runCode: chemistry.runCode }));

    const queue = await json(await samira.get('/api/reviews'));
    expect(queue.state).toBe('queue');
    expect(queue.requested.map((item: any) => item.code)).toEqual([code]);
    expect(queue.requested[0]).toMatchObject({ taskLabel: run.label, domainName: 'Biology', ownerName: 'Maya Chen', claim: { allowed: true } });
    expect(JSON.stringify(queue)).not.toContain(ownRequest.code);
    expect(JSON.stringify(queue)).not.toContain(chemRequest.code);
    expect(queue.lockedDomains).toEqual(['Chemistry', 'Computer science']);
    expect(queue.submitted.map((item: any) => item.code)).toEqual(['REVIEW-042']);
    expect(queue.submitted[0].report).toEqual({ code: 'RPT-BIO-042', version: '1.0' });
  });

  it('moves a claimed review to your drafts and off everyone else’s queue', async () => {
    const lenaId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'lena@northbridge.example'`))?.id as string;
    await grantCredential(test, lenaId);
    const lena = await signedIn(test, 'lena@northbridge.example');
    const { code } = await claimed();
    expect((await json(await samira.get('/api/reviews'))).drafts.map((item: any) => item.code)).toEqual([code]);
    expect((await json(await lena.get('/api/reviews'))).requested).toEqual([]);
    const late = await lena.post(`/api/reviews/${code}/claim`);
    expect(late.status).toBe(409);
    expect((await json(late)).error.code).toBe('already_claimed');
    expect((await test.ctx.db.get<any>('SELECT expert_id FROM reviews WHERE code = ?', [code])).expert_id).not.toBe(lenaId);
  });
});

describe('permission refusals', () => {
  it('refuses the task owner, even holding the domain credential', async () => {
    await grantCredential(test, mayaId);
    const { code, run } = await requested();
    const claim = await maya.post(`/api/reviews/${code}/claim`);
    expect(claim.status).toBe(403);
    expect((await json(claim)).error.message).toBe('You own this task');
    const detail = await json(await maya.get(`/api/reviews/${code}`));
    expect(detail.statusLine).toBe('You own this task');
    expect(detail.actions.claim).toEqual({ allowed: false, reason: 'You own this task' });

    // Even a review assigned to the owner directly cannot be saved or submitted.
    await test.ctx.db.run(`UPDATE reviews SET expert_id = ?, status = 'draft' WHERE code = ?`, [mayaId, code]);
    expect((await maya.put(`/api/reviews/${code}`, reviewBody(run.evidenceCodes))).status).toBe(403);
    const submit = await maya.post(`/api/reviews/${code}/submit`, reviewBody(run.evidenceCodes));
    expect(submit.status).toBe(403);
    expect((await json(submit)).error.message).toBe('You own this task');
  });

  it('refuses anyone without the domain credential', async () => {
    const { code, run } = await requested();
    const { client } = await member(test, 'no-credential@lab.example');
    const claim = await client.post(`/api/reviews/${code}/claim`);
    expect(claim.status).toBe(403);
    expect((await json(claim)).error.message).toBe('Verified Biology credential required');
    expect((await client.post(`/api/reviews/${code}/submit`, reviewBody(run.evidenceCodes))).status).toBe(403);
    expect((await client.get(`/api/reviews/${code}`)).status).toBe(404);
    expect((await client.get('/api/reviews')).status).toBe(200);
    expect((await json(await client.get('/api/reviews'))).requested).toEqual([]);
  });

  it('keeps other domains locked for a credentialed expert', async () => {
    const run = await mayaRun({ domainId: 'chemistry', taskCode: 'CHEM-002' });
    const { code } = await requested(run);
    const claim = await samira.post(`/api/reviews/${code}/claim`);
    expect(claim.status).toBe(403);
    expect((await json(claim)).error.message).toBe('Verified Chemistry credential required');
  });

  it('refuses a workspace owner without a credential: a workspace role never grants this', async () => {
    const ownerId = await makeUser(test, { email: 'owner@lab.example', name: 'Olive Owner' });
    const workspaceId = await makeWorkspace(test, ownerId, 'Owner Lab');
    const authorId = await makeUser(test, { email: 'author@lab.example', name: 'Art Author' });
    await test.ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)`, [newId(), workspaceId, authorId, test.ctx.now().toISOString()]);
    const run = await frozenRun(test, { ownerId: authorId, workspaceId });
    const author = await signedIn(test, 'author@lab.example');
    const { code } = await json(await author.post('/api/reviews', { runCode: run.runCode }));

    const owner = await signedIn(test, 'owner@lab.example');
    const claim = await owner.post(`/api/reviews/${code}/claim`);
    expect(claim.status).toBe(403);
    expect((await json(claim)).error.message).toBe('Verified Biology credential required');
    const detail = await json(await owner.get(`/api/reviews/${code}`));
    expect(detail.actions.claim.allowed).toBe(false);
    expect(detail.actions.edit.allowed).toBe(false);
    expect(detail.contentVisible).toBe(false);
  });

  it('reads the credential fresh: revoking it stops saving and submitting', async () => {
    const { code, run } = await claimed();
    const samiraId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'samira@northbridge.example'`))?.id as string;
    await test.ctx.db.run(`UPDATE credentials SET revoked_at = ? WHERE user_id = ?`, [test.ctx.now().toISOString(), samiraId]);
    const save = await samira.put(`/api/reviews/${code}`, reviewBody(run.evidenceCodes));
    expect(save.status).toBe(403);
    expect((await json(save)).error.message).toBe('Verified Biology credential required');
    expect((await samira.post(`/api/reviews/${code}/submit`, reviewBody(run.evidenceCodes))).status).toBe(403);
  });

  it('refuses another expert writing to a claimed review', async () => {
    const { code, run } = await claimed();
    const { id, client } = await member(test, 'other-expert@lab.example');
    await grantCredential(test, id);
    expect((await client.put(`/api/reviews/${code}`, reviewBody(run.evidenceCodes))).status).toBe(403);
    expect((await client.post(`/api/reviews/${code}/submit`, reviewBody(run.evidenceCodes))).status).toBe(403);
  });

  it('refuses saving before claiming', async () => {
    const { code, run } = await requested();
    const res = await samira.put(`/api/reviews/${code}`, reviewBody(run.evidenceCodes));
    expect(res.status).toBe(403);
    expect((await json(res)).error.message).toBe('Claim this review to start.');
  });

  it('refuses non-admins from adjudication, including the assigned expert and the task owner', async () => {
    const { code } = await submitted();
    for (const client of [maya, samira, await signedIn(test, 'lena@northbridge.example')]) {
      expect((await client.get('/api/admin/adjudications')).status).toBe(403);
      expect((await client.get(`/api/admin/adjudications/${code}`)).status).toBe(403);
      const res = await client.post(`/api/admin/adjudications/${code}`, { decision: 'accept', rationale: 'Finalizing without the role.', checksAck: true });
      expect(res.status).toBe(403);
      expect((await json(res)).error.message).toBe('Admin role required');
    }
    expect((await test.ctx.db.get<any>('SELECT status FROM reviews WHERE code = ?', [code])).status).toBe('submitted');
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM reports WHERE code = ?', [`RPT-${code}`])).toBeUndefined();
  });

  it('refuses an admin who wrote the review or owns the task', async () => {
    const { code } = await submitted();
    await test.ctx.db.run(`UPDATE users SET role = 'admin' WHERE email = 'samira@northbridge.example'`);
    const asExpert = await samira.post(`/api/admin/adjudications/${code}`, { decision: 'accept', rationale: 'Deciding my own review.', checksAck: true });
    expect(asExpert.status).toBe(403);
    expect((await json(asExpert)).error.message).toMatch(/another administrator/);

    await test.ctx.db.run(`UPDATE users SET role = 'admin' WHERE email = 'maya@helixlab.example'`);
    const asOwner = await maya.post(`/api/admin/adjudications/${code}`, { decision: 'return', rationale: 'Deciding on my own task.' });
    expect(asOwner.status).toBe(403);
  });

  it('keeps a draft private to its expert until submission', async () => {
    const { code, run } = await claimed();
    await samira.put(`/api/reviews/${code}`, reviewBody(run.evidenceCodes));
    const owner = await json(await maya.get(`/api/reviews/${code}`));
    expect(owner.contentVisible).toBe(false);
    expect(owner.assessment).toBe('');
    expect(owner.recommendations).toEqual({});
    const admin = await json(await alex.get(`/api/reviews/${code}`));
    expect(admin.assessment).toBe('');
    const adjudication = await json(await alex.get(`/api/admin/adjudications/${code}`));
    expect(adjudication.finding).toBe('');
    expect(adjudication.actions.finalize.reason).toBe('The expert has not submitted this review yet.');
  });
});

describe('writing a review', () => {
  it('persists a partial draft with a saved time', async () => {
    const { code, run } = await claimed();
    test.setNow('2026-11-01T10:00:00.000Z');
    const partial = { assessment: 'First thoughts on the outputs.', recommendations: { [run.evidenceCodes[0] as string]: { annotation: '', criteria: [{ score: 25, note: 'Plausible' }] } } };
    const res = await samira.put(`/api/reviews/${code}`, partial);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ status: 'draft', assessment: 'First thoughts on the outputs.', draftSavedAt: '2026-11-01T10:00:00.000Z' });
    const criteria = body.recommendations[run.evidenceCodes[0] as string].criteria;
    expect(criteria).toHaveLength(4);
    expect(criteria[0]).toMatchObject({ name: 'Mechanistic reasoning', points: 30, score: 25, note: 'Plausible' });
    expect(criteria[1]).toMatchObject({ score: null, note: '' });
    expect((await json(await samira.get(`/api/reviews/${code}`))).assessment).toBe('First thoughts on the outputs.');
  });

  it('rejects an out-of-range score on save and on submit, naming the field', async () => {
    const { code, run } = await claimed();
    const evidence = run.evidenceCodes[1] as string;
    const body = reviewBody(run.evidenceCodes);
    (body.recommendations as any)[evidence].criteria[0].score = 31;
    for (const res of [await samira.put(`/api/reviews/${code}`, body), await samira.post(`/api/reviews/${code}/submit`, body)]) {
      expect(res.status).toBe(422);
      expect((await json(res)).error.fields[`recommendations.${evidence}.criteria.0.score`]).toBe('Enter a whole number from 0 to 30 for Mechanistic reasoning.');
    }
  });

  it('validates everything at submission, for every model', async () => {
    const { code, run } = await claimed();
    const res = await samira.post(`/api/reviews/${code}/submit`, { assessment: 'short', rationale: '', finding: '', conflictAck: false, recommendations: {} });
    expect(res.status).toBe(422);
    const { fields } = (await json(res)).error;
    expect(fields.assessment).toBeTruthy();
    expect(fields.rationale).toBeTruthy();
    expect(fields.finding).toBeTruthy();
    expect(fields.conflictAck).toContain(run.taskCode);
    for (const evidence of run.evidenceCodes) {
      expect(fields[`recommendations.${evidence}.annotation`]).toBeTruthy();
      for (const index of [0, 1, 2, 3]) {
        expect(fields[`recommendations.${evidence}.criteria.${index}.score`]).toBeTruthy();
        expect(fields[`recommendations.${evidence}.criteria.${index}.note`]).toBeTruthy();
      }
    }
    expect((await test.ctx.db.get<any>('SELECT status FROM reviews WHERE code = ?', [code])).status).toBe('draft');
  });

  it('cannot change a criterion’s name or points', async () => {
    const { code, run } = await claimed();
    const evidence = run.evidenceCodes[0] as string;
    const body = await json(await samira.put(`/api/reviews/${code}`, { recommendations: { [evidence]: { annotation: '', criteria: [{ score: 10, note: 'n', name: 'Easy marks', points: 1000 }] } } }));
    expect(body.recommendations[evidence].criteria[0]).toMatchObject({ name: 'Mechanistic reasoning', points: 30 });
  });

  it('is refused for evidence outside the review', async () => {
    const { code } = await claimed();
    const res = await samira.put(`/api/reviews/${code}`, { recommendations: { 'EV-1042-A': { annotation: '', criteria: [] } } });
    expect(res.status).toBe(422);
  });

  it('becomes read-only after submission', async () => {
    const { code, run } = await submitted();
    const body = await json(await samira.get(`/api/reviews/${code}`));
    expect(body.status).toBe('submitted');
    expect(body.actions.edit).toEqual({ allowed: false, reason: 'This review has been submitted and is read-only.' });
    const save = await samira.put(`/api/reviews/${code}`, reviewBody(run.evidenceCodes, { assessment: 'Rewriting history after submission.' }));
    expect(save.status).toBe(409);
    expect((await json(save)).error.code).toBe('review_read_only');
    expect((await samira.post(`/api/reviews/${code}/submit`, reviewBody(run.evidenceCodes))).status).toBe(409);
    expect((await test.ctx.db.get<any>('SELECT assessment FROM reviews WHERE code = ?', [code])).assessment).not.toContain('Rewriting');
  });

  it('reports the server’s real verification and refuses submission on a mismatch', async () => {
    const { code, run } = await claimed();
    let body = await json(await samira.get(`/api/reviews/${code}`));
    expect(body.evidenceVerified).toBe(true);
    expect(body.evidence.map((item: any) => item.verified)).toEqual([true, true, true]);
    expect(body.evidence[0]).toMatchObject({ code: run.evidenceCodes[0], runCode: run.runCode, taskLabel: run.label });

    await test.ctx.db.exec('DROP TRIGGER evidence_no_update');
    await test.ctx.db.run(`UPDATE evidence SET total_score = 100 WHERE code = ?`, [run.evidenceCodes[0]]);
    body = await json(await samira.get(`/api/reviews/${code}`));
    expect(body.evidenceVerified).toBe(false);
    expect(body.evidence[0].verified).toBe(false);
    const res = await samira.post(`/api/reviews/${code}/submit`, reviewBody(run.evidenceCodes));
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('hash_mismatch');
  });

  it('shows REVIEW-042 read-only, with the frame’s content', async () => {
    const body = await json(await samira.get('/api/reviews/REVIEW-042'));
    expect(body).toMatchObject({ status: 'finalized', expertName: 'Dr. Samira Patel', statusLine: 'Biology verified / No ownership conflict' });
    expect(body.task).toMatchObject({ label: 'BIO-042 v1.0', ownerName: 'Maya Chen' });
    expect(body.recommendations['EV-1042-A'].criteria[0]).toMatchObject({ name: 'Mechanistic reasoning', score: 28, note: 'Plausible, not proven' });
    expect(body.actions.edit.allowed).toBe(false);
    expect(body.actions.publish).toEqual({ allowed: false, reason: 'Admin role required' });
    expect(body.lockedDomains).toEqual(['Chemistry', 'Computer science']);
    expect(body.report).toEqual({ code: 'RPT-BIO-042', version: '1.0' });
    expect((await json(await alex.get('/api/reviews/REVIEW-042'))).actions.publish.allowed).toBe(true);
  });
});

describe('adjudication', () => {
  it('runs the full path: request, claim, submit, finalize', async () => {
    const before = await json(await alex.get('/api/leaderboards?domain=biology'));
    expect(before.sample.tasks).toBe(24);

    const { code, run } = await submitted();
    const queue = await json(await alex.get('/api/admin/adjudications'));
    expect(queue.awaiting.map((item: any) => item.reviewCode)).toEqual([code]);
    expect(queue.finalized.map((item: any) => item.reviewCode)).toEqual(['REVIEW-042']);

    const detail = await json(await alex.get(`/api/admin/adjudications/${code}`));
    expect(detail).toMatchObject({ adjudicationCode: 'ADJ-043', adjudicationCodeIsPreview: true, reportCode: `RPT-${run.taskCode}`, reportVersion: '1.0', evidenceVerified: true, conflictAck: true });
    expect(detail.scores.map((item: any) => [item.displayName, item.score, item.sealedScore, item.label, item.evidenceCode])).toEqual([
      ['Aster 3.2', 80, 75, 'demo', run.evidenceCodes[0]],
      ['Meridian 2.1', 72, 68, 'demo', run.evidenceCodes[1]],
      ['Lumen 4 Mini', 64, 60, 'demo', run.evidenceCodes[2]],
    ]);
    expect(detail.actions.finalize.allowed).toBe(true);

    const res = await finalize(code);
    expect(res.status).toBe(200);
    const result = await json(res);
    expect(result).toMatchObject({ status: 'finalized', adjudicationCode: 'ADJ-043', decision: 'accept', report: { code: `RPT-${run.taskCode}`, version: '1.0' } });

    // One transaction's worth of rows.
    const adjudication = await test.ctx.db.get<any>(`SELECT * FROM adjudications WHERE code = 'ADJ-043'`);
    expect(adjudication).toMatchObject({ decision: 'accept', checks_ack: 1 });
    const report = await test.ctx.db.get<any>('SELECT * FROM reports WHERE code = ?', [`RPT-${run.taskCode}`]);
    expect(report.adjudication_id).toBe(adjudication.id);
    expect(adjudication.report_id).toBe(report.id);
    expect((await test.ctx.db.get<any>('SELECT status FROM reviews WHERE code = ?', [code])).status).toBe('finalized');
    const rows = await test.ctx.db.all<any>('SELECT * FROM leaderboard_scores WHERE report_id = ? ORDER BY model_id', [report.id]);
    expect(rows.map((row) => [row.model_id, row.score, row.task_label, row.is_fixture])).toEqual([
      ['aster-3.2', 80, run.label, 0],
      ['lumen-4-mini', 64, run.label, 0],
      ['meridian-2.1', 72, run.label, 0],
    ]);
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM audit_log WHERE action = 'adjudication.accepted' AND subject_code = ?`, [code])).toBeTruthy();

    // Report hash: the stored hash is the SHA-256 of the canonical JSON, which says what the columns say.
    expect(sha256Hex(report.canonical)).toBe(report.sha256);
    const manifest = JSON.parse(report.canonical);
    expect(manifest).toMatchObject({ schema: 'rivet.report.v1', code: `RPT-${run.taskCode}`, version: '1.0', adjudication: 'ADJ-043', review: code, run: run.runCode, owner: 'Maya Chen', expert: 'Dr. Samira Patel', admin: 'Alex Rivera', synthetic: true });
    expect(manifest.evidenceSha256[run.evidenceCodes[0] as string]).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.headline).toBe(report.headline);

    // The sample moved, which is correct.
    const after = await json(await alex.get('/api/leaderboards?domain=biology'));
    expect(after.sample).toMatchObject({ tasks: 25, sealedReceipts: 2, authoredOnly: 23, fixtureTasks: 24, liveReports: 1 });
    expect(after.rows[0].n).toBe(25);
    expect(after.rows[0].mean).not.toBe(87.4);
    expect(after.alert).toContain('24 authored task fixtures and 1 finalized report');
    expect(after.receipts).toBe('2 sealed run receipts · 23 authored fixtures →');
    expect(after.included.label).toBe(run.label);

    // Decided: the queue moved and nothing further can happen.
    const later = await json(await alex.get(`/api/admin/adjudications/${code}`));
    expect(later).toMatchObject({ status: 'finalized', adjudicationCode: 'ADJ-043', adjudicationCodeIsPreview: false });
    expect(later.finalDecision.adminName).toBe('Alex Rivera');
    expect(later.actions.finalize).toEqual({ allowed: false, reason: 'This review is already finalized.' });
    expect((await finalize(code)).status).toBe(409);
  });

  it('generates headline, summary and limitations from the finding, the scores and the scan', async () => {
    const { code, run } = await submitted();
    await finalize(code);
    const report = await test.ctx.db.get<any>('SELECT * FROM reports WHERE code = ?', [`RPT-${run.taskCode}`]);
    expect(report.headline).toBe('Uphold the ordering for this task.');
    expect(report.summary).toContain('Aster 3.2 has the highest reviewed score on this task at 80 / 100, followed by Meridian 2.1 at 72 and Lumen 4 Mini at 64.');
    expect(report.summary).toContain('“Uphold the ordering for this task. These scores cannot be generalized beyond it.”');
    expect(report.summary).toContain('These findings do not establish real model capability.');
    expect(report.limitations).toContain('n = 1 task. No population confidence interval.');
    expect(report.limitations).toContain(`A low-risk overlap was acknowledged in contamination scan SCAN-${run.taskCode.split('-')[1]}: “efflux pump”.`);
    expect(report.limitations).toContain('Acknowledged at freeze: “The matching phrase is standard terminology.”');
    expect(report.limitations).toContain('Model training exposure remains unknown.');
    expect(report.citation).toBe(`Chen, M. (${new Date(report.frozen_at).getUTCFullYear()}). ${run.taskCode}: Fixture task ${run.taskCode}. Rivet, RPT-${run.taskCode} v1.0. Synthetic demo report.`);
    expect(report.is_synthetic).toBe(1);
  });

  it('notes a missing scan and keeps the training-exposure limit', async () => {
    const run = await mayaRun({ withScan: false });
    const { code } = await requested(run);
    await samira.post(`/api/reviews/${code}/claim`);
    await samira.post(`/api/reviews/${code}/submit`, reviewBody(run.evidenceCodes));
    await finalize(code);
    const report = await test.ctx.db.get<any>('SELECT * FROM reports WHERE code = ?', [`RPT-${run.taskCode}`]);
    expect(report.limitations).toContain('No contamination scan is attached to this version.');
    expect(report.limitations).toContain('Model training exposure remains unknown.');
  });

  it('requires the rationale and the checks acknowledgement to finalize', async () => {
    const { code } = await submitted();
    const noAck = await alex.post(`/api/admin/adjudications/${code}`, { decision: 'accept', rationale: 'Long enough rationale for the record.', checksAck: false });
    expect(noAck.status).toBe(422);
    expect((await json(noAck)).error.fields.checksAck).toBeTruthy();
    const noRationale = await alex.post(`/api/admin/adjudications/${code}`, { decision: 'accept', rationale: '', checksAck: true });
    expect(noRationale.status).toBe(422);
    expect((await json(noRationale)).error.fields.rationale).toBeTruthy();
    expect((await test.ctx.db.get<any>('SELECT status FROM reviews WHERE code = ?', [code])).status).toBe('submitted');
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM adjudications WHERE review_id = (SELECT id FROM reviews WHERE code = ?)', [code])).toBeUndefined();
  });

  it('refuses to finalize when evidence fails its seal', async () => {
    const { code, run } = await submitted();
    await test.ctx.db.exec('DROP TRIGGER evidence_no_update');
    await test.ctx.db.run(`UPDATE evidence SET output_text = 'edited' WHERE code = ?`, [run.evidenceCodes[2]]);
    const detail = await json(await alex.get(`/api/admin/adjudications/${code}`));
    expect(detail.evidenceVerified).toBe(false);
    expect(detail.actions.finalize.allowed).toBe(false);
    const res = await finalize(code);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('hash_mismatch');
  });

  it('refuses to adjudicate before the expert submits', async () => {
    const { code } = await claimed();
    const res = await finalize(code);
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toBe('The expert has not submitted this review yet.');
  });

  it('rolls back everything if the transaction fails part way', async () => {
    const { code, run } = await submitted();
    // A leaderboard row already holds this task and model, so the last insert of the transaction fails.
    await test.ctx.db.run(
      `INSERT INTO leaderboard_scores (id, domain_id, task_label, model_id, score, is_fixture, created_at) VALUES (?, 'biology', ?, 'meridian-2.1', 1, 1, ?)`,
      [newId(), run.label, test.ctx.now().toISOString()],
    );
    const res = await finalize(code);
    expect(res.status).toBe(500);
    expect((await test.ctx.db.get<any>('SELECT status FROM reviews WHERE code = ?', [code])).status).toBe('submitted');
    expect(await test.ctx.db.get('SELECT 1 AS ok FROM reports WHERE code = ?', [`RPT-${run.taskCode}`])).toBeUndefined();
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM adjudications WHERE review_id = (SELECT id FROM reviews WHERE code = ?)`, [code])).toBeUndefined();
    expect((await test.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM leaderboard_scores WHERE task_label = ?`, [run.label]))?.n).toBe(1);
  });
});

describe('returning a review', () => {
  it('appends a decision, emails the expert and reopens the review with the note', async () => {
    const { code, run } = await submitted();
    const note = 'Please address inhibitor specificity in the Meridian annotation.';
    const res = await alex.post(`/api/admin/adjudications/${code}`, { decision: 'return', rationale: note });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: 'returned', decision: 'return', adjudicationCode: 'ADJ-043', report: null, mail: { sent: true } });

    const mail = await lastMail(test, 'samira@northbridge.example');
    expect(mail?.subject).toBe(`${code} was returned to you`);
    expect(mail?.body_text).toContain(note);
    expect(mail?.link).toContain(`/review/${code}`);

    const detail = await json(await samira.get(`/api/reviews/${code}`));
    expect(detail).toMatchObject({ status: 'returned', returnedNote: note });
    expect(detail.actions.edit.allowed).toBe(true);
    expect(detail.assessment).toContain('The outputs treat');
    expect((await json(await samira.get('/api/reviews'))).drafts.map((item: any) => item.code)).toEqual([code]);
    expect((await json(await alex.get('/api/admin/adjudications'))).returned.map((item: any) => item.reviewCode)).toEqual([code]);
    expect(await test.ctx.db.get(`SELECT 1 AS ok FROM reports WHERE code = ?`, [`RPT-${run.taskCode}`])).toBeUndefined();

    // Back with the expert, so an admin cannot decide it again yet.
    const again = await alex.post(`/api/admin/adjudications/${code}`, { decision: 'accept', rationale: 'Trying while it is with the expert.', checksAck: true });
    expect(again.status).toBe(409);
    expect((await json(again)).error.message).toBe('This review is back with the expert.');
  });

  it('never overwrites: earlier decisions, submissions and sealed scores all survive', async () => {
    const { code, run } = await submitted();
    const sealedBefore = await test.ctx.db.all<any>('SELECT code, total_score, sha256 FROM evidence WHERE run_id = ? ORDER BY code', [run.runId]);
    const first = (await test.ctx.db.get<any>('SELECT assessment, rationale FROM reviews WHERE code = ?', [code]));

    await alex.post(`/api/admin/adjudications/${code}`, { decision: 'return', rationale: 'Please revisit the attribution scores.' });
    const reworked = reviewBody(run.evidenceCodes, { assessment: 'Second pass: attribution revisited against the same outputs.', rationale: 'Attribution is lower once inhibitor specificity is weighed.' });
    expect((await samira.put(`/api/reviews/${code}`, reworked)).status).toBe(200);
    expect((await test.ctx.db.get<any>('SELECT status FROM reviews WHERE code = ?', [code])).status).toBe('draft');
    expect((await json(await samira.get(`/api/reviews/${code}`))).returnedNote).toBe('Please revisit the attribution scores.');
    expect((await samira.post(`/api/reviews/${code}/submit`, reworked)).status).toBe(200);
    expect((await json(await samira.get(`/api/reviews/${code}`))).returnedNote).toBeNull();

    expect((await finalize(code)).status).toBe(200);

    const decisions = await test.ctx.db.all<any>(`SELECT code, decision FROM adjudications WHERE review_id = (SELECT id FROM reviews WHERE code = ?) ORDER BY created_at, rowid`, [code]);
    expect(decisions).toEqual([
      { code: 'ADJ-043', decision: 'return' },
      { code: 'ADJ-043', decision: 'accept' },
    ]);
    const detail = await json(await alex.get(`/api/admin/adjudications/${code}`));
    expect(detail.decisions.map((item: any) => item.decision)).toEqual(['return', 'accept']);
    expect(detail.submissions).toBe(2);

    const submissions = await test.ctx.db.all<any>(`SELECT seq, assessment, rationale FROM review_submissions WHERE review_id = (SELECT id FROM reviews WHERE code = ?) ORDER BY seq`, [code]);
    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toMatchObject({ seq: 1, assessment: first.assessment, rationale: first.rationale });
    expect(submissions[1].assessment).toContain('Second pass');

    const sealedAfter = await test.ctx.db.all<any>('SELECT code, total_score, sha256 FROM evidence WHERE run_id = ? ORDER BY code', [run.runId]);
    expect(sealedAfter).toEqual(sealedBefore);
  });

  it('refuses edits to adjudications, reports and submissions at the database', async () => {
    const { code } = await submitted();
    await finalize(code);
    await expect(test.ctx.db.run(`UPDATE adjudications SET rationale = 'rewritten'`)).rejects.toThrow(/append-only/);
    await expect(test.ctx.db.run(`DELETE FROM adjudications`)).rejects.toThrow(/append-only/);
    await expect(test.ctx.db.run(`UPDATE reports SET headline = 'rewritten'`)).rejects.toThrow(/immutable/);
    await expect(test.ctx.db.run(`DELETE FROM reports`)).rejects.toThrow(/immutable/);
    await expect(test.ctx.db.run(`UPDATE review_submissions SET finding = 'rewritten'`)).rejects.toThrow(/append-only/);
    await expect(test.ctx.db.run(`DELETE FROM review_submissions`)).rejects.toThrow(/append-only/);
  });

  it('reports a failed email honestly on a return', async () => {
    const noMail = await makeTestApp({ seed: true, config: { allowDevOutbox: false } });
    try {
      const admin = await new Client(noMail).signIn('alex@rivet.example');
      const expert = await new Client(noMail).signIn('samira@northbridge.example');
      const owner = await new Client(noMail).signIn('maya@helixlab.example');
      const ownerId = (await noMail.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'maya@helixlab.example'`))?.id as string;
      const workspaceId = (await noMail.ctx.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-HELIX'`))?.id as string;
      const run = await frozenRun(noMail, { ownerId, workspaceId });
      const { code } = await (await owner.post('/api/reviews', { runCode: run.runCode })).json();
      await expert.post(`/api/reviews/${code}/claim`);
      await expert.post(`/api/reviews/${code}/submit`, reviewBody(run.evidenceCodes));
      const body = await (await admin.post(`/api/admin/adjudications/${code}`, { decision: 'return', rationale: 'Please revisit the attribution scores.' })).json();
      expect(body.status).toBe('returned');
      expect(body.mail.sent).toBe(false);
    } finally {
      noMail.close();
    }
  });

  it('shows REVIEW-042 read-only with its final decision', async () => {
    const body = await json(await alex.get('/api/admin/adjudications/REVIEW-042'));
    expect(body).toMatchObject({ status: 'finalized', adjudicationCode: 'ADJ-042', adjudicationCodeIsPreview: false, reportCode: 'RPT-BIO-042', reportVersion: '1.0', expertName: 'Dr. Samira Patel', adminName: 'Alex Rivera', evidenceVerified: true });
    expect(body.scores.map((item: any) => [item.displayName, item.score, item.label, item.evidenceCode])).toEqual([
      ['Aster 3.2', 86, 'demo', 'EV-1042-A'],
      ['Meridian 2.1', 81, 'demo', 'EV-1042-M'],
      ['Lumen 4 Mini', 74, 'demo', 'EV-1042-L'],
    ]);
    expect(body.finding).toContain('Uphold the ordering for this task.');
    expect(body.finalDecision).toMatchObject({ code: 'ADJ-042', decision: 'accept', adminName: 'Alex Rivera' });
    expect(body.finalDecision.rationale).toContain('Freeze as RPT-BIO-042 v1.0.');
    expect(body.actions.finalize.allowed).toBe(false);
    expect(body.actions.returnToExpert.allowed).toBe(false);
    expect((await alex.post('/api/admin/adjudications/REVIEW-042', { decision: 'return', rationale: 'Reopening a frozen decision.' })).status).toBe(409);
  });
});
