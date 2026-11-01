import type { FindingStatus, ScanFinding, ScanFindings, ScanRisk } from '../../shared/types/evaluation.ts';
import type { AppContext, UserRow } from '../context.ts';
import { accessRow, datasetLabel, hasPrivateAccess, loadDataset, parseJson, recordRange, sourceRecords, type DatasetVersionInfo, type TaskRow, versionLabel } from '../engine/contract.ts';
import { canReadDataset, canReadTask } from './permissions.ts';
import { canonicalJson, sha256Hex } from './crypto.ts';

/**
 * The contamination preview a task owner sees before freezing.
 *
 * Rivet can only compare a prompt with what it holds. The corpus is limited to documents the owner
 * may read, so a scan cannot be used to probe another workspace's private prompts, and a finding of
 * no match never means the prompt is clean: training exposure stays unknown.
 */

export const NGRAM_SIZE = 13;
const MIN_PHRASE_TOKENS = 3;
const MIN_CONTENT_TOKENS = 2;
const MAX_PHRASES_SHOWN = 3;
/** A very large dataset is scanned up to this many characters, and the scope line says so. */
const MAX_DATASET_CHARS = 2_000_000;

const STOPWORDS = new Set(
  'a an and are as at be been but by can cannot could did do does for from had has have how if in into is it its may might more most must no nor not of on one only or other our should so such than that the their them then there these they this those to two under up use using was we were what when where which while who why will with would you your'.split(' '),
);

