import type { CheckFailure, CheckStatus, CheckTone, OperationalEvent } from '../../shared/types/admin.ts';
import type { AppContext, UserRow } from '../context.ts';
import { audit } from '../lib/audit.ts';
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import { reportHash, taskVersionHash, traceHash, verifyEvidenceRow } from '../lib/evidence.ts';
import { newId, nextCounter, pad3 } from '../lib/ids.ts';
import { canReadDataset, canReadTask, canReviewTask, type TaskAccessRow, type Verdict } from '../lib/permissions.ts';
import { authorizationRedirect, exchangeAuthorizationCode, isS256Challenge, isWellFormedState, issueAuthorizationCode, redirectMatches, validateAuthorizationParams, verifyPkce, type ExchangeResult } from '../routes/external.ts';

/**
 * System checks. Each one does the real work on this request: recomputes hashes, attempts the writes the
 * triggers must refuse, asks the permission functions, and redeems authorization codes. Anything a check
 * creates lives in a transaction that always rolls back, so running them never changes the database.
 */

export const TIMEOUT_THRESHOLD_PERCENT = 3;

export interface CheckOutcome {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  failures: CheckFailure[];
  data: Record<string, unknown>;
}

/** The functions under test. Tests pass broken ones to prove a check notices. */
export interface CheckDependencies {
  canReadTask: (ctx: AppContext, user: UserRow, task: TaskAccessRow) => Promise<Verdict>;
  canReadDataset: (ctx: AppContext, user: UserRow, dataset: { workspace_id: string; visibility: string; deleted_at?: string | null }) => Promise<Verdict>;
  canReviewTask: (ctx: AppContext, user: UserRow, task: Pick<TaskAccessRow, 'owner_id' | 'domain_id'>) => Promise<Verdict>;
  verifyPkce: (verifier: string, challenge: string) => boolean;
  validateAuthorizationParams: typeof validateAuthorizationParams;
  redirectMatches: (registered: string, presented: string | undefined) => boolean;
  authorizationRedirect: (redirectUri: string, params: Record<string, string>) => string;
  exchangeAuthorizationCode: (ctx: AppContext, input: { clientRowId: string; code: string; redirectUri: string; codeVerifier: string }) => Promise<ExchangeResult>;
}

export const realDependencies: CheckDependencies = { canReadTask, canReadDataset, canReviewTask, verifyPkce, validateAuthorizationParams, redirectMatches, authorizationRedirect, exchangeAuthorizationCode };

/* ---------- A transaction that always rolls back ---------- */

class AlwaysRollBack extends Error {}

async function inRollback<T>(ctx: AppContext, work: () => Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await ctx.db.tx(async () => {
      // Fixtures may point at rows that do not exist. The check never commits, so it never matters.
      await ctx.db.exec('PRAGMA defer_foreign_keys = ON');
      result = { value: await work() };
      throw new AlwaysRollBack();
    });
  } catch (error) {
    if (!(error instanceof AlwaysRollBack)) throw error;
  }
  return (result as { value: T }).value;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/* ---------- 1. Artifact hashes ---------- */

export async function checkArtifactHashes(ctx: AppContext): Promise<CheckOutcome> {
  const { db, storage } = ctx;
  const failures: CheckFailure[] = [];
  const counts: Record<string, number> = { evidence: 0, reports: 0, traces: 0, taskVersions: 0, datasetVersions: 0 };
  let verified = 0;
  let total = 0;
  const tally = (kind: keyof typeof counts, subject: string, reason: string | null) => {
    total += 1;
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (reason) failures.push({ subject, reason });
    else verified += 1;
  };

  for (const row of await db.all<any>('SELECT * FROM evidence ORDER BY code')) {
    let ok = false;
    try {
      ok = await verifyEvidenceRow(db, row);
    } catch {
      ok = false;
    }
    tally('evidence', row.code, ok ? null : 'Evidence seal does not match its stored fields');
  }

  for (const row of await db.all<any>('SELECT * FROM reports ORDER BY code, version')) {
    const subject = `${row.code} v${row.version}`;
    let reason: string | null = null;
    if (reportHash(row.canonical) !== row.sha256) reason = 'Report hash does not match its canonical manifest';
    else {
      try {
        // The manifest is what the hash covers. The columns a page reads must still say the same.
        const canonical = JSON.parse(row.canonical) as Record<string, unknown>;
        for (const field of ['headline', 'summary', 'limitations', 'citation']) {
          if (field in canonical && canonical[field] !== row[field]) reason = `Report ${field} differs from its canonical manifest`;
        }
        if ('scores' in canonical && canonicalJson(canonical.scores) !== canonicalJson(JSON.parse(row.scores))) reason = 'Report scores differ from its canonical manifest';
      } catch {
        reason = 'Report manifest could not be read';
      }
    }
    tally('reports', subject, reason);
  }

  for (const row of await db.all<any>('SELECT * FROM traces ORDER BY code')) {
    let ok = false;
    try {
      ok = traceHash({ code: row.code, agent_label: row.agent_label, harness_version: row.harness_version, steps: JSON.parse(row.steps) }) === row.sha256;
    } catch {
      ok = false;
    }
    tally('traces', row.code, ok ? null : 'Trace hash does not match its stored steps');
  }

  const versions = await db.all<any>(
    `SELECT tv.*, t.code AS task_code, s.code AS scan_code, dv.sha256 AS dataset_sha256
     FROM task_versions tv JOIN tasks t ON t.id = tv.task_id
     LEFT JOIN scans s ON s.id = tv.scan_id LEFT JOIN dataset_versions dv ON dv.id = tv.dataset_version_id
     ORDER BY t.code, tv.version`,
  );
  for (const row of versions) {
    let ok = false;
    try {
      ok =
        taskVersionHash({
          task_code: row.task_code,
          version: row.version,
          title: row.title,
          prompt: row.prompt,
          rubric: JSON.parse(row.rubric),
          models: JSON.parse(row.models),
          settings: JSON.parse(row.settings),
          dataset_sha256: row.dataset_sha256 ?? null,
          scan_code: row.scan_code ?? null,
          acknowledgements: JSON.parse(row.acknowledgements),
        }) === row.sha256;
    } catch {
      ok = false;
    }
    tally('taskVersions', `${row.task_code} v${row.version}`, ok ? null : 'Frozen task version does not match its hash');
  }

  const datasets = await db.all<{ code: string; version: string; sha256: string; size: number }>(
    `SELECT d.code, dv.version, dv.sha256, dv.size FROM dataset_versions dv JOIN datasets d ON d.id = dv.dataset_id ORDER BY d.code, dv.version`,
  );
  for (const row of datasets) {
    const subject = `${row.code} v${row.version}`;
    let reason: string | null = null;
    try {
      const bytes = await storage.read(row.sha256);
      if (sha256Hex(bytes) !== row.sha256) reason = 'Stored bytes do not match the dataset hash';
      else if (bytes.length !== row.size) reason = 'Stored bytes do not match the recorded size';
    } catch {
      reason = 'Stored bytes are missing';
    }
    tally('datasetVersions', subject, reason);
  }

  return {
    key: 'artifact_hashes',
    label: 'Artifact hashes',
    status: failures.length ? 'failed' : 'passed',
    detail: `${failures.length ? 'Failed' : 'Passed'} · ${verified} of ${total} verified`,
    failures,
    data: { verified, total, counts },
  };
}

