import type { Hono } from 'hono';
import type {
  EvidenceDetailResponse,
  EvidenceSources,
  PinnedModel,
  RunDetailResponse,
  RunModelState,
  RunReportState,
  RunReviewState,
  RunStartResponse,
  ScoreEntry,
  VerdictDto,
} from '../../shared/types/evaluation.ts';
import type { AppContext, AppEnv, C, UserRow } from '../context.ts';
import {
  accessRow,
  allow,
  datasetLabel,
  evidenceCode,
  hasPrivateAccess,
  latestReviewForRun,
  latestReviewForVersion,
  loadDataset,
  loadTask,
  loadVersion,
  parseJson,
  parseModels,
  parseRubric,
  refuse,
  reviewAction,
  runListItems,
  runVerdict,
  sourceRecords,
  tamperDto,
  verifyEvidence,
  versionLabel,
  type DatasetVersionInfo,
  type EvidenceRow,
  type ModelRow,
  type ReviewRow,
  type RunOutputRow,
  type RunRow,
  type RunStageRow,
  type TaskRow,
  type TaskVersionRow,
} from '../engine/contract.ts';
import { kickEngine } from '../engine/runner.ts';
import { audit } from '../lib/audit.ts';
import { requireVerified } from '../lib/auth.ts';
import { integrityBlockReason } from '../lib/integrity.ts';
import { conflict, forbidden, notFound } from '../lib/errors.ts';
import { evidenceManifest, type EvidenceContent } from '../lib/evidence.ts';
import { newId, nextCounter } from '../lib/ids.ts';
import { canReadDataset, canReadTask, canResumeRun } from '../lib/permissions.ts';

/* ---------- Loading and permission ---------- */

async function readableRun(c: C, code: string): Promise<{ ctx: AppContext; user: UserRow; run: RunRow; task: TaskRow; version: TaskVersionRow }> {
  const ctx = c.get('ctx');
  const user = requireVerified(c);
  const run = await ctx.db.get<RunRow>('SELECT * FROM runs WHERE code = ?', [code]);
  if (!run) throw notFound();
  const task = (await ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [run.task_id])) as TaskRow;
  if (!(await canReadTask(ctx, user, accessRow(task))).allowed) throw notFound();
  const version = (await loadVersion(ctx, run.task_version_id)) as TaskVersionRow;
  return { ctx, user, run, task, version };
}

const ACTIVE: RunRow['status'][] = ['queued', 'running', 'stopping'];

function stopVerdict(user: UserRow, run: RunRow): VerdictDto {
  if (run.owner_id !== user.id) return refuse('Only the task owner can stop a run.');
  if (run.status === 'stopping') return refuse('This run stops after its current checkpoint.');
  if (!ACTIVE.includes(run.status)) return refuse('This run is not executing.');
  return allow;
}

async function resumeVerdict(ctx: AppContext, user: UserRow, run: RunRow, models: PinnedModel[]): Promise<VerdictDto> {
  const owner = canResumeRun(user, run);
  if (!owner.allowed) return refuse(owner.reason);
  if (run.status !== 'interrupted') return refuse('Only an interrupted run can resume.');
  const integrity = await integrityBlockReason(ctx);
  if (integrity) return refuse(integrity);
  // Resume keeps the same revisions, so a model the registry has since disabled can still finish;
  // only a missing credential stops it.
  if (models.some((model) => model.adapter === 'anthropic') && !ctx.config.anthropicKey) return refuse('This run needs a real model, and no Anthropic API key is set on this server.');
  return allow;
}

/** Mirrors what POST /api/reviews refuses, so the button can be disabled with the same reason. */
function requestReviewVerdict(user: UserRow, run: RunRow, review: ReviewRow | undefined, taskLabel: string, quarantined: boolean): VerdictDto {
  if (run.owner_id !== user.id) return refuse('Only the task owner can request expert review.');
  if (run.status !== 'complete') return refuse('This run has not finished. Request review once it is complete.');
  if (review?.status === 'finalized') return refuse(`${taskLabel} already has a finalized review (${review.code}). Revise the task to review a new version.`);
  if (review) return refuse(`${review.code} is already open for ${taskLabel}.`);
  if (quarantined) return refuse('Hash mismatch. Evidence from this run is quarantined, so it cannot go to review.');
  return allow;
}

