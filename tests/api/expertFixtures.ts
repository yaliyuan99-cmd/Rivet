// Frozen tasks, complete runs and sealed evidence inserted with SQL, so these tests do not depend on the run engine.
import { STARTER_RUBRIC } from '../../server/lib/demoFixtures.ts';
import { RUNNER_VERSION, evidenceHash, taskVersionHash } from '../../server/lib/evidence.ts';
import { newId } from '../../server/lib/ids.ts';
import { Client, makeUser, type TestApp } from '../helpers/app.ts';

export const MODELS = [
  { id: 'aster-3.2', displayName: 'Aster 3.2', shortName: 'Aster', letter: 'A', revision: 'aster-3.2-20261001', adapter: 'demo', contextK: 128, outputK: 8 },
  { id: 'meridian-2.1', displayName: 'Meridian 2.1', shortName: 'Meridian', letter: 'M', revision: 'meridian-2.1-20260918', adapter: 'demo', contextK: 128, outputK: 8 },
  { id: 'lumen-4-mini', displayName: 'Lumen 4 Mini', shortName: 'Lumen', letter: 'L', revision: 'lumen-4-mini-20261004', adapter: 'demo', contextK: 64, outputK: 8 },
];

const SETTINGS = { temperature: 0.2, seed: 42, maxOutputK: 8 };
const ACKNOWLEDGEMENTS = ['The matching phrase is standard terminology.', 'Retain the scan and its limitations with every frozen report.'];
const FINDINGS = {
  nearDuplicate: { status: 'low', label: 'Near-duplicate phrase', detail: 'Low risk', phrases: ['efflux pump'] },
  trainingCoverage: { status: 'unknown', label: 'Training corpus coverage', detail: 'Not accessible to Rivet · Unknown' },
};

export interface FrozenRun {
  taskId: string;
  taskCode: string;
  versionId: string;
  runId: string;
  runCode: string;
  evidenceCodes: string[];
  label: string;
}

let sequence = 0;

/** A frozen task owned by `ownerId`, with one run in the given status and sealed evidence if complete. */
export async function frozenRun(
  test: TestApp,
  spec: { ownerId: string; workspaceId: string; domainId?: string; taskCode?: string; stamp?: string; version?: string; runStatus?: 'complete' | 'running' | 'failed'; visibility?: 'private' | 'shared'; withScan?: boolean; label?: 'demo' | 'judge'; synthetic?: boolean },
): Promise<FrozenRun> {
  const { db } = test.ctx;
  sequence += 1;
  const stamp = spec.stamp ?? String(900 + sequence);
  const taskCode = spec.taskCode ?? `BIO-${stamp}`;
  const version = spec.version ?? '1.0';
  const title = `Fixture task ${taskCode}`;
  const prompt = 'Assess whether the supplied observations support the mechanism.';
  const now = test.ctx.now().toISOString();
  const domainId = spec.domainId ?? 'biology';

  const taskId = newId();
  await db.run(
    `INSERT INTO tasks (id, code, workspace_id, owner_id, domain_id, title, prompt, rubric, model_ids, settings, visibility, status, is_synthetic, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'frozen', ?, ?, ?)`,
    [taskId, taskCode, spec.workspaceId, spec.ownerId, domainId, title, prompt, JSON.stringify(STARTER_RUBRIC), JSON.stringify(MODELS.map((m) => m.id)), JSON.stringify(SETTINGS), spec.visibility ?? 'private', spec.synthetic === false ? 0 : 1, now, now],
  );

  let scanId: string | null = null;
  const scanCode = spec.withScan === false ? null : `SCAN-${stamp}`;
  if (scanCode) {
    scanId = newId();
    await db.run(`INSERT INTO scans (id, code, task_id, input_hash, findings, risk, created_by, created_at) VALUES (?, ?, ?, 'test', ?, 'low', ?, ?)`, [scanId, scanCode, taskId, JSON.stringify(FINDINGS), spec.ownerId, now]);
  }
  const acknowledgements = scanCode ? ACKNOWLEDGEMENTS : [];
  const versionHash = taskVersionHash({ task_code: taskCode, version, title, prompt, rubric: STARTER_RUBRIC, models: MODELS, settings: SETTINGS, dataset_sha256: null, scan_code: scanCode, acknowledgements });
  const versionId = newId();
  await db.run(
    `INSERT INTO task_versions (id, task_id, version, title, prompt, rubric, models, settings, dataset_version_id, scan_id, acknowledgements, sha256, frozen_by, frozen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [versionId, taskId, version, title, prompt, JSON.stringify(STARTER_RUBRIC), JSON.stringify(MODELS), JSON.stringify(SETTINGS), scanId, JSON.stringify(acknowledgements), versionHash, spec.ownerId, now],
  );
  await db.run('UPDATE tasks SET latest_version_id = ? WHERE id = ?', [versionId, taskId]);

  const runStatus = spec.runStatus ?? 'complete';
  const runCode = `RUN-${stamp}`;
  const runId = newId();
  await db.run(
    `INSERT INTO runs (id, code, task_id, task_version_id, owner_id, status, stages_total, stages_done, attempt, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 9, ?, 1, ?, ?, ?)`,
    [runId, runCode, taskId, versionId, spec.ownerId, runStatus, runStatus === 'complete' ? 9 : 2, now, runStatus === 'complete' ? now : null, now],
  );

  const evidenceCodes: string[] = [];
  if (runStatus === 'complete') {
    const sealed = [
      [24, 22, 18, 11],
      [22, 20, 16, 10],
      [18, 18, 15, 9],
    ];
    for (const [index, model] of MODELS.entries()) {
      const code = `EV-${stamp}-${model.letter}`;
      const values = sealed[index] as number[];
      const scores = STARTER_RUBRIC.map((criterion, i) => ({ name: criterion.name, short: criterion.short, points: criterion.points, score: values[i], rationale: 'Sealed machine note.' }));
      const total = values.reduce((sum, value) => sum + value, 0);
      const meta = { adapter: 'demo', synthetic: true };
      const scoreLabel = spec.label ?? 'demo';
      const sha256 = evidenceHash({ code, run_code: runCode, task_version_hash: versionHash, model_id: model.id, model_revision: model.revision, output_text: `${model.shortName} output.`, output_meta: meta, scores, total_score: total, score_label: scoreLabel, runner_version: RUNNER_VERSION, captured_at: now });
      await db.run(
        `INSERT INTO evidence (id, code, run_id, task_id, task_version_id, model_id, model_revision, output_text, output_meta, scores, total_score, score_label, runner_version, sha256, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), code, runId, taskId, versionId, model.id, model.revision, `${model.shortName} output.`, JSON.stringify(meta), JSON.stringify(scores), total, scoreLabel, RUNNER_VERSION, sha256, now],
      );
      evidenceCodes.push(code);
    }
  }
  return { taskId, taskCode, versionId, runId, runCode, evidenceCodes, label: `${taskCode} v${version}` };
}