/* ---------- 2. Immutability ---------- */

export const IMMUTABLE_TABLES = ['task_versions', 'evidence', 'reports', 'adjudications', 'trace_adjudications', 'traces', 'gate_runs', 'dataset_versions', 'model_revisions', 'audit_log'] as const;

/** CHECK constraints a probe row has to satisfy on a table with no rows to attempt on. */
const PROBE_VALUES: Record<string, Record<string, string>> = {
  adjudications: { decision: 'accept' },
  trace_adjudications: { kind: 'finding' },
  gate_runs: { status: 'passed' },
  dataset_versions: { format: 'csv' },
};

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

async function insertProbeRow(ctx: AppContext, table: string, columns: ColumnInfo[]): Promise<void> {
  const needed = columns.filter((column) => column.pk || (column.notnull && column.dflt_value === null));
  const values = needed.map((column) => {
    const preset = PROBE_VALUES[table]?.[column.name];
    if (preset !== undefined) return preset;
    return /INT|REAL|NUM/i.test(column.type) ? 0 : `check-probe-${newId()}`;
  });
  await ctx.db.run(`INSERT INTO ${table} (${needed.map((column) => column.name).join(', ')}) VALUES (${needed.map(() => '?').join(', ')})`, values);
}

async function attemptRefused(work: () => Promise<{ changes: number }>): Promise<{ refused: boolean; message: string }> {
  try {
    const { changes } = await work();
    return { refused: false, message: `The write succeeded and changed ${changes} row${changes === 1 ? '' : 's'}` };
  } catch (error) {
    const message = errorMessage(error);
    return /immutable|append-only/i.test(message) ? { refused: true, message } : { refused: false, message: `Refused by something other than the trigger: ${message}` };
  }
}

export async function checkImmutability(ctx: AppContext): Promise<CheckOutcome> {
  const { db } = ctx;
  const failures: CheckFailure[] = [];
  const results: Record<string, unknown>[] = [];
  await inRollback(ctx, async () => {
    for (const table of IMMUTABLE_TABLES) {
      const columns = await db.all<ColumnInfo>(`PRAGMA table_info(${table})`);
      if (!columns.length) {
        failures.push({ subject: table, reason: 'The table does not exist' });
        continue;
      }
      let target = await db.get<{ rid: number }>(`SELECT rowid AS rid FROM ${table} LIMIT 1`);
      let exercised = 'existing row';
      if (!target) {
        await insertProbeRow(ctx, table, columns);
        target = await db.get<{ rid: number }>(`SELECT rowid AS rid FROM ${table} LIMIT 1`);
        exercised = 'probe row';
      }
      const rid = (target as { rid: number }).rid;
      const column = columns.find((item) => !item.pk) as ColumnInfo;
      const mutated = /INT|REAL|NUM/i.test(column.type) ? `${column.name} + 1` : `COALESCE(${column.name}, '') || ' tampered'`;
      const update = await attemptRefused(() => db.run(`UPDATE ${table} SET ${column.name} = ${mutated} WHERE rowid = ?`, [rid]));
      const remove = await attemptRefused(() => db.run(`DELETE FROM ${table} WHERE rowid = ?`, [rid]));
      results.push({ table, exercised, update: update.refused ? 'refused' : 'accepted', delete: remove.refused ? 'refused' : 'accepted' });
      if (!update.refused) failures.push({ subject: `${table} UPDATE`, reason: update.message });
      if (!remove.refused) failures.push({ subject: `${table} DELETE`, reason: remove.message });
    }
  });
  return {
    key: 'immutability',
    label: 'Immutability',
    status: failures.length ? 'failed' : 'passed',
    detail: failures.length ? `Failed · ${failures.length} frozen-table ${failures.length === 1 ? 'write' : 'writes'} not refused` : 'Passed · No frozen-version mutation',
    failures,
    data: { tables: results },
  };
}

