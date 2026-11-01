import type { ModelOption, PinnedModel, ReviewAction, RubricCriterion, RunListItem, RunSettings, TamperDto, VerdictDto } from '../../shared/types/evaluation.ts';
import type { AppContext, UserRow } from '../context.ts';
import { verifyEvidenceRow } from '../lib/evidence.ts';
import { integrityBlockReason } from '../lib/integrity.ts';
import { canReadDataset, canReadTask, canReviewTask, canRunTask, type TaskAccessRow, type Verdict } from '../lib/permissions.ts';

/** Row shapes and small read helpers shared by the task routes, the run routes and the worker. */

export interface TaskRow {
  id: string;
  code: string;
  workspace_id: string;
  owner_id: string;
  domain_id: string;
  title: string;
  short_title: string | null;
  featured_note: string | null;
  prompt: string;
  rubric: string;
  model_ids: string;
  settings: string;
  dataset_version_id: string | null;
  visibility: 'private' | 'shared';
  status: 'draft' | 'frozen';
  draft_version: string;
  latest_version_id: string | null;
  is_synthetic: number;
  draft_saved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskVersionRow {
  id: string;
  task_id: string;
  version: string;
  title: string;
  prompt: string;
  rubric: string;
  models: string;
  settings: string;
  dataset_version_id: string | null;
  scan_id: string | null;
  acknowledgements: string;
  sha256: string;
  frozen_by: string;
  frozen_at: string;
}

export interface RunRow {
  id: string;
  code: string;
  task_id: string;
  task_version_id: string;
  owner_id: string;
  status: 'queued' | 'running' | 'stopping' | 'interrupted' | 'complete' | 'failed';
  interrupt_reason: 'owner_stop' | 'provider_timeout' | 'server_restart' | null;
  interrupt_message: string | null;
  interrupted_at: string | null;
  stages_total: number;
  stages_done: number;
  attempt: number;
  last_checkpoint_code: string | null;
  last_checkpoint_at: string | null;
  active_ms: number;
  active_since: string | null;
  consequential_difference: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface RunStageRow {
  id: string;
  run_id: string;
  model_id: string;
  seq: number;
  kind: 'output' | 'score' | 'seal';
  status: 'pending' | 'running' | 'done';
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
}

export interface RunOutputRow {
  run_id: string;
  model_id: string;
  output_text: string | null;
  output_meta: string | null;
  scores: string | null;
  total_score: number | null;
  score_label: string | null;
  score_meta: string | null;
}

export interface EvidenceRow {
  id: string;
  code: string;
  run_id: string;
  task_id: string;
  task_version_id: string;
  model_id: string;
  model_revision: string;
  output_text: string;
  output_meta: string;
  scores: string;
  total_score: number;
  score_label: string;
  runner_version: string;
  sha256: string;
  captured_at: string;
}

export interface ModelRow {
  id: string;
  display_name: string;
  short_name: string;
  letter: string;
  revision: string;
  adapter: 'demo' | 'anthropic';
  adapter_label: string;
  context_k: number;
  output_k: number;
  cutoff_disclosure: string;
  enabled: number;
  is_illustrative: number;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface DatasetVersionInfo {
  version_id: string;
  version: string;
  filename: string;
  format: string;
  sha256: string;
  records_count: number;
  records: string;
  dataset_id: string;
  code: string;
  name: string;
  workspace_id: string;
  visibility: string;
  is_synthetic: number;
  deleted_at: string | null;
}

export interface SourceRecord {
  id: string;
  label: string;
  observation: string;
  /** Every column of the record, used for scanning and for prompts. */
  raw: Record<string, unknown>;
}

export const SETTINGS_DEFAULT: RunSettings = { temperature: 0.2, seed: 42, maxOutputK: 8 };

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const parseRubric = (value: string | null | undefined) => parseJson<RubricCriterion[]>(value, []);
export const parseSettings = (value: string | null | undefined) => parseJson<RunSettings>(value, SETTINGS_DEFAULT);
export const parseModels = (value: string | null | undefined) => parseJson<PinnedModel[]>(value, []);

export const versionLabel = (code: string, version: string) => `${code} v${version}`;

/** "Temperature 0.2 · Seed 42 · 8k output" */
export const settingsLine = (settings: RunSettings) => `Temperature ${settings.temperature} · Seed ${settings.seed} · ${settings.maxOutputK}k output`;

export const verdictDto = (verdict: Verdict): VerdictDto => (verdict.allowed ? { allowed: true } : { allowed: false, reason: verdict.reason });
export const refuse = (reason: string): VerdictDto => ({ allowed: false, reason });
export const allow: VerdictDto = { allowed: true };

/**
 * permissions.ts grants shared readers access only to a frozen task. A task being revised still has
 * a frozen version they may read, so its access row reports frozen; the draft itself is withheld by
 * canSeeDraft below.
 */
export function accessRow(task: TaskRow): TaskAccessRow {
  return {
    id: task.id,
    code: task.code,
    workspace_id: task.workspace_id,
    owner_id: task.owner_id,
    domain_id: task.domain_id,
    visibility: task.visibility,
    status: task.latest_version_id ? 'frozen' : task.status,
  };
}

/** True when access does not depend on the task being shared: owner, member, assigned reviewer, admin on a review. */
export async function hasPrivateAccess(ctx: AppContext, user: UserRow, task: TaskRow): Promise<boolean> {
  return (await canReadTask(ctx, user, { ...accessRow(task), visibility: 'private' })).allowed;
}

export const canSeeDraft = hasPrivateAccess;

export async function loadTask(ctx: AppContext, code: string): Promise<TaskRow | undefined> {
  return ctx.db.get<TaskRow>('SELECT * FROM tasks WHERE code = ?', [code]);
}

export async function loadVersion(ctx: AppContext, id: string | null | undefined): Promise<TaskVersionRow | undefined> {
  if (!id) return undefined;
  return ctx.db.get<TaskVersionRow>('SELECT * FROM task_versions WHERE id = ?', [id]);
}

export async function loadDataset(ctx: AppContext, versionId: string | null | undefined): Promise<DatasetVersionInfo | undefined> {
  if (!versionId) return undefined;
  return ctx.db.get<DatasetVersionInfo>(
    `SELECT v.id AS version_id, v.version, v.filename, v.format, v.sha256, v.records_count, v.records,
            d.id AS dataset_id, d.code, d.name, d.workspace_id, d.visibility, d.is_synthetic, d.deleted_at
     FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.id = ?`,
    [versionId],
  );
}

export const datasetLabel = (dataset: { code: string; version: string }) => `${dataset.code} v${dataset.version}`;

/** Reads the pinned records, using the short label and observation columns when a file has them. */
export function sourceRecords(rawRecords: string | null | undefined): SourceRecord[] {
  const records = parseJson<unknown>(rawRecords, []);
  if (!Array.isArray(records)) return [];
  return records.map((record, index) => {
    const raw = (record && typeof record === 'object' ? record : {}) as Record<string, unknown>;
    const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string).trim() : '');
    return {
      id: text('source_id') || text('id') || `R${String(index + 1).padStart(2, '0')}`,
      label: text('label') || text('assay') || text('title'),
      observation: text('observation') || text('summary') || text('text'),
      raw,
    };
  });
}

/** E01–E03 for a sequence, a short list otherwise. */
export function recordRange(ids: string[]): string {
  if (ids.length === 0) return '';
  if (ids.length === 1) return ids[0] as string;
  const parsed = ids.map((id) => /^(.*?)(\d+)$/.exec(id));
  const sequential = parsed.every((match, index) => {
    if (!match || match[1] !== parsed[0]?.[1]) return false;
    return Number(match[2]) === Number(parsed[0]?.[2]) + index;
  });
  if (sequential) return `${ids[0]}–${ids[ids.length - 1]}`;
  return ids.length <= 4 ? ids.join(', ') : `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more`;
}

/** Datasets a task in this workspace may attach: its own first, then any shared one the user can read. Deleted ones are skipped. */
export async function usableDatasets(ctx: AppContext, user: UserRow, workspaceId: string | null): Promise<DatasetVersionInfo[]> {
  const rows = await ctx.db.all<DatasetVersionInfo>(
    `SELECT v.id AS version_id, v.version, v.filename, v.format, v.sha256, v.records_count, v.records,
            d.id AS dataset_id, d.code, d.name, d.workspace_id, d.visibility, d.is_synthetic, d.deleted_at
     FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id
     WHERE d.deleted_at IS NULL AND (d.workspace_id = ? OR d.visibility = 'shared')
     ORDER BY CASE WHEN d.workspace_id = ? THEN 0 ELSE 1 END, d.code, v.created_at DESC`,
    [workspaceId, workspaceId],
  );
  const usable: DatasetVersionInfo[] = [];
  for (const row of rows) {
    if ((await canReadDataset(ctx, user, { workspace_id: row.workspace_id, visibility: row.visibility, deleted_at: row.deleted_at })).allowed) usable.push(row);
  }
  return usable;
}

/* ---------- Model registry ---------- */

export const ANTHROPIC_MODEL_ID = 'claude-opus-5-5';

export const ANTHROPIC_SETTINGS_NOTE = 'Current Claude models reject sampling parameters and the Messages API has no seed, so temperature and seed are recorded as not applied. Thinking counts toward the output limit.';

export function modelUnavailableReason(ctx: AppContext, model: Pick<ModelRow, 'enabled' | 'adapter'>): string | null {
  if (!model.enabled) return 'Unavailable for new runs. Historical evidence remains.';
  if (model.adapter === 'anthropic' && !ctx.config.anthropicKey) return 'Unavailable: no Anthropic API key is set on this server.';
  return null;
}

export function modelOption(ctx: AppContext, row: ModelRow): ModelOption {
  const reason = modelUnavailableReason(ctx, row);
  return {
    id: row.id,
    displayName: row.display_name,
    shortName: row.short_name,
    revision: row.revision,
    adapter: row.adapter,
    adapterLabel: row.adapter_label,
    contextK: row.context_k,
    outputK: row.output_k,
    illustrative: Boolean(row.is_illustrative),
    available: reason === null,
    reason,
    settingsNote: row.adapter === 'anthropic' ? ANTHROPIC_SETTINGS_NOTE : null,
  };
}

export async function registryModels(ctx: AppContext): Promise<ModelRow[]> {
  return ctx.db.all<ModelRow>('SELECT * FROM models ORDER BY sort, display_name');
}

export const pinModel = (row: ModelRow): PinnedModel => ({
  id: row.id,
  displayName: row.display_name,
  shortName: row.short_name,
  letter: row.letter,
  revision: row.revision,
  adapter: row.adapter,
  contextK: row.context_k,
  outputK: row.output_k,
});

/** Evidence letters come from the registry; a second model with the same letter takes a number. */
export function evidenceLetter(models: PinnedModel[], modelId: string): string {
  const model = models.find((item) => item.id === modelId);
  if (!model) throw new Error(`Model ${modelId} is not pinned to this version.`);
  const sameLetter = models.filter((item) => item.letter === model.letter);
  const position = sameLetter.findIndex((item) => item.id === modelId);
  return position === 0 ? model.letter : `${model.letter}${position + 1}`;
}

export const runNumber = (runCode: string) => runCode.replace(/^RUN-/, '');
export const evidenceCode = (runCode: string, models: PinnedModel[], modelId: string) => `EV-${runNumber(runCode)}-${evidenceLetter(models, modelId)}`;

/* ---------- Evidence verification ---------- */

/** Recomputes a seal. Anything unreadable counts as a mismatch: a page may only claim what this returned. */
export async function verifyEvidence(ctx: AppContext, row: EvidenceRow): Promise<boolean> {
  try {
    return await verifyEvidenceRow(ctx.db, row);
  } catch {
    return false;
  }
}

export async function tamperDto(ctx: AppContext, row: EvidenceRow, runCode: string, taskLabel: string): Promise<TamperDto> {
  return {
    code: row.code,
    runCode,
    taskLabel,
    sha256: row.sha256,
    capturedAt: row.captured_at,
    runnerVersion: row.runner_version,
    verified: await verifyEvidence(ctx, row),
  };
}

/* ---------- Review and report state, read by SQL from the expert tables ---------- */

export interface ReviewRow {
  id: string;
  code: string;
  task_id: string;
  task_version_id: string;
  run_id: string;
  expert_id: string | null;
  status: 'requested' | 'draft' | 'submitted' | 'returned' | 'finalized';
  recommendations: string;
  submitted_at: string | null;
  created_at: string;
}

export async function latestReviewForRun(ctx: AppContext, runId: string): Promise<ReviewRow | undefined> {
  return ctx.db.get<ReviewRow>('SELECT * FROM reviews WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [runId]);
}

/** Reviews belong to a frozen version: one review covers every run of it. */
export async function latestReviewForVersion(ctx: AppContext, versionId: string): Promise<ReviewRow | undefined> {
  return ctx.db.get<ReviewRow>('SELECT * FROM reviews WHERE task_version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [versionId]);
}

export async function latestReviewForTask(ctx: AppContext, taskId: string): Promise<ReviewRow | undefined> {
  return ctx.db.get<ReviewRow>('SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [taskId]);
}

/** "Review this task · You own this task". A link only exists when there is a review to open. */
export async function reviewAction(ctx: AppContext, user: UserRow, task: TaskRow, label: string, versionId?: string): Promise<ReviewAction> {
  const verdict = await canReviewTask(ctx, user, task);
  if (!verdict.allowed) return { label, verdict: refuse(verdict.reason), href: null };
  const review = versionId ? await latestReviewForVersion(ctx, versionId) : await latestReviewForTask(ctx, task.id);
  if (!review) return { label, verdict: refuse(versionId ? 'No expert review has been requested for this version.' : 'No expert review has been requested for this task.'), href: null };
  return { label, verdict: allow, href: `/review/${review.code}` };
}

/* ---------- Runs ---------- */

const RUN_STATUS_NAMES: Record<RunRow['status'], string> = { queued: 'Queued', running: 'Running', stopping: 'Stopping', interrupted: 'Interrupted', complete: 'Complete', failed: 'Failed' };

export async function runListItems(ctx: AppContext, task: Pick<TaskRow, 'id' | 'code'>): Promise<RunListItem[]> {
  const rows = await ctx.db.all<{ code: string; status: RunRow['status']; stages_done: number; stages_total: number; version: string; created_at: string }>(
    `SELECT r.code, r.status, r.stages_done, r.stages_total, v.version, r.created_at FROM runs r JOIN task_versions v ON v.id = r.task_version_id WHERE r.task_id = ? ORDER BY r.created_at DESC, r.rowid DESC`,
    [task.id],
  );
  return rows.map((row) => ({ code: row.code, status: row.status, summary: `${row.stages_done} / ${row.stages_total} stages · ${RUN_STATUS_NAMES[row.status]}`, taskLabel: versionLabel(task.code, row.version), createdAt: row.created_at }));
}

export async function activeRunFor(ctx: AppContext, taskId: string): Promise<Pick<RunRow, 'id' | 'code' | 'status'> | undefined> {
  return ctx.db.get(`SELECT id, code, status FROM runs WHERE task_id = ? AND status IN ('queued', 'running', 'stopping') ORDER BY created_at DESC LIMIT 1`, [taskId]);
}

/** Whether every pinned model can still execute. Disabling a model blocks new runs, not old evidence. */
export async function pinnedModelsBlocked(ctx: AppContext, models: PinnedModel[]): Promise<string | null> {
  for (const pinned of models) {
    const row = await ctx.db.get<ModelRow>('SELECT * FROM models WHERE id = ?', [pinned.id]);
    if (!row) return `${pinned.displayName} is no longer in the model registry.`;
    const reason = modelUnavailableReason(ctx, row);
    if (reason) return `${pinned.displayName} is unavailable for new runs.`;
  }
  return null;
}

export async function runVerdict(ctx: AppContext, user: UserRow, task: TaskRow, version: TaskVersionRow | undefined): Promise<VerdictDto> {
  const owner = canRunTask(user, task);
  if (!owner.allowed) return refuse(owner.reason);
  if (!version) return refuse('Freeze this draft before running it.');
  const active = await activeRunFor(ctx, task.id);
  if (active) return refuse(`${active.code} is already running on this task.`);
  const integrity = await integrityBlockReason(ctx);
  if (integrity) return refuse(integrity);
  const blocked = await pinnedModelsBlocked(ctx, parseModels(version.models));
  return blocked ? refuse(blocked) : allow;
}

export function numberWord(value: number): string {
  return ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][value] ?? String(value);
}
