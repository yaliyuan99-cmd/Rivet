import type { Hono } from 'hono';
import { z } from 'zod';
import type {
  DatasetOption,
  DomainOption,
  DraftDto,
  DraftSaveResponse,
  DraftValidation,
  EditorDraftResponse,
  EditorNewResponse,
  EditorOptions,
  FilterOption,
  FreezeResponse,
  FreezeResult,
  RubricCriterion,
  ScanDto,
  ScanFindings,
  StarterDraft,
  TaskBrowseResponse,
  TaskDetailResponse,
  TaskListItem,
  VerdictDto,
} from '../../shared/types/evaluation.ts';
import type { AppContext, AppEnv, C, UserRow } from '../context.ts';
import {
  accessRow,
  allow,
  activeRunFor,
  datasetLabel,
  hasPrivateAccess,
  loadDataset,
  loadTask,
  loadVersion,
  modelOption,
  modelUnavailableReason,
  numberWord,
  parseModels,
  parseRubric,
  parseSettings,
  parseJson,
  pinModel,
  recordRange,
  refuse,
  registryModels,
  reviewAction,
  runListItems,
  runVerdict,
  sourceRecords,
  tamperDto,
  usableDatasets,
  verdictDto,
  versionLabel,
  type EvidenceRow,
  type ModelRow,
  type SourceRecord,
  type TaskRow,
  type TaskVersionRow,
} from '../engine/contract.ts';
import { audit } from '../lib/audit.ts';
import { requireVerified } from '../lib/auth.ts';
import { citedRecordIds, draftInputHash, runContaminationScan } from '../lib/contamination.ts';
import { DS_BIO_07_CSV, DEMO_MODELS, STARTER_PROMPT, STARTER_RUBRIC, STARTER_TITLE } from '../lib/demoFixtures.ts';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.ts';
import { taskVersionHash } from '../lib/evidence.ts';
import { newId, nextCounter, pad3 } from '../lib/ids.ts';
import { canCreateInWorkspace, canReadTask, canReviseTask } from '../lib/permissions.ts';
import { readJson } from '../lib/validate.ts';

const STARTER_PACK_URL = '/api/tasks/starter-pack.csv';

/* ---------- Loading and permission ---------- */

async function readableTask(c: C, code: string): Promise<{ ctx: AppContext; user: UserRow; task: TaskRow }> {
  const ctx = c.get('ctx');
  const user = requireVerified(c);
  const task = await loadTask(ctx, code);
  if (!task) throw notFound();
  // A private item the caller may not see is simply absent.
  if (!(await canReadTask(ctx, user, accessRow(task))).allowed) throw notFound();
  return { ctx, user, task };
}

const canEditTask = (user: UserRow, task: Pick<TaskRow, 'owner_id'>): VerdictDto => (task.owner_id === user.id ? allow : refuse('Only the task owner can edit this task.'));
const canFreezeTask = (user: UserRow, task: Pick<TaskRow, 'owner_id'>): VerdictDto => (task.owner_id === user.id ? allow : refuse('Only the task owner can freeze this task.'));
const canChangeVisibility = (user: UserRow, task: Pick<TaskRow, 'owner_id'>): VerdictDto => (task.owner_id === user.id ? allow : refuse('Only the task owner can change visibility.'));

async function activeWorkspace(ctx: AppContext, user: UserRow) {
  const rows = await ctx.db.all<{ id: string; name: string; default_visibility: 'private' | 'shared' }>(
    `SELECT w.id, w.name, w.default_visibility FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ? AND m.status = 'active' ORDER BY m.created_at`,
    [user.id],
  );
  return rows.find((row) => row.id === user.active_workspace_id) ?? rows[0] ?? null;
}

/* ---------- Editor options ---------- */

async function domainOptions(ctx: AppContext): Promise<DomainOption[]> {
  const rows = await ctx.db.all<{ id: string; name: string; field: string; prefix: string }>('SELECT id, name, field, prefix FROM domains ORDER BY sort');
  return rows.map((row) => ({ id: row.id, name: row.name, field: row.field, prefix: row.prefix, label: `${row.name} / ${row.field}` }));
}

/** The starter prompt cites E01 to E03. A pack answers for them only if its records say what the authored ones say. */
function isAuthoredPack(records: SourceRecord[]): boolean {
  return ['E01', 'E02', 'E03'].every((id) => {
    const record = records.find((item) => item.id === id);
    return Boolean(record?.observation) && DS_BIO_07_CSV.includes(record?.observation as string);
  });
}

async function datasetOptions(ctx: AppContext, user: UserRow, workspaceId: string | null): Promise<DatasetOption[]> {
  const rows = await usableDatasets(ctx, user, workspaceId);
  return rows.map((row) => {
    const records = sourceRecords(row.records);
    return {
      versionId: row.version_id,
      code: row.code,
      name: row.name,
      version: row.version,
      label: datasetLabel(row),
      recordsCount: row.records_count,
      recordIds: records.map((record) => record.id).slice(0, 50),
      format: row.format,
      authoredPack: isAuthoredPack(records),
    };
  });
}

async function editorOptions(ctx: AppContext, user: UserRow, workspace: { id: string; name: string; default_visibility: 'private' | 'shared' } | null, domainId?: string): Promise<EditorOptions> {
  const domains = await domainOptions(ctx);
  const review = await reviewAction(ctx, user, { owner_id: user.id, domain_id: domainId ?? domains[0]?.id ?? '' } as TaskRow, 'Expert review');
  return {
    domains,
    models: (await registryModels(ctx)).map((row) => modelOption(ctx, row)),
    datasets: await datasetOptions(ctx, user, workspace?.id ?? null),
    defaultSettings: { temperature: 0.2, seed: 42, maxOutputK: 8 },
    ownerName: user.name,
    workspace: workspace ? { id: workspace.id, name: workspace.name, defaultVisibility: workspace.default_visibility } : null,
    review: review.verdict,
    starterPackUrl: STARTER_PACK_URL,
  };
}

