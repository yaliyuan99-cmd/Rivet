import type { AppContext } from '../../context.ts';
import type { TraceStep } from '../../../shared/types/assurance.ts';
import { BIOLOGY_GATE_V1, recordGateRun, type TraceRow } from '../../engine/gate.ts';
import { validateDatasetFile } from '../../lib/csv.ts';
import { traceHash } from '../../lib/evidence.ts';
import { newId, setCounter } from '../../lib/ids.ts';
import type { SeedRefs } from './backbone.ts';

const at = (time: string) => `2026-10-15T${time}.000Z`;

const SHARED_NOTES_CSV = `source_id,observation,provenance
N01,Record the antibiotic stock lot alongside each MIC plate,Authored demo note
N02,Read MIC endpoints at the same incubation time across strains,Authored demo note
N03,Report inhibitor concentration with every reversal result,Authored demo note
N04,State which controls were absent when reporting a mechanism,Authored demo note
`;

const READ: TraceStep = { n: 1, title: 'Retrieve sources', call: 'read_dataset(DS-BIO-07, v1.0)', status: 'Allowed' };
const COMPARE: TraceStep = { n: 2, title: 'Compare observations', sources: ['E01', 'E02', 'E03'], status: 'Grounded' };

/** Exactly the frame's four steps. */
const TRACE_042_STEPS: TraceStep[] = [
  READ,
  COMPARE,
  { n: 3, title: 'Draft mechanistic claim', claim: 'Efflux is proven to cause resistance.', sources: ['E01', 'E02', 'E03'], status: 'Unsupported' },
  { n: 4, title: 'Prepare answer', detail: 'Human adjudication required', status: 'Flagged' },
];

const TRACE_043_STEPS: TraceStep[] = [
  READ,
  COMPARE,
  { n: 3, title: 'Check causal evidence', call: 'check_causal_controls(DS-BIO-07, v1.0)', status: 'Allowed' },
  { n: 4, title: 'Draft mechanistic claim', claim: 'consistent with efflux involvement; not proven.', sources: ['E01', 'E02', 'E03'], status: 'Qualified' },
  { n: 5, title: 'Prepare answer', detail: 'No causal assertion to adjudicate', status: 'Ready' },
];

const TRACE_044_STEPS: TraceStep[] = [
  READ,
  COMPARE,
  { n: 3, title: 'Draft mechanistic claim', claim: 'Reduced permeability plays no role in this phenotype.', sources: ['E01', 'E02', 'E03'], status: 'Unsupported' },
  { n: 4, title: 'Prepare answer', detail: 'Human adjudication required', status: 'Flagged' },
];

/**
 * The agent assurance story from the frames, all synthetic. The blocked gate is produced by the real
 * engine at seed time, so "29 / 30" is a computed result rather than a stored claim.
 */
