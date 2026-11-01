import type { PinnedModel, ScoreEntry } from '../../shared/types/evaluation.ts';
import type { AppContext } from '../context.ts';
import { audit } from '../lib/audit.ts';
import { RUNNER_VERSION, evidenceHash } from '../lib/evidence.ts';
import { newId, pad3 } from '../lib/ids.ts';
import { ProviderRejectedError, ProviderTimeoutError, ProviderUnavailableError, type FrozenTask, type ModelAdapter } from './adapters.ts';
import { createAnthropicAdapter } from './anthropicAdapter.ts';
import {
  ANTHROPIC_MODEL_ID,
  evidenceCode,
  loadDataset,
  parseModels,
  parseRubric,
  parseSettings,
  sourceRecords,
  verifyEvidence,
  versionLabel,
  type EvidenceRow,
  type RunOutputRow,
  type RunRow,
  type RunStageRow,
  type SourceRecord,
  type TaskVersionRow,
} from './contract.ts';
import { demoAdapter } from './demoAdapter.ts';
import { AUTHORED_CONSEQUENTIAL } from './demoStory.ts';

/**
 * The in-process run worker. A run is models × (capture output, score, seal). Provider calls happen
 * outside transactions; each result is committed with its stage, checkpoint, log line and counters
 * in one transaction, so a crash can only lose work that was never committed.
 *
 * The database is the queue: runs stay `queued` until a worker slot takes them, and a stop request is
 * just a status the worker reads between stages.
 */

const MAX_CONCURRENT_RUNS = 4;

interface EngineState {
  active: Map<string, Promise<void>>;
  adapterOverride: ((model: PinnedModel) => ModelAdapter | null) | null;
  anthropic: ModelAdapter | null;
}

const engines = new WeakMap<AppContext, EngineState>();

function engineFor(ctx: AppContext): EngineState {
  let state = engines.get(ctx);
  if (!state) {
    state = { active: new Map(), adapterOverride: null, anthropic: null };
    engines.set(ctx, state);
  }
  return state;
}

