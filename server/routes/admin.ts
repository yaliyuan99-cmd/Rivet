import type { Hono } from 'hono';
import { z } from 'zod';
import type { AdminModel, AdminModelsResponse, AdminPerson, AdminSummary, CheckFailure, CheckReceipt, CheckRun, CheckStatus, ChecksResponse, ModelRevisionEntry } from '../../shared/types/admin.ts';
import type { AppContext, AppEnv, UserRow } from '../context.ts';
import { operationalEvents, runSystemChecks, summarizeReceipts } from '../engine/checks.ts';
import { audit } from '../lib/audit.ts';
import { requireAdmin } from '../lib/auth.ts';
import { invalid, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { readJson, trimmed } from '../lib/validate.ts';

const person = (user: Pick<UserRow, 'name' | 'role'>): AdminPerson => ({ name: user.name, role: user.role === 'admin' ? 'Admin' : 'Member' });

/* ---------- Check receipts ---------- */

interface ReceiptRow {
  code: string;
  check_key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  data: string;
  created_at: string;
}

function receiptDto(row: ReceiptRow): CheckReceipt {
  let failures: CheckFailure[] = [];
  try {
    const data = JSON.parse(row.data) as { failures?: CheckFailure[] };
    failures = data.failures ?? [];
  } catch {
    failures = [];
  }
  return { code: row.code, key: row.check_key, label: row.label, status: row.status, detail: row.detail, failures, createdAt: row.created_at };
}

async function loadRun(ctx: AppContext, run: { id: string; started_by: string; started_at: string; finished_at: string }): Promise<CheckRun> {
  const operator = await ctx.db.get<Pick<UserRow, 'name' | 'role'>>('SELECT name, role FROM users WHERE id = ?', [run.started_by]);
  // CHECK codes are zero padded only to three digits, so rowid keeps them in the order they ran.
  const rows = await ctx.db.all<ReceiptRow>('SELECT * FROM check_receipts WHERE check_run_id = ? ORDER BY rowid', [run.id]);
  const receipts = rows.map(receiptDto);
  return { id: run.id, startedAt: run.started_at, finishedAt: run.finished_at, operator: operator ? person(operator) : { name: 'Unknown', role: '' }, receipts, ...summarizeReceipts(receipts) };
}

async function latestRun(ctx: AppContext): Promise<CheckRun | null> {
  const run = await ctx.db.get<{ id: string; started_by: string; started_at: string; finished_at: string }>('SELECT * FROM check_runs ORDER BY rowid DESC LIMIT 1');
  return run ? loadRun(ctx, run) : null;
}

/* ---------- Model registry ---------- */

interface ModelRow {
  id: string;
  display_name: string;
  short_name: string;
  revision: string;
  adapter: string;
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

async function modelDto(ctx: AppContext, row: ModelRow): Promise<AdminModel> {
  const revisions = await ctx.db.all<{ id: string; rationale: string; changes: string; created_at: string; editor: string | null }>(
    `SELECT mr.id, mr.rationale, mr.changes, mr.created_at, u.name AS editor FROM model_revisions mr LEFT JOIN users u ON u.id = mr.editor_id
     WHERE mr.model_id = ? ORDER BY mr.created_at DESC, mr.rowid DESC`,
    [row.id],
  );
  const history: ModelRevisionEntry[] = revisions.map((revision) => ({ id: revision.id, editor: revision.editor, rationale: revision.rationale, changes: JSON.parse(revision.changes), createdAt: revision.created_at }));
  return {
    id: row.id,
    displayName: row.display_name,
    shortName: row.short_name,
    revision: row.revision,
    adapter: row.adapter,
    adapterLabel: row.adapter_label,
    contextK: row.context_k,
    outputK: row.output_k,
    cutoffDisclosure: row.cutoff_disclosure,
    enabled: Boolean(row.enabled),
    illustrative: Boolean(row.is_illustrative),
    updatedAt: row.updated_at,
    history,
  };
}

/**
 * The whole editable surface. Strict on purpose: revision, adapter and anything else are not fields of
 * this API, so sending one is refused rather than ignored.
 */
const modelEdit = z.strictObject(
  {
    displayName: trimmed('Enter a display name.', 120),
    cutoffDisclosure: trimmed('Enter a cutoff disclosure, or say it is unknown.', 200),
    enabled: z.boolean({ error: 'Say whether this model is available for new evaluations.' }),
    rationale: trimmed('Explain why this metadata is changing.', 1000),
  },
  { error: (issue) => (issue.code === 'unrecognized_keys' ? 'Only the display name, cutoff disclosure and availability can change. Pinned revisions and adapters cannot be edited.' : undefined) },
);

export function registerAdmin(app: Hono<AppEnv>) {
  /* ---------- Index ---------- */

  app.get('/api/admin/summary', async (c) => {
    const ctx = c.get('ctx');
    const user = requireAdmin(c);
    const credentials = await ctx.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM applications WHERE status = 'pending'`);
    const adjudications = await ctx.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM reviews WHERE status = 'submitted'`);
    const models = await ctx.db.get<{ total: number; enabled: number | null }>(`SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM models`);
    const latest = await latestRun(ctx);
    const body: AdminSummary = {
      pendingCredentials: credentials?.count ?? 0,
      pendingAdjudications: adjudications?.count ?? 0,
      models: { total: models?.total ?? 0, enabled: models?.enabled ?? 0 },
      latestCheck: latest
        ? {
            finishedAt: latest.finishedAt,
            passed: latest.receipts.filter((receipt) => receipt.status === 'passed').length,
            warnings: latest.receipts.filter((receipt) => receipt.status === 'warning').length,
            failed: latest.receipts.filter((receipt) => receipt.status === 'failed').length,
            message: latest.message,
            tone: latest.tone,
          }
        : null,
      operator: person(user),
    };
    return c.json(body);
  });

  /* ---------- Models ---------- */

  app.get('/api/admin/models', async (c) => {
    const ctx = c.get('ctx');
    const user = requireAdmin(c);
    const rows = await ctx.db.all<ModelRow>('SELECT * FROM models ORDER BY sort, display_name');
    const body: AdminModelsResponse = { items: await Promise.all(rows.map((row) => modelDto(ctx, row))), editor: person(user) };
    return c.json(body);
  });

  app.patch('/api/admin/models/:id', async (c) => {
    const ctx = c.get('ctx');
    const user = requireAdmin(c);
    const input = await readJson(c, modelEdit);
    const row = await ctx.db.get<ModelRow>('SELECT * FROM models WHERE id = ?', [c.req.param('id')]);
    if (!row) throw notFound('This model is not in the registry.');

    const changes: ModelRevisionEntry['changes'] = {};
    if (input.displayName !== row.display_name) changes.displayName = { from: row.display_name, to: input.displayName };
    if (input.cutoffDisclosure !== row.cutoff_disclosure) changes.cutoffDisclosure = { from: row.cutoff_disclosure, to: input.cutoffDisclosure };
    if (input.enabled !== Boolean(row.enabled)) changes.enabled = { from: Boolean(row.enabled), to: input.enabled };
    if (!Object.keys(changes).length) throw invalid({ form: 'Nothing has changed. Edit a field before saving a metadata revision.' }, 'Nothing has changed. Edit a field before saving a metadata revision.');

    const now = ctx.now().toISOString();
    await ctx.db.tx(async () => {
      await ctx.db.run(`UPDATE models SET display_name = ?, cutoff_disclosure = ?, enabled = ?, updated_at = ? WHERE id = ?`, [input.displayName, input.cutoffDisclosure, input.enabled ? 1 : 0, now, row.id]);
      await ctx.db.run(`INSERT INTO model_revisions (id, model_id, editor_id, rationale, changes, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [newId(), row.id, user.id, input.rationale, JSON.stringify(changes), now]);
      await audit(ctx, { actorId: user.id, action: 'model.metadata_revised', subjectType: 'model', subjectId: row.id, subjectCode: row.revision, detail: { message: `${input.displayName} metadata revised`, changes, rationale: input.rationale } });
    });
    const fresh = (await ctx.db.get<ModelRow>('SELECT * FROM models WHERE id = ?', [row.id])) as ModelRow;
    return c.json(await modelDto(ctx, fresh));
  });

  /* ---------- System checks ---------- */

  app.get('/api/admin/checks', async (c) => {
    const ctx = c.get('ctx');
    const user = requireAdmin(c);
    const body: ChecksResponse = { latest: await latestRun(ctx), events: await operationalEvents(ctx), operator: person(user) };
    return c.json(body);
  });

  app.post('/api/admin/checks/run', async (c) => {
    const ctx = c.get('ctx');
    const user = requireAdmin(c);
    await runSystemChecks(ctx, user.id);
    const body: ChecksResponse = { latest: await latestRun(ctx), events: await operationalEvents(ctx), operator: person(user) };
    return c.json(body);
  });

  /** A real file. Permission-checked and audited on each request. */
  app.get('/api/admin/checks/export', async (c) => {
    const ctx = c.get('ctx');
    const user = requireAdmin(c);
    const now = ctx.now().toISOString();
    const runs = await ctx.db.all<{ id: string; started_by: string; started_at: string; finished_at: string }>('SELECT * FROM check_runs ORDER BY rowid DESC');
    const payload = {
      schema: 'rivet.check_log.v1',
      exportedAt: now,
      exportedBy: person(user),
      synthetic: ctx.config.demo,
      note: ctx.config.demo
        ? 'Receipts are computed for real over the synthetic fixtures on this instance. They do not describe a live production service.'
        : 'Receipts are computed for real over the data on this instance.',
      runs: await Promise.all(runs.map((run) => loadRun(ctx, run))),
      operationalEvents: await operationalEvents(ctx, 200),
    };
    await audit(ctx, { actorId: user.id, action: 'system_checks.exported', subjectType: 'check_log', subjectCode: 'check-log', detail: { runs: runs.length } });
    const stamp = now.replace(/[-:]/g, '').slice(0, 13);
    return c.body(JSON.stringify(payload, null, 2), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="rivet-check-log-${stamp}Z.json"`,
      'Cache-Control': 'no-store',
    });
  });
}
