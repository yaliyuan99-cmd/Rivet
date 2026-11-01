import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, AppEnv, C, UserRow } from '../context.ts';
import { nowIso } from '../context.ts';
import type {
  AdjudicationResponse,
  AssuranceCandidateItem,
  AssuranceGateItem,
  AssuranceIndex,
  AssuranceRegressionItem,
  AssuranceTraceItem,
  CheckSeverity,
  GateCheckResult,
  GateDetail,
  GateGroupResult,
  GateState,
  ImportTraceResponse,
  RegressionDetail,
  RegressionPin,
  RegressionPolicy,
  RegressionVersionView,
  TraceAdjudication,
  TraceDetail,
  TraceStep,
  TraceStepView,
  Verdict,
} from '../../shared/types/assurance.ts';
import { BIOLOGY_GATE_V1, evaluateTrace, FINDINGS, isFlaggedStep, loadGateInput, pad2, policyLabel, POLICY_CHOICES, recordGateRun, SEVERITY_CHOICES, severityLabel, suiteForDomain, type TraceRow } from '../engine/gate.ts';
import { audit } from '../lib/audit.ts';
import { requireVerified } from '../lib/auth.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { traceHash } from '../lib/evidence.ts';
import { conflict, forbidden, HttpError, invalid, notFound } from '../lib/errors.ts';
import { newId, nextCounter, pad3 } from '../lib/ids.ts';
import { sendMail } from '../lib/mail.ts';
import { canCreateInWorkspace, canReadDataset, canReviewTask, workspaceRole } from '../lib/permissions.ts';
import { readJson } from '../lib/validate.ts';
import { activeWorkspaceOf, attachmentHeaders, peekCounter } from './datasets.ts';

const yes: Verdict = { allowed: true };
const no = (reason: string): Verdict => ({ allowed: false, reason });

const OWNER_ONLY = 'Workspace or task owner only';
const NO_WORKSPACE = 'Create a workspace before importing a trace.';

/* ---------- Rows and rules ---------- */

async function getTrace(ctx: AppContext, code: string): Promise<TraceRow | undefined> {
  return ctx.db.get<TraceRow>('SELECT * FROM traces WHERE code = ?', [code]);
}

const stepsOf = (trace: Pick<TraceRow, 'steps'>) => JSON.parse(trace.steps) as TraceStep[];
const isFlagged = (trace: Pick<TraceRow, 'steps'>) => stepsOf(trace).some(isFlaggedStep);
const traceVerified = (trace: TraceRow) => traceHash({ code: trace.code, agent_label: trace.agent_label, harness_version: trace.harness_version, steps: stepsOf(trace) }) === trace.sha256;

/**
 * Workspace members read their traces. A verified reviewer in the trace's domain can read one that is
 * flagged or that already has an adjudication: that is what asks for outside review.
 */
async function canReadTrace(ctx: AppContext, user: UserRow, trace: TraceRow): Promise<Verdict> {
  if (await workspaceRole(ctx, user.id, trace.workspace_id)) return yes;
  const credential = await ctx.db.get(`SELECT 1 AS ok FROM credentials WHERE user_id = ? AND domain_id = ? AND revoked_at IS NULL`, [user.id, trace.domain_id]);
  if (credential && isFlagged(trace)) return yes;
  if (credential && (await ctx.db.get('SELECT 1 AS ok FROM trace_adjudications WHERE trace_id = ?', [trace.id]))) return yes;
  return no('Only workspace members and verified reviewers can read this trace.');
}

/** canReviewTask's rules, with the wording for a trace: no reviewing your own, a verified domain credential required. */
async function canReviewTrace(ctx: AppContext, user: UserRow, trace: TraceRow): Promise<Verdict> {
  if (trace.owner_id === user.id) return no('You own this trace');
  if ((await workspaceRole(ctx, user.id, trace.workspace_id)) === 'owner') return no('You own this workspace');
  return canReviewTask(ctx, user, { owner_id: trace.owner_id, domain_id: trace.domain_id });
}

/** Regressions, gate runs and release approval: the workspace owner or the task's owner, while still a member. */
async function canManageRelease(ctx: AppContext, user: UserRow, spec: { workspaceId: string; taskVersionId: string | null }): Promise<Verdict> {
  const role = await workspaceRole(ctx, user.id, spec.workspaceId);
  if (role === 'owner') return yes;
  if (role && spec.taskVersionId) {
    const task = await ctx.db.get<{ owner_id: string }>('SELECT t.owner_id FROM task_versions tv JOIN tasks t ON t.id = tv.task_id WHERE tv.id = ?', [spec.taskVersionId]);
    if (task?.owner_id === user.id) return yes;
  }
  return no(OWNER_ONLY);
}

const shortAgent = (label: string) => label.replace(/\s+agent$/i, '');

async function taskLabel(ctx: AppContext, taskVersionId: string | null): Promise<string | null> {
  if (!taskVersionId) return null;
  const row = await ctx.db.get<{ code: string; version: string }>('SELECT t.code, tv.version FROM task_versions tv JOIN tasks t ON t.id = tv.task_id WHERE tv.id = ?', [taskVersionId]);
  return row ? `${row.code} v${row.version}` : null;
}

async function datasetLabel(ctx: AppContext, datasetVersionId: string | null): Promise<string | null> {
  if (!datasetVersionId) return null;
  const row = await ctx.db.get<{ code: string; version: string }>('SELECT d.code, v.version FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.id = ?', [datasetVersionId]);
  return row ? `${row.code} v${row.version}` : null;
}

function stepView(step: TraceStep): TraceStepView {
  const body = step.claim ? `“${step.claim}”` : (step.call ?? step.detail ?? (step.sources?.length ? `${step.sources.join(', ')} cited` : ''));
  const separator = step.status.toLowerCase() === 'flagged' ? ' / ' : ' · ';
  return {
    n: step.n,
    heading: `${pad2(step.n)} / ${step.title}`,
    detail: body ? `${body}${separator}${step.status}` : step.status,
    status: step.status,
    flagged: isFlaggedStep(step),
  };
}

interface AdjudicationRow {
  id: string;
  code: string;
  trace_id: string;
  reviewer_id: string;
  kind: 'finding' | 'clarification';
  finding: string;
  severity: CheckSeverity;
  rationale: string;
  conflict_ack: number;
  created_at: string;
  reviewer_name: string;
}

const adjudicationsOf = (ctx: AppContext, traceId: string) =>
  ctx.db.all<AdjudicationRow>(
    `SELECT a.*, u.name AS reviewer_name FROM trace_adjudications a JOIN users u ON u.id = a.reviewer_id WHERE a.trace_id = ? ORDER BY a.created_at, a.rowid`,
    [traceId],
  );

const traceState = (flagged: boolean, adjudications: { kind: string }[]) => {
  if (adjudications.some((row) => row.kind === 'finding')) return 'Confirmed finding';
  if (adjudications.length) return 'Clarification requested';
  return flagged ? 'Awaiting adjudication' : 'No flags';
};