/* ---------- Fixtures shared by the checks below. Only ever created inside inRollback(). ---------- */

function fixtureUser(ctx: AppContext, role: 'member' | 'admin' = 'member'): UserRow {
  const id = newId();
  const now = ctx.now().toISOString();
  return { id, email: `check-probe-${id}@checks.invalid`, name: 'Check probe', password_hash: null, email_verified_at: now, role, bio: '', active_workspace_id: null, terms_accepted_at: now, is_synthetic: 1, created_at: now, updated_at: now };
}

async function insertUser(ctx: AppContext, user: UserRow): Promise<UserRow> {
  await ctx.db.run(
    `INSERT INTO users (id, email, name, password_hash, email_verified_at, role, bio, terms_accepted_at, is_synthetic, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.id, user.email, user.name, user.password_hash, user.email_verified_at, user.role, user.bio, user.terms_accepted_at, user.is_synthetic, user.created_at, user.updated_at],
  );
  return user;
}

async function insertWorkspace(ctx: AppContext, ownerId: string): Promise<string> {
  const id = newId();
  await ctx.db.run(`INSERT INTO workspaces (id, code, name, slug, owner_id, is_synthetic, created_at) VALUES (?, ?, 'Check probe', ?, ?, 1, ?)`, [id, `WS-PROBE-${id}`, `check-probe-${id}`, ownerId, ctx.now().toISOString()]);
  return id;
}

async function insertMembership(ctx: AppContext, workspaceId: string, userId: string, status: 'active' | 'removed', role: 'owner' | 'member' = 'member'): Promise<void> {
  await ctx.db.run(
    `INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role, status = excluded.status, removed_at = excluded.removed_at`,
    [newId(), workspaceId, userId, role, status, ctx.now().toISOString(), status === 'removed' ? ctx.now().toISOString() : null],
  );
}

async function insertTask(ctx: AppContext, spec: { workspaceId: string; ownerId: string; domainId: string; visibility: 'private' | 'shared'; status: 'draft' | 'frozen' }): Promise<TaskAccessRow> {
  const id = newId();
  const now = ctx.now().toISOString();
  const code = `CHECK-PROBE-${id}`;
  await ctx.db.run(`INSERT INTO tasks (id, code, workspace_id, owner_id, domain_id, visibility, status, is_synthetic, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [id, code, spec.workspaceId, spec.ownerId, spec.domainId, spec.visibility, spec.status, now, now]);
  return { id, code, workspace_id: spec.workspaceId, owner_id: spec.ownerId, domain_id: spec.domainId, visibility: spec.visibility, status: spec.status };
}

async function insertCredential(ctx: AppContext, userId: string, domainId: string, revoked = false): Promise<void> {
  const now = ctx.now().toISOString();
  await ctx.db.run(`INSERT INTO credentials (id, user_id, domain_id, rationale, granted_at, revoked_at) VALUES (?, ?, ?, 'Check probe', ?, ?)`, [newId(), userId, domainId, now, revoked ? now : null]);
}

class CaseLedger {
  passed = 0;
  total = 0;
  failures: CheckFailure[] = [];

  record(subject: string, ok: boolean, reason: string) {
    this.total += 1;
    if (ok) this.passed += 1;
    else this.failures.push({ subject, reason });
  }

  /** A permission call whose verdict must come out one way, compared on the verdict alone. */
  verdict(subject: string, verdict: Verdict, expected: 'allowed' | 'refused') {
    const ok = expected === 'allowed' ? verdict.allowed : !verdict.allowed;
    this.record(subject, ok, expected === 'allowed' ? 'Refused where access is required' : 'Allowed across a private boundary');
  }
}

/* ---------- 3. Private access ---------- */

export async function checkPrivateAccess(ctx: AppContext, deps: CheckDependencies = realDependencies): Promise<CheckOutcome> {
  const { db } = ctx;
  const ledger = new CaseLedger();
  await inRollback(ctx, async () => {
    const tasks = await db.all<TaskAccessRow>('SELECT id, code, workspace_id, owner_id, domain_id, visibility, status FROM tasks ORDER BY code');
    const datasets = await db.all<{ id: string; code: string; workspace_id: string; visibility: string; deleted_at: string | null }>('SELECT id, code, workspace_id, visibility, deleted_at FROM datasets ORDER BY code');
    const workspaces = await db.all<{ id: string }>('SELECT id FROM workspaces');

    // A fixture workspace too, so the check means something on an instance with no data yet.
    const owner = await insertUser(ctx, fixtureUser(ctx));
    const fixtureWorkspace = await insertWorkspace(ctx, owner.id);
    await insertMembership(ctx, fixtureWorkspace, owner.id, 'active', 'owner');
    const fixtureDomain = (await db.get<{ id: string }>('SELECT id FROM domains ORDER BY sort LIMIT 1'))?.id ?? 'biology';
    const privateTask = await insertTask(ctx, { workspaceId: fixtureWorkspace, ownerId: owner.id, domainId: fixtureDomain, visibility: 'private', status: 'frozen' });
    const sharedDraft = await insertTask(ctx, { workspaceId: fixtureWorkspace, ownerId: owner.id, domainId: fixtureDomain, visibility: 'shared', status: 'draft' });
    const privateDataset = { code: 'fixture private dataset', workspace_id: fixtureWorkspace, visibility: 'private', deleted_at: null };
    const deletedShared = { code: 'fixture deleted shared dataset', workspace_id: fixtureWorkspace, visibility: 'shared', deleted_at: ctx.now().toISOString() };

    const nonMember = await insertUser(ctx, fixtureUser(ctx));
    const removed = await insertUser(ctx, fixtureUser(ctx));
    const member = await insertUser(ctx, fixtureUser(ctx));
    for (const workspace of [...workspaces, { id: fixtureWorkspace }]) {
      await insertMembership(ctx, workspace.id, removed.id, 'removed');
      await insertMembership(ctx, workspace.id, member.id, 'active');
    }

    for (const task of [...tasks, privateTask, sharedDraft]) {
      const label = task === privateTask ? 'Fixture private task' : task === sharedDraft ? 'Fixture shared draft' : task.code;
      if (task.visibility === 'shared' && task.status === 'frozen') {
        ledger.verdict(`${label}: verified non-member can read a shared frozen task`, await deps.canReadTask(ctx, nonMember, task), 'allowed');
      } else {
        ledger.verdict(`${label}: non-member`, await deps.canReadTask(ctx, nonMember, task), 'refused');
        ledger.verdict(`${label}: removed member`, await deps.canReadTask(ctx, removed, task), 'refused');
      }
      ledger.verdict(`${label}: active member`, await deps.canReadTask(ctx, member, task), 'allowed');
    }
    for (const dataset of [...datasets, privateDataset, deletedShared]) {
      if (dataset.visibility === 'shared' && !dataset.deleted_at) {
        ledger.verdict(`${dataset.code}: verified non-member can read a shared dataset`, await deps.canReadDataset(ctx, nonMember, dataset), 'allowed');
      } else {
        ledger.verdict(`${dataset.code}: non-member`, await deps.canReadDataset(ctx, nonMember, dataset), 'refused');
        ledger.verdict(`${dataset.code}: removed member`, await deps.canReadDataset(ctx, removed, dataset), 'refused');
      }
      ledger.verdict(`${dataset.code}: active member`, await deps.canReadDataset(ctx, member, dataset), 'allowed');
    }

    // Roles and credentials do not open private items by themselves.
    const admin = await insertUser(ctx, fixtureUser(ctx, 'admin'));
    ledger.verdict('Fixture private task: administrator with no review on it', await deps.canReadTask(ctx, admin, privateTask), 'refused');
    ledger.verdict('Fixture private dataset: administrator', await deps.canReadDataset(ctx, admin, privateDataset), 'refused');
    const expert = await insertUser(ctx, fixtureUser(ctx));
    await insertCredential(ctx, expert.id, fixtureDomain);
    ledger.verdict('Fixture private task: credentialed expert with no assignment', await deps.canReadTask(ctx, expert, privateTask), 'refused');

    // A private dataset pinned into another workspace's task would reach that task's readers.
    const pins = await db.all<{ label: string; task_workspace: string; dataset_code: string; dataset_workspace: string; visibility: string }>(
      `SELECT t.code AS label, t.workspace_id AS task_workspace, d.code AS dataset_code, d.workspace_id AS dataset_workspace, d.visibility
       FROM tasks t JOIN dataset_versions dv ON dv.id = t.dataset_version_id JOIN datasets d ON d.id = dv.dataset_id
       UNION
       SELECT t.code || ' v' || tv.version, t.workspace_id, d.code, d.workspace_id, d.visibility
       FROM task_versions tv JOIN tasks t ON t.id = tv.task_id JOIN dataset_versions dv ON dv.id = tv.dataset_version_id JOIN datasets d ON d.id = dv.dataset_id`,
    );
    for (const pin of pins) {
      ledger.record(`${pin.label}: pins ${pin.dataset_code}`, pin.task_workspace === pin.dataset_workspace || pin.visibility === 'shared', 'A private dataset is pinned into a task of another workspace');
    }
  });
  const ok = ledger.failures.length === 0;
  return {
    key: 'private_access',
    label: 'Private access',
    status: ok ? 'passed' : 'failed',
    detail: `${ok ? 'Passed' : 'Failed'} · ${ledger.passed} of ${ledger.total} boundary cases`,
    failures: ledger.failures,
    data: { passed: ledger.passed, total: ledger.total },
  };
}

/* ---------- 4. OAuth state and PKCE ---------- */

/** RFC 7636 appendix B. */
const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

export async function checkOAuth(ctx: AppContext, deps: CheckDependencies = realDependencies): Promise<CheckOutcome> {
  const { db } = ctx;
  const ledger = new CaseLedger();
  const wellFormed = { response_type: 'code', scope: 'tasks:read reports:read advisor:query', resource: 'task:BIO-042', state: 'check-state', code_challenge: RFC7636_CHALLENGE, code_challenge_method: 'S256' };
  const refused = (subject: string, params: Record<string, string | undefined>, error: string) => {
    const result = deps.validateAuthorizationParams({ ...wellFormed, ...params });
    ledger.record(subject, !result.ok && result.error === error, `Expected ${error}`);
  };

  // PKCE
  ledger.record('RFC 7636 verifier matches its challenge', deps.verifyPkce(RFC7636_VERIFIER, RFC7636_CHALLENGE), 'A correct verifier was refused');
  ledger.record('Wrong verifier refused', !deps.verifyPkce(`${RFC7636_VERIFIER.slice(0, -1)}A`, RFC7636_CHALLENGE), 'A wrong verifier was accepted');
  ledger.record('Short verifier refused', !deps.verifyPkce('short', RFC7636_CHALLENGE), 'A short verifier was accepted');
  ledger.record('Verifier with illegal characters refused', !deps.verifyPkce(`${'a'.repeat(42)}!`, RFC7636_CHALLENGE), 'An illegal verifier was accepted');

  // Authorization request
  ledger.record('Well-formed request accepted', deps.validateAuthorizationParams(wellFormed).ok, 'A valid request was refused');
  refused('The plain PKCE method refused', { code_challenge_method: 'plain' }, 'invalid_request');
  refused('Missing state refused', { state: undefined }, 'invalid_request');
  refused('Missing challenge refused', { code_challenge: undefined }, 'invalid_request');
  refused('Scope outside the allow-list refused', { scope: 'tasks:read tasks:write' }, 'invalid_scope');
  refused('Missing resource refused', { resource: undefined }, 'invalid_target');

  // Redirects: exact match only, and the state comes back unchanged.
  const registered = 'https://atlas.example/oauth/callback';
  ledger.record('Exact redirect accepted', deps.redirectMatches(registered, registered), 'An exact redirect was refused');
  ledger.record('Redirect with a trailing slash refused', !deps.redirectMatches(registered, `${registered}/`), 'A near-match redirect was accepted');
  ledger.record('Redirect on another host refused', !deps.redirectMatches(registered, 'https://atlas.example.evil.test/oauth/callback'), 'A redirect on another host was accepted');
  const state = 'a b&c=d/e?f';
  const approved = new URL(deps.authorizationRedirect(registered, { code: 'one-time', state }));
  ledger.record('Approved redirect carries the code and the exact state', approved.searchParams.get('state') === state && approved.searchParams.get('code') === 'one-time', 'The state did not survive the redirect');
  const denied = new URL(deps.authorizationRedirect(registered, { error: 'access_denied', state }));
  ledger.record('Denied redirect carries the error and the exact state', denied.searchParams.get('state') === state && denied.searchParams.get('error') === 'access_denied', 'The state did not survive the denial');

  // A live code through the real exchange, in a transaction that rolls back.
  await inRollback(ctx, async () => {
    const user = await insertUser(ctx, fixtureUser(ctx));
    const workspace = await insertWorkspace(ctx, user.id);
    await insertMembership(ctx, workspace, user.id, 'active', 'owner');
    const domain = (await db.get<{ id: string }>('SELECT id FROM domains ORDER BY sort LIMIT 1'))?.id ?? 'biology';
    const task = await insertTask(ctx, { workspaceId: workspace, ownerId: user.id, domainId: domain, visibility: 'private', status: 'frozen' });
    const clientRowId = newId();
    const nowDate = ctx.now();
    const now = nowDate.toISOString();
    await db.run(`INSERT INTO oauth_clients (id, client_id, name, developer, description, redirect_uri, is_synthetic, created_at) VALUES (?, ?, 'Check probe', 'Rivet', 'Check probe', ?, 1, ?)`, [clientRowId, `check-probe-${clientRowId}`, registered, now]);
    const requestId = newId();
    await db.run(
      `INSERT INTO oauth_requests (id, code, client_id, user_id, workspace_id, scopes, resource, task_id, task_version_id, redirect_uri, state, code_challenge, code_challenge_method, status, created_at, expires_at, decided_at)
       VALUES (?, ?, ?, ?, ?, '["tasks:read"]', ?, ?, ?, ?, ?, ?, 'S256', 'approved', ?, ?, ?)`,
      [requestId, `OAUTH-PROBE-${requestId}`, clientRowId, user.id, workspace, `task:${task.code}`, task.id, newId(), registered, 'check-state', RFC7636_CHALLENGE, now, now, now],
    );
    const { code } = await issueAuthorizationCode(ctx, requestId);
    const exchange = (over: Partial<{ code: string; redirectUri: string; codeVerifier: string }> = {}) => deps.exchangeAuthorizationCode(ctx, { clientRowId, code, redirectUri: registered, codeVerifier: RFC7636_VERIFIER, ...over });

    const wrongVerifier = await exchange({ codeVerifier: `${RFC7636_VERIFIER.slice(0, -1)}A` });
    ledger.record('Live code refused with the wrong verifier', !wrongVerifier.ok && wrongVerifier.error === 'invalid_grant', 'A code was redeemed with the wrong verifier');
    const wrongRedirect = await exchange({ redirectUri: `${registered}/` });
    ledger.record('Live code refused with the wrong redirect', !wrongRedirect.ok && wrongRedirect.error === 'invalid_grant', 'A code was redeemed with the wrong redirect');
    const redeemed = await exchange();
    ledger.record('Live code redeemed once with the right verifier', redeemed.ok, 'The right verifier could not redeem the code');
    const replay = await exchange();
    ledger.record('Live code refused the second time', !replay.ok && replay.error === 'invalid_grant', 'A used code was redeemed again');
    const live = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM oauth_tokens WHERE request_id = ? AND revoked_at IS NULL', [requestId]);
    ledger.record('A replayed code revokes what it issued', (live?.count ?? 0) === 0, 'A token survived the replay of its code');

    const stale = await issueAuthorizationCode(ctx, requestId);
    await db.run('UPDATE oauth_requests SET auth_code_expires_at = ? WHERE id = ?', [new Date(nowDate.getTime() - 1000).toISOString(), requestId]);
    const expired = await exchange({ code: stale.code });
    ledger.record('Expired code refused', !expired.ok && expired.error === 'invalid_grant', 'An expired code was redeemed');
  });

  // What is stored must keep to the same rules.
  const requests = await db.all<{ code: string; state: string; code_challenge: string; code_challenge_method: string; status: string; auth_code_hash: string | null; redirect_uri: string }>('SELECT code, state, code_challenge, code_challenge_method, status, auth_code_hash, redirect_uri FROM oauth_requests');
  const badStored = requests.filter((row) => !isWellFormedState(row.state) || !isS256Challenge(row.code_challenge) || row.code_challenge_method !== 'S256');
  ledger.record('Every stored request has a state and an S256 challenge', badStored.length === 0, `Not well formed: ${badStored.map((row) => row.code).join(', ')}`);
  const hexHash = /^[a-f0-9]{64}$/;
  const badCode = requests.filter((row) => (row.auth_code_hash !== null && !hexHash.test(row.auth_code_hash)) || (row.status !== 'approved' && row.auth_code_hash !== null));
  ledger.record('Authorization codes are stored only as hashes, and only once approved', badCode.length === 0, `Not a hash, or issued without approval: ${badCode.map((row) => row.code).join(', ')}`);
  const tokens = await db.all<{ id: string; token_hash: string; status: string | null }>('SELECT t.id, t.token_hash, r.status FROM oauth_tokens t LEFT JOIN oauth_requests r ON r.id = t.request_id');
  const badToken = tokens.filter((row) => !hexHash.test(row.token_hash) || row.status !== 'approved');
  ledger.record('Access tokens are stored only as hashes, and only from approved requests', badToken.length === 0, `${badToken.length} stored ${badToken.length === 1 ? 'token' : 'tokens'} break this`);

  const ok = ledger.failures.length === 0;
  return {
    key: 'oauth_pkce',
    label: 'OAuth state & PKCE',
    status: ok ? 'passed' : 'failed',
    detail: `${ok ? 'Passed' : 'Failed'} · ${ledger.passed} of ${ledger.total} cases`,
    failures: ledger.failures,
    data: { passed: ledger.passed, total: ledger.total },
  };
}

/* ---------- 5. Provider timeouts ---------- */

export async function checkProviderTimeouts(ctx: AppContext): Promise<CheckOutcome> {
  const { db } = ctx;
  const logged = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM run_log WHERE LOWER(message) LIKE '%provider timeout%'`);
  const unlogged = await db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM runs r WHERE r.interrupt_reason = 'provider_timeout'
     AND NOT EXISTS (SELECT 1 FROM run_log l WHERE l.run_id = r.id AND LOWER(l.message) LIKE '%provider timeout%')`,
  );
  const stages = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM run_stages WHERE status <> 'pending' OR attempt > 0`);
  const timeouts = (logged?.count ?? 0) + (unlogged?.count ?? 0);
  // Every timeout used up a provider call that the stage count alone does not show.
  const calls = (stages?.count ?? 0) + timeouts;
  const percent = calls ? (timeouts / calls) * 100 : 0;
  // Compared in whole numbers: exactly at the threshold is not over it.
  const over = timeouts * 100 > TIMEOUT_THRESHOLD_PERCENT * calls;
  const label = ctx.config.demo ? ' demo' : '';
  return {
    key: 'provider_timeouts',
    label: 'Provider timeouts',
    status: over ? 'warning' : 'passed',
    detail: calls ? `${over ? 'Warning' : 'Passed'} · ${percent.toFixed(1)}%${label} / Threshold ${TIMEOUT_THRESHOLD_PERCENT}%` : `Passed · No provider calls yet / Threshold ${TIMEOUT_THRESHOLD_PERCENT}%`,
    failures: [],
    data: { timeouts, calls, percent, thresholdPercent: TIMEOUT_THRESHOLD_PERCENT },
  };
}

/* ---------- 6. Domain enforcement ---------- */

export async function checkDomainEnforcement(ctx: AppContext, deps: CheckDependencies = realDependencies): Promise<CheckOutcome> {
  const { db } = ctx;
  const ledger = new CaseLedger();
  await inRollback(ctx, async () => {
    let domains = await db.all<{ id: string; name: string }>('SELECT id, name FROM domains ORDER BY sort');
    if (domains.length < 2) {
      const extra = `check-probe-${newId()}`;
      await db.run(`INSERT INTO domains (id, name, field, prefix, sort) VALUES (?, 'Check probe', 'Check probe', ?, 99)`, [extra, extra]);
      domains = await db.all<{ id: string; name: string }>('SELECT id, name FROM domains ORDER BY sort');
    }
    for (const [index, domain] of domains.entries()) {
      const other = domains[(index + 1) % domains.length] as { id: string; name: string };
      const owner = await insertUser(ctx, fixtureUser(ctx));
      await insertCredential(ctx, owner.id, domain.id);
      const task = { owner_id: owner.id, domain_id: domain.id };
      const required = `Verified ${domain.name} credential required`;

      const self = await deps.canReviewTask(ctx, owner, task);
      ledger.record(`${domain.name}: the owner cannot review their own task, even when credentialed`, !self.allowed && self.reason === 'You own this task', 'The task owner was allowed to review');

      const verifiedExpert = await insertUser(ctx, fixtureUser(ctx));
      await insertCredential(ctx, verifiedExpert.id, domain.id);
      ledger.verdict(`${domain.name}: verified expert in the domain`, await deps.canReviewTask(ctx, verifiedExpert, task), 'allowed');

      const wrongDomain = await insertUser(ctx, fixtureUser(ctx));
      await insertCredential(ctx, wrongDomain.id, other.id);
      const crossDomain = await deps.canReviewTask(ctx, wrongDomain, task);
      ledger.record(`${domain.name}: a ${other.name} credential does not transfer`, !crossDomain.allowed && crossDomain.reason === required, 'A credential from another domain was accepted');

      const revoked = await insertUser(ctx, fixtureUser(ctx));
      await insertCredential(ctx, revoked.id, domain.id, true);
      const lapsed = await deps.canReviewTask(ctx, revoked, task);
      ledger.record(`${domain.name}: a revoked credential is refused`, !lapsed.allowed && lapsed.reason === required, 'A revoked credential was accepted');
    }
  });

  // And every review on file must have respected the same rule.
  const reviews = await db.all<{ code: string; status: string; expert_id: string; owner_id: string; domain_id: string; submitted_at: string | null; created_at: string }>(
    `SELECT r.code, r.status, r.expert_id, t.owner_id, t.domain_id, r.submitted_at, r.created_at FROM reviews r JOIN tasks t ON t.id = r.task_id WHERE r.expert_id IS NOT NULL ORDER BY r.code`,
  );
  for (const review of reviews) {
    const expert = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', [review.expert_id]);
    if (!expert) {
      ledger.record(review.code, false, 'The reviewing expert no longer exists');
      continue;
    }
    if (review.status === 'finalized') {
      // A credential revoked after the work was finished does not undo it. Self-review is never allowed.
      const at = review.submitted_at ?? review.created_at;
      const heldThen = await db.get(`SELECT 1 AS ok FROM credentials WHERE user_id = ? AND domain_id = ? AND granted_at <= ? AND (revoked_at IS NULL OR revoked_at > ?)`, [expert.id, review.domain_id, at, at]);
      ledger.record(`${review.code}: finalized by a credentialed non-owner`, review.expert_id !== review.owner_id && Boolean(heldThen), review.expert_id === review.owner_id ? 'The task owner reviewed their own task' : 'The expert held no credential in this domain when the review was submitted');
    } else {
      const verdict = await deps.canReviewTask(ctx, expert, { owner_id: review.owner_id, domain_id: review.domain_id });
      ledger.record(`${review.code}: assigned to a credentialed non-owner`, verdict.allowed, verdict.allowed ? '' : verdict.reason);
    }
  }

  const ok = ledger.failures.length === 0;
  return {
    key: 'domain_enforcement',
    label: 'Domain enforcement',
    status: ok ? 'passed' : 'failed',
    detail: `${ok ? 'Passed' : 'Failed'} · ${ledger.passed} of ${ledger.total} cases`,
    failures: ledger.failures,
    data: { passed: ledger.passed, total: ledger.total },
  };
}

/* ---------- Running them all ---------- */

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];
const numberWord = (count: number) => NUMBER_WORDS[count] ?? String(count);

/** These two say whether the frozen record can be trusted. A failure of either blocks runs. */
const INTEGRITY_KEYS = new Set(['artifact_hashes', 'immutability']);

/** The alert on the page, computed from what actually happened. */
export function summarizeReceipts(receipts: { key: string; status: CheckStatus; label: string }[]): { message: string; tone: CheckTone } {
  const failed = receipts.filter((receipt) => receipt.status === 'failed');
  const warnings = receipts.filter((receipt) => receipt.status === 'warning');
  const labels = failed.map((receipt) => receipt.label).join(', ');
  if (failed.some((receipt) => INTEGRITY_KEYS.has(receipt.key))) {
    return { message: `Core integrity failed. ${numberWord(failed.length)} ${failed.length === 1 ? 'check needs' : 'checks need'} attention: ${labels}. Runs are blocked until the checks pass.`, tone: 'danger' };
  }
  if (failed.length) {
    return { message: `Core integrity passed, but ${numberWord(failed.length).toLowerCase()} permission ${failed.length === 1 ? 'check' : 'checks'} failed: ${labels}.`, tone: 'danger' };
  }
  if (warnings.length) {
    return { message: `Core integrity passed. ${numberWord(warnings.length)} operational ${warnings.length === 1 ? 'warning needs' : 'warnings need'} attention.`, tone: 'warning' };
  }
  return { message: 'Core integrity passed. No operational warnings.', tone: 'accent' };
}

async function guarded(key: string, label: string, work: () => Promise<CheckOutcome>): Promise<CheckOutcome> {
  try {
    return await work();
  } catch (error) {
    return { key, label, status: 'failed', detail: 'Failed · The check could not finish', failures: [{ subject: label, reason: errorMessage(error) }], data: {} };
  }
}

export interface CheckRunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  outcomes: (CheckOutcome & { code: string })[];
}

/** Runs all six checks and stores one CHECK-n receipt each. */
export async function runSystemChecks(ctx: AppContext, operatorId: string, deps: CheckDependencies = realDependencies): Promise<CheckRunResult> {
  const startedAt = ctx.now().toISOString();
  const outcomes = [
    await guarded('artifact_hashes', 'Artifact hashes', () => checkArtifactHashes(ctx)),
    await guarded('immutability', 'Immutability', () => checkImmutability(ctx)),
    await guarded('private_access', 'Private access', () => checkPrivateAccess(ctx, deps)),
    await guarded('oauth_pkce', 'OAuth state & PKCE', () => checkOAuth(ctx, deps)),
    await guarded('provider_timeouts', 'Provider timeouts', () => checkProviderTimeouts(ctx)),
    await guarded('domain_enforcement', 'Domain enforcement', () => checkDomainEnforcement(ctx, deps)),
  ];
  const finishedAt = ctx.now().toISOString();
  const runId = newId();
  const stored = await ctx.db.tx(async () => {
    await ctx.db.run('INSERT INTO check_runs (id, started_by, started_at, finished_at) VALUES (?, ?, ?, ?)', [runId, operatorId, startedAt, finishedAt]);
    const coded: (CheckOutcome & { code: string })[] = [];
    for (const outcome of outcomes) {
      const code = `CHECK-${pad3(await nextCounter(ctx.db, 'check'))}`;
      await ctx.db.run(
        `INSERT INTO check_receipts (id, code, check_run_id, check_key, label, status, detail, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), code, runId, outcome.key, outcome.label, outcome.status, outcome.detail, JSON.stringify({ ...outcome.data, failures: outcome.failures }), finishedAt],
      );
      coded.push({ ...outcome, code });
    }
    await audit(ctx, {
      actorId: operatorId,
      action: 'system_checks.run',
      subjectType: 'check_run',
      subjectId: runId,
      subjectCode: `${coded[0]?.code}–${coded[coded.length - 1]?.code}`,
      detail: { statuses: Object.fromEntries(coded.map((outcome) => [outcome.code, outcome.status])) },
    });
    return coded;
  });
  return { runId, startedAt, finishedAt, outcomes: stored };
}

