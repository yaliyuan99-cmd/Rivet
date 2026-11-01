import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DraftSaveResponse, EditorDraftResponse, EditorNewResponse, FreezeResponse, FreezeResult, TaskBrowseResponse, TaskDetailResponse } from '../../shared/types/evaluation.ts';
import { waitForIdle } from '../../server/engine/runner.ts';
import { canonicalJson, sha256Hex } from '../../server/lib/crypto.ts';
import { STARTER_PROMPT, STARTER_RUBRIC, STARTER_TITLE } from '../../server/lib/demoFixtures.ts';
import { ngramCoverage, sharedRuns, tokenize } from '../../server/lib/contamination.ts';
import { Client, makeTestApp, makeUser, makeWorkspace, type TestApp } from '../helpers/app.ts';

let test: TestApp;

const RUBRIC = [
  { name: 'Interpretation', short: 'Interpretation', points: 60, guidance: 'Say what the result shows.' },
  { name: 'Controls', short: 'Controls', points: 40, guidance: 'Propose controls.' },
];
const MODELS = ['aster-3.2', 'meridian-2.1'];

const draftBody = (overrides: Record<string, unknown> = {}) => ({
  title: 'Does the reporter strain leak?',
  domainId: 'biology',
  prompt: 'Assess whether a fluorescent reporter leaks into the medium during stationary phase and name what would separate leakage from lysis in this culture system.',
  rubric: RUBRIC,
  modelIds: MODELS,
  datasetVersionId: null,
  ...overrides,
});

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const signedIn = (email: string) => new Client(test).signIn(email);

async function outsider(name = 'Outside Olu', email = 'olu@outside.example') {
  const id = await makeUser(test, { name, email });
  await makeWorkspace(test, id, 'Outside Lab');
  return signedIn(email);
}

async function createTask(client: Client, overrides: Record<string, unknown> = {}) {
  return json<DraftSaveResponse>(await client.post('/api/tasks', draftBody(overrides)), 201);
}

async function scanAndFreeze(client: Client, code: string) {
  const preview = await json<FreezeResponse>(await client.post(`/api/tasks/${code}/scan`));
  const frozen = await json<FreezeResult>(await client.post(`/api/tasks/${code}/freeze`, { scanCode: preview.scan?.code, acknowledgeFindings: true, acknowledgeRetention: true }), 201);
  return { preview, frozen };
}

beforeEach(async () => {
  test = await makeTestApp({ seed: true });
});
afterEach(async () => {
  await waitForIdle(test.ctx);
  test.close();
});

describe('browse', () => {
  it('lists what the frame shows, from real rows', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const body = await json<TaskBrowseResponse>(await maya.get('/api/tasks'));
    expect(body.items.map((item) => [item.label, item.title, item.meta])).toEqual([
      ['BIO-042 v1.0', 'Antibiotic resistance mechanism', 'Maya Chen · Private · 3 models · Run / Resume / Revise'],
      ['BIO-041 v1.0', 'Efflux versus permeability', 'Dr. Samira Patel · Demo shared · Read only'],
      ['BIO-043 v0.1', 'Limits of inhibitor controls', 'Maya Chen · Private draft · No runs yet'],
    ]);
    expect(body.headline).toBe('Biology / 3 authored demo tasks');
    expect(body.counts).toEqual({ readable: 3, synthetic: 3, mine: 2, matched: 3 });
    expect(body.featured?.code).toBe('BIO-042');
    expect(body.featured?.note).toMatch(/^Evaluate a causal claim against three source fixtures/);
    expect(body.featured?.reviewAction).toEqual({ label: 'Review BIO-042', verdict: { allowed: false, reason: 'You own this task' }, href: null });
    expect(body.workspaceName).toBe('Helix Lab');
  });

  it('searches and filters only tasks the user may read', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const search = async (query: string) => (await json<TaskBrowseResponse>(await maya.get(`/api/tasks?${query}`))).items.map((item) => item.code);
    expect(await search('q=antibiotic+resistance')).toEqual(['BIO-042']);
    expect(await search('q=efflux')).toEqual(['BIO-042', 'BIO-041', 'BIO-043']);
    expect(await search('status=draft')).toEqual(['BIO-043']);
    expect(await search('status=frozen')).toEqual(['BIO-042', 'BIO-041']);
    expect(await search('scope=mine')).toEqual(['BIO-042', 'BIO-043']);
    expect(await search('scope=WS-NORTHBRIDGE')).toEqual(['BIO-041']);
    expect(await search('domain=chemistry')).toEqual([]);
    expect(await search('domain=biology&status=frozen&scope=WS-HELIX&q=mechanism')).toEqual(['BIO-042']);
    const none = await json<TaskBrowseResponse>(await maya.get('/api/tasks?q=nothing+matches+this'));
    expect(none.items).toEqual([]);
    expect(none.counts.readable).toBe(3);
  });

  it('hides private tasks from other accounts, and their text from search', async () => {
    const olu = await outsider();
    const list = await json<TaskBrowseResponse>(await olu.get('/api/tasks'));
    expect(list.items.map((item) => [item.code, item.meta])).toEqual([['BIO-041', 'Dr. Samira Patel · Demo shared · Read only']]);
    expect(list.counts).toEqual({ readable: 1, synthetic: 1, mine: 0, matched: 1 });
    expect(list.featured?.reviewAction.verdict).toEqual({ allowed: false, reason: 'Verified Biology credential required' });
    const searched = await json<TaskBrowseResponse>(await olu.get('/api/tasks?q=ciprofloxacin'));
    expect(searched.items).toEqual([]);
  });

  it('gives a brand-new account an empty list', async () => {
    await makeUser(test, { name: 'New Nia', email: 'nia@new.example' });
    const nia = await signedIn('nia@new.example');
    await test.ctx.db.run(`UPDATE tasks SET visibility = 'private' WHERE code = 'BIO-041'`);
    const body = await json<TaskBrowseResponse>(await nia.get('/api/tasks'));
    expect(body.items).toEqual([]);
    expect(body.featured).toBeNull();
    expect(body.workspaceName).toBeNull();
  });

  it('requires a verified account', async () => {
    expect((await new Client(test).get('/api/tasks')).status).toBe(401);
    await makeUser(test, { email: 'unverified@lab.example', verified: false });
    const unverified = await signedIn('unverified@lab.example');
    expect((await unverified.get('/api/tasks')).status).toBe(403);
  });
});

