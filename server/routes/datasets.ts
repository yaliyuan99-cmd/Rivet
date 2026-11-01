import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, AppEnv, C, UserRow } from '../context.ts';
import { nowIso } from '../context.ts';
import type {
  CreateDatasetResponse,
  DatasetActivityItem,
  DatasetDeletion,
  DatasetDetail,
  DatasetFilter,
  DatasetFormat,
  DatasetListItem,
  DatasetListResponse,
  DatasetReceipt,
  DatasetVersionSummary,
  DatasetVisibility,
  DatasetWorkspace,
  UploadContext,
  UploadDomain,
  UploadDraft,
  UploadTarget,
  Verdict,
} from '../../shared/types/datasets.ts';
import { audit } from '../lib/audit.ts';
import { requireVerified } from '../lib/auth.ts';
import { compareVersions, displayRow, MAX_UPLOAD_BYTES, nextVersion, storedBytesMatch, validateDatasetFile, VERSION_PATTERN, type DatasetRecord } from '../lib/csv.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, HttpError, invalid, notFound } from '../lib/errors.ts';
import { newId, nextCounter } from '../lib/ids.ts';
import { canCreateInWorkspace, canDeleteDataset, canReadDataset, workspaceRole } from '../lib/permissions.ts';
import { readJson } from '../lib/validate.ts';

const MAX_DISPLAY_ROWS = 50;
const NO_WORKSPACE = 'Create a workspace before uploading a dataset.';
const DELETED_NO_VERSIONS = 'This dataset was deleted from the library, so it cannot take new versions.';
const TOO_LARGE = 'This file is larger than the 100 MB upload limit.';

const yes: Verdict = { allowed: true };

interface DatasetRow {
  id: string;
  code: string;
  workspace_id: string;
  owner_id: string;
  domain_id: string;
  name: string;
  provenance: string;
  visibility: DatasetVisibility;
  is_synthetic: number;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

interface VersionRow {
  id: string;
  dataset_id: string;
  version: string;
  upload_id: string;
  filename: string;
  size: number;
  format: DatasetFormat;
  sha256: string;
  records_count: number;
  receipt: string;
  provenance: string;
  is_synthetic: number;
  created_by: string;
  created_by_name: string;
  created_at: string;
}

interface DraftRow {
  id: string;
  workspace_id: string;
  user_id: string;
  upload_id: string | null;
  target_dataset_id: string | null;
  filename: string;
  size: number;
  sha256: string;
  format: string;
  records_count: number;
  records: string;
  receipt: string;
  passed: number;
  consumed_at: string | null;
  consumed_version_id: string | null;
  created_at: string;
}

const VERSION_COLUMNS = `v.id, v.dataset_id, v.version, v.upload_id, v.filename, v.size, v.format, v.sha256, v.records_count, v.receipt, v.provenance, v.is_synthetic, v.created_by, v.created_at, u.name AS created_by_name`;

/* ---------- Shared helpers (the assurance routes use these too) ---------- */

/** The workspace a request acts in. A stale active_workspace_id falls back, as the session does. */
export async function activeWorkspaceOf(ctx: AppContext, user: UserRow): Promise<{ id: string; name: string; default_visibility: DatasetVisibility; role: 'owner' | 'member' } | null> {
  const rows = await ctx.db.all<{ id: string; name: string; default_visibility: DatasetVisibility; role: 'owner' | 'member' }>(
    `SELECT w.id, w.name, w.default_visibility, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ? AND m.status = 'active' ORDER BY m.created_at`,
    [user.id],
  );
  return rows.find((row) => row.id === user.active_workspace_id) ?? rows[0] ?? null;
}

/** What the next nextCounter call will return, without taking it. */
export async function peekCounter(ctx: AppContext, name: string, initial = 1): Promise<number> {
  const row = await ctx.db.get<{ value: number }>('SELECT value FROM counters WHERE name = ?', [name]);
  return row ? row.value + 1 : initial;
}

export function attachmentHeaders(filename: string, contentType: string, extra: Record<string, string> = {}): Record<string, string> {
  const ascii = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  // RFC 5987: encodeURIComponent leaves these four, which an ext-value may not contain.
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'private, no-store',
    ...extra,
  };
}
/* ---------- Dataset helpers ---------- */

const datasetCode = (prefix: string, n: number) => `DS-${prefix}-${String(n).padStart(2, '0')}`;
const toWorkspace = (row: { id: string; name: string; default_visibility: DatasetVisibility }): DatasetWorkspace => ({ id: row.id, name: row.name, visibility: row.default_visibility });
const parseReceipt = (json: string) => JSON.parse(json) as DatasetReceipt;
const unique = <T>(items: T[]) => [...new Set(items)];

function shortList(items: string[], max = 3): string {
  return items.length > max ? `${items.slice(0, max).join(', ')} +${items.length - max} more` : items.join(', ');
}

