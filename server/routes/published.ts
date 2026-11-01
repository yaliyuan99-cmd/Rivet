import type { Hono } from 'hono';
import type { DomainDto } from '../../shared/types/expert.ts';
import type { IncludedTask, LeaderboardResponse, LeaderboardRowDto, LeaderboardSample, MethodologyResponse, MethodologyTaskRow, ReportEvidenceDto, ReportListItem, ReportResponse, ReportScoreDto, ReportsResponse } from '../../shared/types/published.ts';
import type { AppContext, AppEnv, UserRow } from '../context.ts';
import { requireVerified } from '../lib/auth.ts';
import { canonicalJson } from '../lib/crypto.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { reportHash, verifyEvidenceRow } from '../lib/evidence.ts';
import { canReadTask, type TaskAccessRow } from '../lib/permissions.ts';
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, describeUncertainty, pairedBootstrap, percentileIndices, readOverlap, round1 } from '../lib/statistics.ts';

/* ---------- Report content ---------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (value: number) => String(value).padStart(2, '0');

/** 15 Oct 2026, 15:30 UTC */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Chen, M. */
export function citationAuthor(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => !/^(dr|prof|mr|ms|mrs)\.?$/i.test(part));
  if (parts.length < 2) return parts[0] ?? name;
  const initials = parts.slice(0, -1).map((part) => `${part[0]?.toUpperCase()}.`).join(' ');
  return `${parts[parts.length - 1]}, ${initials}`;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const sentence = trimmed.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? trimmed;
  if (sentence.length <= 140) return sentence;
  return `${sentence.slice(0, 140).replace(/\s+\S*$/, '')}…`;
}

function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface ReportContentInput {
  taskCode: string;
  title: string;
  reportCode: string;
  version: string;
  ownerName: string;
  frozenAt: string;
  finding: string;
  scores: ReportScoreDto[];
  scan: { code: string; risk: string; findings: { nearDuplicate?: { phrases?: string[] } } } | null;
  acknowledgements: string[];
  synthetic: boolean;
  sourcesSynthetic: boolean;
}

/**
 * Writes a live report's prose from what the review recorded, with no model in the loop:
 * the headline is the first sentence of the expert's finding; the summary is the score ordering
 * followed by the finding, quoted whole; the limitations always state n = 1, the scan and its
 * acknowledgement, and unknown training exposure.
 */
export function generateReportContent(input: ReportContentInput) {
  const sorted = [...input.scores].sort((a, b) => b.score - a.score);
  const topScore = sorted[0]?.score ?? 0;
  const leaders = sorted.filter((item) => item.score === topScore);
  const rest = sorted.filter((item) => item.score !== topScore);
  const lead =
    leaders.length > 1
      ? `${joinNames(leaders.map((item) => item.displayName))} share the highest reviewed score on this task at ${topScore} / 100`
      : `${leaders[0]?.displayName} has the highest reviewed score on this task at ${topScore} / 100`;
  const followers = rest.length ? `, followed by ${joinNames(rest.map((item) => `${item.displayName} at ${item.score}`))}` : '';
  const closing = input.synthetic ? 'These findings do not establish real model capability.' : 'One task does not establish general model capability.';

  const limitations = ['n = 1 task. No population confidence interval.'];
  if (input.synthetic) limitations.push('Scores are synthetic demo scores, not measurements.');
  if (input.sourcesSynthetic) limitations.push('Attached sources are authored fixtures, not measurements.');
  if (input.scan) {
    const phrases = input.scan.findings.nearDuplicate?.phrases ?? [];
    const phrase = phrases.length ? `: “${phrases.join('”, “')}”` : '';
    if (input.scan.risk === 'none') limitations.push(`Contamination scan ${input.scan.code} found no overlap in the indexes Rivet can scan.`);
    else limitations.push(`A ${input.scan.risk}-risk overlap was acknowledged in contamination scan ${input.scan.code}${phrase}.`);
  } else {
    limitations.push('No contamination scan is attached to this version.');
  }
  if (input.acknowledgements[0]) limitations.push(`Acknowledged at freeze: “${input.acknowledgements[0]}”`);
  limitations.push('Model training exposure remains unknown.');

  return {
    headline: firstSentence(input.finding),
    summary: `${lead}${followers}. Expert finding: “${input.finding.trim()}” ${closing}`,
    limitations: limitations.join(' '),
    citation: `${citationAuthor(input.ownerName)} (${new Date(input.frozenAt).getUTCFullYear()}). ${input.taskCode}: ${input.title}. Rivet, ${input.reportCode} v${input.version}.${input.synthetic ? ' Synthetic demo report.' : ''}`,
  };
}