describe('editor', () => {
  it('offers the registry, keeps disabled models visible with a reason, and skips deleted datasets', async () => {
    const maya = await signedIn('maya@helixlab.example');
    await test.ctx.db.run(`UPDATE models SET enabled = 0 WHERE id = 'lumen-4-mini'`);
    await test.ctx.db.run(`UPDATE datasets SET deleted_at = ? WHERE code = 'DS-BIO-09'`, [new Date().toISOString()]);
    const { options, starter } = await json<EditorNewResponse>(await maya.get('/api/tasks/editor-options'));
    expect(starter).toBeNull();
    const lumen = options.models.find((model) => model.id === 'lumen-4-mini');
    expect(lumen).toMatchObject({ available: false, reason: 'Unavailable for new runs. Historical evidence remains.', revision: 'lumen-4-mini-20261004' });
    // The workspace's own datasets first, then what others have shared. Deleted ones are gone.
    const labels = options.datasets.map((dataset) => dataset.label);
    expect(labels.slice(0, 2)).toEqual(['DS-BIO-07 v1.0', 'DS-BIO-08 v1.0']);
    expect(labels).not.toContain('DS-BIO-09 v1.0');
    expect(options.datasets[0]?.recordIds).toEqual(['E01', 'E02', 'E03']);
    expect(options.domains[0]?.label).toBe('Biology / Microbiology');
    expect(options.ownerName).toBe('Maya Chen');
    expect(options.review).toEqual({ allowed: false, reason: 'You own this task' });
  });

  it('prefills the authored starter', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const { starter, options } = await json<EditorNewResponse>(await maya.get('/api/tasks/editor-options?starter=1'));
    expect(starter).toMatchObject({ title: STARTER_TITLE, prompt: STARTER_PROMPT, rubric: STARTER_RUBRIC, domainId: 'biology', modelIds: ['aster-3.2', 'meridian-2.1', 'lumen-4-mini'] });
    expect(starter?.datasetVersionId).toBe(options.datasets[0]?.versionId);
  });

  it('serves the authored source pack as a real file', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const res = await maya.get('/api/tasks/starter-pack.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('resistance-evidence-demo.csv');
    expect(await res.text()).toContain('E01,MIC assay');
  });

  it('needs an active workspace to create a task', async () => {
    await makeUser(test, { name: 'New Nia', email: 'nia@new.example' });
    const nia = await signedIn('nia@new.example');
    const res = await nia.post('/api/tasks', draftBody());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('no_workspace');
  });

  it('takes codes from the domain counter and reports each bad field', async () => {
    const maya = await signedIn('maya@helixlab.example');
    expect((await createTask(maya)).code).toBe('BIO-044');
    expect((await createTask(maya)).code).toBe('BIO-045');
    expect((await createTask(maya, { domainId: 'chemistry' })).code).toBe('CHEM-001');

    const bad = await maya.post('/api/tasks', draftBody({ title: '   ', domainId: '' }));
    expect(bad.status).toBe(422);
    const { fields } = (await bad.json()).error;
    expect(fields.title).toBe('Enter a task title to continue.');
    expect(fields.domainId).toBe('Choose a domain to continue.');

    const unknownModel = await maya.post('/api/tasks', draftBody({ modelIds: ['not-a-model'] }));
    expect((await unknownModel.json()).error.fields.modelIds).toBe('Choose models from the registry.');
  });

  it('autosaves an unfinished draft and says what freezing would refuse', async () => {
    const maya = await signedIn('maya@helixlab.example');
    test.setNow('2026-11-01T14:20:00Z');
    const { code } = await createTask(maya);
    test.setNow('2026-11-01T14:25:00Z');
    const saved = await json<DraftSaveResponse>(await maya.put(`/api/tasks/${code}/draft`, draftBody({ title: '', prompt: '', rubric: [{ name: '', points: 30, guidance: '' }], modelIds: ['aster-3.2'] })));
    expect(saved.savedAt).toBe('2026-11-01T14:25:00.000Z');
    expect(saved.validation.ok).toBe(false);
    expect(saved.validation.fields).toMatchObject({
      title: 'Enter a task title to continue.',
      prompt: 'Enter the prompt every model will answer.',
      rubric: 'Rubric points must total 100. They total 30.',
      'rubric.0.name': 'Name this criterion.',
      modelIds: 'Select 2–4 models. 1 selected.',
    });
    const { draft } = await json<EditorDraftResponse>(await maya.get(`/api/tasks/${code}/draft`));
    expect(draft).toMatchObject({ status: 'draft', draftVersion: '0.1', freezeVersion: '1.0', afterFreezeVersion: '1.1', savedAt: '2026-11-01T14:25:00.000Z', title: '', domainLocked: false });
  });

  it('lets a never-frozen draft change domain, and moves its code', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const { code } = await createTask(maya);
    expect(code).toBe('BIO-044');
    const moved = await json<DraftSaveResponse>(await maya.put(`/api/tasks/${code}/draft`, draftBody({ domainId: 'chemistry' })));
    expect(moved.code).toBe('CHEM-001');
    expect((await maya.get('/api/tasks/BIO-044')).status).toBe(404);
    expect((await maya.get('/api/tasks/CHEM-001')).status).toBe(200);
  });

  it('only lets the owner edit', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const { code } = await createTask(maya);
    // A workspace member can read the draft but not change it.
    const memberId = await makeUser(test, { name: 'Member Mo', email: 'mo@helixlab.example' });
    const helix = await test.ctx.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-HELIX'`);
    await test.ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)`, ['m-mo', helix?.id, memberId, new Date().toISOString()]);
    const mo = await signedIn('mo@helixlab.example');
    expect((await mo.get(`/api/tasks/${code}`)).status).toBe(200);
    const res = await mo.put(`/api/tasks/${code}/draft`, draftBody());
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('Only the task owner can edit this task.');
    expect((await mo.get(`/api/tasks/${code}/draft`)).status).toBe(403);
    // Anyone else sees nothing at all.
    const olu = await outsider();
    expect((await olu.get(`/api/tasks/${code}/draft`)).status).toBe(404);
    expect((await olu.put(`/api/tasks/${code}/draft`, draftBody())).status).toBe(404);
  });

  it('never edits a frozen version', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const res = await maya.put('/api/tasks/BIO-042/draft', draftBody({ prompt: 'A silently different prompt.' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('frozen');
  });
});

describe('contamination scan', () => {
  it('uses the authored wording for the frame cases and shares the task number', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const preview = await json<FreezeResponse>(await maya.post('/api/tasks/BIO-043/scan'));
    expect(preview.scan?.code).toBe('SCAN-043');
    expect(preview.scan?.stale).toBe(false);
    expect(preview.scan?.findings.exactPrompt.detail).toBe('No match in scanned indexes.');
    // BIO-043's prompt really does share this phrase with a record in DS-BIO-08.
    expect(preview.scan?.risk).toBe('low');
    expect(preview.scan?.findings.nearDuplicate.detail).toBe('“off-target effects” · Low risk');
    expect(preview.scan?.findings.nearDuplicate.matches).toEqual(['DS-BIO-08 v1.0 / C03']);
    expect(preview.scan?.findings.coverage?.detail).toBe('No 13-word window of this prompt appears in scanned indexes.');
    expect(preview.scan?.findings.sourceExposure.detail).toBe('E01–E03 synthetic and private; no public match.');
    expect(preview.scan?.findings.trainingCoverage.detail).toBe('Not accessible to Rivet · Unknown');
    expect(preview.scan?.findings.summary).toBe('One possible terminology overlap. This signal is not proof of training contamination.');
    expect(preview.scan?.findings.acknowledgementText).toBe('The matching phrase is standard terminology. These source records were authored for this synthetic demo. Training exposure cannot be ruled out.');
    expect(preview.scan?.findings.retentionText).toBe('Retain the scan and its limitations with every frozen report.');
    expect(preview.label).toBe('BIO-043 v1.0');
    expect(preview.rail).toEqual({ promptAndRubric: '3 criteria / 100 points', sourcePack: 'DS-BIO-07 v1.0', modelRevisions: '3 pinned revisions' });
  });

  it('finds an exact prompt match, near-duplicate phrases and 13-gram coverage', async () => {
    const maya = await signedIn('maya@helixlab.example');

    const exact = await createTask(maya, { prompt: `  ${STARTER_PROMPT.toUpperCase()} ` });
    const exactScan = (await json<FreezeResponse>(await maya.post(`/api/tasks/${exact.code}/scan`))).scan;
    expect(exactScan?.risk).toBe('high');
    expect(exactScan?.findings.exactPrompt.status).toBe('high');
    expect(exactScan?.findings.exactPrompt.detail).toContain('BIO-042 v1.0');
    expect(exactScan?.findings.coverage?.status).toBe('high');
    expect(exactScan?.findings.coverage?.maxCoverage).toBe(1);
    expect(exactScan?.findings.summary).toBe('This prompt exactly matches a scanned document. This signal is not proof of training contamination.');
    expect(exactScan?.findings.acknowledgementText).toMatch(/^I have reviewed the overlap/);

    const near = await createTask(maya, { prompt: 'Does increased AcrAB-TolC efflux matter here? Answer with care, please, in plain language for a colleague.' });
    const nearScan = (await json<FreezeResponse>(await maya.post(`/api/tasks/${near.code}/scan`))).scan;
    expect(nearScan?.risk).toBe('low');
    expect(nearScan?.findings.nearDuplicate.phrases).toContain('increased AcrAB-TolC efflux');
    expect(nearScan?.findings.nearDuplicate.detail).toBe('“increased AcrAB-TolC efflux” · Low risk');
    expect(nearScan?.findings.summary).toBe('One possible terminology overlap. This signal is not proof of training contamination.');
    expect(nearScan?.findings.acknowledgementText).toBe('The matching phrase is standard terminology. Training exposure cannot be ruled out.');

    const partial = await createTask(maya, { prompt: `Start with this: ${STARTER_PROMPT.split('.').slice(0, 1).join('.')} and then go on to explain something else entirely about how you read these results.` });
    const partialScan = (await json<FreezeResponse>(await maya.post(`/api/tasks/${partial.code}/scan`))).scan;
    expect(partialScan?.risk).toBe('high');
    expect(partialScan?.findings.exactPrompt.status).toBe('clear');
    expect(partialScan?.findings.coverage?.status).toBe('high');
    expect(partialScan?.findings.coverage?.maxCoverage).toBeGreaterThan(0);
    expect(partialScan?.findings.coverage?.maxCoverage).toBeLessThan(1);
    expect(partialScan?.findings.coverage?.detail).toContain('BIO-042 v1.0');
  });

  it('compares with reports and dataset records too', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const report = await createTask(maya, { prompt: 'Explain why efflux is supported; causality is not established in this case, step by step.' });
    const reportScan = (await json<FreezeResponse>(await maya.post(`/api/tasks/${report.code}/scan`))).scan;
    expect(reportScan?.findings.nearDuplicate.matches).toContain('RPT-BIO-042 v1.0');

    const record = await createTask(maya, { prompt: 'Comment on acrB transcript 3.1× control as an indirect signal of activity in a short note.' });
    const recordScan = (await json<FreezeResponse>(await maya.post(`/api/tasks/${record.code}/scan`))).scan;
    expect(recordScan?.findings.nearDuplicate.matches).toContain('DS-BIO-07 v1.0 / E02');

    // A task's own attached pack is expected to overlap, so it is not counted against it.
    const pack = await test.ctx.db.get<{ id: string }>(`SELECT v.id FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE d.code = 'DS-BIO-07'`);
    await maya.put(`/api/tasks/${record.code}/draft`, draftBody({ prompt: 'Comment on acrB transcript 3.1× control as an indirect signal of activity in a short note.', datasetVersionId: pack?.id }));
    const attachedScan = (await json<FreezeResponse>(await maya.post(`/api/tasks/${record.code}/scan`))).scan;
    expect(attachedScan?.findings.nearDuplicate.phrases).not.toContain('acrB transcript 3.1× control');
  });

  it('never compares with another workspace’s private content, so it cannot be used to probe it', async () => {
    const olu = await outsider();
    const { code } = await createTask(olu, { prompt: STARTER_PROMPT });
    const scan = (await json<FreezeResponse>(await olu.post(`/api/tasks/${code}/scan`))).scan;
    expect(scan?.findings.exactPrompt.status).toBe('clear');
    expect(scan?.risk).toBe('none');
    expect(scan?.findings.summary).toBe('No overlap found in the indexes Rivet can scan.');
    expect(scan?.findings.scope).toContain('you can access');
  });

  it('does not call a very short prompt clean', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const { code } = await createTask(maya, { prompt: 'Too short to window.' });
    const scan = (await json<FreezeResponse>(await maya.post(`/api/tasks/${code}/scan`))).scan;
    expect(scan?.findings.coverage).toMatchObject({ status: 'unknown', detail: 'Not checkable: this prompt is shorter than 13 words.' });
  });

  it('warns, without blocking, when a prompt cites records the pack does not have', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const { code } = await createTask(maya, { prompt: `${STARTER_PROMPT} Also weigh E09.` });
    const preview = await json<FreezeResponse>(await maya.post(`/api/tasks/${code}/scan`));
    expect(preview.warnings).toEqual(['This prompt cites E01, E02, E03, E09, but no source pack is attached.']);
    expect(preview.validation.ok).toBe(true);
  });

  it('avoids a code clash between domains, and numbers later versions', async () => {
    const maya = await signedIn('maya@helixlab.example');
    await test.ctx.db.run(`INSERT INTO counters (name, value) VALUES ('task:CHEM', 42) ON CONFLICT (name) DO UPDATE SET value = 42`);
    const chem = await createTask(maya, { domainId: 'chemistry' });
    expect(chem.code).toBe('CHEM-043');
    await maya.post('/api/tasks/BIO-043/scan');
    const chemScan = (await json<FreezeResponse>(await maya.post(`/api/tasks/${chem.code}/scan`))).scan;
    expect(chemScan?.code).toBe('SCAN-CHEM-043');
    // Scanning twice replaces the preview and keeps its code.
    const again = (await json<FreezeResponse>(await maya.post(`/api/tasks/${chem.code}/scan`))).scan;
    expect(again?.code).toBe('SCAN-CHEM-043');
    const rows = await test.ctx.db.all(`SELECT code FROM scans WHERE code LIKE 'SCAN-CHEM%'`);
    expect(rows).toHaveLength(1);
  });

  it('has working parts', () => {
    const a = tokenize('Increased AcrAB-TolC efflux.');
    expect(a.map((token) => token.text)).toEqual(['increased', 'acrab', 'tolc', 'efflux']);
    const words = 'one two three four five six seven eight nine ten eleven twelve thirteen'.split(' ');
    expect(ngramCoverage(words, words)).toEqual({ checkable: true, covered: 1 });
    expect(ngramCoverage(words.slice(0, 5), words)).toEqual({ checkable: false, covered: 0 });
    expect(sharedRuns(['a', 'b', 'c', 'd', 'x'], ['q', 'a', 'b', 'c', 'd'])).toEqual([{ start: 0, length: 4 }]);
  });
});

describe('freeze', () => {
  it('refuses an incomplete draft with field-level reasons', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const { code } = await createTask(maya);
    await maya.put(`/api/tasks/${code}/draft`, draftBody({ prompt: '', rubric: [{ name: 'Only', short: 'Only', points: 90, guidance: '' }], modelIds: ['aster-3.2'] }));
    const res = await maya.post(`/api/tasks/${code}/freeze`, { scanCode: 'SCAN-044', acknowledgeFindings: true, acknowledgeRetention: true });
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields).toEqual({
      prompt: 'Enter the prompt every model will answer.',
      rubric: 'Rubric points must total 100. They total 90.',
      modelIds: 'Select 2–4 models. 1 selected.',
    });
    const preview = await json<FreezeResponse>(await maya.get(`/api/tasks/${code}/freeze`));
    expect(preview.validation.ok).toBe(false);
    expect(preview.scan).toBeNull();
  });

  it('refuses disabled models', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const { code } = await createTask(maya);
    await test.ctx.db.run(`UPDATE models SET enabled = 0 WHERE id = 'aster-3.2'`);
    const preview = await json<FreezeResponse>(await maya.get(`/api/tasks/${code}/freeze`));
    expect(preview.validation.fields.modelIds).toBe('Aster 3.2: Unavailable for new runs. Historical evidence remains.');
  });

  it('refuses a dataset deleted since it was attached', async () => {
    const maya = await signedIn('maya@helixlab.example');
    await test.ctx.db.run(`UPDATE datasets SET deleted_at = ? WHERE code = 'DS-BIO-07'`, [new Date().toISOString()]);
    const preview = await json<FreezeResponse>(await maya.get('/api/tasks/BIO-043/freeze'));
    expect(preview.validation.fields.datasetVersionId).toBe('This dataset was deleted from the library. Choose another or remove it.');
  });

  it('needs both owner acknowledgements', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const preview = await json<FreezeResponse>(await maya.post('/api/tasks/BIO-043/scan'));
    const res = await maya.post('/api/tasks/BIO-043/freeze', { scanCode: preview.scan?.code, acknowledgeFindings: false });
    expect(res.status).toBe(422);
    expect(Object.keys((await res.json()).error.fields).sort()).toEqual(['acknowledgeFindings', 'acknowledgeRetention']);
    const task = await json<TaskDetailResponse>(await maya.get('/api/tasks/BIO-043'));
    expect(task.status).toBe('draft');
  });

  it('refuses a preview the draft has moved past', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const { code } = await createTask(maya);
    const preview = await json<FreezeResponse>(await maya.post(`/api/tasks/${code}/scan`));
    expect(preview.scan?.stale).toBe(false);
    await maya.put(`/api/tasks/${code}/draft`, draftBody({ prompt: 'A prompt that was changed after the scan ran and which no longer matches its input hash at all.' }));
    const stale = await json<FreezeResponse>(await maya.get(`/api/tasks/${code}/freeze`));
    expect(stale.scan?.stale).toBe(true);
    const res = await maya.post(`/api/tasks/${code}/freeze`, { scanCode: preview.scan?.code, acknowledgeFindings: true, acknowledgeRetention: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('scan_stale');
    // A fresh scan clears it.
    await scanAndFreeze(maya, code);
  });

  it('refuses without any scan', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const { code } = await createTask(maya);
    const res = await maya.post(`/api/tasks/${code}/freeze`, { scanCode: 'SCAN-044', acknowledgeFindings: true, acknowledgeRetention: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('scan_stale');
  });

  it('writes an immutable version with pinned revisions and a real hash', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const { preview, frozen } = await scanAndFreeze(maya, 'BIO-043');
    expect(frozen).toMatchObject({ code: 'BIO-043', version: '1.0', label: 'BIO-043 v1.0' });

    const row = await test.ctx.db.get<Record<string, string>>(`SELECT v.* FROM task_versions v JOIN tasks t ON t.id = v.task_id WHERE t.code = 'BIO-043' AND v.version = '1.0'`);
    const models = JSON.parse(row?.models as string);
    expect(models.map((model: { revision: string }) => model.revision)).toEqual(['aster-3.2-20261001', 'meridian-2.1-20260918', 'lumen-4-mini-20261004']);
    expect(JSON.parse(row?.acknowledgements as string)).toEqual([preview.scan?.findings.acknowledgementText, preview.scan?.findings.retentionText]);

    const dataset = await test.ctx.db.get<{ sha256: string }>(`SELECT sha256 FROM dataset_versions WHERE id = ?`, [row?.dataset_version_id]);
    const recomputed = sha256Hex(
      canonicalJson({
        schema: 'rivet.task_version.v1',
        task_code: 'BIO-043',
        version: '1.0',
        title: row?.title,
        prompt: row?.prompt,
        rubric: JSON.parse(row?.rubric as string),
        models,
        settings: JSON.parse(row?.settings as string),
        dataset_sha256: dataset?.sha256,
        scan_code: 'SCAN-043',
        acknowledgements: JSON.parse(row?.acknowledgements as string),
      }),
    );
    expect(row?.sha256).toBe(recomputed);
    expect(frozen.sha256).toBe(recomputed);

    await expect(test.ctx.db.run(`UPDATE task_versions SET prompt = 'edited' WHERE id = ?`, [row?.id])).rejects.toThrow(/immutable/);
    await expect(test.ctx.db.run(`DELETE FROM task_versions WHERE id = ?`, [row?.id])).rejects.toThrow(/immutable/);

    const task = await json<TaskDetailResponse>(await maya.get('/api/tasks/BIO-043'));
    expect(task.status).toBe('frozen');
    expect(task.nextVersion).toBe('1.1');
    expect(task.statusLine).toBe('Private / Helix Lab / Frozen');

    // Freezing twice, or editing afterwards, is refused.
    const again = await maya.post('/api/tasks/BIO-043/freeze', { scanCode: preview.scan?.code, acknowledgeFindings: true, acknowledgeRetention: true });
    expect(again.status).toBe(409);
    expect((await maya.put('/api/tasks/BIO-043/draft', draftBody())).status).toBe(409);
    expect((await maya.post('/api/tasks/BIO-043/scan')).status).toBe(409);

    const audited = await test.ctx.db.get<{ detail: string }>(`SELECT detail FROM audit_log WHERE action = 'task.frozen' AND subject_code = 'BIO-043 v1.0'`);
    expect(JSON.parse(audited?.detail as string).sha256).toBe(recomputed);
  });

  it('shows the frozen record to anyone who can read the task', async () => {
    const olu = await outsider();
    const record = await json<FreezeResponse>(await olu.get('/api/tasks/BIO-041/freeze'));
    expect(record.status).toBe('frozen');
    expect(record.frozen?.acknowledgements).toEqual(['Training exposure cannot be ruled out.', 'Retain the scan and its limitations with every frozen report.']);
    expect(record.scan?.code).toBe('SCAN-041');
  });
});

describe('revise', () => {
  it('makes a new draft, leaves v1.0 untouched, and the next label increments', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const before = await test.ctx.db.get<Record<string, unknown>>(`SELECT v.* FROM task_versions v JOIN tasks t ON t.id = v.task_id WHERE t.code = 'BIO-042'`);

    const revised = await json<{ draftVersion: string }>(await maya.post('/api/tasks/BIO-042/revise'), 201);
    expect(revised.draftVersion).toBe('1.1');

    // The draft starts from the frozen copy and can now change.
    const { draft } = await json<EditorDraftResponse>(await maya.get('/api/tasks/BIO-042/draft'));
    expect(draft).toMatchObject({ status: 'draft', draftVersion: '1.1', freezeVersion: '1.1', afterFreezeVersion: '1.2', latestVersion: '1.0', domainLocked: true, prompt: STARTER_PROMPT });
    const changed = 'Assess the same observations again, and now weigh the inhibitor’s specificity explicitly before you state any mechanism at all in your answer.';
    await json(await maya.put('/api/tasks/BIO-042/draft', { ...draft, prompt: changed }));

    // The domain cannot move once a version exists.
    const moved = await maya.put('/api/tasks/BIO-042/draft', { ...draft, domainId: 'chemistry' });
    expect((await moved.json()).error.fields.domainId).toBe('The domain is fixed once a version is frozen.');

    // Revising twice is refused; v1.0 can still run meanwhile.
    expect((await maya.post('/api/tasks/BIO-042/revise')).status).toBe(409);
    const during = await json<TaskDetailResponse>(await maya.get('/api/tasks/BIO-042'));
    expect(during.label).toBe('BIO-042 v1.0');
    expect(during.statusLine).toBe('Private / Helix Lab / Frozen / v1.1 draft');
    expect(during.latestVersion?.prompt).toBe(STARTER_PROMPT);
    expect(during.draft?.prompt).toBe(changed);
    expect(during.verdicts.run.allowed).toBe(true);
    expect(during.verdicts.edit.allowed).toBe(true);

    const { frozen, preview } = await scanAndFreeze(maya, 'BIO-042');
    expect(frozen.label).toBe('BIO-042 v1.1');
    expect(preview.scan?.code).toBe('SCAN-042-2');

    const after = await test.ctx.db.get<Record<string, unknown>>(`SELECT * FROM task_versions WHERE id = ?`, [before?.id as string]);
    expect(after).toEqual(before);

    const task = await json<TaskDetailResponse>(await maya.get('/api/tasks/BIO-042'));
    expect(task.label).toBe('BIO-042 v1.1');
    expect(task.nextVersion).toBe('1.2');
    await json(await maya.post('/api/tasks/BIO-042/revise'), 201);
    const { draft: next } = await json<EditorDraftResponse>(await maya.get('/api/tasks/BIO-042/draft'));
    expect(next.freezeVersion).toBe('1.2');

    const list = await json<TaskBrowseResponse>(await maya.get('/api/tasks?q=BIO-042'));
    expect(list.items[0]?.label).toBe('BIO-042 v1.1');
    expect(list.items[0]?.meta).toContain('v1.2 draft');
  });

  it('refuses to revise a task that was never frozen, and refuses non-owners', async () => {
    const maya = await signedIn('maya@helixlab.example');
    expect((await maya.post('/api/tasks/BIO-043/revise')).status).toBe(409);
    const samira = await signedIn('samira@northbridge.example');
    const res = await samira.post('/api/tasks/BIO-042/revise');
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('Only the task owner can revise this task.');
  });

  it('keeps a shared task readable while its revision stays hidden', async () => {
    const samira = await signedIn('samira@northbridge.example');
    await json(await samira.post('/api/tasks/BIO-041/revise'), 201);
    const secret = 'A private revision that nobody outside the workspace should read or find by searching for zanzibar.';
    const { draft } = await json<EditorDraftResponse>(await samira.get('/api/tasks/BIO-041/draft'));
    await json(await samira.put('/api/tasks/BIO-041/draft', { ...draft, prompt: secret }));

    const olu = await outsider();
    const task = await json<TaskDetailResponse>(await olu.get('/api/tasks/BIO-041'));
    expect(task.draft).toBeNull();
    expect(task.latestVersion?.prompt).not.toContain('zanzibar');
    expect(task.statusLine).not.toContain('draft');
    expect((await json<TaskBrowseResponse>(await olu.get('/api/tasks?q=zanzibar'))).items).toEqual([]);
    expect((await json<TaskBrowseResponse>(await olu.get('/api/tasks?status=draft'))).items).toEqual([]);
    expect((await json<TaskBrowseResponse>(await olu.get('/api/tasks'))).items[0]?.meta).not.toContain('draft');

    // The frozen record stays readable, and the draft's preview is not offered instead.
    const record = await json<FreezeResponse>(await olu.get('/api/tasks/BIO-041/freeze'));
    expect(record).toMatchObject({ status: 'frozen', label: 'BIO-041 v1.0' });
    expect(record.scan?.code).toBe('SCAN-041');
  });
});

describe('task page', () => {
  it('reads the access policy and verdicts from real data', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const task = await json<TaskDetailResponse>(await maya.get('/api/tasks/BIO-042'));
    expect(task).toMatchObject({
      label: 'BIO-042 v1.0',
      title: STARTER_TITLE,
      workspaceName: 'Helix Lab',
      ownerName: 'Maya Chen',
      statusLine: 'Private / Helix Lab / Frozen',
      statement: 'Only Helix Lab members and explicitly authorized reviewers can access this task and its evidence.',
      sourcePack: 'DS-BIO-07 v1.0',
      nextVersion: '1.1',
    });
    expect(task.accessPolicy).toEqual([
      { term: 'Maya Chen', detail: 'Task owner · Run / resume / revise' },
      { term: 'Helix Lab members', detail: 'Read private task and evidence' },
      { term: 'Dr. Samira Patel', detail: 'Assigned Biology review only' },
      { term: 'External visitors', detail: 'No access · Authentication required' },
    ]);
    expect(task.verdicts.run).toEqual({ allowed: true });
    expect(task.verdicts.revise).toEqual({ allowed: true });
    expect(task.verdicts.visibility).toEqual({ allowed: true });
    expect(task.reviewAction).toEqual({ label: 'Review this task', verdict: { allowed: false, reason: 'You own this task' }, href: null });
    expect(task.tamper).toMatchObject({ code: 'EV-1042-A', runCode: 'RUN-1042', taskLabel: 'BIO-042 v1.0', verified: true, runnerVersion: '2.4' });
    expect(task.runs.map((run) => [run.code, run.summary])).toEqual([['RUN-1042', '9 / 9 stages · Complete']]);
  });

  it('shows non-owners the disabled reason, and a reviewer their review', async () => {
    const samira = await signedIn('samira@northbridge.example');
    const task = await json<TaskDetailResponse>(await samira.get('/api/tasks/BIO-042'));
    expect(task.isOwner).toBe(false);
    expect(task.verdicts.run).toEqual({ allowed: false, reason: 'Only the task owner can run this task.' });
    expect(task.verdicts.revise).toEqual({ allowed: false, reason: 'Only the task owner can revise this task.' });
    expect(task.verdicts.visibility).toEqual({ allowed: false, reason: 'Only the task owner can change visibility.' });
    expect(task.reviewAction).toEqual({ label: 'Review this task', verdict: { allowed: true }, href: '/review/REVIEW-042' });
  });

  it('keeps shared tasks read-only for others and private tasks invisible', async () => {
    const olu = await outsider();
    const shared = await json<TaskDetailResponse>(await olu.get('/api/tasks/BIO-041'));
    expect(shared.statement).toContain('Any verified Rivet member can read');
    expect(shared.verdicts.run).toEqual({ allowed: false, reason: 'Only the task owner can run this task.' });
    expect(shared.draft).toBeNull();
    expect(shared.accessPolicy.map((row) => row.term)).toContain('Verified Rivet members');

    for (const path of ['/api/tasks/BIO-042', '/api/tasks/BIO-043', '/api/tasks/BIO-042/runs', '/api/tasks/BIO-042/freeze', '/api/runs/RUN-1042', '/api/evidence/EV-1042-A', '/api/evidence/EV-1042-A/download']) {
      expect((await olu.get(path)).status, path).toBe(404);
    }
    expect((await olu.post('/api/tasks/BIO-042/runs')).status).toBe(404);
    expect((await olu.post('/api/runs/RUN-1042/resume')).status).toBe(404);
    expect((await olu.patch('/api/tasks/BIO-042/visibility', { visibility: 'shared' })).status).toBe(404);
  });

  it('saves visibility, and that decides who can read', async () => {
    const maya = await signedIn('maya@helixlab.example');
    const olu = await outsider();
    expect((await olu.get('/api/tasks/BIO-042')).status).toBe(404);

    await json(await maya.patch('/api/tasks/BIO-042/visibility', { visibility: 'shared' }));
    const shared = await json<TaskDetailResponse>(await olu.get('/api/tasks/BIO-042'));
    expect(shared.visibility).toBe('shared');

    const refused = await olu.patch('/api/tasks/BIO-042/visibility', { visibility: 'private' });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.message).toBe('Only the task owner can change visibility.');

    await json(await maya.patch('/api/tasks/BIO-042/visibility', { visibility: 'private' }));
    expect((await olu.get('/api/tasks/BIO-042')).status).toBe(404);

    const bad = await maya.patch('/api/tasks/BIO-042/visibility', { visibility: 'public' });
    expect(bad.status).toBe(422);
    const logged = await test.ctx.db.all(`SELECT 1 FROM audit_log WHERE action = 'task.visibility_changed'`);
    expect(logged).toHaveLength(2);
  });

  it('removing a membership revokes access on the next request', async () => {
    const memberId = await makeUser(test, { name: 'Member Mo', email: 'mo@helixlab.example' });
    const helix = await test.ctx.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-HELIX'`);
    await test.ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)`, ['m-mo', helix?.id, memberId, new Date().toISOString()]);
    const mo = await signedIn('mo@helixlab.example');
    const read = await json<TaskDetailResponse>(await mo.get('/api/tasks/BIO-042'));
    expect(read.verdicts.run).toEqual({ allowed: false, reason: 'Only the task owner can run this task.' });
    await test.ctx.db.run(`UPDATE memberships SET status = 'removed' WHERE id = 'm-mo'`);
    expect((await mo.get('/api/tasks/BIO-042')).status).toBe(404);
  });

  it('refuses every owner action from a credentialed non-owner', async () => {
    const samira = await signedIn('samira@northbridge.example');
    const expectForbidden = async (res: Response, reason: string) => {
      expect(res.status).toBe(403);
      expect((await res.json()).error.message).toBe(reason);
    };
    await expectForbidden(await samira.post('/api/tasks/BIO-042/runs'), 'Only the task owner can run this task.');
    await expectForbidden(await samira.post('/api/tasks/BIO-042/revise'), 'Only the task owner can revise this task.');
    await expectForbidden(await samira.put('/api/tasks/BIO-042/draft', draftBody()), 'Only the task owner can edit this task.');
    await expectForbidden(await samira.post('/api/tasks/BIO-042/scan'), 'Only the task owner can freeze this task.');
    await expectForbidden(await samira.post('/api/tasks/BIO-042/freeze', { scanCode: 'x', acknowledgeFindings: true, acknowledgeRetention: true }), 'Only the task owner can freeze this task.');
    await expectForbidden(await samira.patch('/api/tasks/BIO-042/visibility', { visibility: 'shared' }), 'Only the task owner can change visibility.');
  });
});