const contentTypes: Record<DatasetFormat, string> = { csv: 'text/csv; charset=utf-8', jsonl: 'application/x-ndjson; charset=utf-8', pdf: 'application/pdf' };

async function getDataset(ctx: AppContext, code: string): Promise<DatasetRow | undefined> {
  return ctx.db.get<DatasetRow>('SELECT * FROM datasets WHERE code = ?', [code]);
}

/** Readable or 404: a private dataset's existence is not disclosed. */
async function readableDataset(c: C, code: string): Promise<{ ctx: AppContext; user: UserRow; dataset: DatasetRow; member: boolean }> {
  const ctx = c.get('ctx');
  const user = requireVerified(c);
  const dataset = await getDataset(ctx, code);
  if (!dataset) throw notFound();
  const verdict = await canReadDataset(ctx, user, dataset);
  if (!verdict.allowed) throw notFound();
  return { ctx, user, dataset, member: Boolean(await workspaceRole(ctx, user.id, dataset.workspace_id)) };
}

async function versionsOf(ctx: AppContext, datasetId: string): Promise<VersionRow[]> {
  const rows = await ctx.db.all<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM dataset_versions v JOIN users u ON u.id = v.created_by WHERE v.dataset_id = ?`, [datasetId]);
  return rows.sort((a, b) => compareVersions(b.version, a.version));
}

interface References {
  frozen: { code: string; version: string; datasetVersion: string }[];
  drafts: string[];
  reports: string[];
  traces: string[];
}

/** Everything that points at this dataset. Outside the workspace, only what is itself shared is named. */
async function referencesOf(ctx: AppContext, dataset: DatasetRow, member: boolean): Promise<References> {
  const frozen = await ctx.db.all<{ code: string; version: string; dataset_version: string; visibility: string }>(
    `SELECT t.code, tv.version, dv.version AS dataset_version, t.visibility
     FROM task_versions tv JOIN tasks t ON t.id = tv.task_id JOIN dataset_versions dv ON dv.id = tv.dataset_version_id
     WHERE dv.dataset_id = ? ORDER BY tv.frozen_at`,
    [dataset.id],
  );
  const drafts = await ctx.db.all<{ code: string; visibility: string }>(
    `SELECT t.code, t.visibility FROM tasks t JOIN dataset_versions dv ON dv.id = t.dataset_version_id
     WHERE dv.dataset_id = ? AND t.status = 'draft' ORDER BY t.code`,
    [dataset.id],
  );
  const reports = await ctx.db.all<{ code: string; version: string; visibility: string }>(
    `SELECT r.code, r.version, t.visibility FROM reports r JOIN tasks t ON t.id = r.task_id JOIN task_versions tv ON tv.id = r.task_version_id
     JOIN dataset_versions dv ON dv.id = tv.dataset_version_id WHERE dv.dataset_id = ? ORDER BY r.frozen_at`,
    [dataset.id],
  );
  const traces = member
    ? await ctx.db.all<{ code: string }>(`SELECT tr.code FROM traces tr JOIN dataset_versions dv ON dv.id = tr.dataset_version_id WHERE dv.dataset_id = ? ORDER BY tr.code`, [dataset.id])
    : [];
  const visible = (row: { visibility: string }) => member || row.visibility === 'shared';
  return {
    frozen: frozen.filter(visible).map((row) => ({ code: row.code, version: row.version, datasetVersion: row.dataset_version })),
    drafts: drafts.filter(visible).map((row) => row.code),
    reports: unique(reports.filter(visible).map((row) => `${row.code} v${row.version}`)),
    traces: traces.map((row) => row.code),
  };
}

function attachmentLabel(references: References, isSynthetic: boolean): string {
  const frozen = unique(references.frozen.map((row) => row.code));
  if (frozen.length) return `Attached to ${shortList(frozen)}`;
  if (references.drafts.length) return `Attached to ${shortList(references.drafts)} (draft)`;
  return isSynthetic ? 'Authored demo' : 'Not attached';
}

const downloadPath = (code: string, version: string) => `/api/datasets/${code}/versions/${version}/download`;
const manifestPath = (code: string, version: string) => `/api/datasets/${code}/versions/${version}/manifest`;

async function activityFor(ctx: AppContext, workspaceId: string): Promise<DatasetActivityItem[]> {
  const rows = await ctx.db.all<{ id: string; kind: string; message: string; created_at: string }>(
    `SELECT id, kind, message, created_at FROM dataset_activity WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 6`,
    [workspaceId],
  );
  return rows.map((row) => ({ id: row.id, kind: row.kind, message: row.message, createdAt: row.created_at }));
}

async function logActivity(ctx: AppContext, entry: { workspaceId: string; datasetId: string | null; kind: string; message: string; actorId: string }): Promise<void> {
  await ctx.db.run(`INSERT INTO dataset_activity (id, workspace_id, dataset_id, kind, message, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [newId(), entry.workspaceId, entry.datasetId, entry.kind, entry.message, entry.actorId, nowIso(ctx)]);
}