export { integrityBlockReason } from '../lib/integrity.ts';

/* ---------- Operational events: from run logs and the audit log ---------- */

function describeRunLog(message: string): string {
  if (/provider timeout/i.test(message) && /checkpoint/i.test(message)) return 'Safe checkpoint after provider timeout · Owner can resume';
  return message;
}

/** What an operator wants to see, out of everything the audit log records. */
const OPERATIONAL_ACTIONS: Record<string, string> = {
  'dataset.manifest_verified': 'Source manifest hash matched',
  'dataset.hash_mismatch': 'Stored bytes do not match the dataset hash',
  'dataset.deleted': 'Dataset removed from the library',
  'credential.granted': 'Credential verified',
  'credential.verified': 'Credential verified',
  'credential.declined': 'Credential application declined',
  'adjudication.accepted': 'Adjudication accepted',
  'adjudication.returned': 'Adjudication returned to the expert',
  'model.metadata_revised': 'Model metadata revised',
  'run.failed': 'Run failed',
  'oauth.code_replayed': 'Authorization code replayed · Tokens revoked',
  'release.approved': 'Release approved',
};

async function describeAudit(ctx: AppContext, action: string, rawDetail: string): Promise<string> {
  let detail: { message?: unknown; domain?: unknown; applicantId?: unknown; report?: unknown } = {};
  try {
    detail = JSON.parse(rawDetail);
  } catch {
    // The action alone still says what happened.
  }
  if (typeof detail.message === 'string' && detail.message) return detail.message;
  if (action === 'credential.verified' && typeof detail.domain === 'string' && typeof detail.applicantId === 'string') {
    const applicant = await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [detail.applicantId]);
    return `${detail.domain} credential verified / ${applicant?.name ?? 'Applicant'}`;
  }
  if (action === 'adjudication.accepted' && typeof detail.report === 'string') return `Adjudication accepted · Frozen as ${detail.report}`;
  return OPERATIONAL_ACTIONS[action] ?? action;
}