function starterDraft(options: EditorOptions): StarterDraft {
  const pack = options.datasets.find((dataset) => dataset.authoredPack);
  const demoIds = DEMO_MODELS.map((model) => model.id);
  return {
    title: STARTER_TITLE,
    domainId: 'biology',
    prompt: STARTER_PROMPT,
    rubric: STARTER_RUBRIC,
    modelIds: options.models.filter((model) => model.available && demoIds.includes(model.id)).map((model) => model.id),
    datasetVersionId: pack?.versionId ?? null,
  };
}

/* ---------- Drafts ---------- */

const criterionSchema = z.object({
  name: z.string({ error: 'Name this criterion.' }).max(120, 'Keep this under 120 characters.'),
  short: z.string().max(120, 'Keep this under 120 characters.').optional(),
  points: z.number({ error: 'Enter the points as a whole number.' }).int('Enter the points as a whole number.').min(0, 'Points cannot be negative.').max(100, 'A criterion cannot exceed 100 points.'),
  guidance: z.string({ error: 'Enter guidance for this criterion.' }).max(500, 'Keep this under 500 characters.'),
});

/** Drafts may be unfinished, so a half-typed task still saves. Freezing is where completeness is enforced. */
const draftSchema = z.object({
  title: z.string({ error: 'Enter a task title to continue.' }).max(200, 'Keep this under 200 characters.'),
  domainId: z.string({ error: 'Choose a domain to continue.' }).min(1, 'Choose a domain to continue.'),
  prompt: z.string({ error: 'Enter the prompt every model will answer.' }).max(40000, 'Keep this under 40,000 characters.'),
  rubric: z.array(criterionSchema, { error: 'Enter the rubric as a list of criteria.' }).max(20, 'Keep the rubric to 20 criteria.'),
  modelIds: z.array(z.string(), { error: 'Select 2–4 models.' }).max(20, 'Select 2–4 models.'),
  datasetVersionId: z.string({ error: 'Choose a dataset, or no source pack.' }).nullable(),
});

const createSchema = draftSchema.extend({
  title: z.string({ error: 'Enter a task title to continue.' }).trim().min(1, 'Enter a task title to continue.').max(200, 'Keep this under 200 characters.'),
});

const normalizeRubric = (rubric: z.output<typeof criterionSchema>[]): RubricCriterion[] =>
  rubric.map((criterion) => ({ name: criterion.name, short: criterion.short?.trim() || criterion.name.trim(), points: criterion.points, guidance: criterion.guidance }));