export interface Token {
  text: string;
  start: number;
  end: number;
}

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Letters, digits and marks, so "AcrAB-TolC" is two tokens and spacing or case cannot hide a match. */
export function tokenize(text: string): Token[] {
  const source = text.normalize('NFKC');
  const tokens: Token[] = [];
  for (const match of source.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    tokens.push({ text: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

const tokenTexts = (text: string) => tokenize(text).map((token) => token.text);

/** Share of source tokens inside an n-word window that also appears in the reference. */
export function ngramCoverage(source: string[], reference: string[], n = NGRAM_SIZE): { checkable: boolean; covered: number } {
  if (source.length < n || reference.length < n) return { checkable: source.length >= n, covered: 0 };
  const windows = new Set<string>();
  for (let i = 0; i <= reference.length - n; i += 1) windows.add(reference.slice(i, i + n).join('\u0001'));
  const covered = new Set<number>();
  for (let i = 0; i <= source.length - n; i += 1) {
    if (windows.has(source.slice(i, i + n).join('\u0001'))) for (let j = i; j < i + n; j += 1) covered.add(j);
  }
  return { checkable: true, covered: covered.size / source.length };
}

export interface SharedRun {
  start: number;
  length: number;
}

/** Longest common runs of at least `min` tokens, found through an index of the reference's opening trigrams. */
export function sharedRuns(source: string[], reference: string[], min = MIN_PHRASE_TOKENS): SharedRun[] {
  if (source.length < min || reference.length < min) return [];
  const index = new Map<string, number[]>();
  for (let i = 0; i <= reference.length - min; i += 1) {
    const key = reference.slice(i, i + min).join('\u0001');
    const positions = index.get(key);
    if (positions) positions.push(i);
    else index.set(key, [i]);
  }
  const runs: SharedRun[] = [];
  let cursor = 0;
  while (cursor <= source.length - min) {
    const positions = index.get(source.slice(cursor, cursor + min).join('\u0001'));
    let best = 0;
    if (positions) {
      for (const position of positions) {
        let length = min;
        while (cursor + length < source.length && position + length < reference.length && source[cursor + length] === reference[position + length]) length += 1;
        if (length > best) best = length;
      }
    }
    if (best > 0) {
      runs.push({ start: cursor, length: best });
      cursor += best;
    } else {
      cursor += 1;
    }
  }
  return runs;
}

function contentTokens(tokens: string[]): number {
  return tokens.filter((token) => !STOPWORDS.has(token) && !/^\d+$/.test(token)).length;
}

/** What the scan compares against. `shared` documents are visible beyond one workspace. */
interface CorpusDocument {
  kind: 'task' | 'report' | 'dataset';
  label: string;
  text: string;
  shared: boolean;
}

export interface ScanDraft {
  id: string;
  title: string;
  prompt: string;
  rubric: string;
  model_ids: string;
  settings: string;
  dataset_version_id: string | null;
  domain_id: string;
}

/** What a preview vouches for. Any change to it makes the preview stale. */
export function draftInputHash(draft: Omit<ScanDraft, 'id'>): string {
  return sha256Hex(
    canonicalJson({
      schema: 'rivet.scan_input.v1',
      title: draft.title,
      prompt: draft.prompt,
      rubric: parseJson<unknown>(draft.rubric, []),
      model_ids: parseJson<unknown>(draft.model_ids, []),
      settings: parseJson<unknown>(draft.settings, {}),
      dataset_version_id: draft.dataset_version_id,
      domain_id: draft.domain_id,
    }),
  );
}

async function buildCorpus(ctx: AppContext, user: UserRow, task: TaskRow, attachedDatasetId: string | null): Promise<{ documents: CorpusDocument[]; truncated: boolean }> {
  const documents: CorpusDocument[] = [];

  const others = await ctx.db.all<TaskRow>('SELECT * FROM tasks WHERE id <> ? ORDER BY code', [task.id]);
  for (const other of others) {
    if (!(await canReadTask(ctx, user, accessRow(other))).allowed) continue;
    const shared = other.visibility === 'shared' && Boolean(other.latest_version_id);
    const versions = await ctx.db.all<{ version: string; prompt: string }>('SELECT version, prompt FROM task_versions WHERE task_id = ? ORDER BY frozen_at', [other.id]);
    for (const version of versions) documents.push({ kind: 'task', label: versionLabel(other.code, version.version), text: version.prompt, shared });
    const draftIsNew = other.status === 'draft' && other.prompt.trim() && !versions.some((version) => version.prompt === other.prompt);
    if (draftIsNew && (await hasPrivateAccess(ctx, user, other))) documents.push({ kind: 'task', label: `${versionLabel(other.code, other.draft_version)} draft`, text: other.prompt, shared: false });
  }

  // Reports are published to every verified account, including those of this task's earlier versions.
  const reports = await ctx.db.all<{ code: string; version: string; headline: string; summary: string; limitations: string }>('SELECT code, version, headline, summary, limitations FROM reports ORDER BY code, version');
  for (const report of reports) {
    documents.push({ kind: 'report', label: `${report.code} v${report.version}`, text: `${report.headline} ${report.summary} ${report.limitations}`, shared: true });
  }

  let truncated = false;
  const versions = await ctx.db.all<{ id: string; dataset_id: string; code: string; version: string; records: string; workspace_id: string; visibility: string; deleted_at: string | null }>(
    `SELECT v.id, v.dataset_id, d.code, v.version, v.records, d.workspace_id, d.visibility, d.deleted_at
     FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id
     WHERE d.deleted_at IS NULL ORDER BY d.code, v.created_at`,
  );
  for (const version of versions) {
    // A task's own source pack is expected to overlap with its prompt.
    if (version.dataset_id === attachedDatasetId) continue;
    if (!(await canReadDataset(ctx, user, version)).allowed) continue;
    let used = 0;
    for (const record of sourceRecords(version.records)) {
      const text = Object.values(record.raw).filter((value) => typeof value === 'string').join(' ');
      used += text.length;
      if (used > MAX_DATASET_CHARS) {
        truncated = true;
        break;
      }
      documents.push({ kind: 'dataset', label: `${version.code} v${version.version} / ${record.id}`, text, shared: version.visibility === 'shared' });
    }
  }
  return { documents, truncated };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function describeScope(documents: CorpusDocument[], truncated: boolean): string {
  const count = (kind: CorpusDocument['kind']) => documents.filter((document) => document.kind === kind).length;
  const parts = [plural(count('task'), 'other task version'), plural(count('report'), 'report'), plural(count('dataset'), 'dataset record')];
  return `Compared with ${parts[0]}, ${parts[1]} and ${parts[2]} you can access${truncated ? ', up to the size limit per dataset' : ''}. Other workspaces’ private content is not scanned.`;
}

function sourceExposureFinding(dataset: DatasetVersionInfo | undefined, documents: CorpusDocument[]): ScanFinding {
  const label = 'Source exposure';
  if (!dataset) return { status: 'clear', label, detail: 'No attached source pack.' };
  const records = sourceRecords(dataset.records);
  if (records.length === 0) return { status: 'unknown', label, detail: `${datasetLabel(dataset)} has no parsed records to compare.` };
  const ids = records.map((record) => record.id);
  const publicTexts = documents.filter((document) => document.shared).map((document) => tokenTexts(document.text).join(' '));
  const exposed = records.filter((record) => {
    const tokens = tokenTexts(record.observation);
    if (tokens.length < MIN_PHRASE_TOKENS) return false;
    const needle = tokens.join(' ');
    return publicTexts.some((text) => text.includes(needle));
  });
  const provenance = [dataset.is_synthetic ? 'synthetic' : null, dataset.visibility === 'shared' ? 'shared' : 'private'].filter(Boolean).join(' and ');
  if (exposed.length > 0) {
    return { status: 'low', label, detail: `${recordRange(exposed.map((record) => record.id))} ${exposed.length === 1 ? 'appears' : 'appear'} in shared Rivet documents · Low risk`, matches: exposed.map((record) => record.id) };
  }
  return { status: 'clear', label, detail: `${recordRange(ids)} ${provenance}; no public match.` };
}

function acknowledgementFor(findings: { exact: boolean; covered: boolean; phrases: number; exposed: boolean; dataset: DatasetVersionInfo | undefined }): string {
  const parts: string[] = [];
  if (findings.exact || findings.covered) parts.push('I have reviewed the overlap this scan reports and accept it for this version.');
  else if (findings.phrases === 1) parts.push('The matching phrase is standard terminology.');
  else if (findings.phrases > 1) parts.push('The matching phrases are standard terminology.');
  if (findings.exposed) parts.push('I have reviewed where these source records already appear.');
  if (findings.dataset) parts.push(findings.dataset.is_synthetic ? 'These source records were authored for this synthetic demo.' : 'I have reviewed these source records and their provenance.');
  parts.push('Training exposure cannot be ruled out.');
  return parts.join(' ');
}

function summaryFor(findings: { exact: boolean; covered: boolean; phrases: number; exposed: boolean }): string {
  const tail = 'This signal is not proof of training contamination.';
  if (findings.exact) return `This prompt exactly matches a scanned document. ${tail}`;
  if (findings.covered) return `Part of this prompt closely matches a scanned document. ${tail}`;
  if (findings.phrases > 0) return `${findings.phrases === 1 ? 'One possible terminology overlap' : `${findings.phrases} possible terminology overlaps`}. ${tail}`;
  if (findings.exposed) return `Attached source records appear in shared documents. ${tail}`;
  return 'No overlap found in the indexes Rivet can scan.';
}

export interface ScanResult {
  findings: ScanFindings;
  risk: ScanRisk;
  inputHash: string;
}

/** Runs the whole check for the current draft. Pure reads; the route stores the result. */
export async function runContaminationScan(ctx: AppContext, user: UserRow, task: TaskRow): Promise<ScanResult> {
  const dataset = await loadDataset(ctx, task.dataset_version_id);
  const { documents, truncated } = await buildCorpus(ctx, user, task, dataset?.dataset_id ?? null);

  const promptTokens = tokenize(task.prompt);
  const promptTexts = promptTokens.map((token) => token.text);
  const normalizedPrompt = promptTexts.join(' ');

  const exactMatches: string[] = [];
  const phraseSources = new Map<string, Set<string>>();
  let bestCoverage = 0;
  let coverageSource: string | null = null;
  let checkable = promptTexts.length >= NGRAM_SIZE;
  const coverageMatches = new Set<string>();

  const sourcePrompt = task.prompt.normalize('NFKC');

  for (const document of documents) {
    const reference = tokenTexts(document.text);
    if (normalizedPrompt && reference.join(' ') === normalizedPrompt) exactMatches.push(document.label);

    const coverage = ngramCoverage(promptTexts, reference);
    if (!coverage.checkable) checkable = false;
    if (coverage.covered > 0) coverageMatches.add(document.label);
    if (coverage.covered > bestCoverage) {
      bestCoverage = coverage.covered;
      coverageSource = document.label;
    }

    for (const run of sharedRuns(promptTexts, reference)) {
      if (run.length >= NGRAM_SIZE) continue; // reported by the coverage line
      const tokens = promptTexts.slice(run.start, run.start + run.length);
      if (contentTokens(tokens) < MIN_CONTENT_TOKENS) continue;
      const first = promptTokens[run.start] as Token;
      const last = promptTokens[run.start + run.length - 1] as Token;
      const phrase = sourcePrompt.slice(first.start, last.end);
      const sources = phraseSources.get(phrase) ?? new Set<string>();
      sources.add(document.label);
      phraseSources.set(phrase, sources);
    }
  }

  // Keep the longest phrases and drop any contained in a longer one.
  const phrases = [...phraseSources.keys()]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .filter((phrase, index, all) => !all.slice(0, index).some((longer) => normalize(longer).includes(normalize(phrase))));

  const exact = exactMatches.length > 0;
  const covered = bestCoverage > 0;
  const sourceExposure = sourceExposureFinding(dataset, documents);
  const exposed = sourceExposure.status === 'low';

  const exactPrompt: ScanFinding = exact
    ? { status: 'high', label: 'Exact prompt match', detail: `Matches ${exactMatches.slice(0, 3).join(', ')}${exactMatches.length > 3 ? ` and ${exactMatches.length - 3} more` : ''} · High risk`, matches: exactMatches }
    : { status: 'clear', label: 'Exact prompt match', detail: 'No match in scanned indexes.' };

  const shown = phrases.slice(0, MAX_PHRASES_SHOWN).map((phrase) => `“${phrase}”`).join(', ');
  const nearDuplicate: ScanFinding = phrases.length
    ? {
        status: 'low',
        label: 'Near-duplicate phrase',
        detail: `${shown}${phrases.length > MAX_PHRASES_SHOWN ? ` and ${phrases.length - MAX_PHRASES_SHOWN} more` : ''} · Low risk`,
        phrases,
        matches: [...new Set(phrases.flatMap((phrase) => [...(phraseSources.get(phrase) ?? [])]))],
      }
    : { status: 'clear', label: 'Near-duplicate phrase', detail: 'No match in scanned indexes.', phrases: [] };

  const coverageStatus: FindingStatus = covered ? 'high' : checkable ? 'clear' : 'unknown';
  const coverage: ScanFinding = {
    status: coverageStatus,
    label: '13-gram coverage',
    detail: covered
      ? `${Math.round(bestCoverage * 100)}% of this prompt overlaps ${coverageSource} · High risk`
      : promptTexts.length < NGRAM_SIZE
        ? `Not checkable: this prompt is shorter than ${NGRAM_SIZE} words.`
        : 'No 13-word window of this prompt appears in scanned indexes.',
    maxCoverage: bestCoverage,
    matches: [...coverageMatches],
  };

  const trainingCoverage: ScanFinding = { status: 'unknown', label: 'Training corpus coverage', detail: 'Not accessible to Rivet · Unknown' };

  const shape = { exact, covered, phrases: phrases.length, exposed };
  const findings: ScanFindings = {
    exactPrompt,
    nearDuplicate,
    coverage,
    sourceExposure,
    trainingCoverage,
    summary: summaryFor(shape),
    acknowledgementText: acknowledgementFor({ ...shape, dataset }),
    retentionText: 'Retain the scan and its limitations with every frozen report.',
    scope: describeScope(documents, truncated),
  };

  const risk: ScanRisk = exact || covered ? 'high' : phrases.length > 0 || exposed ? 'low' : 'none';
  return { findings, risk, inputHash: draftInputHash(task) };
}

/** IDs written like E01 in a prompt, with ranges expanded: "E01–E03" gives E01, E02, E03. */
export function citedRecordIds(prompt: string): string[] {
  const ids = new Set<string>();
  for (const match of prompt.matchAll(/\b([A-Z])(\d{2,3})\s*[–—-]\s*\1?(\d{2,3})\b/g)) {
    const [, letter, from, to] = match as unknown as [string, string, string, string];
    const start = Number(from);
    const end = Number(to);
    if (end >= start && end - start <= 50) for (let i = start; i <= end; i += 1) ids.add(`${letter}${String(i).padStart(from.length, '0')}`);
  }
  for (const match of prompt.matchAll(/\b([A-Z]\d{2,3})\b/g)) ids.add(match[1] as string);
  return [...ids].sort();
}