const REVIEW_LABELS: Record<ReviewRow['status'], string> = {
  requested: 'Expert review requested',
  draft: 'Expert review in progress',
  submitted: 'Awaiting adjudication',
  returned: 'Returned to the expert',
  finalized: 'Expert review finalized',
};

/* ---------- Execution lines ---------- */

function executionLine(run: RunRow, doneStages: number, isCurrent: boolean, code: string | null): string {
  const interrupted = run.status === 'interrupted' || run.status === 'failed';
  if (doneStages >= 3) return interrupted ? `Output and score complete · ${code} sealed` : `Output captured · Scored · ${code} sealed`;
  if (interrupted) {
    if (doneStages === 2) return 'Output and score preserved · Sealing interrupted';
    if (doneStages === 1) return 'Output preserved · Scoring interrupted';
    return 'Not started · Still queued';
  }
  if (doneStages === 2) return 'Output captured · Scored · Sealing in progress';
  if (doneStages === 1) return 'Output captured · Scoring in progress';
  return isCurrent && run.status !== 'queued' ? 'Output capture in progress' : 'Queued · Waiting for worker';
}

export function registerRuns(app: Hono<AppEnv>) {
  /* ----- Start and list, per task ----- */

  app.post('/api/tasks/:code/runs', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const task = await loadTask(ctx, c.req.param('code'));
    if (!task || !(await canReadTask(ctx, user, accessRow(task))).allowed) throw notFound();

    const version = await loadVersion(ctx, task.latest_version_id);
    const verdict = await runVerdict(ctx, user, task, version);
    if (!verdict.allowed) {
      if (task.owner_id !== user.id) throw forbidden(verdict.reason);
      throw conflict(verdict.reason, 'run_blocked');
    }
    const contract = version as TaskVersionRow;
    const models = parseModels(contract.models);
    const now = ctx.now().toISOString();

    const code = await ctx.db.tx(async () => {
      const number = await nextCounter(ctx.db, 'run', 1001);
      const runCode = `RUN-${number}`;
      const runId = newId();
      await ctx.db.run(
        `INSERT INTO runs (id, code, task_id, task_version_id, owner_id, status, stages_total, stages_done, attempt, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, 1, ?)`,
        [runId, runCode, task.id, contract.id, user.id, models.length * 3, now],
      );
      let seq = 1;
      for (const model of models) {
        for (const kind of ['output', 'score', 'seal'] as const) {
          await ctx.db.run(`INSERT INTO run_stages (id, run_id, model_id, seq, kind, status, attempt) VALUES (?, ?, ?, ?, ?, 'pending', 0)`, [newId(), runId, model.id, seq, kind]);
          seq += 1;
        }
      }
      await audit(ctx, { actorId: user.id, action: 'run.started', subjectType: 'run', subjectId: runId, subjectCode: runCode, workspaceId: task.workspace_id, detail: { task: versionLabel(task.code, contract.version), models: models.map((model) => model.revision) } });
      return runCode;
    });
    kickEngine(ctx);
    const body: RunStartResponse = { code };
    return c.json(body, 201);
  });

  app.get('/api/tasks/:code/runs', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const task = await loadTask(ctx, c.req.param('code'));
    if (!task || !(await canReadTask(ctx, user, accessRow(task))).allowed) throw notFound();
    return c.json({ items: await runListItems(ctx, task) });
  });

  /* ----- The run page ----- */

  app.get('/api/runs/:code', async (c) => {
    const { ctx, user, run, task, version } = await readableRun(c, c.req.param('code'));
    const models = parseModels(version.models);
    const rubric = parseRubric(version.rubric);
    const taskLabel = versionLabel(task.code, version.version);

    const stages = await ctx.db.all<RunStageRow>('SELECT * FROM run_stages WHERE run_id = ? ORDER BY seq', [run.id]);
    const outputs = await ctx.db.all<RunOutputRow>('SELECT * FROM run_outputs WHERE run_id = ?', [run.id]);
    const evidenceRows = await ctx.db.all<EvidenceRow>('SELECT * FROM evidence WHERE run_id = ? ORDER BY captured_at, rowid', [run.id]);
    const log = await ctx.db.all<{ at: string; message: string }>('SELECT at, message FROM run_log WHERE run_id = ? ORDER BY seq', [run.id]);
    const owner = await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [run.owner_id]);
    const dataset = await loadDataset(ctx, version.dataset_version_id);

    const firstPending = stages.find((stage) => stage.status !== 'done');

    // Each sealed artifact is re-verified on this request. Nothing below may claim otherwise.
    const verified = new Map<string, boolean>();
    for (const row of evidenceRows) verified.set(row.model_id, await verifyEvidence(ctx, row));

    const modelStates: RunModelState[] = models.map((model) => {
      const done = stages.filter((stage) => stage.model_id === model.id && stage.status === 'done').length;
      const evidence = evidenceRows.find((row) => row.model_id === model.id);
      const output = outputs.find((row) => row.model_id === model.id);
      const code = evidence?.code ?? evidenceCode(run.code, models, model.id);
      return {
        id: model.id,
        displayName: model.displayName,
        shortName: model.shortName,
        revision: model.revision,
        adapter: model.adapter,
        stagesDone: done,
        execution: executionLine(run, done, firstPending?.model_id === model.id, code),
        evidenceCode: evidence?.code ?? null,
        evidenceVerified: evidence ? (verified.get(model.id) as boolean) : null,
        score: evidence?.total_score ?? output?.total_score ?? null,
        scoreLabel: evidence?.score_label ?? output?.score_label ?? null,
      };
    });

    const scoresByModel = models.map((model) => {
      const row = evidenceRows.find((item) => item.model_id === model.id)?.scores ?? outputs.find((item) => item.model_id === model.id)?.scores;
      return parseJson<ScoreEntry[]>(row, []);
    });
    const rubricRows = rubric.map((criterion) => ({
      name: criterion.name,
      short: criterion.short || criterion.name,
      points: criterion.points,
      scores: scoresByModel.map((scores) => scores.find((entry) => entry.name === criterion.name)?.score ?? null),
    }));

    // One review covers a whole frozen version, so a later run of it can show a review from an earlier one.
    const review = await latestReviewForVersion(ctx, version.id);
    const reviewedRun = review && review.run_id !== run.id ? await ctx.db.get<{ code: string }>('SELECT code FROM runs WHERE id = ?', [review.run_id]) : undefined;
    const reviewState: RunReviewState | null = review ? { code: review.code, status: review.status, label: reviewedRun ? `${REVIEW_LABELS[review.status]} on ${reviewedRun.code}` : REVIEW_LABELS[review.status], href: `/review/${review.code}` } : null;
    const reportRow = await ctx.db.get<{ code: string; version: string }>('SELECT code, version FROM reports WHERE run_id = ? ORDER BY frozen_at DESC, rowid DESC LIMIT 1', [run.id]);
    const report: RunReportState | null = reportRow ? { code: reportRow.code, version: reportRow.version, label: `${reportRow.code} v${reportRow.version}`, href: `/reports/${reportRow.code}/v${reportRow.version}` } : null;

    const labels = new Set(modelStates.map((model) => model.scoreLabel).filter(Boolean));
    const limits = 'n = 1 task; no population confidence interval is estimated.';
    const resultsNote = labels.size > 1 ? `Mixed scoring: demo scores are synthetic and judge scores come from an LLM judge, not an expert. ${limits}` : labels.has('judge') ? `LLM judge scores, not expert findings. ${limits}` : `Synthetic demo scores. ${limits}`;

    const settingsNotes = [
      ...new Set(
        outputs.flatMap((row) => {
          const meta = parseJson<{ settingsNotes?: string[] }>(row.output_meta, {});
          return meta.settingsNotes ?? [];
        }),
      ),
    ];

    const nowMs = ctx.now().getTime();
    const elapsedMs = run.active_ms + (run.active_since ? Math.max(0, nowMs - new Date(run.active_since).getTime()) : 0);
    const firstEvidence = evidenceRows.find((row) => !verified.get(row.model_id)) ?? evidenceRows[0];
    const quarantined = evidenceRows.filter((row) => !verified.get(row.model_id)).map((row) => row.code);

    const body: RunDetailResponse = {
      code: run.code,
      status: run.status,
      interruptReason: run.interrupt_reason,
      interruptMessage: run.interrupt_message,
      interruptedAt: run.interrupted_at,
      stagesTotal: run.stages_total,
      stagesDone: run.stages_done,
      percent: run.stages_total ? Math.round((run.stages_done / run.stages_total) * 100) : 0,
      attempt: run.attempt,
      checkpointCode: run.last_checkpoint_code,
      checkpointAt: run.last_checkpoint_at,
      elapsedMs,
      serverNow: new Date(nowMs).toISOString(),
      task: { code: task.code, title: version.title, version: version.version, label: taskLabel, sourcePack: dataset ? datasetLabel(dataset) : null },
      ownerName: owner?.name ?? '',
      isOwner: run.owner_id === user.id,
      models: modelStates,
      // The log records what was true at sealing. It may not read as a current claim about a mismatched artifact.
      log: log.map((line) => (quarantined.some((code) => line.message === `${code} hash verified`) ? { at: line.at, message: line.message.replace(' hash verified', ' sealed. Its stored bytes no longer match this seal') } : line)),
      tamper: firstEvidence ? await tamperDto(ctx, firstEvidence, run.code, taskLabel) : null,
      sealedCount: evidenceRows.length,
      quarantined,
      rubric: rubricRows,
      consequentialDifference: run.consequential_difference,
      resultsNote,
      settingsNotes,
      review: reviewState,
      report,
      verdicts: {
        stop: stopVerdict(user, run),
        resume: await resumeVerdict(ctx, user, run, models),
        requestReview: requestReviewVerdict(user, run, review, taskLabel, quarantined.length > 0),
      },
      reviewAction: await reviewAction(ctx, user, task, 'Review this task', version.id),
    };
    return c.json(body);
  });

  /* ----- Stop after checkpoint ----- */

  app.post('/api/runs/:code/stop', async (c) => {
    const { ctx, user, run, task } = await readableRun(c, c.req.param('code'));
    const verdict = stopVerdict(user, run);
    if (!verdict.allowed) {
      if (run.owner_id !== user.id) throw forbidden(verdict.reason);
      throw conflict(verdict.reason, 'not_running');
    }
    await ctx.db.tx(async () => {
      const changed = await ctx.db.run(`UPDATE runs SET status = 'stopping' WHERE id = ? AND status IN ('queued', 'running')`, [run.id]);
      if (changed.changes === 0) throw conflict('This run has already finished.', 'not_running');
      await audit(ctx, { actorId: user.id, action: 'run.stop_requested', subjectType: 'run', subjectId: run.id, subjectCode: run.code, workspaceId: task.workspace_id, detail: { stagesDone: run.stages_done } });
    });
    kickEngine(ctx);
    return c.json({ status: 'stopping' });
  });

  /* ----- Resume ----- */

  app.post('/api/runs/:code/resume', async (c) => {
    const { ctx, user, run, task, version } = await readableRun(c, c.req.param('code'));
    const verdict = await resumeVerdict(ctx, user, run, parseModels(version.models));
    if (!verdict.allowed) {
      if (run.owner_id !== user.id) throw forbidden(verdict.reason);
      throw conflict(verdict.reason, 'not_resumable');
    }
    const attempt = await ctx.db.tx(async () => {
      const current = (await ctx.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [run.id])) as RunRow;
      if (current.status !== 'interrupted') throw conflict('Only an interrupted run can resume.', 'not_resumable');
      const next = current.attempt + 1;
      await ctx.db.run(`UPDATE runs SET status = 'queued', attempt = ?, interrupt_reason = NULL, interrupt_message = NULL, interrupted_at = NULL WHERE id = ?`, [next, run.id]);
      await audit(ctx, { actorId: user.id, action: 'run.resumed', subjectType: 'run', subjectId: run.id, subjectCode: run.code, workspaceId: task.workspace_id, detail: { attempt: next, fromCheckpoint: current.last_checkpoint_code, stagesDone: current.stages_done, interruptedBy: current.interrupt_reason } });
      return next;
    });
    kickEngine(ctx);
    return c.json({ status: 'queued', attempt });
  });

  /* ----- Evidence ----- */

  interface EvidenceContext {
    ctx: AppContext;
    user: UserRow;
    row: EvidenceRow;
    run: RunRow;
    task: TaskRow;
    version: TaskVersionRow;
    dataset: DatasetVersionInfo | undefined;
    sourcesVisible: boolean;
  }

  async function readableEvidence(c: C, code: string): Promise<EvidenceContext> {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const row = await ctx.db.get<EvidenceRow>('SELECT * FROM evidence WHERE code = ?', [code]);
    if (!row) throw notFound();
    const task = (await ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [row.task_id])) as TaskRow;
    if (!(await canReadTask(ctx, user, accessRow(task))).allowed) throw notFound();
    const run = (await ctx.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [row.run_id])) as RunRow;
    const version = (await loadVersion(ctx, row.task_version_id)) as TaskVersionRow;
    const dataset = await loadDataset(ctx, version.dataset_version_id);
    // A shared task does not open its private source pack: that takes membership, a review, or a shared dataset.
    const sourcesVisible = dataset ? (await hasPrivateAccess(ctx, user, task)) || (await canReadDataset(ctx, user, { workspace_id: dataset.workspace_id, visibility: dataset.visibility, deleted_at: dataset.deleted_at })).allowed : false;
    return { ctx, user, row, run, task, version, dataset, sourcesVisible };
  }

  function evidenceSources({ dataset, sourcesVisible, task }: Pick<EvidenceContext, 'dataset' | 'sourcesVisible' | 'task'>, workspaceName: string): EvidenceSources {
    if (!dataset) return { state: 'none', label: null, datasetCode: null, sha256: null, records: [], note: 'No source pack is pinned to this version.' };
    const base = { label: datasetLabel(dataset), datasetCode: dataset.code, sha256: dataset.sha256 };
    if (!sourcesVisible) return { ...base, state: 'hidden', records: [], note: `These source records are private to ${workspaceName}. Sharing a task does not open its source pack.` };
    const records = sourceRecords(dataset.records);
    if (records.length === 0) return { ...base, state: 'unparsed', records: [], note: `${dataset.filename} is pinned as a file with no parsed records.` };
    return {
      ...base,
      state: 'visible',
      records: records.map((record) => ({ id: record.id, label: record.label, observation: record.observation })),
      note: dataset.deleted_at ? 'This dataset was removed from the library. The frozen snapshot is retained for audit.' : null,
    };
  }

  app.get('/api/evidence/:code', async (c) => {
    const context = await readableEvidence(c, c.req.param('code'));
    const { ctx, row, run, task, version } = context;
    const model = parseModels(version.models).find((item) => item.id === row.model_id);
    const taskLabel = versionLabel(task.code, version.version);
    const workspace = await ctx.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [task.workspace_id]);
    const meta = parseJson<{ synthetic?: boolean; settingsNotes?: string[] }>(row.output_meta, {});

    const submitted = await ctx.db.get<{ code: string; recommendations: string }>(`SELECT code, recommendations FROM reviews WHERE run_id = ? AND status IN ('submitted', 'finalized') ORDER BY created_at DESC, rowid DESC LIMIT 1`, [run.id]);
    const annotationText = submitted ? parseJson<Record<string, { annotation?: string }>>(submitted.recommendations, {})[row.code]?.annotation?.trim() : undefined;
    const openReview = await latestReviewForRun(ctx, run.id);

    const body: EvidenceDetailResponse = {
      code: row.code,
      runCode: run.code,
      task: { code: task.code, version: version.version, label: taskLabel },
      model: { id: row.model_id, displayName: model?.displayName ?? row.model_id, shortName: model?.shortName ?? row.model_id, revision: row.model_revision },
      outputText: row.output_text,
      scores: parseJson<ScoreEntry[]>(row.scores, []),
      totalScore: row.total_score,
      scoreLabel: row.score_label,
      synthetic: Boolean(meta.synthetic),
      settingsNotes: meta.settingsNotes ?? [],
      sources: evidenceSources(context, workspace?.name ?? 'this workspace'),
      annotation: submitted && annotationText ? { text: annotationText, reviewCode: submitted.code } : null,
      annotationEmpty: submitted ? `${submitted.code} did not annotate this output.` : openReview ? `${openReview.code} has not been submitted yet, so no expert has annotated this output.` : 'No expert has reviewed this output yet. An annotation appears here once a review is submitted.',
      tamper: await tamperDto(ctx, row, run.code, taskLabel),
      downloadUrl: `/api/evidence/${row.code}/download`,
    };
    return c.json(body);
  });

  /** A real file: the manifest the seal covers, plus the contract and what was verified on this request. */
  app.get('/api/evidence/:code/download', async (c) => {
    const context = await readableEvidence(c, c.req.param('code'));
    const { ctx, user, row, run, task, version, dataset } = context;
    const verified = await verifyEvidence(ctx, row);
    const content: EvidenceContent = {
      code: row.code,
      run_code: run.code,
      task_version_hash: version.sha256,
      model_id: row.model_id,
      model_revision: row.model_revision,
      output_text: row.output_text,
      output_meta: parseJson<unknown>(row.output_meta, {}),
      scores: parseJson<unknown>(row.scores, []),
      total_score: row.total_score,
      score_label: row.score_label,
      runner_version: row.runner_version,
      captured_at: row.captured_at,
    };
    const workspace = await ctx.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [task.workspace_id]);
    const sources = evidenceSources(context, workspace?.name ?? 'this workspace');
    const file = {
      schema: 'rivet.evidence_download.v1',
      manifest: evidenceManifest(content),
      sha256: row.sha256,
      verification: {
        algorithm: 'SHA-256 of the manifest as canonical JSON (sorted keys, no whitespace)',
        verified,
        checkedAt: ctx.now().toISOString(),
        statement: verified ? 'The stored bytes match this seal. Hash integrity does not establish truth.' : 'Hash mismatch: the stored bytes differ from this seal. Do not use this artifact for scoring.',
      },
      taskVersion: {
        label: versionLabel(task.code, version.version),
        sha256: version.sha256,
        title: version.title,
        prompt: version.prompt,
        rubric: parseJson<unknown>(version.rubric, []),
        models: parseJson<unknown>(version.models, []),
        settings: parseJson<unknown>(version.settings, {}),
        frozenAt: version.frozen_at,
      },
      sources: { label: sources.label, sha256: sources.sha256, state: sources.state, records: sources.records, note: sources.note },
      labels: { score: row.score_label, synthetic: Boolean(parseJson<{ synthetic?: boolean }>(row.output_meta, {}).synthetic) },
    };
    await audit(ctx, { actorId: user.id, action: 'evidence.downloaded', subjectType: 'evidence', subjectId: row.id, subjectCode: row.code, workspaceId: task.workspace_id, detail: { verified, dataset: dataset ? datasetLabel(dataset) : null } });
    return new Response(JSON.stringify(file, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${row.code}.json"` },
    });
  });
}