async function checkDraftReferences(ctx: AppContext, user: UserRow, workspaceId: string, input: z.output<typeof draftSchema>, currentDatasetVersionId: string | null) {
  const fields: Record<string, string> = {};
  const domain = await ctx.db.get<{ id: string; prefix: string }>('SELECT id, prefix FROM domains WHERE id = ?', [input.domainId]);
  if (!domain) fields.domainId = 'Choose a domain from the list.';
  const known = new Set((await registryModels(ctx)).map((row) => row.id));
  if (input.modelIds.some((id) => !known.has(id))) fields.modelIds = 'Choose models from the registry.';
  if (new Set(input.modelIds).size !== input.modelIds.length) fields.modelIds = 'Select each model only once.';
  if (input.datasetVersionId && input.datasetVersionId !== currentDatasetVersionId) {
    const usable = await usableDatasets(ctx, user, workspaceId);
    if (!usable.some((row) => row.version_id === input.datasetVersionId)) fields.datasetVersionId = 'Choose a dataset this workspace can use.';
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  return domain as { id: string; prefix: string };
}

const freezeVersionOf = (task: Pick<TaskRow, 'latest_version_id' | 'draft_version'>) => (task.latest_version_id ? task.draft_version : '1.0');

function nextMinor(version: string): string {
  const [major, minor] = version.split('.');
  return `${major}.${Number(minor ?? 0) + 1}`;
}

/** Everything a freeze refuses, with a reason per field. Also what "Review & freeze" reports in the editor. */
async function validateDraft(ctx: AppContext, task: TaskRow): Promise<DraftValidation> {
  const fields: Record<string, string> = {};
  if (!task.title.trim()) fields.title = 'Enter a task title to continue.';
  if (!task.prompt.trim()) fields.prompt = 'Enter the prompt every model will answer.';

  const rubric = parseRubric(task.rubric);
  if (rubric.length === 0) fields.rubric = 'Add at least one rubric criterion.';
  else {
    const total = rubric.reduce((sum, criterion) => sum + criterion.points, 0);
    if (total !== 100) fields.rubric = `Rubric points must total 100. They total ${total}.`;
    const names = new Set<string>();
    rubric.forEach((criterion, index) => {
      const name = criterion.name.trim().toLowerCase();
      if (!name) fields[`rubric.${index}.name`] = 'Name this criterion.';
      else if (names.has(name)) fields[`rubric.${index}.name`] = 'Each criterion needs its own name.';
      names.add(name);
      if (!Number.isInteger(criterion.points) || criterion.points < 1) fields[`rubric.${index}.points`] = 'Give it at least 1 point.';
    });
  }

  const modelIds = parseJson<string[]>(task.model_ids, []);
  if (modelIds.length < 2 || modelIds.length > 4) fields.modelIds = `Select 2–4 models. ${modelIds.length} selected.`;
  else {
    for (const id of modelIds) {
      const row = await ctx.db.get<ModelRow>('SELECT * FROM models WHERE id = ?', [id]);
      const reason = row ? modelUnavailableReason(ctx, row) : 'This model is no longer in the registry.';
      if (reason) {
        fields.modelIds = `${row?.display_name ?? id}: ${reason}`;
        break;
      }
    }
  }

  if (task.dataset_version_id) {
    const dataset = await loadDataset(ctx, task.dataset_version_id);
    if (!dataset || dataset.deleted_at) fields.datasetVersionId = 'This dataset was deleted from the library. Choose another or remove it.';
  }
  return { ok: Object.keys(fields).length === 0, fields };
}

function draftDto(task: TaskRow, latestVersion: string | null): DraftDto {
  const freezeVersion = freezeVersionOf(task);
  return {
    code: task.code,
    status: task.status,
    visibility: task.visibility,
    title: task.title,
    domainId: task.domain_id,
    prompt: task.prompt,
    rubric: parseRubric(task.rubric),
    modelIds: parseJson<string[]>(task.model_ids, []),
    datasetVersionId: task.dataset_version_id,
    draftVersion: task.draft_version,
    freezeVersion,
    afterFreezeVersion: nextMinor(freezeVersion),
    latestVersion,
    domainLocked: Boolean(task.latest_version_id),
    settings: parseSettings(task.settings),
    savedAt: task.draft_saved_at,
  };
}

/* ---------- Freeze preview ---------- */

const pluralize = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The newest preview nothing is frozen against, if any. */
async function openScan(ctx: AppContext, taskId: string) {
  return ctx.db.get<{ id: string; code: string; input_hash: string; findings: string; risk: 'none' | 'low' | 'high'; created_at: string }>(
    `SELECT s.* FROM scans s WHERE s.task_id = ? AND NOT EXISTS (SELECT 1 FROM task_versions v WHERE v.scan_id = s.id) ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`,
    [taskId],
  );
}

async function freezeResponse(ctx: AppContext, user: UserRow, task: TaskRow): Promise<FreezeResponse> {
  const verdict = canFreezeTask(user, task);
  // Others only ever see what was frozen, even while the owner is drafting the next version.
  if (task.status === 'frozen' || !verdict.allowed) {
    const version = await loadVersion(ctx, task.latest_version_id);
    if (!version) throw notFound();
    const scanRow = version.scan_id ? await ctx.db.get<{ code: string; findings: string; risk: 'none' | 'low' | 'high'; created_at: string }>('SELECT code, findings, risk, created_at FROM scans WHERE id = ?', [version.scan_id]) : undefined;
    const rubric = parseRubric(version.rubric);
    const dataset = await loadDataset(ctx, version.dataset_version_id);
    const models = parseModels(version.models);
    const frozenBy = await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [version.frozen_by]);
    return {
      code: task.code,
      title: version.title,
      status: 'frozen',
      version: version.version,
      label: versionLabel(task.code, version.version),
      validation: { ok: true, fields: {} },
      warnings: [],
      scan: scanRow ? { code: scanRow.code, risk: scanRow.risk, findings: parseJson<ScanFindings>(scanRow.findings, {} as ScanFindings), createdAt: scanRow.created_at, stale: false } : null,
      rail: {
        promptAndRubric: `${pluralize(rubric.length, 'criterion', 'criteria')} / ${rubric.reduce((sum, item) => sum + item.points, 0)} points`,
        sourcePack: dataset ? datasetLabel(dataset) : null,
        modelRevisions: `${pluralize(models.length, 'pinned revision')}`,
      },
      frozen: { sha256: version.sha256, frozenAt: version.frozen_at, frozenBy: frozenBy?.name ?? '', acknowledgements: parseJson<string[]>(version.acknowledgements, []) },
      verdict,
    };
  }

  const version = freezeVersionOf(task);
  const validation = await validateDraft(ctx, task);
  const rubric = parseRubric(task.rubric);
  const dataset = await loadDataset(ctx, task.dataset_version_id);
  const modelIds = parseJson<string[]>(task.model_ids, []);
  const scanRow = await openScan(ctx, task.id);
  const scan: ScanDto | null = scanRow
    ? { code: scanRow.code, risk: scanRow.risk, findings: parseJson<ScanFindings>(scanRow.findings, {} as ScanFindings), createdAt: scanRow.created_at, stale: scanRow.input_hash !== draftInputHash(task) }
    : null;

  const warnings: string[] = [];
  const cited = citedRecordIds(task.prompt);
  const ids = sourceRecords(dataset?.records).map((record) => record.id);
  const missing = cited.filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    warnings.push(dataset ? `This prompt cites ${recordRange(missing)}, but ${datasetLabel(dataset)} has no such records.` : `This prompt cites ${recordRange(missing)}, but no source pack is attached.`);
  }

  return {
    code: task.code,
    title: task.title,
    status: 'draft',
    version,
    label: versionLabel(task.code, version),
    validation,
    warnings,
    scan,
    rail: {
      promptAndRubric: `${pluralize(rubric.length, 'criterion', 'criteria')} / ${rubric.reduce((sum, item) => sum + item.points, 0)} points`,
      sourcePack: dataset ? datasetLabel(dataset) : null,
      modelRevisions: `${pluralize(modelIds.length, 'pinned revision')}`,
    },
    frozen: null,
    verdict,
  };
}