/* ---------- Report integrity ---------- */

export interface ReportRow {
  id: string;
  code: string;
  version: string;
  task_id: string;
  task_version_id: string;
  run_id: string;
  review_id: string;
  adjudication_id: string;
  owner_id: string;
  expert_id: string;
  admin_id: string;
  domain_id: string;
  headline: string;
  summary: string;
  limitations: string;
  scores: string;
  citation: string;
  canonical: string;
  sha256: string;
  frozen_at: string;
  is_synthetic: number;
}

/** The stored hash must match the manifest, and the manifest must say what the columns say. */
export function reportIntegrity(row: ReportRow): boolean {
  if (reportHash(row.canonical) !== row.sha256) return false;
  try {
    const manifest = JSON.parse(row.canonical) as Record<string, unknown>;
    return (
      manifest.code === row.code &&
      manifest.version === row.version &&
      manifest.headline === row.headline &&
      manifest.summary === row.summary &&
      manifest.limitations === row.limitations &&
      manifest.citation === row.citation &&
      canonicalJson(manifest.scores) === canonicalJson(JSON.parse(row.scores))
    );
  } catch {
    return false;
  }
}

const reportPath = (code: string, version: string) => `/reports/${code}/v${version}`;

interface EvidenceRow {
  code: string;
  run_id: string;
  task_version_id: string;
  model_id: string;
  model_revision: string;
  output_text: string;
  output_meta: string;
  scores: string;
  total_score: number;
  score_label: string;
  runner_version: string;
  captured_at: string;
  sha256: string;
}

/** Recomputes the report's hash and every evidence seal on this request. */
async function verifyReport(ctx: AppContext, row: ReportRow, runCode: string, taskLabel: string) {
  const reportOk = reportIntegrity(row);
  const evidenceRows = await ctx.db.all<EvidenceRow>('SELECT * FROM evidence WHERE run_id = ?', [row.run_id]);
  const seals = await Promise.all(evidenceRows.map((evidence) => verifyEvidenceRow(ctx.db, evidence)));
  const scores = parseScores(row.scores);
  const topCode = [...scores].sort((a, b) => b.score - a.score)[0]?.evidenceCode;
  const topIndex = evidenceRows.findIndex((evidence) => evidence.code === topCode);
  const top = evidenceRows[topIndex];
  const evidence: ReportEvidenceDto | null = top
    ? { code: top.code, runCode, taskLabel, sha256: top.sha256, capturedAt: top.captured_at, runnerVersion: top.runner_version, verified: seals[topIndex] === true }
    : null;
  return { reportOk, verified: reportOk && seals.every(Boolean), evidence, scores };
}

function parseScores(json: string): ReportScoreDto[] {
  try {
    return JSON.parse(json) as ReportScoreDto[];
  } catch {
    return [];
  }
}

interface ReportContextRow extends ReportRow {
  task_code: string;
  task_version: string;
  title: string;
  domain_name: string;
  owner_name: string;
  expert_name: string;
  admin_name: string;
  adjudication_code: string;
  review_code: string;
  run_code: string;
}

async function loadReport(ctx: AppContext, code: string, version: string): Promise<ReportContextRow | undefined> {
  return ctx.db.get<ReportContextRow>(
    `SELECT r.*, t.code AS task_code, tv.version AS task_version, tv.title AS title, d.name AS domain_name,
            o.name AS owner_name, e.name AS expert_name, a.name AS admin_name,
            adj.code AS adjudication_code, rv.code AS review_code, run.code AS run_code
     FROM reports r
     JOIN tasks t ON t.id = r.task_id
     JOIN task_versions tv ON tv.id = r.task_version_id
     JOIN domains d ON d.id = r.domain_id
     JOIN users o ON o.id = r.owner_id
     JOIN users e ON e.id = r.expert_id
     JOIN users a ON a.id = r.admin_id
     JOIN adjudications adj ON adj.id = r.adjudication_id
     JOIN reviews rv ON rv.id = r.review_id
     JOIN runs run ON run.id = r.run_id
     WHERE r.code = ? AND r.version = ?`,
    [code, version],
  );
}