const adjCode = (n: number) => `ADJ-TRACE-${pad3(n)}`;
const nextAdjCode = async (ctx: AppContext) => adjCode(await peekCounter(ctx, 'adjudication:trace'));

/* ---------- Gate helpers ---------- */

interface GateRow {
  id: string;
  code: string;
  workspace_id: string;
  domain_id: string | null;
  target: string;
  suite: string;
  suite_size: number;
  created_at: string;
}

interface GateRunRow {
  id: string;
  gate_id: string;
  candidate: string;
  harness_version: string;
  trace_id: string;
  status: 'blocked' | 'passed';
  checks: string;
  groups: string;
  regressions: string;
  blocking_reason: string | null;
  passed_count: number;
  total_count: number;
  change_note: string;
  created_by: string;
  created_at: string;
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const countWord = (n: number) => WORDS[n] ?? String(n);

function blockedAlert(run: { checks: GateCheckResult[]; regressions: RegressionPin[] }): string {
  const failedCodes = new Set(run.checks.filter((check) => check.blocking).flatMap((check) => check.regressions ?? []));
  const failed = run.regressions.filter((regression) => failedCodes.has(regression.code));
  const tail = 'Release is not eligible and cannot be bypassed.';
  if (failed.length) {
    const adjective = failed.every((regression) => regression.severity === 'high') ? 'high-severity ' : '';
    return `${countWord(failed.length)} ${adjective}regression${failed.length === 1 ? '' : 's'} failed. ${tail}`;
  }
  const blocking = run.checks.filter((check) => check.blocking).length;
  return `${countWord(blocking)} required check${blocking === 1 ? '' : 's'} failed. ${tail}`;
}

function retryAdvice(groups: GateGroupResult[]): string {
  const failed = new Set(groups.filter((group) => group.status === 'failed').map((group) => group.id));
  const first: string[] = [];
  if (failed.has('claim')) first.push('Revise the agent harness to check whether causal controls exist.');
  if (failed.has('source')) first.push('Revise the agent harness so every claim cites a record in the pinned dataset.');
  if (failed.has('private')) first.push('Remove the external call or personal data from the agent harness.');
  if (failed.has('integrity')) first.push('Find out why the pinned artifacts no longer match their hashes.');
  return [...first, 'Rerun the same frozen suite as a new release candidate. Preserve the failed trace and independent expert finding.'].join(' ');
}

async function gateOr404(c: C): Promise<{ ctx: AppContext; user: UserRow; gate: GateRow; trace: TraceRow; run: GateRunRow | undefined; candidate: string }> {
  const ctx = c.get('ctx');
  const user = requireVerified(c);
  const gate = await ctx.db.get<GateRow>('SELECT * FROM gates WHERE code = ?', [c.req.param('code') as string]);
  // Only workspace members see a gate; everyone else learns nothing about it.
  if (!gate || !(await workspaceRole(ctx, user.id, gate.workspace_id))) throw notFound();
  const candidate = c.req.param('candidate') as string;
  const trace = await ctx.db.get<TraceRow>('SELECT * FROM traces WHERE gate_id = ? AND candidate = ?', [gate.id, candidate]);
  if (!trace) throw notFound('This release candidate does not exist.');
  const run = await ctx.db.get<GateRunRow>('SELECT * FROM gate_runs WHERE gate_id = ? AND candidate = ?', [gate.id, candidate]);
  return { ctx, user, gate, trace, run, candidate };
}

/** Why a passed run cannot be approved right now, re-reading the current state on every call. */
async function approvalVerdict(ctx: AppContext, user: UserRow, gate: GateRow, trace: TraceRow, run: GateRunRow | undefined): Promise<Verdict> {
  if (!run) return no('The gate has not run for this candidate');
  if (run.status !== 'passed') return no(run.blocking_reason ?? 'The gate is blocked');
  const manage = await canManageRelease(ctx, user, { workspaceId: gate.workspace_id, taskVersionId: trace.task_version_id });
  if (!manage.allowed) return manage;
  if (await ctx.db.get('SELECT 1 AS ok FROM release_decisions WHERE gate_run_id = ?', [run.id])) return no('This release is already approved');
  // A pass is a snapshot. Anything learned since, such as a later finding or tampering, stops approval.
  const current = evaluateTrace(await loadGateInput(ctx, trace));
  if (current.status !== 'passed') return no(`${current.blockingReason ?? 'New evidence blocks this candidate'}. Run a new candidate`);
  return yes;
}

/* ---------- Validation ---------- */

const stepSchema = z.object({
  n: z.number({ error: 'Number each step with a whole number.' }).int('Number each step with a whole number.').positive('Number each step from 1.').optional(),
  title: z.string({ error: 'Give every step a title.' }).trim().min(1, 'Give every step a title.').max(200, 'Keep step titles under 200 characters.'),
  call: z.string({ error: 'A tool call must be text.' }).trim().max(500, 'Keep tool calls under 500 characters.').optional(),
  claim: z.string({ error: 'A claim must be text.' }).trim().max(2000, 'Keep claims under 2,000 characters.').optional(),
  detail: z.string({ error: 'A step detail must be text.' }).trim().max(2000, 'Keep step details under 2,000 characters.').optional(),
  sources: z.array(z.string({ error: 'Each source must be a source ID.' }).trim().min(1, 'Each source must be a source ID.').max(100, 'Keep source IDs under 100 characters.'), { error: 'List sources as an array of source IDs.' }).max(200, 'Cite at most 200 sources in a step.').optional(),
  status: z.string({ error: 'Give every step a status.' }).trim().min(1, 'Give every step a status.').max(40, 'Keep step statuses under 40 characters.'),
});

const traceSchema = z.object({
  agentLabel: z.string({ error: 'Name the agent this trace came from in agentLabel.' }).trim().min(1, 'Name the agent this trace came from in agentLabel.').max(120, 'Keep agentLabel under 120 characters.'),
  harnessVersion: z.string({ error: 'Give the harness version as numbers in harnessVersion, such as 0.8.21.' }).trim().regex(/^\d+\.\d+(?:\.\d+)*$/, 'Give the harness version as numbers in harnessVersion, such as 0.8.21.'),
  candidate: z.string({ error: 'Name the release candidate in candidate, such as rc.21.' }).trim().regex(/^rc\.\d+$/, 'Name the release candidate in candidate, such as rc.21.'),
  task: z.string({ error: 'Name the frozen task as task, such as BIO-042 v1.0.' }).trim().optional(),
  dataset: z.string({ error: 'Name the dataset version as dataset, such as DS-BIO-07 v1.0.' }).trim().optional(),
  domain: z.string({ error: 'Name the domain as domain, such as biology.' }).trim().optional(),
  changeNote: z.string({ error: 'changeNote must be text.' }).trim().max(1000, 'Keep changeNote under 1,000 characters.').optional(),
  synthetic: z.boolean({ error: 'synthetic must be true or false.' }).optional(),
  steps: z.array(stepSchema, { error: 'Give the trace a steps array.' }).min(1, 'A trace needs at least one step.').max(200, 'A trace can have at most 200 steps.'),
});

const adjudicationSchema = z.object({
  kind: z.enum(['finding', 'clarification'], { error: 'Choose to confirm a finding or request clarification.' }),
  finding: z.string({ error: 'Choose a finding.' }).refine((value) => FINDINGS.some((finding) => finding.label === value), 'Choose a finding.'),
  severity: z.enum(['high', 'medium', 'low'], { error: 'Choose a severity.' }),
  rationale: z.string({ error: 'Explain your rationale to continue.' }).trim().min(1, 'Explain your rationale to continue.').max(4000, 'Keep the rationale under 4,000 characters.'),
  conflictAck: z.literal(true, { error: 'Confirm you have no ownership or financial conflict.' }),
});

const regressionSchema = z.object({
  name: z.string({ error: 'Name this regression to continue.' }).trim().min(1, 'Name this regression to continue.').max(120, 'Keep the name under 120 characters.'),
  passCondition: z.string({ error: 'State the pass condition to continue.' }).trim().min(1, 'State the pass condition to continue.').max(2000, 'Keep the pass condition under 2,000 characters.'),
  policy: z.enum(['block_high', 'block_any'], { error: 'Choose a blocking policy.' }),
  scopeAck: z.boolean().optional(),
});

/* ---------- Regression helpers ---------- */

interface RegressionRow {
  id: string;
  code: string;
  workspace_id: string;
  owner_id: string;
  source_adjudication_id: string | null;
  task_version_id: string | null;
  dataset_version_id: string | null;
  gate_id: string | null;
  status: 'draft' | 'active';
  current_version: number;
  created_at: string;
  activated_at: string | null;
}

interface RegressionVersionRow {
  id: string;
  regression_id: string;
  version: number;
  name: string;
  pass_condition: string;
  policy: RegressionPolicy;
  scope: string;
  scope_ack: number;
  rule: string;
  created_by: string;
  created_at: string;
  created_by_name: string;
}

const regressionVersionsOf = (ctx: AppContext, regressionId: string) =>
  ctx.db.all<RegressionVersionRow>(
    `SELECT v.*, u.name AS created_by_name FROM regression_versions v JOIN users u ON u.id = v.created_by WHERE v.regression_id = ? ORDER BY v.version DESC`,
    [regressionId],
  );

async function memberRegression(c: C): Promise<{ ctx: AppContext; user: UserRow; regression: RegressionRow }> {
  const ctx = c.get('ctx');
  const user = requireVerified(c);
  const regression = await ctx.db.get<RegressionRow>('SELECT * FROM regressions WHERE code = ?', [c.req.param('code') as string]);
  if (!regression || !(await workspaceRole(ctx, user.id, regression.workspace_id))) throw notFound();
  return { ctx, user, regression };
}

/** Editing writes a new rule version unless nothing changed. Never updates an old row. */
async function saveRegressionVersion(ctx: AppContext, user: UserRow, regression: RegressionRow, input: z.output<typeof regressionSchema>): Promise<{ version: number; changed: boolean }> {
  const [current] = await regressionVersionsOf(ctx, regression.id);
  if (!current) throw notFound();
  const scopeAck = input.scopeAck === true;
  const changed = current.name !== input.name || current.pass_condition !== input.passCondition || current.policy !== input.policy || Boolean(current.scope_ack) !== scopeAck;
  if (!changed) return { version: current.version, changed: false };
  const version = current.version + 1;
  await ctx.db.run(
    `INSERT INTO regression_versions (id, regression_id, version, name, pass_condition, policy, scope, scope_ack, rule, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), regression.id, version, input.name, input.passCondition, input.policy, current.scope, scopeAck ? 1 : 0, current.rule, user.id, nowIso(ctx)],
  );
  await ctx.db.run('UPDATE regressions SET current_version = ? WHERE id = ?', [version, regression.id]);
  return { version, changed: true };
}

/* ---------- Routes ---------- */

export function registerAssurance(app: Hono<AppEnv>) {
  app.get('/api/assurance', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const workspace = await activeWorkspaceOf(ctx, user);

    const itemOf = async (row: TraceRow & { workspace_name: string }): Promise<AssuranceTraceItem> => {
      const adjudications = await adjudicationsOf(ctx, row.id);
      const flagged = isFlagged(row);
      return {
        code: row.code,
        agentLabel: row.agent_label,
        harnessVersion: row.harness_version,
        candidate: row.candidate,
        taskLabel: await taskLabel(ctx, row.task_version_id),
        state: traceState(flagged, adjudications),
        flagged,
        decisionCode: adjudications.filter((entry) => entry.kind === 'finding').at(-1)?.code ?? null,
        isSynthetic: Boolean(row.is_synthetic),
        createdAt: row.created_at,
        workspaceName: row.workspace_name,
      };
    };

    const traces: AssuranceTraceItem[] = [];
    const gates: AssuranceGateItem[] = [];
    const regressions: AssuranceRegressionItem[] = [];
    if (workspace) {
      const traceRows = await ctx.db.all<TraceRow & { workspace_name: string }>(`SELECT tr.*, w.name AS workspace_name FROM traces tr JOIN workspaces w ON w.id = tr.workspace_id WHERE tr.workspace_id = ? ORDER BY tr.created_at DESC, tr.code DESC`, [workspace.id]);
      for (const row of traceRows) traces.push(await itemOf(row));

      const gateRows = await ctx.db.all<GateRow>('SELECT * FROM gates WHERE workspace_id = ? ORDER BY code', [workspace.id]);
      for (const gate of gateRows) {
        const candidates: AssuranceCandidateItem[] = [];
        const candidateRows = await ctx.db.all<{ candidate: string; code: string; harness_version: string; status: GateState | null; passed_count: number | null; total_count: number | null; decision: string | null }>(
          `SELECT tr.candidate, tr.code, tr.harness_version, r.status, r.passed_count, r.total_count, d.id AS decision
           FROM traces tr LEFT JOIN gate_runs r ON r.gate_id = tr.gate_id AND r.candidate = tr.candidate LEFT JOIN release_decisions d ON d.gate_run_id = r.id
           WHERE tr.gate_id = ? ORDER BY tr.created_at DESC, tr.code DESC`,
          [gate.id],
        );
        for (const row of candidateRows) {
          candidates.push({ candidate: row.candidate, traceCode: row.code, harnessVersion: row.harness_version, state: row.status ?? 'not_run', passedCount: row.passed_count, totalCount: row.total_count, approved: Boolean(row.decision) });
        }
        gates.push({ code: gate.code, target: gate.target, suite: gate.suite, suiteSize: gate.suite_size, candidates });
      }

      const regressionRows = await ctx.db.all<RegressionRow & { name: string; policy: string; source_code: string | null }>(
        `SELECT r.*, v.name, v.policy, a.code AS source_code FROM regressions r JOIN regression_versions v ON v.regression_id = r.id AND v.version = r.current_version
         LEFT JOIN trace_adjudications a ON a.id = r.source_adjudication_id WHERE r.workspace_id = ? ORDER BY r.created_at DESC, r.code DESC`,
        [workspace.id],
      );
      for (const row of regressionRows) regressions.push({ code: row.code, name: row.name, status: row.status, policyLabel: policyLabel(row.policy), currentVersion: row.current_version, sourceCode: row.source_code });
    }

    // Flagged traces in other workspaces that this person's verified credentials let them adjudicate.
    const reviewQueue: AssuranceTraceItem[] = [];
    const credentials = await ctx.db.all<{ domain_id: string }>('SELECT domain_id FROM credentials WHERE user_id = ? AND revoked_at IS NULL', [user.id]);
    if (credentials.length) {
      const queueRows = await ctx.db.all<TraceRow & { workspace_name: string }>(
        `SELECT tr.*, w.name AS workspace_name FROM traces tr JOIN workspaces w ON w.id = tr.workspace_id
         WHERE tr.domain_id IN (${credentials.map(() => '?').join(', ')}) ORDER BY tr.created_at DESC, tr.code DESC`,
        credentials.map((row) => row.domain_id),
      );
      for (const row of queueRows) {
        if (!(await canReviewTrace(ctx, user, row)).allowed) continue;
        if (!(await canReadTrace(ctx, user, row)).allowed) continue;
        if (await workspaceRole(ctx, user.id, row.workspace_id)) continue;
        reviewQueue.push(await itemOf(row));
      }
    }

    // A worked example that imports as it stands, pinned to what this workspace actually has.
    let example = '';
    if (workspace) {
      const pinned = await ctx.db.get<{ code: string; version: string; dataset_code: string | null; dataset_version: string | null; records: string | null }>(
        `SELECT t.code, tv.version, d.code AS dataset_code, v.version AS dataset_version, v.records FROM task_versions tv JOIN tasks t ON t.id = tv.task_id
         LEFT JOIN dataset_versions v ON v.id = tv.dataset_version_id LEFT JOIN datasets d ON d.id = v.dataset_id
         WHERE t.workspace_id = ? ORDER BY tv.frozen_at DESC LIMIT 1`,
        [workspace.id],
      );
      const numbers = (await ctx.db.all<{ candidate: string | null; harness_version: string }>('SELECT candidate, harness_version FROM traces WHERE workspace_id = ?', [workspace.id])).map((row) => Number(/^rc\.(\d+)$/.exec(row.candidate ?? '')?.[1] ?? 0));
      const nextCandidate = Math.max(0, ...numbers) + 1;
      const sources = pinned?.records ? (JSON.parse(pinned.records) as { source_id?: string }[]).flatMap((record) => record.source_id ?? []).slice(0, 3) : [];
      example = JSON.stringify(
        {
          agentLabel: 'Example agent',
          harnessVersion: `0.9.${nextCandidate}`,
          candidate: `rc.${nextCandidate}`,
          ...(pinned ? { task: `${pinned.code} v${pinned.version}` } : {}),
          ...(pinned?.dataset_code ? { dataset: `${pinned.dataset_code} v${pinned.dataset_version}` } : {}),
          synthetic: true,
          changeNote: 'Describe what changed in this candidate.',
          steps: [
            { title: 'Retrieve sources', call: pinned?.dataset_code ? `read_dataset(${pinned.dataset_code}, v${pinned.dataset_version})` : 'read_dataset(DS-BIO-01, v1.0)', status: 'Allowed' },
            { title: 'Compare observations', sources: sources.length ? sources : ['S1'], status: 'Grounded' },
            { title: 'Draft mechanistic claim', claim: 'consistent with efflux involvement; not proven.', sources: sources.length ? sources : ['S1'], status: 'Qualified' },
            { title: 'Prepare answer', detail: 'Ready for the release gate', status: 'Ready' },
          ],
        },
        null,
        2,
      );
    }

    const response: AssuranceIndex = {
      workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
      canImport: workspace ? await canCreateInWorkspace(ctx, user, workspace.id) : no(NO_WORKSPACE),
      gates,
      traces,
      regressions,
      reviewQueue,
      suite: BIOLOGY_GATE_V1.name,
      importExample: example,
    };
    return c.json(response);
  });

  /* ---------- Traces ---------- */

  app.post('/api/assurance/traces', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const workspace = await activeWorkspaceOf(ctx, user);
    if (!workspace) throw forbidden(NO_WORKSPACE);

    const body = await readJson(c, z.object({ json: z.string({ error: 'Paste the trace JSON to import it.' }).min(1, 'Paste the trace JSON to import it.') }));
    let raw: unknown;
    try {
      raw = JSON.parse(body.json);
    } catch (error) {
      throw invalid({ json: `This is not valid JSON: ${error instanceof Error ? error.message : 'it could not be parsed'}.` });
    }
    const parsed = traceSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path[0] === 'steps' && typeof issue.path[1] === 'number' ? `Step ${issue.path[1] + 1}: ` : '';
      throw invalid({ json: `${where}${issue?.message ?? 'This trace is not valid.'}` });
    }
    const input = parsed.data;

    const steps: TraceStep[] = input.steps.map((step, index) => ({
      n: step.n ?? index + 1,
      title: step.title,
      ...(step.call ? { call: step.call } : {}),
      ...(step.claim ? { claim: step.claim } : {}),
      ...(step.detail ? { detail: step.detail } : {}),
      ...(step.sources?.length ? { sources: step.sources } : {}),
      status: step.status,
    }));

    let taskVersionId: string | null = null;
    let domainId = input.domain ?? 'biology';
    if (input.task) {
      const [code, version] = input.task.split(/\s+v/);
      const row = await ctx.db.get<{ id: string; domain_id: string }>(
        `SELECT tv.id, t.domain_id FROM task_versions tv JOIN tasks t ON t.id = tv.task_id WHERE t.code = ? AND tv.version = ? AND t.workspace_id = ?`,
        [code ?? '', version ?? '', workspace.id],
      );
      if (!row) throw invalid({ json: `${input.task} is not a frozen task version in ${workspace.name}.` });
      taskVersionId = row.id;
      domainId = row.domain_id;
    }
    const domain = await ctx.db.get<{ id: string; name: string }>('SELECT id, name FROM domains WHERE id = ?', [domainId]);
    if (!domain) throw invalid({ json: `${domainId} is not a domain Rivet knows.` });

    let datasetVersionId: string | null = null;
    if (input.dataset) {
      const [code, version] = input.dataset.split(/\s+v/);
      const row = await ctx.db.get<{ id: string; workspace_id: string; visibility: string; deleted_at: string | null }>(
        `SELECT v.id, d.workspace_id, d.visibility, d.deleted_at FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE d.code = ? AND v.version = ?`,
        [code ?? '', version ?? ''],
      );
      if (!row || !(await canReadDataset(ctx, user, row)).allowed) throw invalid({ json: `${input.dataset} is not a dataset version you can read.` });
      if (row.deleted_at) throw invalid({ json: `${input.dataset} was deleted from the library and cannot be pinned.` });
      datasetVersionId = row.id;
    }

    const models = await ctx.db.all<{ id: string; display_name: string }>('SELECT id, display_name FROM models');
    const modelId = models.find((model) => input.agentLabel.toLowerCase().startsWith(model.display_name.toLowerCase()))?.id ?? null;

    const suite = suiteForDomain(domain.id);
    const created = nowIso(ctx);
    const result = await ctx.db.tx(async (): Promise<ImportTraceResponse> => {
      let gateId: string | null = null;
      if (suite) {
        const gate = await ctx.db.get<GateRow>('SELECT * FROM gates WHERE workspace_id = ? AND domain_id = ?', [workspace.id, domain.id]);
        if (gate) gateId = gate.id;
        else {
          gateId = newId();
          await ctx.db.run(`INSERT INTO gates (id, code, workspace_id, domain_id, target, suite, suite_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
            gateId,
            `GATE-${pad3(await nextCounter(ctx.db, 'gate'))}`,
            workspace.id,
            domain.id,
            `${workspace.name} ${domain.name} agent`,
            suite.name,
            suite.checks.length,
            created,
          ]);
        }
        const taken = await ctx.db.get<{ code: string }>('SELECT code FROM traces WHERE gate_id = ? AND candidate = ?', [gateId, input.candidate]);
        if (taken) throw invalid({ json: `Candidate ${input.candidate} already has ${taken.code}. A rerun needs a new release candidate.` });
      }
      const code = `TRACE-${pad3(await nextCounter(ctx.db, 'trace'))}`;
      const sha256 = traceHash({ code, agent_label: input.agentLabel, harness_version: input.harnessVersion, steps });
      const id = newId();
      await ctx.db.run(
        `INSERT INTO traces (id, code, workspace_id, owner_id, task_version_id, dataset_version_id, domain_id, gate_id, candidate, agent_label, model_id, harness_version, steps, change_note, sha256, is_synthetic, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, code, workspace.id, user.id, taskVersionId, datasetVersionId, domain.id, gateId, input.candidate, input.agentLabel, modelId, input.harnessVersion, JSON.stringify(steps), input.changeNote ?? '', sha256, input.synthetic ? 1 : 0, created],
      );
      await audit(ctx, { actorId: user.id, action: 'trace.imported', subjectType: 'trace', subjectId: id, subjectCode: code, workspaceId: workspace.id, detail: { sha256, candidate: input.candidate, harnessVersion: input.harnessVersion } });
      return { code, sha256 };
    });
    return c.json(result, 201);
  });

  app.get('/api/assurance/traces/:code', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const trace = await getTrace(ctx, c.req.param('code'));
    if (!trace || !(await canReadTrace(ctx, user, trace)).allowed) throw notFound();

    const rows = await adjudicationsOf(ctx, trace.id);
    const canReview = await canReviewTrace(ctx, user, trace);
    const manage = await canManageRelease(ctx, user, { workspaceId: trace.workspace_id, taskVersionId: trace.task_version_id });
    const regressionsBySource = await ctx.db.all<{ source_adjudication_id: string; code: string }>(
      `SELECT r.source_adjudication_id, r.code FROM regressions r JOIN trace_adjudications a ON a.id = r.source_adjudication_id WHERE a.trace_id = ?`,
      [trace.id],
    );
    const member = Boolean(await workspaceRole(ctx, user.id, trace.workspace_id));
    const adjudications: TraceAdjudication[] = rows.map((row) => {
      const regression = regressionsBySource.find((entry) => entry.source_adjudication_id === row.id)?.code ?? null;
      return {
        id: row.id,
        code: row.code,
        kind: row.kind,
        finding: row.finding,
        severity: row.severity,
        severityLabel: severityLabel(row.severity),
        rationale: row.rationale,
        reviewerName: row.reviewer_name,
        createdAt: row.created_at,
        // Regression pages are for workspace members, so an outside reviewer gets no link to one.
        regressionCode: member ? regression : null,
        canCreateRegression: row.kind !== 'finding' ? no('Only a confirmed finding can become a regression') : regression ? no(`${regression} already exists`) : manage,
      };
    });

    const owner = await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [trace.owner_id]);
    const domain = await ctx.db.get<{ name: string }>('SELECT name FROM domains WHERE id = ?', [trace.domain_id]);
    const evidence = trace.model_id && trace.task_version_id
      ? await ctx.db.get<{ code: string; total_score: number; short_name: string }>(
          `SELECT e.code, e.total_score, m.short_name FROM evidence e JOIN models m ON m.id = e.model_id WHERE e.task_version_id = ? AND e.model_id = ? ORDER BY e.captured_at DESC LIMIT 1`,
          [trace.task_version_id, trace.model_id],
        )
      : undefined;
    const kind = trace.is_synthetic ? 'agent-harness fixture' : 'agent-harness record';
    const separationNote = evidence
      ? `This is a separate ${kind}. It does not overwrite ${evidence.code} or ${evidence.short_name}’s frozen ${evidence.total_score}/100 task score. Adjudications are append-only.`
      : `This is a separate ${kind}. It does not overwrite any task evidence. Adjudications are append-only.`;

    let gate: TraceDetail['gate'] = null;
    if (trace.gate_id && trace.candidate && member) {
      const gateRow = await ctx.db.get<{ code: string }>('SELECT code FROM gates WHERE id = ?', [trace.gate_id]);
      const run = await ctx.db.get<{ status: 'blocked' | 'passed' }>('SELECT status FROM gate_runs WHERE gate_id = ? AND candidate = ?', [trace.gate_id, trace.candidate]);
      if (gateRow) gate = { code: gateRow.code, candidate: trace.candidate, state: run?.status ?? 'not_run' };
    }

    const findings = rows.filter((row) => row.kind === 'finding');
    const detail: TraceDetail = {
      code: trace.code,
      agentLabel: trace.agent_label,
      agentShort: shortAgent(trace.agent_label),
      harnessVersion: trace.harness_version,
      candidate: trace.candidate,
      taskLabel: await taskLabel(ctx, trace.task_version_id),
      datasetLabel: await datasetLabel(ctx, trace.dataset_version_id),
      domainName: domain?.name ?? trace.domain_id,
      ownerName: owner?.name ?? '',
      isSynthetic: Boolean(trace.is_synthetic),
      createdAt: trace.created_at,
      sha256: trace.sha256,
      verified: traceVerified(trace),
      steps: stepsOf(trace).map(stepView),
      flagged: isFlagged(trace),
      adjudications,
      decisionCode: findings.at(-1)?.code ?? null,
      nextDecisionCode: await nextAdjCode(ctx),
      reviewerName: canReview.allowed ? user.name : (rows.at(-1)?.reviewer_name ?? null),
      canReview,
      separationNote,
      findingChoices: FINDINGS.map((finding) => ({ value: finding.label, label: finding.label })),
      severityChoices: SEVERITY_CHOICES,
      gate,
    };
    return c.json(detail);
  });

  app.post('/api/assurance/traces/:code/adjudications', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const trace = await getTrace(ctx, c.req.param('code'));
    if (!trace || !(await canReadTrace(ctx, user, trace)).allowed) throw notFound();
    const verdict = await canReviewTrace(ctx, user, trace);
    if (!verdict.allowed) throw forbidden(verdict.reason);
    const input = await readJson(c, adjudicationSchema);
    if (!traceVerified(trace)) throw conflict('This trace no longer matches its hash, so it cannot be adjudicated.', 'hash_mismatch');

    const created = nowIso(ctx);
    const id = newId();
    const code = await ctx.db.tx(async () => {
      const value = input.kind === 'finding' ? adjCode(await nextCounter(ctx.db, 'adjudication:trace')) : `CLAR-TRACE-${pad3(await nextCounter(ctx.db, 'clarification:trace'))}`;
      await ctx.db.run(
        `INSERT INTO trace_adjudications (id, code, trace_id, reviewer_id, kind, finding, severity, rationale, conflict_ack, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [id, value, trace.id, user.id, input.kind, input.finding, input.severity, input.rationale, created],
      );
      await audit(ctx, {
        actorId: user.id,
        action: input.kind === 'finding' ? 'trace.finding_confirmed' : 'trace.clarification_requested',
        subjectType: 'trace',
        subjectId: trace.id,
        subjectCode: trace.code,
        workspaceId: trace.workspace_id,
        detail: { code: value, finding: input.finding, severity: input.severity },
      });
      return value;
    });

    const response: AdjudicationResponse = { code, kind: input.kind };
    if (input.kind === 'clarification') {
      // The request stands even if mail fails; the page says plainly that the owner was not emailed.
      const owner = await ctx.db.get<{ email: string; name: string }>('SELECT email, name FROM users WHERE id = ?', [trace.owner_id]);
      try {
        await sendMail(ctx, {
          to: owner?.email ?? '',
          subject: `${user.name} asked for clarification on ${trace.code}`,
          text: `Hello ${owner?.name ?? ''},\n\n${user.name} reviewed ${trace.code} and asked for clarification:\n\n${input.rationale}\n\nOpen the trace to respond: ${ctx.config.publicUrl}/assurance/traces/${trace.code}\n`,
          link: `${ctx.config.publicUrl}/assurance/traces/${trace.code}`,
          purpose: 'trace_clarification',
        });
        response.emailed = true;
      } catch (error) {
        response.emailed = false;
        response.emailError = error instanceof Error ? error.message : 'The email could not be sent.';
      }
    }
    return c.json(response, 201);
  });

  /* ---------- Regressions ---------- */

  app.post('/api/assurance/regressions', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const input = await readJson(c, z.object({ adjudicationCode: z.string({ error: 'Choose a confirmed finding.' }).trim().min(1, 'Choose a confirmed finding.') }));
    const adjudication = await ctx.db.get<AdjudicationRow>(`SELECT a.*, '' AS reviewer_name FROM trace_adjudications a WHERE a.code = ? AND a.kind = 'finding'`, [input.adjudicationCode]);
    const trace = adjudication ? await ctx.db.get<TraceRow>('SELECT * FROM traces WHERE id = ?', [adjudication.trace_id]) : undefined;
    if (!adjudication || !trace || !(await workspaceRole(ctx, user.id, trace.workspace_id))) throw notFound('This confirmed finding does not exist or you do not have access to it.');
    const verdict = await canManageRelease(ctx, user, { workspaceId: trace.workspace_id, taskVersionId: trace.task_version_id });
    if (!verdict.allowed) throw forbidden(verdict.reason);

    const existing = await ctx.db.get<{ code: string }>('SELECT code FROM regressions WHERE source_adjudication_id = ?', [adjudication.id]);
    if (existing) throw conflict(`${existing.code} already holds this finding.`, 'regression_exists');

    const domain = await ctx.db.get<{ prefix: string }>('SELECT prefix FROM domains WHERE id = ?', [trace.domain_id]);
    const gate = trace.gate_id ? await ctx.db.get<GateRow>('SELECT * FROM gates WHERE id = ?', [trace.gate_id]) : undefined;
    const definition = FINDINGS.find((finding) => finding.label === adjudication.finding) ?? (FINDINGS[0] as (typeof FINDINGS)[number]);
    const created = nowIso(ctx);
    const prefix = domain?.prefix ?? 'GEN';

    const code = await ctx.db.tx(async () => {
      if (await ctx.db.get('SELECT 1 AS ok FROM regressions WHERE source_adjudication_id = ?', [adjudication.id])) throw conflict('A regression already holds this finding.', 'regression_exists');
      const value = `REG-${prefix}-${pad3(await nextCounter(ctx.db, `regression:${prefix}`))}`;
      const id = newId();
      await ctx.db.run(
        `INSERT INTO regressions (id, code, workspace_id, owner_id, source_adjudication_id, task_version_id, dataset_version_id, gate_id, status, current_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?)`,
        [id, value, trace.workspace_id, user.id, adjudication.id, trace.task_version_id, trace.dataset_version_id, trace.gate_id, created],
      );
      await ctx.db.run(
        `INSERT INTO regression_versions (id, regression_id, version, name, pass_condition, policy, scope, scope_ack, rule, created_by, created_at) VALUES (?, ?, 1, ?, ?, 'block_high', ?, 0, ?, ?, ?)`,
        [newId(), id, definition.name, definition.passCondition, gate ? `Run for every ${gate.target} release candidate.` : 'Run for every release candidate.', definition.rule, user.id, created],
      );
      await audit(ctx, { actorId: user.id, action: 'regression.created', subjectType: 'regression', subjectId: id, subjectCode: value, workspaceId: trace.workspace_id, detail: { finding: adjudication.code, trace: trace.code, rule: definition.rule } });
      return value;
    });
    return c.json({ code }, 201);
  });

  app.get('/api/assurance/regressions/:code', async (c) => {
    const { ctx, user, regression } = await memberRegression(c);
    const versions = await regressionVersionsOf(ctx, regression.id);
    const current = versions.find((row) => row.version === regression.current_version) ?? versions[0];
    if (!current) throw notFound();

    let source: RegressionDetail['source'] = null;
    if (regression.source_adjudication_id) {
      const row = await ctx.db.get<{ code: string; finding: string; severity: string; reviewer_name: string; trace_code: string }>(
        `SELECT a.code, a.finding, a.severity, u.name AS reviewer_name, tr.code AS trace_code FROM trace_adjudications a JOIN users u ON u.id = a.reviewer_id JOIN traces tr ON tr.id = a.trace_id WHERE a.id = ?`,
        [regression.source_adjudication_id],
      );
      if (row) {
        source = {
          code: row.code,
          finding: row.finding,
          severityLabel: severityLabel(row.severity),
          severityShort: `${row.severity.charAt(0).toUpperCase()}${row.severity.slice(1)} severity`,
          reviewerName: row.reviewer_name,
          traceCode: row.trace_code,
        };
      }
    }
    const gate = regression.gate_id ? await ctx.db.get<GateRow>('SELECT * FROM gates WHERE id = ?', [regression.gate_id]) : undefined;
    const owner = await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [regression.owner_id]);
    const pins = [await taskLabel(ctx, regression.task_version_id), await datasetLabel(ctx, regression.dataset_version_id)].filter(Boolean);
    const detail: RegressionDetail = {
      code: regression.code,
      status: regression.status,
      name: current.name,
      pinnedEvaluation: pins.join(' / ') || 'No pinned evaluation',
      passCondition: current.pass_condition,
      policy: current.policy,
      policyChoices: POLICY_CHOICES,
      rule: current.rule,
      scope: current.scope,
      scopeAck: Boolean(current.scope_ack),
      currentVersion: current.version,
      activatedAt: regression.activated_at,
      source,
      target: gate?.target ?? null,
      gateCode: gate?.code ?? null,
      ownerName: owner?.name ?? '',
      canEdit: await canManageRelease(ctx, user, { workspaceId: regression.workspace_id, taskVersionId: regression.task_version_id }),
      versions: versions.map(
        (row): RegressionVersionView => ({
          version: row.version,
          name: row.name,
          passCondition: row.pass_condition,
          policy: row.policy,
          policyLabel: policyLabel(row.policy),
          scopeAck: Boolean(row.scope_ack),
          createdByName: row.created_by_name,
          createdAt: row.created_at,
          isCurrent: row.version === current.version,
        }),
      ),
    };
    return c.json(detail);
  });

  app.put('/api/assurance/regressions/:code', async (c) => {
    const { ctx, user, regression } = await memberRegression(c);
    const verdict = await canManageRelease(ctx, user, { workspaceId: regression.workspace_id, taskVersionId: regression.task_version_id });
    if (!verdict.allowed) throw forbidden(verdict.reason);
    const input = await readJson(c, regressionSchema);
    // Once active, the scope has been accepted; a later edit cannot take it back.
    if (regression.status === 'active') input.scopeAck = true;
    const result = await ctx.db.tx(async () => {
      const saved = await saveRegressionVersion(ctx, user, regression, input);
      if (saved.changed) await audit(ctx, { actorId: user.id, action: 'regression.version_saved', subjectType: 'regression', subjectId: regression.id, subjectCode: regression.code, workspaceId: regression.workspace_id, detail: { version: saved.version, policy: input.policy } });
      return saved;
    });
    return c.json(result);
  });

  app.post('/api/assurance/regressions/:code/activate', async (c) => {
    const { ctx, user, regression } = await memberRegression(c);
    const verdict = await canManageRelease(ctx, user, { workspaceId: regression.workspace_id, taskVersionId: regression.task_version_id });
    if (!verdict.allowed) throw forbidden(verdict.reason);
    if (regression.status === 'active') throw conflict(`${regression.code} is already active.`, 'already_active');
    const input = await readJson(c, regressionSchema);
    if (input.scopeAck !== true) throw invalid({ scopeAck: 'Tick the activation scope to activate this regression.' });
    if (!regression.gate_id) throw conflict('This regression has no release gate to activate on.', 'no_gate');

    const now = nowIso(ctx);
    const result = await ctx.db.tx(async () => {
      const saved = await saveRegressionVersion(ctx, user, regression, input);
      await ctx.db.run(`UPDATE regressions SET status = 'active', activated_at = ? WHERE id = ?`, [now, regression.id]);
      const [current] = await regressionVersionsOf(ctx, regression.id);
      const source = regression.source_adjudication_id
        ? await ctx.db.get<{ code: string; finding: string; severity: string; trace_code: string }>(`SELECT a.code, a.finding, a.severity, tr.code AS trace_code FROM trace_adjudications a JOIN traces tr ON tr.id = a.trace_id WHERE a.id = ?`, [regression.source_adjudication_id])
        : undefined;
      // "Activation records the rule, source task, expert finding and creator."
      await audit(ctx, {
        actorId: user.id,
        action: 'regression.activated',
        subjectType: 'regression',
        subjectId: regression.id,
        subjectCode: regression.code,
        workspaceId: regression.workspace_id,
        detail: {
          rule: current?.rule,
          version: saved.version,
          policy: input.policy,
          sourceTask: await taskLabel(ctx, regression.task_version_id),
          sourceDataset: await datasetLabel(ctx, regression.dataset_version_id),
          expertFinding: source ?? null,
          creator: regression.owner_id,
          activatedBy: user.id,
        },
      });
      return saved;
    });
    return c.json({ code: regression.code, status: 'active', version: result.version });
  });

  /* ---------- Gates ---------- */

  app.get('/api/assurance/gates/:code/:candidate', async (c) => {
    const { ctx, user, gate, trace, run, candidate } = await gateOr404(c);
    const workspace = await ctx.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [gate.workspace_id]);
    const canManage = await canManageRelease(ctx, user, { workspaceId: gate.workspace_id, taskVersionId: trace.task_version_id });
    const canRun: Verdict = run ? no(`${candidate} already has an immutable gate result`) : canManage;
    const canApprove = await approvalVerdict(ctx, user, gate, trace, run);

    const checks = run ? (JSON.parse(run.checks) as GateCheckResult[]) : [];
    const groups = run ? (JSON.parse(run.groups) as GateGroupResult[]) : [];
    const pinned = run ? (JSON.parse(run.regressions) as RegressionPin[]) : [];
    const createdBy = run ? await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [run.created_by]) : undefined;
    const decision = run
      ? await ctx.db.get<{ created_at: string; decided_by_name: string }>(`SELECT d.created_at, u.name AS decided_by_name FROM release_decisions d JOIN users u ON u.id = d.decided_by WHERE d.gate_run_id = ?`, [run.id])
      : undefined;

    const activeRows = await ctx.db.all<{ code: string; status: string }>(`SELECT code, status FROM regressions WHERE gate_id = ? AND status = 'active' ORDER BY code`, [gate.id]);
    const regressions = run ? pinned.map((regression) => ({ code: regression.code, status: 'active' })) : activeRows;

    const previousRow = await ctx.db.get<{ candidate: string; status: 'blocked' | 'passed'; trace_code: string }>(
      `SELECT r.candidate, r.status, tr.code AS trace_code FROM gate_runs r JOIN traces tr ON tr.id = r.trace_id
       WHERE r.gate_id = ? AND r.candidate <> ? AND tr.created_at < ? ORDER BY tr.created_at DESC LIMIT 1`,
      [gate.id, candidate, trace.created_at],
    );

    // "What changed": the candidate's own note, what its trace now states, and what stays frozen.
    let whatChanged: string | null = null;
    if (trace.change_note) {
      const claim = stepsOf(trace).filter((step) => step.claim).at(-1)?.claim;
      const frozen = [await taskLabel(ctx, trace.task_version_id), previousRow?.status === 'blocked' ? `the failed ${previousRow.trace_code}` : null].filter(Boolean);
      whatChanged = [
        trace.change_note,
        claim ? `${trace.code} now states “${claim}”` : null,
        frozen.length ? `${frozen.join(' and ')} ${frozen.length === 1 ? 'remains' : 'remain'} immutable.` : null,
      ].filter(Boolean).join(' ');
    }

    let alert: string;
    if (!run) alert = `${trace.code} is imported and has not been evaluated. Run the gate to decide eligibility; nothing is eligible until it passes.`;
    else if (run.status === 'blocked') alert = blockedAlert({ checks, regressions: pinned });
    else alert = 'All required checks passed. Eligibility is not deployment; approval creates a separate audited decision.';

    const detail: GateDetail = {
      gate: { code: gate.code, target: gate.target, suite: gate.suite, suiteSize: gate.suite_size, workspaceName: workspace?.name ?? '' },
      candidate,
      state: run?.status ?? 'not_run',
      trace: { code: trace.code, harnessVersion: trace.harness_version, verified: traceVerified(trace), agentLabel: trace.agent_label },
      run: run
        ? { passedCount: run.passed_count, totalCount: run.total_count, groups, checks, regressions: pinned, blockingReason: run.blocking_reason, createdAt: run.created_at, createdByName: createdBy?.name ?? '' }
        : null,
      decision: decision ? { decidedByName: decision.decided_by_name, createdAt: decision.created_at } : null,
      regressions,
      previous: previousRow ? { candidate: previousRow.candidate, state: previousRow.status } : null,
      canRun,
      canApprove,
      whatChanged,
      requiredBeforeRetry: run?.status === 'blocked' ? retryAdvice(groups) : null,
      alert,
      reportPath: run ? `/api/assurance/gates/${gate.code}/${candidate}/report` : null,
    };
    return c.json(detail);
  });

  app.post('/api/assurance/gates/:code/:candidate/run', async (c) => {
    const { ctx, user, gate, trace, run, candidate } = await gateOr404(c);
    const verdict = await canManageRelease(ctx, user, { workspaceId: gate.workspace_id, taskVersionId: trace.task_version_id });
    if (!verdict.allowed) throw forbidden(verdict.reason);
    if (run) throw conflict(`${candidate} already has an immutable gate result. Rerun the suite as a new release candidate.`, 'already_run');

    const id = newId();
    const created = nowIso(ctx);
    const evaluation = await ctx.db.tx(async () => {
      if (await ctx.db.get('SELECT 1 AS ok FROM gate_runs WHERE gate_id = ? AND candidate = ?', [gate.id, candidate])) {
        throw conflict(`${candidate} already has an immutable gate result. Rerun the suite as a new release candidate.`, 'already_run');
      }
      const result = await recordGateRun(ctx, { id, gateId: gate.id, trace, actorId: user.id, createdAt: created });
      await audit(ctx, {
        actorId: user.id,
        action: result.status === 'passed' ? 'gate.passed' : 'gate.blocked',
        subjectType: 'gate_run',
        subjectId: id,
        subjectCode: gate.code,
        workspaceId: gate.workspace_id,
        detail: { candidate, trace: trace.code, passed: result.passedCount, total: result.totalCount, reason: result.blockingReason },
      });
      return result;
    });
    return c.json({ state: evaluation.status, passedCount: evaluation.passedCount, totalCount: evaluation.totalCount }, 201);
  });

  /** The only way to approve. It reads nothing from the request: no flag, reason or role can change the outcome. */
  app.post('/api/assurance/gates/:code/:candidate/approve', async (c) => {
    const { ctx, user, gate, trace, run, candidate } = await gateOr404(c);
    const manage = await canManageRelease(ctx, user, { workspaceId: gate.workspace_id, taskVersionId: trace.task_version_id });
    if (!manage.allowed) throw forbidden(manage.reason);
    const verdict = await approvalVerdict(ctx, user, gate, trace, run);
    if (!verdict.allowed || !run) throw new HttpError(409, 'not_eligible', verdict.allowed ? 'The gate has not run for this candidate.' : verdict.reason);

    const id = newId();
    const created = nowIso(ctx);
    await ctx.db.tx(async () => {
      if (await ctx.db.get('SELECT 1 AS ok FROM release_decisions WHERE gate_run_id = ?', [run.id])) throw new HttpError(409, 'not_eligible', 'This release is already approved');
      await ctx.db.run(`INSERT INTO release_decisions (id, gate_run_id, decided_by, decision, created_at) VALUES (?, ?, ?, 'approved', ?)`, [id, run.id, user.id, created]);
      await audit(ctx, {
        actorId: user.id,
        action: 'release.approved',
        subjectType: 'gate_run',
        subjectId: run.id,
        subjectCode: gate.code,
        workspaceId: gate.workspace_id,
        detail: { candidate, trace: trace.code, passed: run.passed_count, total: run.total_count, note: 'Eligibility is not deployment.' },
      });
    });
    return c.json({ decision: 'approved', candidate, createdAt: created }, 201);
  });

  app.get('/api/assurance/gates/:code/:candidate/report', async (c) => {
    const { ctx, gate, trace, run, candidate } = await gateOr404(c);
    if (!run) throw notFound('This candidate has no gate run yet, so there is no report.');
    const workspace = await ctx.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [gate.workspace_id]);
    const createdBy = await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [run.created_by]);
    const decision = await ctx.db.get<{ created_at: string; decided_by_name: string }>(`SELECT d.created_at, u.name AS decided_by_name FROM release_decisions d JOIN users u ON u.id = d.decided_by WHERE d.gate_run_id = ?`, [run.id]);
    const report = {
      schema: 'rivet.gate_report.v1',
      gate: { code: gate.code, target: gate.target, workspace: workspace?.name ?? '' },
      candidate,
      harnessVersion: run.harness_version,
      suite: gate.suite,
      status: run.status,
      result: `${run.passed_count} / ${run.total_count}`,
      blockingReason: run.blocking_reason,
      policy: 'No manual bypass',
      trace: { code: trace.code, sha256: trace.sha256, hashVerifiedAtDownload: traceVerified(trace), synthetic: Boolean(trace.is_synthetic) },
      evaluatedAt: run.created_at,
      evaluatedBy: createdBy?.name ?? '',
      groups: JSON.parse(run.groups),
      checks: JSON.parse(run.checks),
      regressions: JSON.parse(run.regressions),
      releaseDecision: decision ? { decision: 'approved', decidedBy: decision.decided_by_name, decidedAt: decision.created_at, note: 'Eligibility is not deployment.' } : null,
      generatedAt: nowIso(ctx),
    };
    const body = `${JSON.stringify(report, null, 2)}\n`;
    return c.body(body, 200, attachmentHeaders(`${gate.code}-${candidate}-report.json`, 'application/json; charset=utf-8', { 'X-Rivet-SHA256': sha256Hex(body) }));
  });
}