/** SCAN-042 shares its task's number. A later version's scan adds a counter; another domain's clash adds the prefix. */
async function nextScanCode(ctx: AppContext, task: TaskRow): Promise<string> {
  const rows = await ctx.db.all<{ code: string }>('SELECT code FROM scans WHERE task_id = ? ORDER BY created_at, rowid', [task.id]);
  if (rows[0]) return `${rows[0].code}-${rows.length + 1}`;
  const number = task.code.split('-').pop() as string;
  const taken = await ctx.db.get('SELECT 1 AS ok FROM scans WHERE code = ?', [`SCAN-${number}`]);
  return taken ? `SCAN-${task.code}` : `SCAN-${number}`;
}

/* ---------- Browse ---------- */

interface BrowseRow extends TaskRow {
  owner_name: string;
  workspace_name: string;
  workspace_code: string;
  domain_name: string;
  domain_field: string;
  latest_version: string | null;
  version_title: string | null;
  version_prompt: string | null;
  version_models: string | null;
  run_count: number;
}

function matchesSearch(haystack: string[], query: string): boolean {
  const text = haystack.join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => text.includes(term));
}

function metaFor(row: BrowseRow, isOwner: boolean, seesDraft: boolean): string {
  const visibilityWord = row.visibility === 'shared' ? (row.is_synthetic ? 'Demo shared' : 'Shared') : 'Private';
  const parts = [row.owner_name];
  const access = isOwner ? 'Run / Resume / Revise' : 'Read only';
  if (row.latest_version) {
    parts.push(visibilityWord);
    const models = parseModels(row.version_models).length;
    // The frame's read-only row leaves out the model count.
    if (isOwner || row.visibility === 'private') parts.push(pluralize(models, 'model'));
    parts.push(access);
    if (row.status === 'draft' && seesDraft) parts.push(`v${row.draft_version} draft`);
  } else {
    parts.push(`${visibilityWord} draft`);
    parts.push(row.run_count > 0 ? pluralize(row.run_count, 'run') : 'No runs yet');
  }
  return parts.join(' · ');
}

function featuredNote(row: BrowseRow, version: { rubric: string; dataset_records: number | null } | undefined): string {
  if (row.featured_note) return row.featured_note;
  const rubric = parseRubric(version?.rubric ?? row.rubric);
  const criteria = rubric.map((criterion) => criterion.name.toLowerCase());
  const list = criteria.length > 1 ? `${criteria.slice(0, -1).join(', ')} and ${criteria[criteria.length - 1]}` : (criteria[0] ?? 'each answer');
  const sources = version?.dataset_records ? `against ${numberWord(version.dataset_records).toLowerCase()} source ${version.dataset_records === 1 ? 'record' : 'records'}` : 'without an attached source pack';
  return `Evaluate “${row.version_title ?? row.title}” ${sources}. Compare ${list} with a 100-point rubric.`;
}