function adapterFor(ctx: AppContext, model: PinnedModel): ModelAdapter {
  const state = engineFor(ctx);
  const override = state.adapterOverride?.(model);
  if (override) return override;
  if (model.adapter === 'anthropic') {
    state.anthropic ??= createAnthropicAdapter(ctx);
    return state.anthropic;
  }
  return demoAdapter;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const utcTime = (date: Date) => date.toISOString().slice(11, 16) + ' UTC';

const isDbClosed = (error: unknown) => error instanceof Error && /database is not open|not open/i.test(error.message);

/* ---------- Commits ---------- */

async function log(ctx: AppContext, runId: string, message: string, at: string): Promise<void> {
  const row = await ctx.db.get<{ next: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_log WHERE run_id = ?', [runId]);
  await ctx.db.run('INSERT INTO run_log (id, run_id, at, message, seq) VALUES (?, ?, ?, ?, ?)', [newId(), runId, at, message, row?.next ?? 1]);
}

/** Brings active_ms up to date. */
function activeClock(run: RunRow, nowMs: number): { activeMs: number } {
  const since = run.active_since ? new Date(run.active_since).getTime() : nowMs;
  return { activeMs: run.active_ms + Math.max(0, nowMs - since) };
}

async function interruptRun(ctx: AppContext, runId: string, reason: NonNullable<RunRow['interrupt_reason']>, cause?: string): Promise<void> {
  const nowDate = ctx.now();
  const now = nowDate.toISOString();
  const time = utcTime(nowDate);
  await ctx.db.tx(async () => {
    const run = await ctx.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [runId]);
    if (!run || ['interrupted', 'complete', 'failed'].includes(run.status)) return;
    const { activeMs } = activeClock(run, nowDate.getTime());
    const checkpoint = run.last_checkpoint_code;
    const safe = checkpoint ? `Safe checkpoint at ${checkpoint}` : 'No stage had been committed';
    const lead =
      reason === 'owner_stop'
        ? { alert: `Stopped by the owner at ${time}.`, line: `Stopped by the owner. ${safe}; owner can resume` }
        : reason === 'server_restart'
          ? { alert: `Server restart at ${time}.`, line: `Server restarted. ${safe}; owner can resume` }
          : cause
            ? { alert: `Provider unavailable at ${time}. ${cause}`, line: `Provider unavailable. ${safe}; owner can resume` }
            : { alert: `Provider timeout at ${time}.`, line: `Provider timeout. ${safe}; owner can resume` };
    await ctx.db.run(
      `UPDATE runs SET status = 'interrupted', interrupt_reason = ?, interrupt_message = ?, interrupted_at = ?, active_ms = ?, active_since = NULL WHERE id = ?`,
      [reason, `${lead.alert} No evidence lost. Resume only incomplete work.`, now, activeMs, runId],
    );
    await ctx.db.run(`UPDATE run_stages SET status = 'pending', started_at = NULL WHERE run_id = ? AND status = 'running'`, [runId]);
    await log(ctx, runId, lead.line, now);
    await audit(ctx, { actorId: null, action: 'run.interrupted', subjectType: 'run', subjectId: runId, subjectCode: run.code, detail: { reason, checkpoint, stagesDone: run.stages_done } });
  });
}

async function failRun(ctx: AppContext, runId: string, message: string): Promise<void> {
  const nowDate = ctx.now();
  const now = nowDate.toISOString();
  await ctx.db.tx(async () => {
    const run = await ctx.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [runId]);
    if (!run || ['interrupted', 'complete', 'failed'].includes(run.status)) return;
    const { activeMs } = activeClock(run, nowDate.getTime());
    await ctx.db.run(`UPDATE runs SET status = 'failed', interrupt_message = ?, finished_at = ?, active_ms = ?, active_since = NULL WHERE id = ?`, [message, now, activeMs, runId]);
    await ctx.db.run(`UPDATE run_stages SET status = 'pending', started_at = NULL WHERE run_id = ? AND status = 'running'`, [runId]);
    await log(ctx, runId, `Run stopped: ${message}`, now);
    await audit(ctx, { actorId: null, action: 'run.failed', subjectType: 'run', subjectId: runId, subjectCode: run.code, detail: { message, stagesDone: run.stages_done } });
  });
}

/** Everything one stage changes, in one transaction. `work` adds the stage's own artifact. */
async function commitStage(ctx: AppContext, run: RunRow, stage: RunStageRow, lines: string[], work: () => Promise<void>): Promise<void> {
  const nowDate = ctx.now();
  const now = nowDate.toISOString();
  await ctx.db.tx(async () => {
    const current = await ctx.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [run.id]);
    if (!current) throw new Error(`Run ${run.code} disappeared.`);
    // A worker that outlived its run (a restart recovered it meanwhile) must not write anything.
    if (current.status !== 'running' && current.status !== 'stopping') return;
    await work();
    const changed = await ctx.db.run(`UPDATE run_stages SET status = 'done', attempt = ?, finished_at = ? WHERE id = ? AND status <> 'done'`, [current.attempt, now, stage.id]);
    if (changed.changes === 0) return; // Already committed; completed work is never replaced.
    const done = current.stages_done + 1;
    const code = `CP-${pad3(done)}`;
    await ctx.db.run('INSERT INTO checkpoints (id, run_id, code, stages_done, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?)', [newId(), run.id, code, done, current.attempt, now]);
    for (const line of lines) await log(ctx, run.id, line, now);
    const { activeMs } = activeClock(current, nowDate.getTime());
    await ctx.db.run('UPDATE runs SET stages_done = ?, last_checkpoint_code = ?, last_checkpoint_at = ?, active_ms = ?, active_since = ? WHERE id = ?', [done, code, now, activeMs, now, run.id]);
    // Whole models are the natural resume points, so those checkpoints are written to the log.
    if (stage.kind === 'seal' && done < current.stages_total) await log(ctx, run.id, `${code} committed`, now);
  });
}