function reportMarkdown(row: ReportContextRow, scores: ReportScoreDto[], evidenceSeals: { code: string; sha256: string }[], url: string): string {
  const lines = [
    `# ${row.code} v${row.version}: ${row.headline}`,
    '',
    `Frozen ${formatUtc(row.frozen_at)}. ${row.task_code} v${row.task_version}: ${row.title}.`,
    ...(row.is_synthetic ? ['', 'SYNTHETIC DEMO. All scores, sources and findings are authored examples. Not real benchmark claims or scientific evidence.'] : []),
    '',
    '## Summary',
    '',
    row.summary,
    '',
    '## Final, independently reviewed scores',
    '',
    '| Model | Score | Label | Evidence |',
    '| --- | --- | --- | --- |',
    ...scores.map((score) => `| ${score.displayName} | ${score.score} / 100 | ${score.label} | ${score.evidenceCode} |`),
    '',
    '## Scope and limitations',
    '',
    row.limitations,
    '',
    '## Provenance',
    '',
    `- Owner: ${row.owner_name}`,
    `- Expert: ${row.expert_name} / ${row.review_code}`,
    `- Admin: ${row.admin_name} / ${row.adjudication_code}`,
    `- Run: ${row.run_code}`,
    ...evidenceSeals.map((seal) => `- Evidence ${seal.code}: SHA-256 ${seal.sha256}`),
    '',
    '## Citation',
    '',
    row.citation,
    '',
    url,
    '',
    '## Frozen manifest',
    '',
    `SHA-256 of the JSON below, byte for byte: ${row.sha256}`,
    '',
    '```json',
    row.canonical,
    '```',
    '',
    'Hash integrity does not establish truth.',
    '',
  ];
  return lines.join('\n');
}

/* ---------- Leaderboard ---------- */

async function loadDomains(ctx: AppContext): Promise<DomainDto[]> {
  return ctx.db.all<DomainDto>('SELECT id, name, field FROM domains ORDER BY sort, name');
}

interface ScoreRowJoined {
  task_label: string;
  model_id: string;
  score: number;
  report_id: string | null;
  is_fixture: number;
  created_at: string;
  display_name: string | null;
  short_name: string | null;
  report_synthetic: number | null;
}

async function loadSample(ctx: AppContext, domain: DomainDto) {
  const rows = await ctx.db.all<ScoreRowJoined>(
    `SELECT l.task_label, l.model_id, l.score, l.report_id, l.is_fixture, l.created_at, m.display_name, m.short_name, r.is_synthetic AS report_synthetic
     FROM leaderboard_scores l
     LEFT JOIN models m ON m.id = l.model_id
     LEFT JOIN reports r ON r.id = l.report_id
     WHERE l.domain_id = ?`,
    [domain.id],
  );
  const result = pairedBootstrap(rows.map((row) => ({ taskLabel: row.task_label, modelId: row.model_id, score: row.score })));
  const names = new Map(rows.map((row) => [row.model_id, { displayName: row.display_name ?? row.model_id, shortName: row.short_name ?? row.display_name ?? row.model_id }]));

  const tasks = new Map<string, { fixture: boolean; reportId: string | null }>();
  for (const row of rows) {
    const task = tasks.get(row.task_label) ?? { fixture: false, reportId: null };
    tasks.set(row.task_label, { fixture: task.fixture || row.is_fixture === 1, reportId: task.reportId ?? row.report_id });
  }
  const taskValues = [...tasks.values()];
  const sample: LeaderboardSample = {
    tasks: result.tasks.length,
    models: result.models.length,
    missing: result.missing,
    sealedReceipts: taskValues.filter((task) => task.reportId).length,
    authoredOnly: taskValues.filter((task) => !task.reportId).length,
    fixtureTasks: taskValues.filter((task) => task.fixture).length,
    liveReports: taskValues.filter((task) => !task.fixture).length,
    synthetic: rows.some((row) => row.is_fixture === 1 || row.report_synthetic === 1),
    snapshotAt: rows.reduce<string | null>((latest, row) => (!latest || row.created_at > latest ? row.created_at : latest), null),
  };

  const leaderboardRows: LeaderboardRowDto[] = result.models.map((model) => ({
    modelId: model.modelId,
    displayName: names.get(model.modelId)?.displayName ?? model.modelId,
    mean: round1(model.mean),
    low: model.low === null ? null : round1(model.low),
    high: model.high === null ? null : round1(model.high),
    n: model.n,
    summary: model.low === null || model.high === null ? `${model.mean.toFixed(1)} · no interval · n=${model.n}` : `${model.mean.toFixed(1)} [${model.low.toFixed(1)}, ${model.high.toFixed(1)}] n=${model.n}`,
  }));
  const intervals = result.models.map((model) => ({ label: names.get(model.modelId)?.shortName ?? model.modelId, low: model.low, high: model.high }));
  return { rows, result, names, tasks, sample, leaderboardRows, intervals };
}