export function registerTasks(app: Hono<AppEnv>) {
  /* ----- Static paths come first: :code below would otherwise catch them. ----- */

  app.get('/api/tasks/editor-options', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const workspace = await activeWorkspace(ctx, user);
    const options = await editorOptions(ctx, user, workspace);
    const body: EditorNewResponse = { options, starter: c.req.query('starter') === '1' ? starterDraft(options) : null };
    return c.json(body);
  });

  /** The authored source pack for the starter task, so a new workspace can upload it through Datasets. */
  app.get('/api/tasks/starter-pack.csv', (c) => {
    requireVerified(c);
    return new Response(DS_BIO_07_CSV, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="resistance-evidence-demo.csv"' } });
  });

  /* ----- Browse ----- */

  app.get('/api/tasks', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const { q = '', domain = '', status = '', scope = '' } = c.req.query();

    const rows = await ctx.db.all<BrowseRow>(
      `SELECT t.*, u.name AS owner_name, w.name AS workspace_name, w.code AS workspace_code, d.name AS domain_name, d.field AS domain_field,
              v.version AS latest_version, v.title AS version_title, v.prompt AS version_prompt, v.models AS version_models,
              (SELECT COUNT(*) FROM runs r WHERE r.task_id = t.id) AS run_count
       FROM tasks t
       JOIN users u ON u.id = t.owner_id
       JOIN workspaces w ON w.id = t.workspace_id
       JOIN domains d ON d.id = t.domain_id
       LEFT JOIN task_versions v ON v.id = t.latest_version_id
       WHERE t.owner_id = ?
          OR t.workspace_id IN (SELECT workspace_id FROM memberships WHERE user_id = ? AND status = 'active')
          OR t.visibility = 'shared'
          OR EXISTS (SELECT 1 FROM reviews r WHERE r.task_id = t.id)
       ORDER BY CASE WHEN t.latest_version_id IS NULL THEN 1 ELSE 0 END, t.updated_at DESC, t.code`,
      [user.id, user.id],
    );

    const readable: { row: BrowseRow; isOwner: boolean; seesDraft: boolean }[] = [];
    for (const row of rows) {
      if (!(await canReadTask(ctx, user, accessRow(row))).allowed) continue;
      readable.push({ row, isOwner: row.owner_id === user.id, seesDraft: await hasPrivateAccess(ctx, user, row) });
    }

    const filtered = readable.filter(({ row, isOwner, seesDraft }) => {
      if (domain && row.domain_id !== domain) return false;
      if (status === 'frozen' && !row.latest_version) return false;
      if (status === 'draft' && !(row.status === 'draft' && seesDraft)) return false;
      if (scope === 'mine' && !isOwner) return false;
      if (scope && scope !== 'mine' && row.workspace_code !== scope) return false;
      if (q.trim()) {
        // A shared reader searches only what they can read: the frozen version, never a draft.
        const haystack = [row.code, row.owner_name, row.workspace_name, row.domain_name, row.domain_field, row.version_title ?? '', row.version_prompt ?? '', row.short_title ?? ''];
        if (seesDraft) haystack.push(row.title, row.prompt);
        if (!matchesSearch(haystack, q)) return false;
      }
      return true;
    });

    const items: TaskListItem[] = filtered.map(({ row, isOwner, seesDraft }) => {
      const version = row.latest_version ?? row.draft_version;
      return {
        code: row.code,
        version,
        label: versionLabel(row.code, version),
        title: row.short_title || row.version_title || row.title || 'Untitled draft',
        meta: metaFor(row, isOwner, seesDraft),
        status: row.latest_version ? 'frozen' : 'draft',
        visibility: row.visibility,
        domainId: row.domain_id,
        domainName: row.domain_name,
        workspaceCode: row.workspace_code,
        workspaceName: row.workspace_name,
        isOwner,
        synthetic: Boolean(row.is_synthetic),
      };
    });

    const workspace = await activeWorkspace(ctx, user);

    const featuredEntry = readable.find(({ row }) => row.featured_note && row.latest_version) ?? readable.find(({ row }) => row.latest_version);
    let featured: TaskBrowseResponse['featured'] = null;
    if (featuredEntry) {
      const { row } = featuredEntry;
      const version = await ctx.db.get<{ rubric: string; dataset_records: number | null }>(
        `SELECT v.rubric, dv.records_count AS dataset_records FROM task_versions v LEFT JOIN dataset_versions dv ON dv.id = v.dataset_version_id WHERE v.id = ?`,
        [row.latest_version_id],
      );
      featured = {
        code: row.code,
        label: versionLabel(row.code, row.latest_version as string),
        note: featuredNote(row, version),
        reviewAction: await reviewAction(ctx, user, row, `Review ${row.code}`),
      };
    }

    const domains = await domainOptions(ctx);
    const scopeWorkspaces = new Map<string, string>();
    for (const { row } of readable) scopeWorkspaces.set(row.workspace_code, row.workspace_name);
    const filters: TaskBrowseResponse['filters'] = {
      domains: [{ value: '', label: 'All domains' }, ...domains.map((item): FilterOption => ({ value: item.id, label: item.name }))],
      statuses: [
        { value: '', label: 'All statuses' },
        { value: 'frozen', label: 'Frozen versions' },
        { value: 'draft', label: 'Drafts' },
      ],
      scopes: [{ value: '', label: 'All workspaces' }, { value: 'mine', label: 'My tasks' }, ...[...scopeWorkspaces].map(([value, label]): FilterOption => ({ value, label }))],
    };

    const matchedDomains = new Set(items.map((item) => item.domainName));
    const selectedDomain = domains.find((item) => item.id === domain)?.name;
    const domainWord = selectedDomain ?? (matchedDomains.size === 1 ? ([...matchedDomains][0] as string) : 'All domains');
    const allSynthetic = items.length > 0 && items.every((item) => item.synthetic);
    const noun = allSynthetic ? 'authored demo task' : 'task';
    const body: TaskBrowseResponse = {
      items,
      headline: `${domainWord} / ${items.length} ${noun}${items.length === 1 ? '' : 's'}`,
      filters,
      counts: {
        readable: readable.length,
        synthetic: readable.filter(({ row }) => row.is_synthetic).length,
        mine: readable.filter(({ isOwner }) => isOwner).length,
        matched: items.length,
      },
      viewerName: user.name,
      workspaceName: workspace?.name ?? null,
      featured,
    };
    return c.json(body);
  });

  /* ----- Create ----- */

  app.post('/api/tasks', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const input = await readJson(c, createSchema);
    const workspace = await activeWorkspace(ctx, user);
    if (!workspace) throw conflict('Create a workspace before creating a task.', 'no_workspace');
    const verdict = await canCreateInWorkspace(ctx, user, workspace.id);
    if (!verdict.allowed) throw forbidden(verdict.reason);
    const domain = await checkDraftReferences(ctx, user, workspace.id, input, null);

    const now = ctx.now().toISOString();
    const code = await ctx.db.tx(async () => {
      const number = await nextCounter(ctx.db, `task:${domain.prefix}`, 1);
      const taskCode = `${domain.prefix}-${pad3(number)}`;
      const id = newId();
      await ctx.db.run(
        `INSERT INTO tasks (id, code, workspace_id, owner_id, domain_id, title, prompt, rubric, model_ids, dataset_version_id, visibility, status, draft_version, is_synthetic, draft_saved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', '0.1', ?, ?, ?, ?)`,
        [id, taskCode, workspace.id, user.id, domain.id, input.title, input.prompt, JSON.stringify(normalizeRubric(input.rubric)), JSON.stringify(input.modelIds), input.datasetVersionId, workspace.default_visibility, input.prompt === STARTER_PROMPT, now, now, now],
      );
      await audit(ctx, { actorId: user.id, action: 'task.created', subjectType: 'task', subjectId: id, subjectCode: taskCode, workspaceId: workspace.id });
      return taskCode;
    });
    const task = (await loadTask(ctx, code)) as TaskRow;
    const body: DraftSaveResponse = { code, savedAt: now, validation: await validateDraft(ctx, task) };
    return c.json(body, 201);
  });

  /* ----- Task page ----- */

  app.get('/api/tasks/:code', async (c) => {
    const { ctx, user, task } = await readableTask(c, c.req.param('code'));
    const version = await loadVersion(ctx, task.latest_version_id);
    const owner = await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [task.owner_id]);
    const workspace = await ctx.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [task.workspace_id]);
    const domain = await ctx.db.get<{ name: string }>('SELECT name FROM domains WHERE id = ?', [task.domain_id]);
    const ownerName = owner?.name ?? '';
    const workspaceName = workspace?.name ?? '';
    const domainName = domain?.name ?? '';
    const seesDraft = await hasPrivateAccess(ctx, user, task);
    const isOwner = task.owner_id === user.id;

    const dataset = await loadDataset(ctx, version ? version.dataset_version_id : seesDraft ? task.dataset_version_id : null);

    // The access policy reads current state: assigned reviewers come from the reviews table.
    const reviewers = await ctx.db.all<{ name: string }>(
      `SELECT DISTINCT u.name FROM reviews r JOIN users u ON u.id = r.expert_id WHERE r.task_id = ? AND r.expert_id IS NOT NULL ORDER BY u.name`,
      [task.id],
    );
    const accessPolicy: TaskDetailResponse['accessPolicy'] = [
      { term: ownerName, detail: 'Task owner · Run / resume / revise' },
      { term: `${workspaceName} members`, detail: task.visibility === 'private' ? 'Read private task and evidence' : 'Read task and evidence' },
      ...reviewers.map((reviewer) => ({ term: reviewer.name, detail: `Assigned ${domainName} review only` })),
      ...(task.visibility === 'shared' ? [{ term: 'Verified Rivet members', detail: 'Read the frozen version and its evidence · Read only' }] : []),
      { term: 'External visitors', detail: 'No access · Authentication required' },
    ];

    const statusWords = [task.visibility === 'shared' ? (task.is_synthetic ? 'Demo shared' : 'Shared') : 'Private', workspaceName, version ? 'Frozen' : 'Draft'];
    if (version && task.status === 'draft' && seesDraft) statusWords.push(`v${task.draft_version} draft`);

    const latestEvidence = await ctx.db.get<EvidenceRow & { run_code: string; version: string }>(
      `SELECT e.*, r.code AS run_code, v.version AS version FROM evidence e JOIN runs r ON r.id = e.run_id JOIN task_versions v ON v.id = e.task_version_id
       WHERE e.task_id = ? ORDER BY r.created_at DESC, r.rowid DESC, e.captured_at ASC, e.rowid ASC LIMIT 1`,
      [task.id],
    );

    const active = await activeRunFor(ctx, task.id);
    const revising = task.status === 'draft' && Boolean(version);
    const reviseVerdict = verdictDto(canReviseTask(user, task));
    const editVerdict = canEditTask(user, task);

    const statement =
      task.visibility === 'private'
        ? `Only ${workspaceName} members and explicitly authorized reviewers can access this task and its evidence.`
        : `Any verified Rivet member can read the frozen version of this task and its evidence. Only ${ownerName} can run, resume or revise it.`;

    const body: TaskDetailResponse = {
      code: task.code,
      title: version?.title ?? task.title,
      status: version ? 'frozen' : 'draft',
      visibility: task.visibility,
      synthetic: Boolean(task.is_synthetic),
      label: versionLabel(task.code, version?.version ?? task.draft_version),
      domainName,
      workspaceName,
      ownerName,
      isOwner,
      statusLine: statusWords.join(' / '),
      statement,
      accessPolicy,
      visibilityOptions: [
        { value: 'private', label: `Private / ${workspaceName}` },
        { value: 'shared', label: 'Shared / Verified Rivet members' },
      ],
      sourcePack: dataset ? datasetLabel(dataset) : null,
      latestVersion: version
        ? {
            version: version.version,
            label: versionLabel(task.code, version.version),
            title: version.title,
            prompt: version.prompt,
            rubric: parseRubric(version.rubric),
            models: parseModels(version.models),
            settings: parseSettings(version.settings),
            sourcePack: dataset ? datasetLabel(dataset) : null,
            sha256: version.sha256,
            frozenAt: version.frozen_at,
            scanCode: version.scan_id ? ((await ctx.db.get<{ code: string }>('SELECT code FROM scans WHERE id = ?', [version.scan_id]))?.code ?? null) : null,
          }
        : null,
      draft: (revising || !version) && seesDraft ? { version: task.draft_version, title: task.title, prompt: task.prompt, rubric: parseRubric(task.rubric), savedAt: task.draft_saved_at } : null,
      tamper: latestEvidence ? await tamperDto(ctx, latestEvidence, latestEvidence.run_code, versionLabel(task.code, latestEvidence.version)) : null,
      runs: await runListItems(ctx, task),
      activeRunCode: active?.code ?? null,
      nextVersion: task.draft_version,
      verdicts: {
        run: await runVerdict(ctx, user, task, version),
        revise: revising ? refuse(`v${task.draft_version} is already in draft.`) : !version ? refuse('Freeze this draft before revising it.') : reviseVerdict,
        edit: editVerdict.allowed && task.status !== 'draft' ? refuse(`${versionLabel(task.code, version?.version ?? '')} is frozen. Revise it to make changes.`) : editVerdict,
        visibility: canChangeVisibility(user, task),
      },
      reviewAction: await reviewAction(ctx, user, task, 'Review this task'),
    };
    return c.json(body);
  });

  /* ----- Editor ----- */

  app.get('/api/tasks/:code/draft', async (c) => {
    const { ctx, user, task } = await readableTask(c, c.req.param('code'));
    const verdict = canEditTask(user, task);
    if (!verdict.allowed) throw forbidden(verdict.reason as string);
    const version = await loadVersion(ctx, task.latest_version_id);
    const workspace = await ctx.db.get<{ id: string; name: string; default_visibility: 'private' | 'shared' }>('SELECT id, name, default_visibility FROM workspaces WHERE id = ?', [task.workspace_id]);
    const body: EditorDraftResponse = { draft: draftDto(task, version?.version ?? null), options: await editorOptions(ctx, user, workspace ?? null, task.domain_id) };
    return c.json(body);
  });

  app.put('/api/tasks/:code/draft', async (c) => {
    const { ctx, user, task } = await readableTask(c, c.req.param('code'));
    const verdict = canEditTask(user, task);
    if (!verdict.allowed) throw forbidden(verdict.reason as string);
    if (task.status !== 'draft') throw conflict(`${task.code} is frozen. Frozen versions are never edited; revise it to make changes.`, 'frozen');
    const input = await readJson(c, draftSchema);
    const domain = await checkDraftReferences(ctx, user, task.workspace_id, input, task.dataset_version_id);
    if (task.latest_version_id && input.domainId !== task.domain_id) throw invalid({ domainId: 'The domain is fixed once a version is frozen.' });

    const now = ctx.now().toISOString();
    const titleChanged = input.title !== task.title;
    const code = await ctx.db.tx(async () => {
      let nextCode = task.code;
      if (input.domainId !== task.domain_id) {
        // Never frozen, so nothing cites this code yet: the code follows the domain's prefix.
        const number = await nextCounter(ctx.db, `task:${domain.prefix}`, 1);
        nextCode = `${domain.prefix}-${pad3(number)}`;
        await ctx.db.run('DELETE FROM scans WHERE task_id = ?', [task.id]);
        await audit(ctx, { actorId: user.id, action: 'task.recoded', subjectType: 'task', subjectId: task.id, subjectCode: nextCode, workspaceId: task.workspace_id, detail: { from: task.code, to: nextCode } });
      }
      await ctx.db.run(
        `UPDATE tasks SET code = ?, domain_id = ?, title = ?, short_title = ?, prompt = ?, rubric = ?, model_ids = ?, dataset_version_id = ?, draft_saved_at = ?, updated_at = ? WHERE id = ?`,
        [nextCode, input.domainId, input.title, titleChanged ? null : task.short_title, input.prompt, JSON.stringify(normalizeRubric(input.rubric)), JSON.stringify(input.modelIds), input.datasetVersionId, now, now, task.id],
      );
      return nextCode;
    });
    const saved = (await loadTask(ctx, code)) as TaskRow;
    const body: DraftSaveResponse = { code, savedAt: now, validation: await validateDraft(ctx, saved) };
    return c.json(body);
  });

  /* ----- Freeze ----- */

  app.get('/api/tasks/:code/freeze', async (c) => {
    const { ctx, user, task } = await readableTask(c, c.req.param('code'));
    // Anyone who can read a task may read what was frozen. A preview of a draft is the owner's.
    if (task.status === 'draft' && !task.latest_version_id) {
      const verdict = canFreezeTask(user, task);
      if (!verdict.allowed) throw forbidden(verdict.reason as string);
    }
    return c.json(await freezeResponse(ctx, user, task));
  });

  app.post('/api/tasks/:code/scan', async (c) => {
    const { ctx, user, task } = await readableTask(c, c.req.param('code'));
    const verdict = canFreezeTask(user, task);
    if (!verdict.allowed) throw forbidden(verdict.reason as string);
    if (task.status !== 'draft') throw conflict(`${task.code} has no draft to scan.`, 'frozen');
    if (!task.prompt.trim()) throw invalid({ prompt: 'Enter the prompt every model will answer.' }, 'A scan needs a prompt.');

    const result = await runContaminationScan(ctx, user, task);
    const now = ctx.now().toISOString();
    const code = await ctx.db.tx(async () => {
      const open = await openScan(ctx, task.id);
      if (open) {
        // A preview nothing is frozen against is simply replaced; its code stays with this draft.
        await ctx.db.run('UPDATE scans SET input_hash = ?, findings = ?, risk = ?, created_by = ?, created_at = ? WHERE id = ?', [result.inputHash, JSON.stringify(result.findings), result.risk, user.id, now, open.id]);
        return open.code;
      }
      const scanCode = await nextScanCode(ctx, task);
      await ctx.db.run('INSERT INTO scans (id, code, task_id, input_hash, findings, risk, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [newId(), scanCode, task.id, result.inputHash, JSON.stringify(result.findings), result.risk, user.id, now]);
      return scanCode;
    });
    await audit(ctx, { actorId: user.id, action: 'task.scanned', subjectType: 'task', subjectId: task.id, subjectCode: task.code, workspaceId: task.workspace_id, detail: { scan: code, risk: result.risk } });
    return c.json(await freezeResponse(ctx, user, task));
  });

  app.post('/api/tasks/:code/freeze', async (c) => {
    const { ctx, user, task } = await readableTask(c, c.req.param('code'));
    const verdict = canFreezeTask(user, task);
    if (!verdict.allowed) throw forbidden(verdict.reason as string);
    const input = await readJson(
      c,
      z.object({
        scanCode: z.string({ error: 'Run the contamination scan first.' }).min(1, 'Run the contamination scan first.'),
        acknowledgeFindings: z.literal(true, { error: 'Acknowledge the scan findings to freeze this version.' }),
        acknowledgeRetention: z.literal(true, { error: 'Agree to retain the scan and its limitations to freeze this version.' }),
      }),
    );

    const result = await ctx.db.tx(async (): Promise<FreezeResult> => {
      // Read again inside the transaction: this is the draft that gets frozen.
      const current = (await loadTask(ctx, task.code)) as TaskRow;
      if (current.status !== 'draft') throw conflict(`${current.code} is already frozen. Revise it to make changes.`, 'frozen');

      const validation = await validateDraft(ctx, current);
      if (!validation.ok) throw invalid(validation.fields, 'This draft is not ready to freeze.');

      const scan = await openScan(ctx, current.id);
      if (!scan || scan.code !== input.scanCode) throw conflict('This scan is no longer the current preview. Run the contamination scan again.', 'scan_stale');
      if (scan.input_hash !== draftInputHash(current)) throw conflict('The draft changed after this scan. Run the contamination scan again before freezing.', 'scan_stale');

      const version = freezeVersionOf(current);
      const findings = parseJson<ScanFindings>(scan.findings, {} as ScanFindings);
      const acknowledgements = [findings.acknowledgementText, findings.retentionText];

      const modelIds = parseJson<string[]>(current.model_ids, []);
      const registry = await registryModels(ctx);
      const pinned = registry.filter((row) => modelIds.includes(row.id)).map(pinModel);

      const dataset = await loadDataset(ctx, current.dataset_version_id);
      const title = current.title.trim();
      const prompt = current.prompt.trim();
      const rubric = parseRubric(current.rubric).map((criterion) => ({ ...criterion, name: criterion.name.trim(), short: criterion.short.trim() || criterion.name.trim(), guidance: criterion.guidance.trim() }));
      const settings = parseSettings(current.settings);
      const now = ctx.now().toISOString();
      const sha256 = taskVersionHash({
        task_code: current.code,
        version,
        title,
        prompt,
        rubric,
        models: pinned,
        settings,
        dataset_sha256: dataset?.sha256 ?? null,
        scan_code: scan.code,
        acknowledgements,
      });
      const versionId = newId();
      await ctx.db.run(
        `INSERT INTO task_versions (id, task_id, version, title, prompt, rubric, models, settings, dataset_version_id, scan_id, acknowledgements, sha256, frozen_by, frozen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [versionId, current.id, version, title, prompt, JSON.stringify(rubric), JSON.stringify(pinned), JSON.stringify(settings), dataset?.version_id ?? null, scan.id, JSON.stringify(acknowledgements), sha256, user.id, now],
      );
      await ctx.db.run(`UPDATE tasks SET status = 'frozen', draft_version = ?, latest_version_id = ?, updated_at = ? WHERE id = ?`, [nextMinor(version), versionId, now, current.id]);
      if (dataset) {
        await ctx.db.run(`INSERT INTO dataset_activity (id, workspace_id, dataset_id, kind, message, actor_id, created_at) VALUES (?, ?, ?, 'Task attachment', ?, ?, ?)`, [
          newId(),
          dataset.workspace_id,
          dataset.dataset_id,
          `${datasetLabel(dataset)} pinned to ${current.code}`,
          user.id,
          now,
        ]);
      }
      await audit(ctx, {
        actorId: user.id,
        action: 'task.frozen',
        subjectType: 'task_version',
        subjectId: versionId,
        subjectCode: versionLabel(current.code, version),
        workspaceId: current.workspace_id,
        detail: { sha256, scan: scan.code, risk: scan.risk, models: pinned.map((model) => model.revision), dataset: dataset ? datasetLabel(dataset) : null },
      });
      return { code: current.code, version, label: versionLabel(current.code, version), sha256 };
    });
    return c.json(result, 201);
  });

  /* ----- Revise ----- */

  app.post('/api/tasks/:code/revise', async (c) => {
    const { ctx, user, task } = await readableTask(c, c.req.param('code'));
    const verdict = canReviseTask(user, task);
    if (!verdict.allowed) throw forbidden(verdict.reason);
    if (task.status === 'draft') throw conflict(task.latest_version_id ? `v${task.draft_version} is already in draft.` : 'Freeze this draft before revising it.', 'already_draft');
    const version = (await loadVersion(ctx, task.latest_version_id)) as TaskVersionRow;
    const now = ctx.now().toISOString();
    const models = parseModels(version.models).map((model) => model.id);
    await ctx.db.tx(async () => {
      // The draft starts from the frozen copy. The task_versions row itself is never touched.
      await ctx.db.run(
        `UPDATE tasks SET status = 'draft', title = ?, prompt = ?, rubric = ?, model_ids = ?, settings = ?, dataset_version_id = ?, draft_saved_at = ?, updated_at = ? WHERE id = ?`,
        [version.title, version.prompt, version.rubric, JSON.stringify(models), version.settings, version.dataset_version_id, now, now, task.id],
      );
      await audit(ctx, { actorId: user.id, action: 'task.revised', subjectType: 'task', subjectId: task.id, subjectCode: task.code, workspaceId: task.workspace_id, detail: { from: version.version, draft: task.draft_version } });
    });
    return c.json({ code: task.code, draftVersion: task.draft_version }, 201);
  });

  /* ----- Visibility ----- */

  app.patch('/api/tasks/:code/visibility', async (c) => {
    const { ctx, user, task } = await readableTask(c, c.req.param('code'));
    const verdict = canChangeVisibility(user, task);
    if (!verdict.allowed) throw forbidden(verdict.reason as string);
    const input = await readJson(c, z.object({ visibility: z.enum(['private', 'shared'], { error: 'Choose private or shared.' }) }));
    if (input.visibility !== task.visibility) {
      const now = ctx.now().toISOString();
      await ctx.db.tx(async () => {
        await ctx.db.run('UPDATE tasks SET visibility = ?, updated_at = ? WHERE id = ?', [input.visibility, now, task.id]);
        await audit(ctx, { actorId: user.id, action: 'task.visibility_changed', subjectType: 'task', subjectId: task.id, subjectCode: task.code, workspaceId: task.workspace_id, detail: { from: task.visibility, to: input.visibility } });
      });
    }
    return c.json({ visibility: input.visibility });
  });
}