async function completeRun(ctx: AppContext, run: RunRow, models: PinnedModel[]): Promise<void> {
  const nowDate = ctx.now();
  const now = nowDate.toISOString();
  const difference = await consequentialDifference(ctx, run.id, models);
  await ctx.db.tx(async () => {
    const current = await ctx.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [run.id]);
    if (!current || current.status === 'complete') return;
    const { activeMs } = activeClock(current, nowDate.getTime());
    await ctx.db.run(
      `UPDATE runs SET status = 'complete', finished_at = ?, active_ms = ?, active_since = NULL, consequential_difference = COALESCE(consequential_difference, ?) WHERE id = ?`,
      [now, activeMs, difference, run.id],
    );
    await log(ctx, run.id, `${current.last_checkpoint_code} committed. Run complete`, now);
    await audit(ctx, { actorId: current.owner_id, action: 'run.completed', subjectType: 'run', subjectId: run.id, subjectCode: run.code, detail: { attempts: current.attempt, stages: current.stages_total } });
  });
}

/* ---------- The consequential difference, from the actual scores ---------- */

export async function consequentialDifference(ctx: AppContext, runId: string, models: PinnedModel[]): Promise<string | null> {
  const rows = await ctx.db.all<RunOutputRow>('SELECT * FROM run_outputs WHERE run_id = ?', [runId]);
  const parsedMeta = rows.map((row) => JSON.parse(row.score_meta ?? '{}') as { authored?: boolean });
  const aster = rows.find((row) => row.model_id === 'aster-3.2');
  if (aster && rows.length > 1 && parsedMeta.every((meta) => meta.authored)) return AUTHORED_CONSEQUENTIAL;

  const scored = models
    .map((model) => {
      const row = rows.find((item) => item.model_id === model.id);
      return row && row.scores ? { model, total: row.total_score ?? 0, label: row.score_label ?? 'demo', scores: JSON.parse(row.scores) as ScoreEntry[] } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.total - a.total);
  const top = scored[0];
  const bottom = scored[scored.length - 1];
  if (!top || !bottom || scored.length < 2) return null;

  if (top.total === bottom.total) {
    return `All ${scored.length} models scored ${top.total} / 100 ${top.label}. No total separates them on this task; compare the rubric lines and the evidence.`;
  }

  // The criterion with the widest gap between the highest and lowest totals.
  let widest: { short: string; points: number; high: number; low: number; rationale: string } | null = null;
  for (const entry of top.scores) {
    const other = bottom.scores.find((item) => item.name === entry.name);
    if (!other) continue;
    if (!widest || entry.score - other.score > widest.high - widest.low) widest = { short: entry.short || entry.name, points: entry.points, high: entry.score, low: other.score, rationale: other.rationale };
  }
  const lead = `${top.model.shortName} scored highest at ${top.total} / 100 ${top.label}; ${bottom.model.shortName} scored lowest at ${bottom.total} / 100 ${bottom.label}.`;
  if (!widest || widest.high <= widest.low) return lead;
  // The scorer writes "−17: reason. −3: reason." Here the gap already states the size.
  const reason = widest.rationale.replace(/−\d+: /g, '');
  return `${lead} The widest gap is ${widest.short}: ${widest.high} against ${widest.low} of ${widest.points}. ${bottom.model.shortName}: ${reason}`;
}

/* ---------- The worker ---------- */

interface RunContext {
  run: RunRow;
  version: TaskVersionRow;
  task: FrozenTask;
  taskCode: string;
  models: PinnedModel[];
  records: SourceRecord[];
}

async function loadRunContext(ctx: AppContext, run: RunRow): Promise<RunContext> {
  const version = await ctx.db.get<TaskVersionRow>('SELECT * FROM task_versions WHERE id = ?', [run.task_version_id]);
  const taskRow = await ctx.db.get<{ code: string }>('SELECT code FROM tasks WHERE id = ?', [run.task_id]);
  if (!version || !taskRow) throw new Error(`Run ${run.code} has no frozen contract.`);
  const dataset = await loadDataset(ctx, version.dataset_version_id);
  return {
    run,
    version,
    taskCode: taskRow.code,
    task: { code: taskRow.code, version: version.version, title: version.title, prompt: version.prompt, rubric: parseRubric(version.rubric), settings: parseSettings(version.settings) },
    models: parseModels(version.models),
    records: sourceRecords(dataset?.records),
  };
}

async function runOutputStage(ctx: AppContext, context: RunContext, stage: RunStageRow, model: PinnedModel, adapter: ModelAdapter): Promise<void> {
  const result = await adapter.generate({ task: context.task, model, records: context.records });
  await commitStage(ctx, context.run, stage, [`${model.shortName} output captured`], async () => {
    await ctx.db.run(`INSERT INTO run_outputs (run_id, model_id, output_text, output_meta) VALUES (?, ?, ?, ?) ON CONFLICT (run_id, model_id) DO NOTHING`, [context.run.id, model.id, result.text, JSON.stringify(result.meta)]);
  });
}

async function runScoreStage(ctx: AppContext, context: RunContext, stage: RunStageRow, model: PinnedModel, adapter: ModelAdapter): Promise<void> {
  const row = await ctx.db.get<RunOutputRow>('SELECT * FROM run_outputs WHERE run_id = ? AND model_id = ?', [context.run.id, model.id]);
  if (!row?.output_text) throw new Error(`No captured output for ${model.displayName}.`);
  const result = await adapter.score({ task: context.task, model, records: context.records, output: row.output_text });
  await commitStage(ctx, context.run, stage, [`${model.shortName} rubric score committed`], async () => {
    await ctx.db.run(`UPDATE run_outputs SET scores = ?, total_score = ?, score_label = ?, score_meta = ? WHERE run_id = ? AND model_id = ? AND scores IS NULL`, [JSON.stringify(result.scores), result.total, result.label, JSON.stringify(result.meta), context.run.id, model.id]);
  });
}

async function runSealStage(ctx: AppContext, context: RunContext, stage: RunStageRow, model: PinnedModel): Promise<void> {
  const row = await ctx.db.get<RunOutputRow>('SELECT * FROM run_outputs WHERE run_id = ? AND model_id = ?', [context.run.id, model.id]);
  if (!row?.output_text || !row.scores || row.total_score === null || !row.score_label) throw new Error(`Nothing to seal for ${model.displayName}.`);
  const code = evidenceCode(context.run.code, context.models, model.id);
  const capturedAt = ctx.now().toISOString();
  const outputMeta = { ...(JSON.parse(row.output_meta ?? '{}') as Record<string, unknown>), scoring: JSON.parse(row.score_meta ?? '{}') as Record<string, unknown> };
  const scores = JSON.parse(row.scores) as ScoreEntry[];
  const sha256 = evidenceHash({
    code,
    run_code: context.run.code,
    task_version_hash: context.version.sha256,
    model_id: model.id,
    model_revision: model.revision,
    output_text: row.output_text,
    output_meta: outputMeta,
    scores,
    total_score: row.total_score,
    score_label: row.score_label,
    runner_version: RUNNER_VERSION,
    captured_at: capturedAt,
  });
  await commitStage(ctx, context.run, stage, [`${code} hash verified`], async () => {
    await ctx.db.run(
      `INSERT INTO evidence (id, code, run_id, task_id, task_version_id, model_id, model_revision, output_text, output_meta, scores, total_score, score_label, runner_version, sha256, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, model_id) DO NOTHING`,
      [newId(), code, context.run.id, context.run.task_id, context.run.task_version_id, model.id, model.revision, row.output_text, JSON.stringify(outputMeta), row.scores, row.total_score, row.score_label, RUNNER_VERSION, sha256, capturedAt],
    );
    const sealed = await ctx.db.get<EvidenceRow>('SELECT * FROM evidence WHERE run_id = ? AND model_id = ?', [context.run.id, model.id]);
    if (!sealed || !(await verifyEvidence(ctx, sealed))) throw new Error(`${code} failed verification immediately after sealing.`);
  });
}

async function takeRun(ctx: AppContext, runId: string): Promise<RunRow | null> {
  const nowDate = ctx.now();
  const now = nowDate.toISOString();
  return ctx.db.tx(async () => {
    const run = await ctx.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [runId]);
    if (!run) return null;
    if (run.status === 'stopping' || run.status === 'running') return run;
    if (run.status !== 'queued') return null;
    await ctx.db.run(`UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?), active_since = ? WHERE id = ?`, [now, now, runId]);
    const version = await ctx.db.get<{ version: string }>('SELECT version FROM task_versions WHERE id = ?', [run.task_version_id]);
    const task = await ctx.db.get<{ code: string }>('SELECT code FROM tasks WHERE id = ?', [run.task_id]);
    const line =
      run.attempt === 1 && !run.last_checkpoint_code
        ? `Attempt 1 started on the frozen ${versionLabel(task?.code ?? '', version?.version ?? '')} contract`
        : `Attempt ${run.attempt} started from ${run.last_checkpoint_code ?? 'the first stage'}. Only unfinished stages are retried`;
    await log(ctx, runId, line, now);
    return { ...run, status: 'running', active_since: now };
  });
}