/** A complete, valid review body for the fixture run: Aster 80, Meridian 72, Lumen 64 on the starter rubric. */
export function reviewBody(evidenceCodes: string[], overrides: Record<string, unknown> = {}) {
  const totals = [
    [25, 22, 20, 13],
    [23, 20, 18, 11],
    [20, 18, 16, 10],
  ];
  return {
    assessment: 'The outputs treat the observations as association and say where the evidence stops.',
    rationale: 'Scores follow the rubric: attribution is present, but inhibitor specificity is unaddressed.',
    finding: 'Uphold the ordering for this task. These scores cannot be generalized beyond it.',
    conflictAck: true,
    recommendations: Object.fromEntries(
      evidenceCodes.map((code, index) => [
        code,
        {
          annotation: `Annotation for ${code}: the limits of the evidence are stated.`,
          criteria: (totals[index] as number[]).map((score, i) => ({ score, note: `Note ${i + 1}` })),
        },
      ]),
    ),
    ...overrides,
  };
}

export async function signedIn(test: TestApp, email: string): Promise<Client> {
  return new Client(test).signIn(email);
}

export async function member(test: TestApp, email: string, name?: string): Promise<{ id: string; client: Client }> {
  const id = await makeUser(test, { email, name });
  return { id, client: await signedIn(test, email) };
}

export async function grantCredential(test: TestApp, userId: string, domainId = 'biology'): Promise<string> {
  const id = newId();
  await test.ctx.db.run(`INSERT INTO credentials (id, user_id, domain_id, rationale, granted_at) VALUES (?, ?, ?, 'Test grant', ?)`, [id, userId, domainId, test.ctx.now().toISOString()]);
  return id;
}

export const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

export async function uploadFile(client: Client, bytes: Uint8Array = PDF_BYTES, name = 'phd-certificate.pdf', type = 'application/pdf'): Promise<Response> {
  const form = new FormData();
  form.append('file', new File([bytes as BlobPart], name, { type }));
  return client.request('POST', '/api/uploads', form);
}

/** A complete application body with the given uploaded document. */
export function applicationBody(uploadId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    legalName: 'Dr. Ada Lane',
    institutionalEmail: 'ada@lab.example',
    domainId: 'biology',
    researchBackground: 'PhD in Microbiology; six years studying efflux and susceptibility.',
    evidenceUploadId: uploadId,
    researchProfileUrl: 'orcid.example/0000-0002-1825-0097',
    commitmentAck: true,
    ...overrides,
  };
}