function draftDto(row: DraftRow, visibility: DatasetVisibility, targetCode: string | null): UploadDraft {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size,
    sha256: row.sha256,
    format: row.format as UploadDraft['format'],
    recordsCount: row.records_count,
    passed: Boolean(row.passed),
    receipt: parseReceipt(row.receipt),
    visibility,
    targetCode,
    createdAt: row.created_at,
  };
}

async function draftResponse(ctx: AppContext, row: DraftRow): Promise<UploadDraft> {
  const workspace = await ctx.db.get<{ default_visibility: DatasetVisibility }>('SELECT default_visibility FROM workspaces WHERE id = ?', [row.workspace_id]);
  const target = row.target_dataset_id ? await ctx.db.get<{ code: string; visibility: DatasetVisibility }>('SELECT code, visibility FROM datasets WHERE id = ?', [row.target_dataset_id]) : undefined;
  return draftDto(row, target?.visibility ?? workspace?.default_visibility ?? 'private', target?.code ?? null);
}

function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (clean || 'upload').slice(-200);
}

/** The reason new bytes cannot become a new version, or null. */
function identicalBytesReason(code: string, versions: { version: string; sha256: string }[], sha256: string): string | null {
  const same = versions.find((version) => version.sha256 === sha256);
  return same ? `These bytes are identical to ${code} v${same.version}. A new version needs new bytes, so nothing was created.` : null;
}

function validationMessage(receipt: DatasetReceipt): string {
  if (receipt.format === 'pdf') return 'PDF signature verified; records not parsed';
  const missing = receipt.missingSourceIds === 0 ? 'no missing source IDs' : `${receipt.missingSourceIds} missing source IDs`;
  return `${receipt.recordsParsed} ${receipt.recordsParsed === 1 ? 'record' : 'records'} parsed; ${missing}`;
}

async function uploadVerdict(ctx: AppContext, user: UserRow, dataset: DatasetRow): Promise<Verdict> {
  if (dataset.deleted_at) return { allowed: false, reason: DELETED_NO_VERSIONS };
  return canCreateInWorkspace(ctx, user, dataset.workspace_id);
}

const createSchema = z.object({
  draftId: z.string({ error: 'Upload a file before creating a dataset.' }).min(1, 'Upload a file before creating a dataset.'),
  name: z.string().optional(),
  version: z.string().optional(),
  provenance: z.string().optional(),
  domainId: z.string().optional(),
  rightsAck: z.boolean().optional(),
  expectedCode: z.string().optional(),
});

const deleteSchema = z.object({
  confirmCode: z.string().optional(),
  acknowledged: z.boolean().optional(),
});

/* ---------- Routes ---------- */