function alertText(sample: LeaderboardSample, hasIntervals: boolean): string {
  const parts = [];
  if (sample.fixtureTasks) parts.push(plural(sample.fixtureTasks, 'authored task fixture'));
  if (sample.liveReports) parts.push(plural(sample.liveReports, 'finalized report'));
  const interval = hasIntervals ? '95% bootstrap intervals' : 'no interval below two tasks';
  return sample.synthetic ? `Synthetic domain aggregate, not real benchmark results. ${parts.join(' and ')}; ${interval}.` : `Domain aggregate of ${parts.join(' and ')}; ${interval}.`;
}

function receiptsText(sample: LeaderboardSample): string {
  const parts = [];
  if (sample.sealedReceipts) parts.push(plural(sample.sealedReceipts, 'sealed run receipt'));
  if (sample.authoredOnly) parts.push(plural(sample.authoredOnly, 'authored fixture'));
  return `${parts.join(' · ')} →`;
}

function boundaryText(sample: LeaderboardSample, domain: DomainDto): string {
  if (sample.fixtureTasks) return `Synthetic fixtures, not real ${domain.name} capability claims`;
  if (sample.synthetic) return `Synthetic demo scores, not real ${domain.name} capability claims`;
  return `These tasks only, not a general ${domain.name} capability claim`;
}

/** The newest report in this domain's sample. */
async function includedTask(ctx: AppContext, user: UserRow, domain: DomainDto): Promise<IncludedTask | null> {
  const row = await ctx.db.get<ReportRow & { task_code: string; task_version: string; owner_name: string; expert_name: string; workspace_id: string; task_owner_id: string; visibility: 'private' | 'shared'; task_status: 'draft' | 'frozen' }>(
    `SELECT r.*, t.code AS task_code, tv.version AS task_version, o.name AS owner_name, e.name AS expert_name,
            t.workspace_id, t.owner_id AS task_owner_id, t.visibility, t.status AS task_status
     FROM reports r
     JOIN tasks t ON t.id = r.task_id
     JOIN task_versions tv ON tv.id = r.task_version_id
     JOIN users o ON o.id = r.owner_id
     JOIN users e ON e.id = r.expert_id
     WHERE r.domain_id = ? AND r.id IN (SELECT report_id FROM leaderboard_scores WHERE domain_id = ? AND report_id IS NOT NULL)
     ORDER BY r.frozen_at DESC LIMIT 1`,
    [domain.id, domain.id],
  );
  if (!row) return null;
  const task: TaskAccessRow = { id: row.task_id, code: row.task_code, workspace_id: row.workspace_id, owner_id: row.task_owner_id, domain_id: row.domain_id, visibility: row.visibility, status: row.task_status };
  const canReadEvidence = (await canReadTask(ctx, user, task)).allowed;
  const scores = parseScores(row.scores);
  const top = [...scores].sort((a, b) => b.score - a.score)[0];
  const reportHref = reportPath(row.code, row.version);
  return {
    label: `${row.task_code} v${row.task_version}`,
    taskCode: row.task_code,
    reportHref,
    evidenceHref: canReadEvidence && top ? `/evidence/${top.evidenceCode}` : reportHref,
    canReadEvidence,
    modelCount: scores.length,
    ownerName: row.owner_name,
    expertName: row.expert_name,
  };
}

async function resolveDomain(ctx: AppContext, requested: string | undefined) {
  const domains = await loadDomains(ctx);
  const domain = requested ? domains.find((item) => item.id === requested) : domains[0];
  if (!domain) throw notFound('That domain does not exist.');
  return { domains, domain };
}