async function workRun(ctx: AppContext, runId: string): Promise<void> {
  const taken = await takeRun(ctx, runId);
  if (!taken) return;
  const context = await loadRunContext(ctx, taken);

  for (;;) {
    const run = await ctx.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [runId]);
    if (!run || !['running', 'stopping'].includes(run.status)) return;
    context.run = run;

    const stage = await ctx.db.get<RunStageRow>(`SELECT * FROM run_stages WHERE run_id = ? AND status <> 'done' ORDER BY seq LIMIT 1`, [runId]);
    if (!stage) {
      await completeRun(ctx, run, context.models);
      return;
    }
    if (run.status === 'stopping') {
      await interruptRun(ctx, runId, 'owner_stop');
      return;
    }

    const model = context.models.find((item) => item.id === stage.model_id);
    if (!model) throw new Error(`Stage ${stage.seq} names a model outside the frozen contract.`);
    const adapter = adapterFor(ctx, model);

    const startedAt = ctx.now().toISOString();
    await ctx.db.run(`UPDATE run_stages SET status = 'running', started_at = ? WHERE id = ?`, [startedAt, stage.id]);
    if (stage.kind === 'score') await log(ctx, runId, 'Rubric scoring started', startedAt);
    if (adapter.paced && ctx.config.stageMs > 0) await sleep(ctx.config.stageMs);

    if (stage.kind === 'output') await runOutputStage(ctx, context, stage, model, adapter);
    else if (stage.kind === 'score') await runScoreStage(ctx, context, stage, model, adapter);
    else await runSealStage(ctx, context, stage, model);
  }
}

