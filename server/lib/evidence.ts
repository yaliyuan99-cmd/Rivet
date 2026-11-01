import { canonicalJson, sha256Hex } from './crypto.ts';

export const RUNNER_VERSION = '2.4';

export interface EvidenceContent {
  code: string;
  run_code: string;
  task_version_hash: string;
  model_id: string;
  model_revision: string;
  output_text: string;
  output_meta: unknown;
  scores: unknown;
  total_score: number;
  score_label: string;
  runner_version: string;
  captured_at: string;
}

/** What a seal covers. Re-derive this from stored fields to verify. */
export function evidenceManifest(content: EvidenceContent) {
  return { schema: 'rivet.evidence.v1', ...content };
}

export function evidenceHash(content: EvidenceContent): string {
  return sha256Hex(canonicalJson(evidenceManifest(content)));
}

export interface TaskVersionContent {
  task_code: string;
  version: string;
  title: string;
  prompt: string;
  rubric: unknown;
  models: unknown;
  settings: unknown;
  dataset_sha256: string | null;
  scan_code: string | null;
  acknowledgements: unknown;
}

export function taskVersionHash(content: TaskVersionContent): string {
  return sha256Hex(canonicalJson({ schema: 'rivet.task_version.v1', ...content }));
}

export function reportHash(canonical: string): string {
  return sha256Hex(canonical);
}

export function traceHash(content: { code: string; agent_label: string; harness_version: string; steps: unknown }): string {
  return sha256Hex(canonicalJson({ schema: 'rivet.trace.v1', ...content }));
}

/**
 * Loads an evidence row with its run and version and recomputes the seal.
 * A mismatch means the stored bytes changed after sealing.
 */
export async function verifyEvidenceRow(
  db: { get: <T>(sql: string, params?: any[]) => Promise<T | undefined> },
  row: { code: string; run_id: string; task_version_id: string; model_id: string; model_revision: string; output_text: string; output_meta: string; scores: string; total_score: number; score_label: string; runner_version: string; captured_at: string; sha256: string },
): Promise<boolean> {
  const run = await db.get<{ code: string }>('SELECT code FROM runs WHERE id = ?', [row.run_id]);
  const version = await db.get<{ sha256: string }>('SELECT sha256 FROM task_versions WHERE id = ?', [row.task_version_id]);
  if (!run || !version) return false;
  const computed = evidenceHash({
    code: row.code,
    run_code: run.code,
    task_version_hash: version.sha256,
    model_id: row.model_id,
    model_revision: row.model_revision,
    output_text: row.output_text,
    output_meta: JSON.parse(row.output_meta),
    scores: JSON.parse(row.scores),
    total_score: row.total_score,
    score_label: row.score_label,
    runner_version: row.runner_version,
    captured_at: row.captured_at,
  });
  return computed === row.sha256;
}