export async function operationalEvents(ctx: AppContext, limit = 6): Promise<OperationalEvent[]> {
  const logs = await ctx.db.all<{ id: string; code: string; message: string; at: string }>(
    `SELECT l.id, r.code, l.message, l.at FROM run_log l JOIN runs r ON r.id = l.run_id
     WHERE LOWER(l.message) LIKE '%provider timeout%' OR LOWER(l.message) LIKE '%provider unavailable%' OR LOWER(l.message) LIKE '%server restarted%'
     ORDER BY l.at DESC LIMIT ?`,
    [limit],
  );
  const actions = Object.keys(OPERATIONAL_ACTIONS);
  const audits = await ctx.db.all<{ id: string; action: string; subject_code: string | null; detail: string; created_at: string }>(
    `SELECT id, action, subject_code, detail, created_at FROM audit_log WHERE subject_code IS NOT NULL AND action IN (${actions.map(() => '?').join(', ')}) ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [...actions, limit],
  );
  const events: OperationalEvent[] = logs.map((row) => ({ id: row.id, subject: row.code, message: describeRunLog(row.message), at: row.at }));
  for (const row of audits) events.push({ id: row.id, subject: row.subject_code as string, message: await describeAudit(ctx, row.action, row.detail), at: row.created_at });
  return events.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, limit);
}