export function registerDatasets(app: Hono<AppEnv>) {
  app.get('/api/datasets', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const requested = c.req.query('visibility');
    const filter: DatasetFilter = requested === 'shared' || requested === 'all' ? requested : 'private';
    const workspace = await activeWorkspaceOf(ctx, user);

    const conditions: string[] = [];
    const params: string[] = [];
    if (filter !== 'shared' && workspace) {
      // private: this workspace's private entries. all: everything in this workspace.
      conditions.push(filter === 'private' ? `(d.workspace_id = ? AND d.visibility = 'private')` : `d.workspace_id = ?`);
      params.push(workspace.id);
    }
    if (filter !== 'private') conditions.push(`d.visibility = 'shared'`);

    const rows = conditions.length
      ? await ctx.db.all<DatasetRow & { owner_name: string; workspace_name: string }>(
          `SELECT d.*, u.name AS owner_name, w.name AS workspace_name
           FROM datasets d JOIN users u ON u.id = d.owner_id JOIN workspaces w ON w.id = d.workspace_id
           WHERE d.deleted_at IS NULL AND (${conditions.join(' OR ')})
           ORDER BY d.created_at DESC, d.code`,
          params,
        )
      : [];

    const items: DatasetListItem[] = [];
    for (const row of rows) {
      // The list re-checks each row, so a permission change applies on the next request.
      const verdict = await canReadDataset(ctx, user, row);
      if (!verdict.allowed) continue;
      const [latest] = await versionsOf(ctx, row.id);
      if (!latest) continue;
      const member = Boolean(await workspaceRole(ctx, user.id, row.workspace_id));
      items.push({
        code: row.code,
        name: row.name,
        visibility: row.visibility,
        version: latest.version,
        format: latest.format,
        size: latest.size,
        recordsCount: latest.records_count,
        attachment: attachmentLabel(await referencesOf(ctx, row, member), Boolean(latest.is_synthetic)),
        isSynthetic: Boolean(latest.is_synthetic),
        ownerName: row.owner_name,
        workspaceName: row.workspace_name,
        inActiveWorkspace: row.workspace_id === workspace?.id,
        downloadPath: downloadPath(row.code, latest.version),
      });
    }

    const response: DatasetListResponse = {
      workspace: workspace ? toWorkspace(workspace) : null,
      filter,
      items,
      activity: workspace ? await activityFor(ctx, workspace.id) : [],
      canCreate: workspace ? await canCreateInWorkspace(ctx, user, workspace.id) : { allowed: false, reason: NO_WORKSPACE },
    };
    return c.json(response);
  });

  app.get('/api/datasets/upload-context', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const workspace = await activeWorkspaceOf(ctx, user);
    const domainRows = await ctx.db.all<{ id: string; name: string; prefix: string }>('SELECT id, name, prefix FROM domains ORDER BY sort');
    const domains: UploadDomain[] = [];
    for (const domain of domainRows) {
      domains.push({ id: domain.id, name: domain.name, prefix: domain.prefix, nextCode: datasetCode(domain.prefix, await peekCounter(ctx, `dataset:${domain.prefix}`)) });
    }

    let target: UploadTarget | null = null;
    const code = c.req.query('dataset');
    if (code) {
      const dataset = await getDataset(ctx, code);
      if (!dataset) throw notFound();
      const verdict = await canReadDataset(ctx, user, dataset);
      if (!verdict.allowed) throw notFound();
      const versions = await versionsOf(ctx, dataset.id);
      const latest = versions[0];
      const domain = domainRows.find((row) => row.id === dataset.domain_id);
      target = {
        code: dataset.code,
        name: dataset.name,
        domainName: domain?.name ?? dataset.domain_id,
        provenance: dataset.provenance,
        latestVersion: latest?.version ?? '',
        nextVersion: latest ? nextVersion(latest.version) : '1.0',
        versions: versions.map((row) => row.version),
        canUpload: await uploadVerdict(ctx, user, dataset),
      };
    }

    const response: UploadContext = {
      workspace: workspace ? toWorkspace(workspace) : null,
      ownerName: user.name,
      maxBytes: MAX_UPLOAD_BYTES,
      formats: ['CSV', 'JSONL', 'PDF'],
      domains,
      defaultDomainId: domainRows[0]?.id ?? '',
      target,
      canCreate: workspace ? await canCreateInWorkspace(ctx, user, workspace.id) : { allowed: false, reason: NO_WORKSPACE },
    };
    return c.json(response);
  });

  app.post('/api/datasets/uploads', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) throw badRequest('Send the file as multipart form data.');

    let body: Record<string, string | File>;
    try {
      body = (await c.req.parseBody()) as Record<string, string | File>;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw badRequest('This upload could not be read. Try again.');
    }
    const file = body.file;
    if (!(file instanceof File)) throw invalid({ file: 'Choose a CSV, JSONL or PDF file to upload.' });
    if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', TOO_LARGE);

    // Where the upload goes: a new version of an existing dataset, or a new dataset in the active workspace.
    const targetCode = typeof body.dataset === 'string' && body.dataset ? body.dataset : null;
    let target: DatasetRow | null = null;
    let workspaceId: string;
    if (targetCode) {
      target = (await getDataset(ctx, targetCode)) ?? null;
      if (!target || !(await canReadDataset(ctx, user, target)).allowed) throw notFound();
      const verdict = await uploadVerdict(ctx, user, target);
      if (!verdict.allowed) throw forbidden(verdict.reason);
      workspaceId = target.workspace_id;
    } else {
      const workspace = await activeWorkspaceOf(ctx, user);
      if (!workspace) throw forbidden(NO_WORKSPACE);
      workspaceId = workspace.id;
    }

    const filename = safeFilename(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = sha256Hex(bytes);
    const validated = validateDatasetFile({ bytes, filename });
    let receipt = validated.receipt;
    let records: DatasetRecord[] = validated.records;

    if (target) {
      const reason = identicalBytesReason(target.code, await versionsOf(ctx, target.id), sha256);
      if (reason) receipt = { ...receipt, failures: [...(receipt.failures ?? []), { code: 'identical_bytes', message: reason }], passed: false };
    }
    if (!receipt.passed) records = [];

    // A file that fails validation may hold exactly what should not be kept, so its bytes are not stored.
    let uploadId: string | null = null;
    if (receipt.passed) {
      const stored = await ctx.storage.put(bytes);
      uploadId = newId();
      await ctx.db.run(`INSERT INTO uploads (id, sha256, filename, size, mime, owner_id, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?, 'dataset', ?)`, [uploadId, stored.sha256, filename, stored.size, file.type || (receipt.format === 'unknown' ? 'application/octet-stream' : contentTypes[receipt.format]), user.id, nowIso(ctx)]);
    }

    const id = newId();
    const created = nowIso(ctx);
    await ctx.db.tx(async () => {
      // One open upload per person and destination: choosing another file replaces the last one.
      await ctx.db.run(
        `DELETE FROM dataset_drafts WHERE user_id = ? AND workspace_id = ? AND consumed_at IS NULL AND ${target ? 'target_dataset_id = ?' : 'target_dataset_id IS NULL'}`,
        target ? [user.id, workspaceId, target.id] : [user.id, workspaceId],
      );
      await ctx.db.run(
        `INSERT INTO dataset_drafts (id, workspace_id, user_id, upload_id, target_dataset_id, filename, size, sha256, format, records_count, records, receipt, passed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, workspaceId, user.id, uploadId, target?.id ?? null, filename, bytes.length, sha256, receipt.format, receipt.recordsParsed, JSON.stringify(records), JSON.stringify(receipt), receipt.passed ? 1 : 0, created],
      );
      await logActivity(ctx, { workspaceId, datasetId: target?.id ?? null, kind: 'Upload', message: `${user.name} uploaded ${filename}`, actorId: user.id });
      await logActivity(ctx, {
        workspaceId,
        datasetId: target?.id ?? null,
        kind: 'Validation',
        message: receipt.passed ? validationMessage(receipt) : `${filename} failed validation: ${receipt.failures?.[0]?.message ?? 'see the receipt'}`,
        actorId: user.id,
      });
    });
    const row = await ctx.db.get<DraftRow>('SELECT * FROM dataset_drafts WHERE id = ?', [id]);
    return c.json(await draftResponse(ctx, row as DraftRow), 201);
  });

  const ownDraft = async (c: C): Promise<{ ctx: AppContext; user: UserRow; draft: DraftRow }> => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const draft = await ctx.db.get<DraftRow>('SELECT * FROM dataset_drafts WHERE id = ?', [c.req.param('id') as string]);
    if (!draft || draft.user_id !== user.id || draft.consumed_at) throw notFound('This upload is no longer available. Choose the file again.');
    if (!(await workspaceRole(ctx, user.id, draft.workspace_id))) throw notFound('This upload is no longer available. Choose the file again.');
    return { ctx, user, draft };
  };

  app.get('/api/datasets/uploads/:id', async (c) => {
    const { ctx, draft } = await ownDraft(c);
    return c.json(await draftResponse(ctx, draft));
  });

  app.delete('/api/datasets/uploads/:id', async (c) => {
    const { ctx, draft } = await ownDraft(c);
    await ctx.db.run('DELETE FROM dataset_drafts WHERE id = ? AND consumed_at IS NULL', [draft.id]);
    return c.body(null, 204);
  });

  app.post('/api/datasets', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const input = await readJson(c, createSchema);

    const draft = await ctx.db.get<DraftRow>('SELECT * FROM dataset_drafts WHERE id = ?', [input.draftId]);
    if (!draft || draft.user_id !== user.id) throw notFound('This upload is no longer available. Choose the file again.');
    if (draft.consumed_at) throw conflict('This upload has already created a dataset version. Choose a new file to upload again.', 'draft_used');
    if (!draft.passed) {
      const failures = (parseReceipt(draft.receipt).failures ?? []).map((failure) => failure.message);
      throw new HttpError(422, 'validation_failed', `This file failed validation, so it cannot create a dataset. ${failures.join(' ')}`.trim());
    }
    const membership = await canCreateInWorkspace(ctx, user, draft.workspace_id);
    if (!membership.allowed) throw forbidden(membership.reason);

    const target = draft.target_dataset_id ? ((await ctx.db.get<DatasetRow>('SELECT * FROM datasets WHERE id = ?', [draft.target_dataset_id])) ?? null) : null;
    if (target?.deleted_at) throw conflict(DELETED_NO_VERSIONS, 'dataset_deleted');
    const existing = target ? await versionsOf(ctx, target.id) : [];

    const fields: Record<string, string> = {};
    const name = (input.name ?? '').trim();
    const provenance = (input.provenance ?? '').trim();
    const version = (input.version ?? '').trim();
    if (!target && !name) fields.name = 'Enter a dataset name to continue.';
    else if (!target && name.length > 120) fields.name = 'Keep the dataset name under 120 characters.';
    if (!provenance) fields.provenance = 'Describe where this file came from to continue.';
    else if (provenance.length > 2000) fields.provenance = 'Keep the provenance statement under 2,000 characters.';
    if (!VERSION_PATTERN.test(version)) fields.version = 'Enter a version such as 1.0.';
    else if (existing.some((row) => compareVersions(row.version, version) === 0)) fields.version = `Version ${version} already exists. Existing snapshots are never replaced.`;
    else if (existing[0] && compareVersions(version, existing[0].version) < 0) fields.version = `Use a version after ${existing[0].version}.`;
    if (input.rightsAck !== true) fields.rightsAck = 'Confirm you have permission to upload this file.';

    let domain: { id: string; prefix: string } | undefined;
    if (!target) {
      domain = await ctx.db.get<{ id: string; prefix: string }>('SELECT id, prefix FROM domains WHERE id = ?', [input.domainId ?? '']);
      if (!domain) fields.domainId = 'Choose a domain for this dataset.';
    }
    if (Object.keys(fields).length) throw invalid(fields);

    if (target) {
      const reason = identicalBytesReason(target.code, existing, draft.sha256);
      if (reason) throw conflict(reason, 'identical_bytes');
    }
    // A version may only pin bytes that still match what was validated.
    if (!(await storedBytesMatch(ctx.storage, draft.sha256))) throw conflict('The uploaded bytes no longer match what was validated. Choose the file again.', 'hash_mismatch');

    const workspace = await ctx.db.get<{ default_visibility: DatasetVisibility }>('SELECT default_visibility FROM workspaces WHERE id = ?', [draft.workspace_id]);
    const receipt = parseReceipt(draft.receipt);
    const isSynthetic = receipt.synthetic === true;
    const created = nowIso(ctx);

    const result = await ctx.db.tx(async (): Promise<{ code: string; datasetId: string; versionId: string }> => {
      // Writes queue, so these re-checks settle a double click or two people racing for the same version.
      const fresh = await ctx.db.get<{ consumed_at: string | null }>('SELECT consumed_at FROM dataset_drafts WHERE id = ?', [draft.id]);
      if (!fresh || fresh.consumed_at) throw conflict('This upload has already created a dataset version. Choose a new file to upload again.', 'draft_used');
      if (target) {
        const current = await ctx.db.all<{ version: string; sha256: string }>('SELECT version, sha256 FROM dataset_versions WHERE dataset_id = ?', [target.id]);
        const reason = identicalBytesReason(target.code, current, draft.sha256);
        if (reason) throw conflict(reason, 'identical_bytes');
        if (current.some((row) => compareVersions(row.version, version) === 0)) throw invalid({ version: `Version ${version} already exists. Existing snapshots are never replaced.` });
      }
      let code: string;
      let datasetId: string;
      if (target) {
        code = target.code;
        datasetId = target.id;
        await ctx.db.run('UPDATE datasets SET provenance = ?, is_synthetic = ? WHERE id = ?', [provenance, isSynthetic ? 1 : 0, target.id]);
      } else {
        const prefix = (domain as { prefix: string }).prefix;
        const counter = `dataset:${prefix}`;
        // The button promises a code. If someone else took it first, say so rather than create a different one.
        const planned = datasetCode(prefix, await peekCounter(ctx, counter));
        if (input.expectedCode && input.expectedCode !== planned) throw conflict(`The next code is now ${planned}. Check the button and confirm again.`, 'code_changed');
        code = datasetCode(prefix, await nextCounter(ctx.db, counter));
        datasetId = newId();
        await ctx.db.run(
          `INSERT INTO datasets (id, code, workspace_id, owner_id, domain_id, name, provenance, visibility, is_synthetic, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [datasetId, code, draft.workspace_id, user.id, (domain as { id: string }).id, name, provenance, workspace?.default_visibility ?? 'private', isSynthetic ? 1 : 0, created],
        );
      }
      const versionId = newId();
      await ctx.db.run(
        `INSERT INTO dataset_versions (id, dataset_id, version, upload_id, filename, size, format, sha256, records_count, records, receipt, provenance, is_synthetic, rights_ack, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [versionId, datasetId, version, draft.upload_id, draft.filename, draft.size, draft.format, draft.sha256, draft.records_count, draft.records, draft.receipt, provenance, isSynthetic ? 1 : 0, user.id, created],
      );
      await ctx.db.run(`UPDATE dataset_drafts SET consumed_at = ?, consumed_version_id = ?, records = '[]' WHERE id = ?`, [created, versionId, draft.id]);
      await logActivity(ctx, { workspaceId: draft.workspace_id, datasetId, kind: 'Upload', message: `${code} v${version} created from ${draft.filename}`, actorId: user.id });
      await audit(ctx, {
        actorId: user.id,
        action: target ? 'dataset.version_created' : 'dataset.created',
        subjectType: 'dataset',
        subjectId: datasetId,
        subjectCode: code,
        workspaceId: draft.workspace_id,
        detail: { version, sha256: draft.sha256, filename: draft.filename, size: draft.size, format: draft.format, rightsAttested: true },
      });
      return { code, datasetId, versionId };
    });

    const response: CreateDatasetResponse = { code: result.code, version };
    return c.json(response, 201);
  });

  app.get('/api/datasets/:code', async (c) => {
    const { ctx, user, dataset, member } = await readableDataset(c, c.req.param('code'));
    const versions = await versionsOf(ctx, dataset.id);
    const requested = c.req.query('version');
    const current = requested ? versions.find((row) => row.version === requested) : versions[0];
    if (!current) throw notFound('This dataset version does not exist.');

    const recordsRow = await ctx.db.get<{ records: string }>('SELECT records FROM dataset_versions WHERE id = ?', [current.id]);
    const records = JSON.parse(recordsRow?.records ?? '[]') as DatasetRecord[];
    const references = await referencesOf(ctx, dataset, member);
    const owner = await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [dataset.owner_id]);
    const domain = await ctx.db.get<{ name: string }>('SELECT name FROM domains WHERE id = ?', [dataset.domain_id]);
    const workspace = await ctx.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [dataset.workspace_id]);
    const deletedBy = dataset.deleted_by ? await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [dataset.deleted_by]) : undefined;
    const pinnedBy = (version: string) => references.frozen.filter((row) => row.datasetVersion === version).map((row) => `${row.code} v${row.version}`);

    const deleteVerdict = await canDeleteDataset(ctx, user, dataset);
    const detail: DatasetDetail = {
      code: dataset.code,
      name: dataset.name,
      domainName: domain?.name ?? dataset.domain_id,
      visibility: dataset.visibility,
      ownerName: owner?.name ?? '',
      workspaceName: workspace?.name ?? '',
      deleted: dataset.deleted_at ? { at: dataset.deleted_at, byName: deletedBy?.name ?? null } : null,
      version: {
        version: current.version,
        filename: current.filename,
        format: current.format,
        size: current.size,
        sha256: current.sha256,
        // Recomputed on every request: this is what lets the page say the download is verified.
        verified: await storedBytesMatch(ctx.storage, current.sha256),
        recordsCount: current.records_count,
        isSynthetic: Boolean(current.is_synthetic),
        provenance: current.provenance || dataset.provenance,
        createdAt: current.created_at,
        createdByName: current.created_by_name,
        isLatest: current.id === versions[0]?.id,
        receipt: parseReceipt(current.receipt),
        rows: records.slice(0, MAX_DISPLAY_ROWS).map((record, index) => ({ key: `${index}-${record.source_id ?? ''}`, ...displayRow(record) })),
        rowsTotal: records.length,
        hasLimits: records.some((record) => Boolean(record.limit?.trim())),
        pinnedBy: pinnedBy(current.version),
        downloadPath: downloadPath(dataset.code, current.version),
        manifestPath: manifestPath(dataset.code, current.version),
      },
      versions: versions.map(
        (row): DatasetVersionSummary => ({
          version: row.version,
          filename: row.filename,
          format: row.format,
          size: row.size,
          sha256: row.sha256,
          recordsCount: row.records_count,
          createdAt: row.created_at,
          createdByName: row.created_by_name,
          pinnedBy: pinnedBy(row.version),
          isCurrent: row.id === current.id,
        }),
      ),
      canDelete: dataset.deleted_at ? { allowed: false, reason: 'This dataset was already deleted from the library.' } : deleteVerdict,
      canUploadVersion: await uploadVerdict(ctx, user, dataset),
    };
    return c.json(detail);
  });

  /** The version to serve, with its bytes re-hashed. A mismatch is refused and recorded. */
  const verifiedVersion = async (c: C) => {
    const { ctx, user, dataset, member } = await readableDataset(c, c.req.param('code') as string);
    const version = await ctx.db.get<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM dataset_versions v JOIN users u ON u.id = v.created_by WHERE v.dataset_id = ? AND v.version = ?`, [dataset.id, c.req.param('version') as string]);
    if (!version) throw notFound('This dataset version does not exist.');
    const matches = await storedBytesMatch(ctx.storage, version.sha256);
    if (!matches) {
      await audit(ctx, {
        actorId: user.id,
        action: 'dataset.hash_mismatch',
        subjectType: 'dataset',
        subjectId: dataset.id,
        subjectCode: dataset.code,
        workspaceId: dataset.workspace_id,
        detail: { version: version.version, sha256: version.sha256 },
      });
    }
    return { ctx, user, dataset, member, version, matches };
  };

  /** A browser following a download link goes to the page that explains; an API client gets the error. */
  const refuseMismatch = (c: C, dataset: DatasetRow, version: VersionRow) => {
    if ((c.req.header('accept') ?? '').includes('text/html')) return c.redirect(`/datasets/${dataset.code}?version=${encodeURIComponent(version.version)}`, 302);
    throw conflict(`The stored bytes for ${dataset.code} v${version.version} no longer match their SHA-256, so this download is refused.`, 'hash_mismatch');
  };

  app.get('/api/datasets/:code/versions/:version/download', async (c) => {
    const { ctx, user, dataset, version, matches } = await verifiedVersion(c);
    if (!matches) return refuseMismatch(c, dataset, version);
    if (c.req.method === 'GET') await logActivity(ctx, { workspaceId: dataset.workspace_id, datasetId: dataset.id, kind: 'Download', message: `${user.name} downloaded ${dataset.code} v${version.version}`, actorId: user.id });
    return c.body(ctx.storage.stream(version.sha256), 200, attachmentHeaders(version.filename, contentTypes[version.format], { 'Content-Length': String(version.size), 'X-Rivet-SHA256': version.sha256 }));
  });

  app.get('/api/datasets/:code/versions/:version/manifest', async (c) => {
    const { ctx, dataset, member, version, matches } = await verifiedVersion(c);
    if (!matches) return refuseMismatch(c, dataset, version);
    const references = await referencesOf(ctx, dataset, member);
    const domain = await ctx.db.get<{ name: string }>('SELECT name FROM domains WHERE id = ?', [dataset.domain_id]);
    const workspace = await ctx.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [dataset.workspace_id]);
    const receipt = parseReceipt(version.receipt);
    const manifest = {
      schema: 'rivet.dataset_version.v1',
      dataset: { code: dataset.code, name: dataset.name, domain: domain?.name ?? dataset.domain_id, workspace: workspace?.name ?? '', visibility: dataset.visibility },
      version: {
        version: version.version,
        filename: version.filename,
        format: version.format,
        size: version.size,
        records: version.records_count,
        columns: receipt.columns ?? [],
        provenance: version.provenance || dataset.provenance,
        synthetic: Boolean(version.is_synthetic),
        createdBy: version.created_by_name,
        createdAt: version.created_at,
      },
      checksum: {
        algorithm: 'SHA-256',
        value: version.sha256,
        // The format sha256sum -c reads.
        line: `${version.sha256}  ${version.filename}`,
        verifiedAt: nowIso(ctx),
      },
      validation: receipt,
      pinnedBy: references.frozen.filter((row) => row.datasetVersion === version.version).map((row) => `${row.code} v${row.version}`),
    };
    return c.body(`${JSON.stringify(manifest, null, 2)}\n`, 200, attachmentHeaders(`${dataset.code}-v${version.version}.manifest.json`, 'application/json; charset=utf-8'));
  });

  app.get('/api/datasets/:code/deletion', async (c) => {
    const { ctx, user, dataset, member } = await readableDataset(c, c.req.param('code'));
    const [latest] = await versionsOf(ctx, dataset.id);
    const references = await referencesOf(ctx, dataset, member);
    const owner = await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [dataset.owner_id]);
    const anyFrozen = references.frozen.length > 0 || references.traces.length > 0;
    const verdict = dataset.deleted_at ? ({ allowed: false, reason: 'This dataset was already deleted from the library.' } satisfies Verdict) : await canDeleteDataset(ctx, user, dataset);
    const deletion: DatasetDeletion = {
      code: dataset.code,
      name: dataset.name,
      version: latest?.version ?? '',
      ownerName: owner?.name ?? '',
      canDelete: verdict,
      references: {
        frozenTasks: references.frozen.map((row) => `${row.code} v${row.version}`),
        draftTasks: references.drafts,
        reports: references.reports,
        traces: references.traces,
      },
      impact: {
        library: 'Removed',
        attachments: 'Prevented',
        snapshots: anyFrozen ? 'Retained for authorized audit' : 'None reference this dataset. Versions and bytes are still kept for audit',
        reports: references.reports.length ? 'Unchanged' : 'None reference this dataset',
      },
    };
    return c.json(deletion);
  });

  app.delete('/api/datasets/:code', async (c) => {
    const { ctx, user, dataset } = await readableDataset(c, c.req.param('code'));
    const verdict = await canDeleteDataset(ctx, user, dataset);
    if (!verdict.allowed) throw forbidden(verdict.reason);
    if (dataset.deleted_at) throw conflict('This dataset was already deleted from the library.', 'already_deleted');

    const input = await readJson(c, deleteSchema);
    const fields: Record<string, string> = {};
    if ((input.confirmCode ?? '').trim() !== dataset.code) fields.confirmCode = `Type ${dataset.code} exactly to confirm.`;
    if (input.acknowledged !== true) fields.acknowledged = 'Tick this box to confirm you understand what deletion does.';
    if (Object.keys(fields).length) throw invalid(fields);

    const now = nowIso(ctx);
    const references = await referencesOf(ctx, dataset, true);
    await ctx.db.tx(async () => {
      // Only the library entry changes. Version rows and bytes stay for audit; their tables refuse deletes anyway.
      await ctx.db.run('UPDATE datasets SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL', [now, user.id, dataset.id]);
      await logActivity(ctx, { workspaceId: dataset.workspace_id, datasetId: dataset.id, kind: 'Deletion', message: `${user.name} deleted ${dataset.code} from the library`, actorId: user.id });
      await audit(ctx, {
        actorId: user.id,
        action: 'dataset.deleted',
        subjectType: 'dataset',
        subjectId: dataset.id,
        subjectCode: dataset.code,
        workspaceId: dataset.workspace_id,
        detail: { retained: { frozenTasks: references.frozen.map((row) => `${row.code} v${row.version}`), reports: references.reports, traces: references.traces } },
      });
    });
    return c.json({ code: dataset.code, deletedAt: now });
  });
}