function startWorker(ctx: AppContext, runId: string): void {
  const state = engineFor(ctx);
  const work = (async () => {
    try {
      await workRun(ctx, runId);
    } catch (error) {
      if (isDbClosed(error)) return;
      try {
        if (error instanceof ProviderTimeoutError) await interruptRun(ctx, runId, 'provider_timeout');
        else if (error instanceof ProviderUnavailableError) await interruptRun(ctx, runId, 'provider_timeout', error.message);
        else if (error instanceof ProviderRejectedError) await failRun(ctx, runId, error.message);
        else {
          console.error(`[run ${runId}]`, error);
          await failRun(ctx, runId, 'The run worker hit an unexpected error. Committed stages and sealed evidence are preserved.');
        }
      } catch (inner) {
        if (!isDbClosed(inner)) console.error(`[run ${runId}]`, inner);
      }
    }
  })().finally(() => {
    state.active.delete(runId);
    kickEngine(ctx);
  });
  state.active.set(runId, work);
}

/** Starts a worker for each waiting run while there is room. Safe to call at any time. */
export function kickEngine(ctx: AppContext): void {
  const state = engineFor(ctx);
  void ctx.db
    .all<{ id: string }>(`SELECT id FROM runs WHERE status IN ('queued', 'running', 'stopping') ORDER BY created_at, rowid`)
    .then((rows) => {
      for (const row of rows) {
        if (state.active.size >= MAX_CONCURRENT_RUNS) break;
        if (!state.active.has(row.id)) startWorker(ctx, row.id);
      }
    })
    .catch((error) => {
      if (!isDbClosed(error)) console.error('[engine]', error);
    });
}