/* ---------- Routes ---------- */

export function registerPublished(app: Hono<AppEnv>) {
  app.get('/api/leaderboards', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const { domains, domain } = await resolveDomain(ctx, c.req.query('domain'));
    const { sample, leaderboardRows, intervals } = await loadSample(ctx, domain);
    const empty = leaderboardRows.length === 0;
    const bounds = leaderboardRows.map((row) => row.low ?? row.mean);
    const body: LeaderboardResponse = {
      domains,
      domain,
      empty,
      rows: leaderboardRows,
      sample,
      alert: empty ? `No frozen tasks in ${domain.name} yet.` : alertText(sample, leaderboardRows.some((row) => row.low !== null)),
      overlap: readOverlap(intervals).state,
      uncertainty: empty ? '' : describeUncertainty({ intervals, modelCount: sample.models, synthetic: sample.synthetic, missing: sample.missing }),
      receipts: empty ? '' : receiptsText(sample),
      evidenceBoundary: boundaryText(sample, domain),
      included: await includedTask(ctx, user, domain),
      axis: { min: Math.min(60, Math.floor(Math.min(60, ...bounds) / 10) * 10), max: 100 },
    };
    return c.json(body);
  });

  app.get('/api/leaderboards/methodology', async (c) => {
    const ctx = c.get('ctx');
    requireVerified(c);
    const { domains, domain } = await resolveDomain(ctx, c.req.query('domain'));
    const { rows, result, names, tasks, sample, leaderboardRows } = await loadSample(ctx, domain);

    const reportIds = [...new Set([...tasks.values()].map((task) => task.reportId).filter((id): id is string => Boolean(id)))];
    const reportCodes = new Map<string, { code: string; version: string }>();
    for (const id of reportIds) {
      const report = await ctx.db.get<{ code: string; version: string }>('SELECT code, version FROM reports WHERE id = ?', [id]);
      if (report) reportCodes.set(id, report);
    }

    const taskRows: MethodologyTaskRow[] = result.tasks.map((label) => {
      const [taskCode = label, versionLabel = ''] = label.split(' ');
      const reportId = tasks.get(label)?.reportId ?? null;
      const scores: Record<string, number | null> = {};
      for (const model of result.models) scores[model.modelId] = rows.find((row) => row.task_label === label && row.model_id === model.modelId)?.score ?? null;
      return { label, taskCode, version: versionLabel, source: reportId ? 'report' : 'fixture', report: reportId ? (reportCodes.get(reportId) ?? null) : null, scores };
    });

    const body: MethodologyResponse = {
      domains,
      domain,
      empty: leaderboardRows.length === 0,
      rows: leaderboardRows,
      sample,
      alert: leaderboardRows.length === 0 ? `No frozen tasks in ${domain.name} yet.` : alertText(sample, leaderboardRows.some((row) => row.low !== null)),
      resamples: BOOTSTRAP_RESAMPLES,
      seed: BOOTSTRAP_SEED,
      percentiles: percentileIndices(BOOTSTRAP_RESAMPLES),
      models: result.models.map((model) => ({ id: model.modelId, displayName: names.get(model.modelId)?.displayName ?? model.modelId, shortName: names.get(model.modelId)?.shortName ?? model.modelId })),
      tasks: taskRows,
    };
    return c.json(body);
  });

  app.get('/api/reports', async (c) => {
    const ctx = c.get('ctx');
    requireVerified(c);
    const domain = c.req.query('domain')?.trim() ?? '';
    const q = c.req.query('q')?.trim().toLowerCase() ?? '';
    const conditions: string[] = [];
    const params: string[] = [];
    if (domain) {
      conditions.push('r.domain_id = ?');
      params.push(domain);
    }
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      conditions.push(`(LOWER(r.code) LIKE ? ESCAPE '\\' OR LOWER(t.code) LIKE ? ESCAPE '\\' OR LOWER(tv.title) LIKE ? ESCAPE '\\' OR LOWER(o.name) LIKE ? ESCAPE '\\' OR LOWER(e.name) LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like, like);
    }
    const rows = await ctx.db.all<ReportRow & { task_code: string; task_version: string; title: string; domain_name: string; owner_name: string; expert_name: string }>(
      `SELECT r.*, t.code AS task_code, tv.version AS task_version, tv.title AS title, d.name AS domain_name, o.name AS owner_name, e.name AS expert_name
       FROM reports r
       JOIN tasks t ON t.id = r.task_id
       JOIN task_versions tv ON tv.id = r.task_version_id
       JOIN domains d ON d.id = r.domain_id
       JOIN users o ON o.id = r.owner_id
       JOIN users e ON e.id = r.expert_id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY r.frozen_at DESC, r.code`,
      params,
    );
    const total = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reports');
    const items: ReportListItem[] = rows.map((row) => ({
      code: row.code,
      version: row.version,
      href: reportPath(row.code, row.version),
      taskLabel: `${row.task_code} v${row.task_version}`,
      title: row.title,
      domainId: row.domain_id,
      domainName: row.domain_name,
      ownerName: row.owner_name,
      expertName: row.expert_name,
      frozenAt: row.frozen_at,
      isSynthetic: row.is_synthetic === 1,
      scoreLine: parseScores(row.scores).map((score) => `${score.displayName} ${score.score}`).join(' · '),
    }));
    const body: ReportsResponse = { items, total: total?.n ?? 0, domains: await loadDomains(ctx) };
    return c.json(body);
  });

  // Assumption: any verified account can read a finalized report. Sources and outputs stay permission-checked.
  app.get('/api/reports/:code/:version', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const version = c.req.param('version').replace(/^v/i, '');
    const row = await loadReport(ctx, c.req.param('code'), version);
    if (!row) throw notFound('This report does not exist.');
    const taskLabel = `${row.task_code} v${row.task_version}`;
    const { verified, evidence, scores } = await verifyReport(ctx, row, row.run_code, taskLabel);
    const task = await ctx.db.get<TaskAccessRow>('SELECT id, code, workspace_id, owner_id, domain_id, visibility, status FROM tasks WHERE id = ?', [row.task_id]);
    const canReadSources = task ? (await canReadTask(ctx, user, task)).allowed : false;
    const url = `${ctx.config.publicUrl}${reportPath(row.code, row.version)}`;
    const hashes = [evidence ? `Evidence ${evidence.code} SHA-256 ${evidence.sha256}.` : null, `Report SHA-256 ${row.sha256}.`].filter(Boolean).join(' ');
    const body: ReportResponse = {
      code: row.code,
      version: row.version,
      taskCode: row.task_code,
      taskVersion: row.task_version,
      title: row.title,
      domainName: row.domain_name,
      frozenAt: row.frozen_at,
      ownerName: row.owner_name,
      expertName: row.expert_name,
      adminName: row.admin_name,
      adjudicationCode: row.adjudication_code,
      reviewCode: row.review_code,
      headline: row.headline,
      summary: row.summary,
      limitations: row.limitations,
      scores,
      citation: row.citation,
      citationText: `${row.citation} ${url} ${hashes}`,
      url,
      sha256: row.sha256,
      verified,
      evidence,
      isSynthetic: row.is_synthetic === 1,
      canReadSources,
      downloadUrl: `/api/reports/${row.code}/v${row.version}/download`,
      download: verified ? { allowed: true } : { allowed: false, reason: 'Hash mismatch · Evidence quarantined' },
    };
    return c.json(body);
  });

  app.get('/api/reports/:code/:version/download', async (c) => {
    const ctx = c.get('ctx');
    requireVerified(c);
    const version = c.req.param('version').replace(/^v/i, '');
    const row = await loadReport(ctx, c.req.param('code'), version);
    if (!row) throw notFound('This report does not exist.');
    const { verified, scores } = await verifyReport(ctx, row, row.run_code, `${row.task_code} v${row.task_version}`);
    if (!verified) throw conflict('Hash mismatch. This report differs from its frozen manifest, so it cannot be downloaded.', 'hash_mismatch');
    const seals = await ctx.db.all<{ code: string; sha256: string }>('SELECT code, sha256 FROM evidence WHERE run_id = ? ORDER BY code', [row.run_id]);
    const url = `${ctx.config.publicUrl}${reportPath(row.code, row.version)}`;
    return c.body(reportMarkdown(row, scores, seals, url), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${row.code}-v${row.version}.md"`,
      'Cache-Control': 'no-store',
    });
  });
}