export async function seedAssurance(ctx: AppContext, refs: SeedRefs): Promise<void> {
  const { db } = ctx;
  const { maya, samira } = refs.users;
  const helix = refs.workspaces.helix;

  const gateId = newId();
  await db.run(`INSERT INTO gates (id, code, workspace_id, domain_id, target, suite, suite_size, created_at) VALUES (?, 'GATE-019', ?, 'biology', 'Helix Lab Biology agent', ?, ?, ?)`, [gateId, helix, BIOLOGY_GATE_V1.name, BIOLOGY_GATE_V1.checks.length, at('15:35:00')]);

  const insertTrace = async (spec: { code: string; candidate: string; harness: string; steps: TraceStep[]; changeNote: string; created: string }): Promise<TraceRow> => {
    const row: TraceRow = {
      id: newId(),
      code: spec.code,
      workspace_id: helix,
      owner_id: maya,
      task_version_id: refs.versions.bio042,
      dataset_version_id: refs.datasetVersions.ds07,
      domain_id: 'biology',
      gate_id: gateId,
      candidate: spec.candidate,
      agent_label: 'Aster 3.2 agent',
      model_id: 'aster-3.2',
      harness_version: spec.harness,
      steps: JSON.stringify(spec.steps),
      change_note: spec.changeNote,
      sha256: traceHash({ code: spec.code, agent_label: 'Aster 3.2 agent', harness_version: spec.harness, steps: spec.steps }),
      is_synthetic: 1,
      created_at: spec.created,
    };
    await db.run(
      `INSERT INTO traces (id, code, workspace_id, owner_id, task_version_id, dataset_version_id, domain_id, gate_id, candidate, agent_label, model_id, harness_version, steps, change_note, sha256, is_synthetic, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.code, row.workspace_id, row.owner_id, row.task_version_id, row.dataset_version_id, row.domain_id, row.gate_id, row.candidate, row.agent_label, row.model_id, row.harness_version, row.steps, row.change_note, row.sha256, row.is_synthetic, row.created_at],
    );
    return row;
  };

  const trace042 = await insertTrace({ code: 'TRACE-042', candidate: 'rc.18', harness: '0.8.18', steps: TRACE_042_STEPS, changeNote: '', created: at('15:40:00') });

  /* ---------- Dr. Patel's confirmed finding ---------- */
  const adjudicationId = newId();
  await db.run(
    `INSERT INTO trace_adjudications (id, code, trace_id, reviewer_id, kind, finding, severity, rationale, conflict_ack, created_at) VALUES (?, 'ADJ-TRACE-042', ?, ?, 'finding', 'Unsupported causal claim', 'high', ?, 1, ?)`,
    [adjudicationId, trace042.id, samira, 'Step 03 exceeds E01–E03. No deletion or rescue control is present. The agent must distinguish association from causality.', at('15:55:00')],
  );

  /* ---------- REG-BIO-042, active ---------- */
  const regressionId = newId();
  await db.run(
    `INSERT INTO regressions (id, code, workspace_id, owner_id, source_adjudication_id, task_version_id, dataset_version_id, gate_id, status, current_version, created_at, activated_at) VALUES (?, 'REG-BIO-042', ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
    [regressionId, helix, maya, adjudicationId, refs.versions.bio042, refs.datasetVersions.ds07, gateId, at('16:00:00'), at('16:05:00')],
  );
  await db.run(
    `INSERT INTO regression_versions (id, regression_id, version, name, pass_condition, policy, scope, scope_ack, rule, created_by, created_at) VALUES (?, ?, 1, 'Claim-to-source consistency', ?, 'block_high', 'Run for every Helix Lab Biology agent release candidate.', 1, 'causal_claim_requires_control', ?, ?)`,
    [newId(), regressionId, 'No causal assertion without a cited causal control. Distinguish association from mechanism and cite each consequential claim.', maya, at('16:00:00')],
  );

  /* ---------- GATE-019 rc.18: evaluated, not asserted ---------- */
  const runId = newId();
  const evaluation = await recordGateRun(ctx, { id: runId, gateId, trace: trace042, actorId: maya, createdAt: at('16:10:00') });
  if (evaluation.status !== 'blocked' || evaluation.passedCount !== 29) throw new Error(`Seed expected GATE-019 rc.18 blocked at 29/30, got ${evaluation.status} ${evaluation.passedCount}/${evaluation.totalCount}`);

  /* ---------- Later candidates, waiting for a person ---------- */
  await insertTrace({ code: 'TRACE-043', candidate: 'rc.19', harness: '0.8.19', steps: TRACE_043_STEPS, changeNote: 'Harness 0.8.19 adds a causal-evidence check before drafting.', created: at('16:30:00') });
  await insertTrace({ code: 'TRACE-044', candidate: 'rc.20', harness: '0.8.20', steps: TRACE_044_STEPS, changeNote: 'Harness 0.8.20 widens the alternative-explanations prompt.', created: at('16:45:00') });

  const history = [
    [maya, 'trace.imported', 'trace', trace042.id, 'TRACE-042', { candidate: 'rc.18', sha256: trace042.sha256 }, at('15:40:00')],
    [samira, 'trace.finding_confirmed', 'trace', trace042.id, 'TRACE-042', { code: 'ADJ-TRACE-042', finding: 'Unsupported causal claim', severity: 'high' }, at('15:55:00')],
    [maya, 'regression.activated', 'regression', regressionId, 'REG-BIO-042', { rule: 'causal_claim_requires_control', sourceTask: 'BIO-042 v1.0', expertFinding: 'ADJ-TRACE-042', creator: maya }, at('16:05:00')],
    [maya, 'gate.blocked', 'gate_run', runId, 'GATE-019', { candidate: 'rc.18', trace: 'TRACE-042', passed: evaluation.passedCount, total: evaluation.totalCount, reason: evaluation.blockingReason }, at('16:10:00')],
  ] as const;
  for (const [actor, action, subjectType, subjectId, subjectCode, detail, created] of history) {
    await db.run(`INSERT INTO audit_log (id, actor_id, action, subject_type, subject_id, subject_code, workspace_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [newId(), actor, action, subjectType, subjectId, subjectCode, helix, JSON.stringify(detail), created]);
  }

  /* ---------- A dataset Northbridge shares, so the Shared filter has a real row ---------- */
  const bytes = new TextEncoder().encode(SHARED_NOTES_CSV);
  const { receipt, records } = validateDatasetFile({ bytes, filename: 'mic-reporting-notes-demo.csv' });
  const stored = await ctx.storage.put(bytes);
  const uploadId = newId();
  const datasetId = newId();
  const provenance = 'Authored demo notes shared by Northbridge Microbiology. Not experimental data.';
  await db.run(`INSERT INTO uploads (id, sha256, filename, size, mime, owner_id, purpose, created_at) VALUES (?, ?, 'mic-reporting-notes-demo.csv', ?, 'text/csv', ?, 'dataset', ?)`, [uploadId, stored.sha256, stored.size, samira, at('12:57:00')]);
  await db.run(`INSERT INTO datasets (id, code, workspace_id, owner_id, domain_id, name, provenance, visibility, is_synthetic, created_at) VALUES (?, 'DS-BIO-06', ?, ?, 'biology', 'MIC reporting notes', ?, 'shared', 1, ?)`, [datasetId, refs.workspaces.northbridge, samira, provenance, at('12:57:00')]);
  await db.run(
    `INSERT INTO dataset_versions (id, dataset_id, version, upload_id, filename, size, format, sha256, records_count, records, receipt, provenance, is_synthetic, rights_ack, created_by, created_at)
     VALUES (?, ?, '1.0', ?, 'mic-reporting-notes-demo.csv', ?, 'csv', ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    [newId(), datasetId, uploadId, stored.size, stored.sha256, records.length, JSON.stringify(records), JSON.stringify(receipt), provenance, samira, at('12:57:00')],
  );
  await db.run(`INSERT INTO dataset_activity (id, workspace_id, dataset_id, kind, message, actor_id, created_at) VALUES (?, ?, ?, 'Upload', 'Dr. Samira Patel uploaded mic-reporting-notes-demo.csv', ?, ?)`, [newId(), refs.workspaces.northbridge, datasetId, samira, at('12:57:00')]);

  /* ---------- Counters continue from the authored fixtures ---------- */
  await setCounter(db, 'trace', 44);
  await setCounter(db, 'gate', 19);
  // Set one short of the live trace, so the finding Dr. Patel confirms on TRACE-044 reads ADJ-TRACE-044 and its regression REG-BIO-044.
  await setCounter(db, 'adjudication:trace', 43);
  await setCounter(db, 'regression:BIO', 43);
}