/* ---------- Boot ---------- */

/**
 * Makes real models selectable when a key is set. An evaluation compares 2 to 4 models, so one row is
 * not enough to run anything. Each row's revision is pinned and never edited.
 */
const CLAUDE_MODELS = [
  { id: ANTHROPIC_MODEL_ID, displayName: 'Claude Opus 5.5', shortName: 'Opus', letter: 'C', sort: 100 },
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', shortName: 'Sonnet', letter: 'S', sort: 101 },
  { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', shortName: 'Haiku', letter: 'H', sort: 102 },
];

async function registerAnthropicModels(ctx: AppContext): Promise<void> {
  if (!ctx.config.anthropicKey) return;
  const now = ctx.now().toISOString();
  for (const model of CLAUDE_MODELS) {
    await ctx.db.run(
      `INSERT INTO models (id, display_name, short_name, letter, revision, adapter, adapter_label, context_k, output_k, cutoff_disclosure, enabled, is_illustrative, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'anthropic', 'Anthropic Messages API', 1000, 128, 'Unknown / Not claimed', 1, 0, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [model.id, model.displayName, model.shortName, model.letter, model.id, model.sort, now, now],
    );
  }
}

/** Marks runs a crashed server left behind as interrupted. Queued runs simply wait for the worker. */
export async function recoverRuns(ctx: AppContext): Promise<void> {
  const left = await ctx.db.all<{ id: string }>(`SELECT id FROM runs WHERE status IN ('running', 'stopping')`);
  for (const run of left) await interruptRun(ctx, run.id, 'server_restart');
}

/** Marks runs a crashed server left behind as interrupted and starts the worker. */
export async function startEngine(ctx: AppContext): Promise<void> {
  await registerAnthropicModels(ctx);
  await recoverRuns(ctx);
  kickEngine(ctx);
}

/* ---------- Seams for tests ---------- */

const SETTLED: RunRow['status'][] = ['interrupted', 'complete', 'failed'];

/** Resolves when the run reaches one of `statuses`: by default, when it has stopped executing. */
export async function waitForRun(ctx: AppContext, code: string, { statuses = SETTLED, timeoutMs = 10_000 }: { statuses?: RunRow['status'][]; timeoutMs?: number } = {}): Promise<RunRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await ctx.db.get<RunRow>('SELECT * FROM runs WHERE code = ?', [code]);
    if (run && statuses.includes(run.status)) {
      // Let the worker finish its cleanup when the run has settled.
      if (SETTLED.includes(run.status)) await engineFor(ctx).active.get(run.id);
      return run;
    }
    if (Date.now() > deadline) throw new Error(`Run ${code} did not reach ${statuses.join(' or ')} in time; it is ${run?.status ?? 'missing'}.`);
    await sleep(2);
  }
}

/** Waits until no worker is executing. Tests call this before closing the database. */
export async function waitForIdle(ctx: AppContext): Promise<void> {
  const state = engineFor(ctx);
  while (state.active.size > 0) await Promise.allSettled(state.active.values());
}

/** Replaces the adapter a run uses; return null to keep the real one. Pass null to clear. */
export function overrideAdapter(ctx: AppContext, override: ((model: PinnedModel) => ModelAdapter | null) | null): void {
  engineFor(ctx).adapterOverride = override;
}

/** Forgets in-memory worker state, as a process restart would. The runs themselves stay untouched. */
export function dropWorkers(ctx: AppContext): void {
  engines.delete(ctx);
}
