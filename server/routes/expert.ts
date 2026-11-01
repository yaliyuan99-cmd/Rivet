import type { Hono } from 'hono';
import { z } from 'zod';
import type {
  AdjudicationDetailResponse,
  AdjudicationDto,
  AdjudicationQueueItem,
  AdjudicationQueueResponse,
  AdjudicationResponse,
  ApplicationDto,
  ApplicationStatus,
  ApplicationsResponse,
  ApplyDomainOption,
  CredentialDecisionResponse,
  CredentialDetailResponse,
  CredentialQueueItem,
  CredentialQueueResponse,
  DomainDto,
  EvidenceRowDto,
  ExpertScoreDto,
  MailOutcome,
  PairDto,
  Recommendation,
  ReviewDetailResponse,
  ReviewEvidenceDto,
  ReviewQueueItem,
  ReviewStatus,
  ReviewsResponse,
  RubricCriterion,
  SealedCriterionScore,
  UploadDto,
  VerdictDto,
} from '../../shared/types/expert.ts';
import type { ReportScoreDto } from '../../shared/types/published.ts';
import type { CredentialSummary } from '../../shared/types/session.ts';
import type { AppContext, AppEnv, UserRow } from '../context.ts';
import { audit } from '../lib/audit.ts';
import { requireVerified } from '../lib/auth.ts';
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import { HttpError, conflict, forbidden, invalid, notFound } from '../lib/errors.ts';
import { reportHash, verifyEvidenceRow } from '../lib/evidence.ts';
import { newId, nextCounter, pad3 } from '../lib/ids.ts';
import { sendMail, type Mail } from '../lib/mail.ts';
import { canAdjudicate, canReadTask, canReviewTask, canVerifyCredential, hasCredential, workspaceRole, type TaskAccessRow, type Verdict } from '../lib/permissions.ts';
import { rateLimit } from '../lib/rateLimit.ts';
import { parse, readJson, trimmed } from '../lib/validate.ts';
import { formatUtc, generateReportContent } from './published.ts';

const no = (reason: string): VerdictDto => ({ allowed: false, reason });
const yes: VerdictDto = { allowed: true };
const toVerdict = (verdict: Verdict): VerdictDto => (verdict.allowed ? yes : no(verdict.reason));

/* ---------- Shared lookups ---------- */

async function loadDomains(ctx: AppContext): Promise<DomainDto[]> {
  return ctx.db.all<DomainDto>('SELECT id, name, field FROM domains ORDER BY sort, name');
}

async function credentialsOf(ctx: AppContext, userId: string): Promise<CredentialSummary[]> {
  const rows = await ctx.db.all<{ domain_id: string; name: string; granted_at: string }>(
    `SELECT c.domain_id, d.name, c.granted_at FROM credentials c JOIN domains d ON d.id = c.domain_id
     WHERE c.user_id = ? AND c.revoked_at IS NULL ORDER BY d.sort`,
    [userId],
  );
  return rows.map((row) => ({ domainId: row.domain_id, domainName: row.name, grantedAt: row.granted_at }));
}

async function lockedDomainNames(ctx: AppContext, userId: string, exceptDomainId?: string): Promise<string[]> {
  const domains = await loadDomains(ctx);
  const held = new Set((await credentialsOf(ctx, userId)).map((credential) => credential.domainId));
  return domains.filter((domain) => !held.has(domain.id) && domain.id !== exceptDomainId).map((domain) => domain.name);
}

/** Sends after the decision is committed. A failed email is reported, never turned into a failed decision. */
async function notify(ctx: AppContext, mail: Mail): Promise<MailOutcome> {
  try {
    await sendMail(ctx, mail);
    return { sent: true, reason: null };
  } catch (error) {
    return { sent: false, reason: error instanceof HttpError ? error.message : 'The email could not be sent.' };
  }
}

/* ---------- Uploads ---------- */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MULTIPART_OVERHEAD = 64 * 1024;

interface UploadRow {
  id: string;
  sha256: string;
  filename: string;
  size: number;
  mime: string;
  owner_id: string | null;
  purpose: string;
  created_at: string;
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);

/** The type comes from the bytes, not from what the browser claims. */
function sniffMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

function cleanFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(-200) || 'credential-evidence';
}

function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const uploadDto = (row: UploadRow): UploadDto => ({
  id: row.id,
  filename: row.filename,
  size: row.size,
  mime: row.mime,
  sha256: row.sha256,
  createdAt: row.created_at,
  downloadUrl: `/api/uploads/${row.id}/download`,
});

/** Re-reads the stored bytes and recomputes the hash. False when they differ or are gone. */
async function verifyUploadBytes(ctx: AppContext, upload: UploadRow): Promise<boolean> {
  try {
    if (!ctx.storage.exists(upload.sha256)) return false;
    return sha256Hex(await ctx.storage.read(upload.sha256)) === upload.sha256;
  } catch {
    return false;
  }
}

/* ---------- Applications ---------- */

interface ApplicationRow {
  id: string;
  code: string;
  user_id: string;
  domain_id: string;
  legal_name: string;
  institutional_email: string;
  research_background: string;
  evidence_upload_id: string | null;
  research_profile_url: string;
  commitment_ack: number;
  status: ApplicationStatus;
  admin_note: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  is_synthetic: number;
  created_at: string;
  updated_at: string;
}

const OPEN_STATUSES: ApplicationStatus[] = ['draft', 'pending', 'more_evidence'];
const DRAFT_PREFIX = 'DRAFT-';

function applicationTimeline(row: ApplicationRow, domainName: string, approved: DomainDto | null): PairDto[] {
  const submitted = row.status !== 'draft';
  const credentialDetail: Record<ApplicationStatus, string> = {
    draft: 'Not submitted',
    pending: 'Admin verification in progress',
    more_evidence: 'More evidence requested',
    verified: `Verified${row.decided_at ? ` ${formatUtc(row.decided_at)}` : ''}`,
    declined: `Declined${row.decided_at ? ` ${formatUtc(row.decided_at)}` : ''}`,
    withdrawn: 'Withdrawn',
  };
  // A verified application with no active credential means the credential was revoked since.
  const revoked = row.status === 'verified' && !approved;
  if (revoked) credentialDetail.verified = 'Verified, then revoked';
  const access = approved ? `Open / Verified ${approved.name}` : revoked || row.status === 'declined' || row.status === 'withdrawn' ? 'Locked' : 'Locked until credential approval';
  return [
    { term: 'Identity and affiliation', detail: submitted ? `Received / ${row.legal_name}` : 'Not submitted' },
    { term: `${domainName} credential`, detail: credentialDetail[row.status] },
    { term: 'Conflict commitment', detail: row.commitment_ack ? 'Acknowledged' : 'Not acknowledged' },
    { term: 'Independent review access', detail: access },
  ];
}

async function applicationDto(ctx: AppContext, row: ApplicationRow): Promise<ApplicationDto> {
  const domain = (await ctx.db.get<DomainDto>('SELECT id, name, field FROM domains WHERE id = ?', [row.domain_id])) as DomainDto;
  const upload = row.evidence_upload_id ? await ctx.db.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', [row.evidence_upload_id]) : undefined;
  const decider = row.decided_by ? await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [row.decided_by]) : undefined;
  const approved =
    (await ctx.db.get<DomainDto>(
      `SELECT d.id, d.name, d.field FROM credentials c JOIN domains d ON d.id = c.domain_id WHERE c.application_id = ? AND c.revoked_at IS NULL`,
      [row.id],
    )) ?? null;
  return {
    code: row.code,
    hasCode: !row.code.startsWith(DRAFT_PREFIX),
    status: row.status,
    domain,
    approvedDomain: approved,
    legalName: row.legal_name,
    institutionalEmail: row.institutional_email,
    researchBackground: row.research_background,
    researchProfileUrl: row.research_profile_url,
    commitmentAck: row.commitment_ack === 1,
    evidence: upload ? uploadDto(upload) : null,
    adminNote: row.admin_note,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    decidedByName: decider?.name ?? null,
    isSynthetic: row.is_synthetic === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timeline: applicationTimeline(row, domain.name, approved),
  };
}

const myApplications = (ctx: AppContext, userId: string) => ctx.db.all<ApplicationRow>('SELECT * FROM applications WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC', [userId]);

/** The application /review/application opens on: anything waiting first, then the latest outcome. */
function pickActive(rows: ApplicationRow[]): ApplicationRow | null {
  return rows.find((row) => row.status === 'more_evidence') ?? rows.find((row) => row.status === 'pending') ?? rows.find((row) => row.status === 'verified' || row.status === 'declined') ?? null;
}

async function ownApplication(ctx: AppContext, user: UserRow, code: string): Promise<ApplicationRow> {
  const row = await ctx.db.get<ApplicationRow>('SELECT * FROM applications WHERE code = ?', [code]);
  // Someone else's application reads as missing. Admins use the credential queue's routes instead.
  if (!row || row.user_id !== user.id) throw notFound('This application does not exist.');
  return row;
}

async function domainConflict(ctx: AppContext, userId: string, domainId: string, exceptId: string | null): Promise<string | null> {
  const domain = await ctx.db.get<{ name: string }>('SELECT name FROM domains WHERE id = ?', [domainId]);
  if (!domain) return 'Choose a domain from the list.';
  if (await hasCredential(ctx, userId, domainId)) return `You already hold a verified ${domain.name} credential.`;
  const open = await ctx.db.get<{ code: string }>(
    `SELECT code FROM applications WHERE user_id = ? AND domain_id = ? AND status IN ('draft', 'pending', 'more_evidence') AND id != ?`,
    [userId, domainId, exceptId ?? ''],
  );
  return open ? `You already have an open ${domain.name} application (${open.code}).` : null;
}

const applicationInput = z.object({
  legalName: z.string().trim().max(200, 'Keep your legal name under 200 characters.').optional(),
  institutionalEmail: z.string().trim().toLowerCase().max(254, 'Keep your email under 254 characters.').optional(),
  domainId: z.string().trim().min(1, 'Choose the domain you want to review.').optional(),
  researchBackground: z.string().trim().max(4000, 'Keep your research background under 4,000 characters.').optional(),
  evidenceUploadId: z.string().nullable().optional(),
  researchProfileUrl: z.string().trim().max(300, 'Keep your research profile link under 300 characters.').optional(),
  commitmentAck: z.boolean().optional(),
});

const PROFILE_LINK = /^(https?:\/\/)?[^\s/$.?#]+\.[^\s]+$/i;

const applicationSubmission = z.object({
  legalName: z.string().trim().min(2, 'Enter your legal name.'),
  institutionalEmail: z.string().trim().email('Enter your institutional email address.'),
  researchBackground: z.string().trim().min(20, 'Describe your research background in at least 20 characters.'),
  evidenceUploadId: z.string({ error: 'Upload your credential evidence as a PDF or image.' }).min(1, 'Upload your credential evidence as a PDF or image.'),
  researchProfileUrl: z.string().trim().regex(PROFILE_LINK, 'Enter a link to your research profile, for example orcid.org/0000-0002-1825-0097.'),
  commitmentAck: z.literal(true, { error: 'Confirm the independent review commitment to submit.' }),
});

async function assertOwnEvidence(ctx: AppContext, userId: string, uploadId: string | null | undefined): Promise<void> {
  if (!uploadId) return;
  const upload = await ctx.db.get(`SELECT 1 AS ok FROM uploads WHERE id = ? AND owner_id = ? AND purpose = 'credential'`, [uploadId, userId]);
  if (!upload) throw invalid({ evidenceUploadId: 'Upload your credential evidence again: that file is not available.' }, 'Upload your credential evidence again: that file is not available.');
}

/* ---------- Reviews ---------- */

interface ReviewRow {
  id: string;
  code: string;
  task_id: string;
  task_version_id: string;
  run_id: string;
  requested_by: string;
  expert_id: string | null;
  status: ReviewStatus;
  assessment: string;
  recommendations: string;
  rationale: string;
  finding: string;
  conflict_ack: number;
  returned_note: string | null;
  draft_saved_at: string | null;
  submitted_at: string | null;
  created_at: string;
}

interface VersionRow {
  id: string;
  version: string;
  title: string;
  prompt: string;
  rubric: string;
  models: string;
  dataset_version_id: string | null;
  scan_id: string | null;
  acknowledgements: string;
  sha256: string;
}

interface EvidenceRow {
  id: string;
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

interface PinnedModel {
  id: string;
  displayName: string;
  shortName: string;
  letter?: string;
}

interface ReviewBundle {
  review: ReviewRow;
  task: TaskAccessRow & { is_synthetic: number };
  version: VersionRow;
  run: { id: string; code: string };
  domain: DomainDto;
  owner: { name: string; email: string };
  expert: { name: string; email: string } | null;
  models: PinnedModel[];
  rubric: RubricCriterion[];
  label: string;
}

async function loadBundle(ctx: AppContext, code: string): Promise<ReviewBundle | null> {
  const review = await ctx.db.get<ReviewRow>('SELECT * FROM reviews WHERE code = ?', [code]);
  if (!review) return null;
  const task = (await ctx.db.get<ReviewBundle['task']>('SELECT id, code, workspace_id, owner_id, domain_id, visibility, status, is_synthetic FROM tasks WHERE id = ?', [review.task_id])) as ReviewBundle['task'];
  const version = (await ctx.db.get<VersionRow>('SELECT * FROM task_versions WHERE id = ?', [review.task_version_id])) as VersionRow;
  const run = (await ctx.db.get<{ id: string; code: string }>('SELECT id, code FROM runs WHERE id = ?', [review.run_id])) as { id: string; code: string };
  const domain = (await ctx.db.get<DomainDto>('SELECT id, name, field FROM domains WHERE id = ?', [task.domain_id])) as DomainDto;
  const owner = (await ctx.db.get<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', [task.owner_id])) as { name: string; email: string };
  const expert = review.expert_id ? ((await ctx.db.get<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', [review.expert_id])) ?? null) : null;
  return { review, task, version, run, domain, owner, expert, models: JSON.parse(version.models) as PinnedModel[], rubric: JSON.parse(version.rubric) as RubricCriterion[], label: `${task.code} v${version.version}` };
}

/** The evidence for a review's run in pinned-model order, each seal recomputed on this request. */
async function loadEvidence(ctx: AppContext, bundle: Pick<ReviewBundle, 'run' | 'models' | 'label'>): Promise<ReviewEvidenceDto[]> {
  const rows = await ctx.db.all<EvidenceRow>('SELECT * FROM evidence WHERE run_id = ?', [bundle.run.id]);
  const order = new Map(bundle.models.map((model, index) => [model.id, index]));
  rows.sort((a, b) => (order.get(a.model_id) ?? 99) - (order.get(b.model_id) ?? 99));
  return Promise.all(
    rows.map(async (row) => {
      const model = bundle.models.find((item) => item.id === row.model_id);
      return {
        code: row.code,
        runCode: bundle.run.code,
        taskLabel: bundle.label,
        sha256: row.sha256,
        capturedAt: row.captured_at,
        runnerVersion: row.runner_version,
        verified: await verifyEvidenceRow(ctx.db, row),
        modelId: row.model_id,
        displayName: model?.displayName ?? row.model_id,
        shortName: model?.shortName ?? row.model_id,
        totalScore: row.total_score,
        scoreLabel: row.score_label,
        outputText: row.output_text,
        scores: JSON.parse(row.scores) as SealedCriterionScore[],
      };
    }),
  );
}

function parseRecommendations(json: string): Record<string, Recommendation> {
  try {
    return JSON.parse(json) as Record<string, Recommendation>;
  } catch {
    return {};
  }
}

const recommendedTotal = (recommendation: Recommendation | undefined): number | null => {
  const criteria = recommendation?.criteria ?? [];
  if (criteria.length === 0 || criteria.some((criterion) => criterion.score === null || criterion.score === undefined)) return null;
  return criteria.reduce((sum, criterion) => sum + (criterion.score as number), 0);
};

const REVIEW_LIMITS = { assessment: 8000, rationale: 4000, finding: 4000, annotation: 2000, note: 500 };

const reviewInput = z.object({
  assessment: z.string({ error: 'The assessment must be text.' }).max(REVIEW_LIMITS.assessment, `Keep the assessment under ${REVIEW_LIMITS.assessment} characters.`).default(''),
  rationale: z.string({ error: 'The rationale must be text.' }).max(REVIEW_LIMITS.rationale, `Keep the rationale under ${REVIEW_LIMITS.rationale} characters.`).default(''),
  finding: z.string({ error: 'The finding must be text.' }).max(REVIEW_LIMITS.finding, `Keep the finding under ${REVIEW_LIMITS.finding} characters.`).default(''),
  conflictAck: z.boolean({ error: 'The conflict attestation must be yes or no.' }).default(false),
  recommendations: z
    .record(
      z.string(),
      z.object({
        annotation: z.string().max(REVIEW_LIMITS.annotation, `Keep each annotation under ${REVIEW_LIMITS.annotation} characters.`).default(''),
        criteria: z.array(z.object({ score: z.number({ error: 'Enter each score as a whole number.' }).nullable().optional(), note: z.string().max(REVIEW_LIMITS.note, `Keep each note under ${REVIEW_LIMITS.note} characters.`).optional() })).default([]),
      }),
    )
    .default({}),
});
type ReviewInputParsed = z.output<typeof reviewInput>;

/**
 * Rebuilds the stored recommendations from the frozen rubric, so a client cannot change a criterion's
 * name or points. A draft may leave things blank; a submission must complete every model.
 */
function buildRecommendations(input: ReviewInputParsed, evidence: ReviewEvidenceDto[], rubric: RubricCriterion[], strict: boolean) {
  const fields: Record<string, string> = {};
  const value: Record<string, Recommendation> = {};
  const known = new Set(evidence.map((item) => item.code));
  for (const key of Object.keys(input.recommendations)) {
    if (!known.has(key)) fields[`recommendations.${key}`] = `${key} is not part of this review.`;
  }
  for (const item of evidence) {
    const given = input.recommendations[item.code];
    const annotation = (given?.annotation ?? '').trim();
    if (strict && annotation.length < 10) fields[`recommendations.${item.code}.annotation`] = `Write a reviewer annotation for ${item.displayName} of at least 10 characters.`;
    const criteria = rubric.map((criterion, index) => {
      const raw = given?.criteria?.[index];
      const score = raw?.score ?? null;
      const note = (raw?.note ?? '').trim();
      const scoreKey = `recommendations.${item.code}.criteria.${index}.score`;
      const message = `Enter a whole number from 0 to ${criterion.points} for ${criterion.name}.`;
      if (score === null) {
        if (strict) fields[scoreKey] = message;
      } else if (!Number.isInteger(score) || score < 0 || score > criterion.points) {
        fields[scoreKey] = message;
      }
      if (strict && !note) fields[`recommendations.${item.code}.criteria.${index}.note`] = `Add a note for ${criterion.name} on ${item.displayName}.`;
      return { name: criterion.name, short: criterion.short, points: criterion.points, score, note };
    });
    value[item.code] = { annotation, criteria };
  }
  return { value, fields };
}

function strictReviewFields(input: ReviewInputParsed, taskCode: string): Record<string, string> {
  const fields: Record<string, string> = {};
  if (input.assessment.trim().length < 20) fields.assessment = 'Write your independent evidence assessment in at least 20 characters.';
  if (input.rationale.trim().length < 20) fields.rationale = 'Write your expert rationale in at least 20 characters.';
  if (input.finding.trim().length < 20) fields.finding = 'Write the finding in at least 20 characters. It is quoted at adjudication and in the report.';
  if (!input.conflictAck) fields.conflictAck = `Confirm you have no ownership, financial or authorship conflict for ${taskCode}.`;
  return fields;
}

function reviewEditVerdict(review: ReviewRow, user: UserRow, eligibility: Verdict): VerdictDto {
  if (!eligibility.allowed) return no(eligibility.reason);
  if (review.status === 'requested') return no('Claim this review to start.');
  if (review.expert_id !== user.id) return no('This review is assigned to another expert.');
  if (review.status === 'submitted' || review.status === 'finalized') return no('This review has been submitted and is read-only.');
  return yes;
}

async function reportFor(ctx: AppContext, reviewId: string) {
  return (await ctx.db.get<{ code: string; version: string; sha256: string }>('SELECT code, version, sha256 FROM reports WHERE review_id = ?', [reviewId])) ?? null;
}

async function queueItem(ctx: AppContext, user: UserRow, row: ReviewRow): Promise<ReviewQueueItem> {
  const bundle = (await loadBundle(ctx, row.code)) as ReviewBundle;
  const report = await reportFor(ctx, row.id);
  const eligibility = await canReviewTask(ctx, user, bundle.task);
  return {
    code: row.code,
    status: row.status,
    taskCode: bundle.task.code,
    taskVersion: bundle.version.version,
    taskLabel: bundle.label,
    title: bundle.version.title,
    domainId: bundle.domain.id,
    domainName: bundle.domain.name,
    ownerName: bundle.owner.name,
    createdAt: row.created_at,
    draftSavedAt: row.draft_saved_at,
    submittedAt: row.submitted_at,
    returnedNote: row.returned_note,
    report: report ? { code: report.code, version: report.version } : null,
    claim: row.status === 'requested' ? toVerdict(eligibility) : no('This review has already been claimed.'),
  };
}

async function reviewDetail(ctx: AppContext, user: UserRow, bundle: ReviewBundle): Promise<ReviewDetailResponse> {
  const { review, task, version, domain, owner, expert } = bundle;
  const eligibility = await canReviewTask(ctx, user, task);
  const isExpert = review.expert_id === user.id;
  const isAdmin = user.role === 'admin';
  const isOwnerSide = task.owner_id === user.id || Boolean(await workspaceRole(ctx, user.id, task.workspace_id));
  // Independence: a draft stays with its expert until it is submitted; a returned one is back in drafting.
  const contentVisible =
    isExpert || review.status === 'finalized' || (review.status === 'submitted' && (isAdmin || isOwnerSide)) || (review.status === 'returned' && isAdmin);
  const evidence = await loadEvidence(ctx, bundle);
  const report = await reportFor(ctx, review.id);

  let statusLine: string;
  if (task.owner_id === user.id) statusLine = 'You own this task';
  else if (eligibility.allowed) statusLine = `${domain.name} verified / No ownership conflict`;
  else if (isAdmin) statusLine = 'Admin / Read only';
  else statusLine = eligibility.reason;

  return {
    code: review.code,
    status: review.status,
    task: {
      code: task.code,
      version: version.version,
      label: bundle.label,
      title: version.title,
      prompt: version.prompt,
      rubric: bundle.rubric,
      domainId: domain.id,
      domainName: domain.name,
      ownerName: owner.name,
    },
    runCode: bundle.run.code,
    expertName: expert?.name ?? null,
    isExpert,
    eligible: eligibility.allowed,
    contentVisible,
    assessment: contentVisible ? review.assessment : '',
    rationale: contentVisible ? review.rationale : '',
    finding: contentVisible ? review.finding : '',
    conflictAck: contentVisible ? review.conflict_ack === 1 : false,
    recommendations: contentVisible ? parseRecommendations(review.recommendations) : {},
    returnedNote: isExpert || isAdmin ? review.returned_note : null,
    draftSavedAt: contentVisible ? review.draft_saved_at : null,
    submittedAt: review.submitted_at,
    createdAt: review.created_at,
    evidence,
    evidenceVerified: evidence.length > 0 && evidence.every((item) => item.verified),
    lockedDomains: await lockedDomainNames(ctx, user.id, task.domain_id),
    statusLine,
    report: report ? { code: report.code, version: report.version } : null,
    actions: {
      claim: review.status === 'requested' ? toVerdict(eligibility) : no('This review has already been claimed.'),
      edit: reviewEditVerdict(review, user, eligibility),
      publish: toVerdict(canAdjudicate(user)),
    },
  };
}

/* ---------- Adjudication ---------- */

interface AdjudicationRow {
  id: string;
  code: string;
  review_id: string;
  admin_id: string;
  decision: 'accept' | 'return';
  rationale: string;
  checks_ack: number;
  report_id: string | null;
  created_at: string;
}

async function adjudicationHistory(ctx: AppContext, reviewId: string): Promise<AdjudicationDto[]> {
  const rows = await ctx.db.all<AdjudicationRow & { admin_name: string; report_code: string | null; report_version: string | null }>(
    `SELECT a.*, u.name AS admin_name, r.code AS report_code, r.version AS report_version
     FROM adjudications a JOIN users u ON u.id = a.admin_id LEFT JOIN reports r ON r.id = a.report_id
     WHERE a.review_id = ? ORDER BY a.created_at, a.rowid`,
    [reviewId],
  );
  return rows.map((row) => ({
    code: row.code,
    decision: row.decision,
    rationale: row.rationale,
    checksAck: row.checks_ack === 1,
    adminName: row.admin_name,
    createdAt: row.created_at,
    report: row.report_code && row.report_version ? { code: row.report_code, version: row.report_version } : null,
  }));
}

/** The code is one per review, and is taken from the counter at the first decision. */
async function adjudicationCodeFor(ctx: AppContext, reviewId: string): Promise<{ code: string; preview: boolean }> {
  const existing = await ctx.db.get<{ code: string }>('SELECT code FROM adjudications WHERE review_id = ? ORDER BY created_at LIMIT 1', [reviewId]);
  if (existing) return { code: existing.code, preview: false };
  const counter = await ctx.db.get<{ value: number }>(`SELECT value FROM counters WHERE name = 'adjudication'`);
  return { code: `ADJ-${pad3((counter?.value ?? 0) + 1)}`, preview: true };
}

function adjudicationVerdicts(user: UserRow, bundle: ReviewBundle, evidenceVerified: boolean): AdjudicationDetailResponse['actions'] {
  const role = canAdjudicate(user);
  let refusal: string | null = role.allowed ? null : role.reason;
  if (!refusal && bundle.review.expert_id === user.id) refusal = 'You wrote this review, so another administrator must decide it.';
  if (!refusal && bundle.task.owner_id === user.id) refusal = 'You own this task, so another administrator must decide it.';
  if (!refusal && bundle.review.status === 'finalized') refusal = 'This review is already finalized.';
  if (!refusal && bundle.review.status === 'returned') refusal = 'This review is back with the expert.';
  if (!refusal && bundle.review.status !== 'submitted') refusal = 'The expert has not submitted this review yet.';
  if (refusal) return { finalize: no(refusal), returnToExpert: no(refusal) };
  return { finalize: evidenceVerified ? yes : no('Hash mismatch · Evidence quarantined'), returnToExpert: yes };
}

async function adjudicationQueueItem(ctx: AppContext, row: ReviewRow): Promise<AdjudicationQueueItem> {
  const bundle = (await loadBundle(ctx, row.code)) as ReviewBundle;
  const last = await ctx.db.get<{ created_at: string }>('SELECT created_at FROM adjudications WHERE review_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [row.id]);
  const report = await reportFor(ctx, row.id);
  return {
    reviewCode: row.code,
    status: row.status,
    taskLabel: bundle.label,
    title: bundle.version.title,
    domainName: bundle.domain.name,
    expertName: bundle.expert?.name ?? null,
    submittedAt: row.submitted_at,
    decidedAt: last?.created_at ?? null,
    report: report ? { code: report.code, version: report.version } : null,
  };
}

async function finalizeReview(ctx: AppContext, user: UserRow, bundle: ReviewBundle, evidence: ReviewEvidenceDto[], rationale: string, checksAck: boolean) {
  const { review, task, version, domain, owner, expert, label, run } = bundle;
  if (!expert || !review.expert_id) throw conflict('This review has no expert.');
  const recommendations = parseRecommendations(review.recommendations);
  const scores: ReportScoreDto[] = evidence.map((item) => {
    const total = recommendedTotal(recommendations[item.code]);
    if (total === null) throw conflict(`The expert's recommendation for ${item.displayName} is incomplete. Return this review to the expert.`);
    return { modelId: item.modelId, displayName: item.displayName, score: total, label: item.scoreLabel, evidenceCode: item.code, ...(total === item.totalScore ? {} : { sealedScore: item.totalScore }) };
  });
  const scan = version.scan_id ? await ctx.db.get<{ code: string; risk: string; findings: string }>('SELECT code, risk, findings FROM scans WHERE id = ?', [version.scan_id]) : undefined;
  const dataset = version.dataset_version_id
    ? await ctx.db.get<{ is_synthetic: number }>('SELECT d.is_synthetic FROM dataset_versions dv JOIN datasets d ON d.id = dv.dataset_id WHERE dv.id = ?', [version.dataset_version_id])
    : undefined;
  const synthetic = task.is_synthetic === 1 || evidence.some((item) => item.scoreLabel === 'demo');
  const reportCode = `RPT-${task.code}`;
  const frozenAt = ctx.now().toISOString();
  const content = generateReportContent({
    taskCode: task.code,
    title: version.title,
    reportCode,
    version: version.version,
    ownerName: owner.name,
    frozenAt,
    finding: review.finding,
    scores,
    scan: scan ? { code: scan.code, risk: scan.risk, findings: JSON.parse(scan.findings) as { nearDuplicate?: { phrases?: string[] } } } : null,
    acknowledgements: JSON.parse(version.acknowledgements) as string[],
    synthetic,
    sourcesSynthetic: dataset?.is_synthetic === 1,
  });

  return ctx.db.tx(async () => {
    // The status decides: of two administrators, only the first decision lands.
    const claimed = await ctx.db.run(`UPDATE reviews SET status = 'finalized', returned_note = NULL WHERE id = ? AND status = 'submitted'`, [review.id]);
    if (claimed.changes === 0) throw conflict('This review is no longer waiting for a decision. Reload to see the latest.');
    if (await ctx.db.get('SELECT 1 AS ok FROM reports WHERE code = ? AND version = ?', [reportCode, version.version])) throw conflict(`${reportCode} v${version.version} already exists.`);

    const adjudicationId = newId();
    const reportId = newId();
    const planned = await adjudicationCodeFor(ctx, review.id);
    const code = planned.preview ? `ADJ-${pad3(await nextCounter(ctx.db, 'adjudication', 1))}` : planned.code;
    const canonical = canonicalJson({
      schema: 'rivet.report.v1',
      code: reportCode,
      version: version.version,
      task: { code: task.code, version: version.version, sha256: version.sha256 },
      run: run.code,
      evidence: evidence.map((item) => item.code),
      evidenceSha256: Object.fromEntries(evidence.map((item) => [item.code, item.sha256])),
      review: review.code,
      adjudication: code,
      scan: scan?.code ?? null,
      owner: owner.name,
      expert: expert.name,
      admin: user.name,
      headline: content.headline,
      summary: content.summary,
      limitations: content.limitations,
      scores,
      citation: content.citation,
      frozenAt,
      synthetic,
    });
    const sha256 = reportHash(canonical);

    await ctx.db.run(
      `INSERT INTO adjudications (id, code, review_id, task_version_id, admin_id, decision, rationale, checks_ack, report_id, created_at) VALUES (?, ?, ?, ?, ?, 'accept', ?, ?, ?, ?)`,
      [adjudicationId, code, review.id, version.id, user.id, rationale, checksAck, reportId, frozenAt],
    );
    await ctx.db.run(
      `INSERT INTO reports (id, code, version, task_id, task_version_id, run_id, review_id, adjudication_id, owner_id, expert_id, admin_id, domain_id, headline, summary, limitations, scores, citation, canonical, sha256, frozen_at, is_synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reportId,
        reportCode,
        version.version,
        task.id,
        version.id,
        run.id,
        review.id,
        adjudicationId,
        task.owner_id,
        review.expert_id,
        user.id,
        domain.id,
        content.headline,
        content.summary,
        content.limitations,
        JSON.stringify(scores),
        content.citation,
        canonical,
        sha256,
        frozenAt,
        synthetic,
      ],
    );
    for (const score of scores) {
      await ctx.db.run(
        `INSERT INTO leaderboard_scores (id, domain_id, task_label, model_id, score, report_id, is_fixture, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        [newId(), domain.id, label, score.modelId, score.score, reportId, frozenAt],
      );
    }
    await audit(ctx, { actorId: user.id, action: 'adjudication.accepted', subjectType: 'review', subjectId: review.id, subjectCode: review.code, workspaceId: task.workspace_id, detail: { adjudication: code, rationale, report: `${reportCode} v${version.version}`, sha256 } });
    return { code, reportCode, sha256 };
  });
}

/* ---------- Routes ---------- */

export function registerExpert(app: Hono<AppEnv>) {
  /* ---------- Uploads ---------- */

  app.post('/api/uploads', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    await rateLimit(ctx, `upload:${user.id}`, 30, 3600, 'Too many uploads in the last hour. Wait a while and try again.');
    const tooLarge = 'This file is larger than the 10 MB limit for credential evidence. Upload a smaller PDF or image.';
    if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD) throw new HttpError(413, 'too_large', tooLarge, { file: tooLarge });
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw invalid({ file: 'Choose a PDF or image to upload.' }, 'Choose a PDF or image to upload.');
    if (file.size === 0) throw invalid({ file: 'This file is empty. Choose a PDF or image with content.' }, 'This file is empty. Choose a PDF or image with content.');
    if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', tooLarge, { file: tooLarge });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffMime(bytes);
    if (!mime) throw invalid({ file: 'Credential evidence must be a PDF, PNG, JPEG or WebP file.' }, 'Credential evidence must be a PDF, PNG, JPEG or WebP file.');
    const stored = await ctx.storage.put(bytes);
    const row: UploadRow = { id: newId(), sha256: stored.sha256, filename: cleanFilename(file.name), size: stored.size, mime, owner_id: user.id, purpose: 'credential', created_at: ctx.now().toISOString() };
    await ctx.db.run(`INSERT INTO uploads (id, sha256, filename, size, mime, owner_id, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, row.sha256, row.filename, row.size, row.mime, row.owner_id, row.purpose, row.created_at]);
    return c.json(uploadDto(row), 201);
  });

  app.get('/api/uploads/:id/download', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const upload = await ctx.db.get<UploadRow>(`SELECT * FROM uploads WHERE id = ? AND purpose = 'credential'`, [c.req.param('id')]);
    if (!upload || (upload.owner_id !== user.id && user.role !== 'admin')) throw notFound('This file does not exist or you do not have access to it.');
    if (!(await verifyUploadBytes(ctx, upload))) throw conflict('Hash mismatch. The stored file differs from what was uploaded, so it cannot be downloaded.', 'hash_mismatch');
    if (upload.owner_id !== user.id) {
      await audit(ctx, { actorId: user.id, action: 'credential.document_opened', subjectType: 'upload', subjectId: upload.id, subjectCode: upload.filename });
    }
    return c.body(new Uint8Array(await ctx.storage.read(upload.sha256)), 200, {
      'Content-Type': upload.mime,
      'Content-Disposition': attachment(upload.filename),
      'Content-Length': String(upload.size),
      'Cache-Control': 'private, no-store',
    });
  });

  /* ---------- Your applications ---------- */

  app.get('/api/applications', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const rows = await myApplications(ctx, user.id);
    const items = await Promise.all(rows.map((row) => applicationDto(ctx, row)));
    const domains = await loadDomains(ctx);
    const options: ApplyDomainOption[] = [];
    for (const domain of domains) {
      const open = rows.find((row) => row.domain_id === domain.id && (row.status === 'pending' || row.status === 'more_evidence'));
      const held = await hasCredential(ctx, user.id, domain.id);
      options.push({ ...domain, available: !open && !held, reason: held ? 'Credential held' : open ? `${open.code} open` : null });
    }
    const draft = rows.find((row) => row.status === 'draft');
    const active = pickActive(rows);
    const body: ApplicationsResponse = {
      items,
      draft: draft ? await applicationDto(ctx, draft) : null,
      active: active ? await applicationDto(ctx, active) : null,
      domains: options,
      credentials: await credentialsOf(ctx, user.id),
      defaults: { legalName: user.name, institutionalEmail: user.email },
    };
    return c.json(body);
  });

  app.post('/api/applications', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const input = await readJson(c, applicationInput);
    // One draft at a time: a repeat click or a second tab continues it rather than starting another.
    const existing = await ctx.db.get<ApplicationRow>(`SELECT * FROM applications WHERE user_id = ? AND status = 'draft'`, [user.id]);
    const domainId = input.domainId ?? existing?.domain_id;
    if (!domainId) throw invalid({ domainId: 'Choose the domain you want to review.' });
    const clash = await domainConflict(ctx, user.id, domainId, existing?.id ?? null);
    if (clash) throw new HttpError(409, 'application_open', clash, { domainId: clash });
    await assertOwnEvidence(ctx, user.id, input.evidenceUploadId);
    const now = ctx.now().toISOString();
    if (existing) {
      await ctx.db.run(
        `UPDATE applications SET domain_id = ?, legal_name = ?, institutional_email = ?, research_background = ?, evidence_upload_id = ?, research_profile_url = ?, commitment_ack = ?, updated_at = ? WHERE id = ?`,
        [domainId, input.legalName ?? existing.legal_name, input.institutionalEmail ?? existing.institutional_email, input.researchBackground ?? existing.research_background, input.evidenceUploadId === undefined ? existing.evidence_upload_id : input.evidenceUploadId, input.researchProfileUrl ?? existing.research_profile_url, input.commitmentAck ?? existing.commitment_ack === 1, now, existing.id],
      );
      return c.json(await applicationDto(ctx, (await ctx.db.get<ApplicationRow>('SELECT * FROM applications WHERE id = ?', [existing.id])) as ApplicationRow));
    }
    const id = newId();
    await ctx.db.run(
      `INSERT INTO applications (id, code, user_id, domain_id, legal_name, institutional_email, research_background, evidence_upload_id, research_profile_url, commitment_ack, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      [id, `${DRAFT_PREFIX}${id.slice(0, 8)}`, user.id, domainId, input.legalName ?? '', input.institutionalEmail ?? '', input.researchBackground ?? '', input.evidenceUploadId ?? null, input.researchProfileUrl ?? '', input.commitmentAck ?? false, now, now],
    );
    return c.json(await applicationDto(ctx, (await ctx.db.get<ApplicationRow>('SELECT * FROM applications WHERE id = ?', [id])) as ApplicationRow), 201);
  });

  app.get('/api/applications/:code', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    return c.json(await applicationDto(ctx, await ownApplication(ctx, user, c.req.param('code'))));
  });

  app.put('/api/applications/:code', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const row = await ownApplication(ctx, user, c.req.param('code'));
    if (row.status !== 'draft' && row.status !== 'more_evidence') throw conflict('This application can no longer be edited.');
    const input = await readJson(c, applicationInput);
    const domainId = input.domainId ?? row.domain_id;
    if (row.status === 'more_evidence' && domainId !== row.domain_id) {
      const message = 'The requested domain cannot change after submission. Withdraw this application to apply for another domain.';
      throw invalid({ domainId: message }, message);
    }
    const clash = await domainConflict(ctx, user.id, domainId, row.id);
    if (clash) throw new HttpError(409, 'application_open', clash, { domainId: clash });
    await assertOwnEvidence(ctx, user.id, input.evidenceUploadId);
    await ctx.db.run(
      `UPDATE applications SET domain_id = ?, legal_name = ?, institutional_email = ?, research_background = ?, evidence_upload_id = ?, research_profile_url = ?, commitment_ack = ?, updated_at = ? WHERE id = ?`,
      [domainId, input.legalName ?? row.legal_name, input.institutionalEmail ?? row.institutional_email, input.researchBackground ?? row.research_background, input.evidenceUploadId === undefined ? row.evidence_upload_id : input.evidenceUploadId, input.researchProfileUrl ?? row.research_profile_url, input.commitmentAck ?? row.commitment_ack === 1, ctx.now().toISOString(), row.id],
    );
    return c.json(await applicationDto(ctx, (await ctx.db.get<ApplicationRow>('SELECT * FROM applications WHERE id = ?', [row.id])) as ApplicationRow));
  });

  app.post('/api/applications/:code/submit', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const row = await ownApplication(ctx, user, c.req.param('code'));
    if (row.status !== 'draft' && row.status !== 'more_evidence') throw conflict('This application has already been submitted.');
    parse(applicationSubmission, {
      legalName: row.legal_name,
      institutionalEmail: row.institutional_email,
      researchBackground: row.research_background,
      evidenceUploadId: row.evidence_upload_id ?? undefined,
      researchProfileUrl: row.research_profile_url,
      commitmentAck: row.commitment_ack === 1,
    });
    await assertOwnEvidence(ctx, user.id, row.evidence_upload_id);
    const clash = await domainConflict(ctx, user.id, row.domain_id, row.id);
    if (clash) throw new HttpError(409, 'application_open', clash, { domainId: clash });
    const now = ctx.now().toISOString();
    const resubmission = row.status === 'more_evidence';
    const code = await ctx.db.tx(async () => {
      const assigned = resubmission ? row.code : `APP-${pad3(await nextCounter(ctx.db, 'application', 1))}`;
      const moved = await ctx.db.run(`UPDATE applications SET code = ?, status = 'pending', submitted_at = ?, updated_at = ? WHERE id = ? AND status = ?`, [assigned, now, now, row.id, row.status]);
      if (moved.changes === 0) throw conflict('This application changed while you were submitting it. Reload and try again.');
      await audit(ctx, { actorId: user.id, action: resubmission ? 'application.resubmitted' : 'application.submitted', subjectType: 'application', subjectId: row.id, subjectCode: assigned, detail: { domainId: row.domain_id } });
      return assigned;
    });
    return c.json(await applicationDto(ctx, await ownApplication(ctx, user, code)));
  });

  app.post('/api/applications/:code/withdraw', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const row = await ownApplication(ctx, user, c.req.param('code'));
    if (row.status !== 'pending' && row.status !== 'more_evidence') throw conflict('Only an application in review can be withdrawn.');
    await ctx.db.tx(async () => {
      const moved = await ctx.db.run(`UPDATE applications SET status = 'withdrawn', updated_at = ? WHERE id = ? AND status = ?`, [ctx.now().toISOString(), row.id, row.status]);
      if (moved.changes === 0) throw conflict('An administrator decided this application while you were withdrawing it. Reload to see the decision.');
      await audit(ctx, { actorId: user.id, action: 'application.withdrawn', subjectType: 'application', subjectId: row.id, subjectCode: row.code, detail: { domainId: row.domain_id } });
    });
    return c.json(await applicationDto(ctx, await ownApplication(ctx, user, row.code)));
  });

  /* ---------- Review queue ---------- */

  app.get('/api/reviews', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const credentials = await credentialsOf(ctx, user.id);
    const applications = await myApplications(ctx, user.id);
    const open = applications.find((row) => row.status === 'more_evidence' || row.status === 'pending');
    const decided = applications.find((row) => row.status === 'verified' || row.status === 'declined');

    let state: ReviewsResponse['state'] = 'apply';
    if (credentials.length > 0) state = 'queue';
    else if (open) state = 'application';
    else if (applications.some((row) => row.status === 'draft')) state = 'apply';
    else if (decided) state = 'application';

    const heldDomains = credentials.map((credential) => credential.domainId);
    const requestedRows = heldDomains.length
      ? await ctx.db.all<ReviewRow>(
          `SELECT r.* FROM reviews r JOIN tasks t ON t.id = r.task_id
           WHERE r.status = 'requested' AND t.owner_id != ? AND t.domain_id IN (${heldDomains.map(() => '?').join(', ')})
           ORDER BY r.created_at, r.code`,
          [user.id, ...heldDomains],
        )
      : [];
    const mine = await ctx.db.all<ReviewRow>(`SELECT * FROM reviews WHERE expert_id = ? ORDER BY COALESCE(submitted_at, draft_saved_at, created_at) DESC, code DESC`, [user.id]);
    const openDomain = open ? await ctx.db.get<{ name: string }>('SELECT name FROM domains WHERE id = ?', [open.domain_id]) : undefined;

    const body: ReviewsResponse = {
      state,
      credentials,
      lockedDomains: await lockedDomainNames(ctx, user.id),
      requested: await Promise.all(requestedRows.map((row) => queueItem(ctx, user, row))),
      drafts: await Promise.all(mine.filter((row) => row.status === 'draft' || row.status === 'returned').map((row) => queueItem(ctx, user, row))),
      submitted: await Promise.all(mine.filter((row) => row.status === 'submitted' || row.status === 'finalized').map((row) => queueItem(ctx, user, row))),
      openApplication: open && openDomain ? { code: open.code, domainName: openDomain.name } : null,
    };
    return c.json(body);
  });

  /** Called from the run results page: the task owner asks for an independent review. */
  app.post('/api/reviews', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const { runCode } = await readJson(c, z.object({ runCode: trimmed('Choose the run to review.', 40) }));
    const run = await ctx.db.get<{ id: string; code: string; task_id: string; task_version_id: string; owner_id: string; status: string }>('SELECT id, code, task_id, task_version_id, owner_id, status FROM runs WHERE code = ?', [runCode]);
    if (!run) throw notFound('This run does not exist.');
    const task = (await ctx.db.get<TaskAccessRow>('SELECT id, code, workspace_id, owner_id, domain_id, visibility, status FROM tasks WHERE id = ?', [run.task_id])) as TaskAccessRow;
    if (task.owner_id !== user.id) {
      if (!(await canReadTask(ctx, user, task)).allowed) throw notFound('This run does not exist.');
      throw forbidden('Only the task owner can request expert review.');
    }
    if (run.status !== 'complete') throw conflict('This run has not finished. Request review once it is complete.', 'run_not_complete');
    const version = (await ctx.db.get<{ version: string; models: string }>('SELECT version, models FROM task_versions WHERE id = ?', [run.task_version_id])) as { version: string; models: string };
    const label = `${task.code} v${version.version}`;
    const existing = await ctx.db.get<{ code: string; status: ReviewStatus }>('SELECT code, status FROM reviews WHERE task_version_id = ? ORDER BY created_at DESC LIMIT 1', [run.task_version_id]);
    if (existing?.status === 'finalized') throw conflict(`${label} already has a finalized review (${existing.code}). Revise the task to review a new version.`, 'review_finalized');
    if (existing) throw conflict(`${existing.code} is already open for ${label}.`, 'review_open');
    const evidence = await loadEvidence(ctx, { run: { id: run.id, code: run.code }, models: JSON.parse(version.models) as PinnedModel[], label });
    if (evidence.length === 0) throw conflict('This run has no sealed evidence to review.');
    if (evidence.some((item) => !item.verified)) throw conflict('Hash mismatch. Evidence from this run is quarantined, so it cannot go to review.', 'hash_mismatch');

    const now = ctx.now().toISOString();
    const code = await ctx.db.tx(async () => {
      const assigned = `REVIEW-${pad3(await nextCounter(ctx.db, 'review', 1))}`;
      const id = newId();
      await ctx.db.run(`INSERT INTO reviews (id, code, task_id, task_version_id, run_id, requested_by, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)`, [id, assigned, task.id, run.task_version_id, run.id, user.id, now]);
      await audit(ctx, { actorId: user.id, action: 'review.requested', subjectType: 'review', subjectId: id, subjectCode: assigned, workspaceId: task.workspace_id, detail: { run: run.code, task: label } });
      return assigned;
    });
    return c.json({ code, status: 'requested' satisfies ReviewStatus, href: `/review/${code}` }, 201);
  });

  /* ---------- One review ---------- */

  app.get('/api/reviews/:code', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const bundle = await loadBundle(ctx, c.req.param('code'));
    if (!bundle || !(await canReadTask(ctx, user, bundle.task)).allowed) throw notFound('This review does not exist or you do not have access to it.');
    return c.json(await reviewDetail(ctx, user, bundle));
  });

  app.post('/api/reviews/:code/claim', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const bundle = await loadBundle(ctx, c.req.param('code'));
    if (!bundle) throw notFound('This review does not exist.');
    const verdict = await canReviewTask(ctx, user, bundle.task);
    if (!verdict.allowed) throw forbidden(verdict.reason);
    await ctx.db.tx(async () => {
      const claimed = await ctx.db.run(`UPDATE reviews SET expert_id = ?, status = 'draft' WHERE id = ? AND status = 'requested'`, [user.id, bundle.review.id]);
      if (claimed.changes === 0) throw conflict('Another expert has already claimed this review.', 'already_claimed');
      await audit(ctx, { actorId: user.id, action: 'review.claimed', subjectType: 'review', subjectId: bundle.review.id, subjectCode: bundle.review.code, workspaceId: bundle.task.workspace_id });
    });
    return c.json(await reviewDetail(ctx, user, (await loadBundle(ctx, bundle.review.code)) as ReviewBundle));
  });

  const assertCanEdit = async (ctx: AppContext, user: UserRow, bundle: ReviewBundle) => {
    const eligibility = await canReviewTask(ctx, user, bundle.task);
    if (!eligibility.allowed) throw forbidden(eligibility.reason);
    if (bundle.review.status === 'submitted' || bundle.review.status === 'finalized') throw conflict('This review has been submitted and is read-only.', 'review_read_only');
    const verdict = reviewEditVerdict(bundle.review, user, eligibility);
    if (!verdict.allowed) throw forbidden(verdict.reason as string);
  };

  app.put('/api/reviews/:code', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const bundle = await loadBundle(ctx, c.req.param('code'));
    if (!bundle) throw notFound('This review does not exist.');
    await assertCanEdit(ctx, user, bundle);
    const input = await readJson(c, reviewInput);
    const evidence = await loadEvidence(ctx, bundle);
    const { value, fields } = buildRecommendations(input, evidence, bundle.rubric, false);
    if (Object.keys(fields).length) throw invalid(fields);
    const now = ctx.now().toISOString();
    const saved = await ctx.db.run(
      `UPDATE reviews SET assessment = ?, recommendations = ?, rationale = ?, finding = ?, conflict_ack = ?, status = 'draft', draft_saved_at = ? WHERE id = ? AND status IN ('draft', 'returned') AND expert_id = ?`,
      [input.assessment.trim(), JSON.stringify(value), input.rationale.trim(), input.finding.trim(), input.conflictAck, now, bundle.review.id, user.id],
    );
    if (saved.changes === 0) throw conflict('This review changed while you were saving it. Reload to see the latest.');
    return c.json(await reviewDetail(ctx, user, (await loadBundle(ctx, bundle.review.code)) as ReviewBundle));
  });

  app.post('/api/reviews/:code/submit', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const bundle = await loadBundle(ctx, c.req.param('code'));
    if (!bundle) throw notFound('This review does not exist.');
    await assertCanEdit(ctx, user, bundle);
    const input = await readJson(c, reviewInput);
    const evidence = await loadEvidence(ctx, bundle);
    if (evidence.length === 0 || evidence.some((item) => !item.verified)) throw conflict('Hash mismatch. This evidence is quarantined, so this review cannot be submitted.', 'hash_mismatch');
    const { value, fields } = buildRecommendations(input, evidence, bundle.rubric, true);
    const allFields = { ...strictReviewFields(input, bundle.task.code), ...fields };
    if (Object.keys(allFields).length) throw invalid(allFields);
    const now = ctx.now().toISOString();
    await ctx.db.tx(async () => {
      const moved = await ctx.db.run(
        `UPDATE reviews SET assessment = ?, recommendations = ?, rationale = ?, finding = ?, conflict_ack = 1, status = 'submitted', returned_note = NULL, draft_saved_at = ?, submitted_at = ? WHERE id = ? AND status IN ('draft', 'returned') AND expert_id = ?`,
        [input.assessment.trim(), JSON.stringify(value), input.rationale.trim(), input.finding.trim(), now, now, bundle.review.id, user.id],
      );
      if (moved.changes === 0) throw conflict('This review changed while you were submitting it. Reload to see the latest.');
      const count = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_submissions WHERE review_id = ?', [bundle.review.id]);
      await ctx.db.run(
        `INSERT INTO review_submissions (id, review_id, seq, expert_id, assessment, recommendations, rationale, finding, conflict_ack, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [newId(), bundle.review.id, (count?.n ?? 0) + 1, user.id, input.assessment.trim(), JSON.stringify(value), input.rationale.trim(), input.finding.trim(), now],
      );
      await audit(ctx, { actorId: user.id, action: 'review.submitted', subjectType: 'review', subjectId: bundle.review.id, subjectCode: bundle.review.code, workspaceId: bundle.task.workspace_id, detail: { task: bundle.label, conflictAck: true } });
    });
    return c.json(await reviewDetail(ctx, user, (await loadBundle(ctx, bundle.review.code)) as ReviewBundle));
  });

  /* ---------- Admin: credential decisions ---------- */

  const requireCredentialAdmin = (c: Parameters<typeof requireVerified>[0]) => {
    const user = requireVerified(c);
    const verdict = canVerifyCredential(user);
    if (!verdict.allowed) throw forbidden(verdict.reason);
    return user;
  };

  const queueRow = async (ctx: AppContext, row: ApplicationRow): Promise<CredentialQueueItem> => {
    const applicant = await ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', [row.user_id]);
    const domain = await ctx.db.get<{ name: string }>('SELECT name FROM domains WHERE id = ?', [row.domain_id]);
    return { code: row.code, status: row.status, applicantName: applicant?.name ?? 'Unknown applicant', domainName: domain?.name ?? row.domain_id, submittedAt: row.submitted_at, decidedAt: row.decided_at };
  };

  app.get('/api/admin/credentials', async (c) => {
    const ctx = c.get('ctx');
    requireCredentialAdmin(c);
    const rows = await ctx.db.all<ApplicationRow>(`SELECT * FROM applications WHERE status != 'draft' ORDER BY submitted_at DESC, code DESC`);
    const items = await Promise.all(rows.map((row) => queueRow(ctx, row)));
    const body: CredentialQueueResponse = {
      awaiting: items.filter((item) => item.status === 'pending' || item.status === 'more_evidence').reverse(),
      decided: items.filter((item) => item.status === 'verified' || item.status === 'declined' || item.status === 'withdrawn'),
    };
    return c.json(body);
  });

  const namesMatch = (a: string, b: string) => {
    const normalize = (name: string) =>
      name
        .toLowerCase()
        .replace(/^(dr|prof|mr|ms|mrs)\.?\s+/, '')
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    return normalize(a) === normalize(b);
  };
  const emailDomain = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

  const credentialDetail = async (ctx: AppContext, admin: UserRow, row: ApplicationRow): Promise<CredentialDetailResponse> => {
    const applicant = (await ctx.db.get<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', [row.user_id])) as { name: string; email: string };
    const application = await applicationDto(ctx, row);
    const upload = row.evidence_upload_id ? await ctx.db.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', [row.evidence_upload_id]) : undefined;
    const documentVerified = upload ? await verifyUploadBytes(ctx, upload) : null;

    const domainMatch = Boolean(emailDomain(row.institutional_email)) && emailDomain(row.institutional_email) === emailDomain(applicant.email);
    const nameMatch = namesMatch(row.legal_name, applicant.name);
    const fixture = row.is_synthetic === 1 ? 'Fixture hash verified' : 'Hash verified';
    const rows: EvidenceRowDto[] = [
      {
        key: 'email',
        term: 'Institutional email',
        detail: domainMatch && nameMatch
          ? 'Domain and name match / Confirmed'
          : domainMatch
            ? `Domain matches the verified account; name differs / Check manually`
            : `${row.institutional_email} is outside the verified account's domain (${emailDomain(applicant.email)}) / Not confirmed`,
        confirmed: domainMatch && nameMatch,
      },
      {
        key: 'document',
        term: 'Credential document',
        detail: upload ? `${upload.filename} / ${documentVerified ? fixture : 'Hash mismatch'}` : 'No document uploaded',
        confirmed: documentVerified,
      },
      { key: 'profile', term: 'Research profile', detail: row.research_profile_url ? `${row.research_profile_url} / Supplied by the applicant` : 'None supplied', confirmed: null },
      { key: 'background', term: 'Research background', detail: row.research_background || 'None supplied', confirmed: null },
      {
        key: 'identity',
        term: 'Identity consistency',
        detail:
          domainMatch && nameMatch
            ? 'No mismatched name or affiliation'
            : [nameMatch ? null : `Legal name “${row.legal_name}” differs from account name “${applicant.name}”`, domainMatch ? null : `Institutional email domain differs from the verified account`].filter(Boolean).join('; '),
        confirmed: domainMatch && nameMatch,
      },
    ];

    const credential = await ctx.db.get<{ rationale: string; granted_at: string; revoked_at: string | null; domain_name: string; granted_by_name: string | null }>(
      `SELECT c.rationale, c.granted_at, c.revoked_at, d.name AS domain_name, u.name AS granted_by_name
       FROM credentials c JOIN domains d ON d.id = c.domain_id LEFT JOIN users u ON u.id = c.granted_by
       WHERE c.application_id = ? ORDER BY c.granted_at DESC LIMIT 1`,
      [row.id],
    );

    const own = row.user_id === admin.id ? 'You cannot decide your own application.' : null;
    const verifyRefusal =
      own ??
      (row.status === 'pending'
        ? documentVerified === null
          ? 'No credential document to inspect'
          : documentVerified === false
            ? 'Hash mismatch · Evidence quarantined'
            : null
        : row.status === 'more_evidence'
          ? 'Waiting for the applicant to resubmit'
          : `This application is ${row.status.replace('_', ' ')}.`);
    const requestRefusal = own ?? (row.status === 'pending' ? null : row.status === 'more_evidence' ? 'Waiting for the applicant to resubmit' : `This application is ${row.status.replace('_', ' ')}.`);
    const declineRefusal = own ?? (row.status === 'pending' || row.status === 'more_evidence' ? null : `This application is ${row.status.replace('_', ' ')}.`);

    return {
      application,
      applicantName: applicant.name,
      applicantEmail: applicant.email,
      evidenceRows: rows,
      documentVerified,
      domains: await loadDomains(ctx),
      adminName: admin.name,
      credential: credential ? { domainName: credential.domain_name, rationale: credential.rationale, grantedAt: credential.granted_at, grantedByName: credential.granted_by_name, revokedAt: credential.revoked_at } : null,
      actions: {
        verify: verifyRefusal ? no(verifyRefusal) : yes,
        requestEvidence: requestRefusal ? no(requestRefusal) : yes,
        decline: declineRefusal ? no(declineRefusal) : yes,
      },
    };
  };

  const loadApplicationForAdmin = async (ctx: AppContext, code: string) => {
    const row = await ctx.db.get<ApplicationRow>(`SELECT * FROM applications WHERE code = ? AND status != 'draft'`, [code]);
    if (!row) throw notFound('This application does not exist.');
    return row;
  };

  app.get('/api/admin/credentials/:code', async (c) => {
    const ctx = c.get('ctx');
    const admin = requireCredentialAdmin(c);
    return c.json(await credentialDetail(ctx, admin, await loadApplicationForAdmin(ctx, c.req.param('code'))));
  });

  const rationaleField = trimmed('Record the rationale for this decision.', 4000).min(10, 'Record the rationale for this decision in at least 10 characters.');

  app.post('/api/admin/credentials/:code/verify', async (c) => {
    const ctx = c.get('ctx');
    const admin = requireCredentialAdmin(c);
    const row = await loadApplicationForAdmin(ctx, c.req.param('code'));
    const detail = await credentialDetail(ctx, admin, row);
    if (!detail.actions.verify.allowed) {
      const reason = detail.actions.verify.reason as string;
      if (row.user_id === admin.id) throw forbidden(reason);
      throw conflict(reason, detail.documentVerified === false ? 'hash_mismatch' : 'conflict');
    }
    const input = await readJson(
      c,
      z.object({
        approvedDomainId: trimmed('Choose the approved domain.', 80),
        rationale: rationaleField,
        basisAck: z.literal(true, { error: 'Confirm you inspected the source documents and recorded the rationale.' }),
      }),
    );
    const domain = await ctx.db.get<DomainDto>('SELECT id, name, field FROM domains WHERE id = ?', [input.approvedDomainId]);
    if (!domain) throw invalid({ approvedDomainId: 'Choose the approved domain from the list.' });
    if (await hasCredential(ctx, row.user_id, domain.id)) throw new HttpError(409, 'credential_held', `This applicant already holds a verified ${domain.name} credential.`, { approvedDomainId: `This applicant already holds a verified ${domain.name} credential.` });
    const now = ctx.now().toISOString();
    await ctx.db.tx(async () => {
      const moved = await ctx.db.run(`UPDATE applications SET status = 'verified', admin_note = ?, decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'`, [input.rationale, now, admin.id, now, row.id]);
      if (moved.changes === 0) throw conflict('This application is no longer waiting for a decision. Reload to see the latest.');
      await ctx.db.run(`INSERT INTO credentials (id, user_id, domain_id, application_id, rationale, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [newId(), row.user_id, domain.id, row.id, input.rationale, admin.id, now]);
      await audit(ctx, { actorId: admin.id, action: 'credential.verified', subjectType: 'application', subjectId: row.id, subjectCode: row.code, detail: { domainId: domain.id, domain: domain.name, rationale: input.rationale, applicantId: row.user_id } });
    });
    const applicant = (await ctx.db.get<{ email: string; name: string }>('SELECT email, name FROM users WHERE id = ?', [row.user_id])) as { email: string; name: string };
    const link = `${ctx.config.publicUrl}/review`;
    const mail = await notify(ctx, {
      to: applicant.email,
      subject: `Your ${domain.name} credential is verified (${row.code})`,
      text: `Hello ${applicant.name},\n\nAn administrator verified your ${domain.name} credential for ${row.code}. You can now review ${domain.name} tasks. Other domains stay locked.\n\n${link}`,
      link,
      purpose: 'credential',
    });
    const body: CredentialDecisionResponse = { code: row.code, status: 'verified', mail };
    return c.json(body);
  });

  app.post('/api/admin/credentials/:code/request-evidence', async (c) => {
    const ctx = c.get('ctx');
    const admin = requireCredentialAdmin(c);
    const row = await loadApplicationForAdmin(ctx, c.req.param('code'));
    const detail = await credentialDetail(ctx, admin, row);
    if (!detail.actions.requestEvidence.allowed) {
      const reason = detail.actions.requestEvidence.reason as string;
      if (row.user_id === admin.id) throw forbidden(reason);
      throw conflict(reason);
    }
    const { rationale } = await readJson(c, z.object({ rationale: trimmed('Tell the applicant what evidence is missing.', 4000).min(10, 'Tell the applicant what evidence is missing in at least 10 characters.') }));
    const now = ctx.now().toISOString();
    await ctx.db.tx(async () => {
      const moved = await ctx.db.run(`UPDATE applications SET status = 'more_evidence', admin_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'`, [rationale, now, row.id]);
      if (moved.changes === 0) throw conflict('This application is no longer waiting for a decision. Reload to see the latest.');
      await audit(ctx, { actorId: admin.id, action: 'credential.more_evidence', subjectType: 'application', subjectId: row.id, subjectCode: row.code, detail: { note: rationale, applicantId: row.user_id } });
    });
    const applicant = (await ctx.db.get<{ email: string; name: string }>('SELECT email, name FROM users WHERE id = ?', [row.user_id])) as { email: string; name: string };
    const link = `${ctx.config.publicUrl}/review/application`;
    const mail = await notify(ctx, {
      to: applicant.email,
      subject: `More evidence requested for ${row.code}`,
      text: `Hello ${applicant.name},\n\nAn administrator needs more evidence before deciding ${row.code}.\n\nTheir note:\n${rationale}\n\nUpdate your application and resubmit it here:\n${link}`,
      link,
      purpose: 'credential',
    });
    const body: CredentialDecisionResponse = { code: row.code, status: 'more_evidence', mail };
    return c.json(body);
  });

  app.post('/api/admin/credentials/:code/decline', async (c) => {
    const ctx = c.get('ctx');
    const admin = requireCredentialAdmin(c);
    const row = await loadApplicationForAdmin(ctx, c.req.param('code'));
    const detail = await credentialDetail(ctx, admin, row);
    if (!detail.actions.decline.allowed) {
      const reason = detail.actions.decline.reason as string;
      if (row.user_id === admin.id) throw forbidden(reason);
      throw conflict(reason);
    }
    const { rationale } = await readJson(c, z.object({ rationale: rationaleField }));
    const now = ctx.now().toISOString();
    await ctx.db.tx(async () => {
      const moved = await ctx.db.run(`UPDATE applications SET status = 'declined', admin_note = ?, decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'more_evidence')`, [rationale, now, admin.id, now, row.id]);
      if (moved.changes === 0) throw conflict('This application is no longer waiting for a decision. Reload to see the latest.');
      await audit(ctx, { actorId: admin.id, action: 'credential.declined', subjectType: 'application', subjectId: row.id, subjectCode: row.code, detail: { rationale, applicantId: row.user_id } });
    });
    const applicant = (await ctx.db.get<{ email: string; name: string }>('SELECT email, name FROM users WHERE id = ?', [row.user_id])) as { email: string; name: string };
    const link = `${ctx.config.publicUrl}/review/application`;
    const mail = await notify(ctx, {
      to: applicant.email,
      subject: `Your application ${row.code} was declined`,
      text: `Hello ${applicant.name},\n\nAn administrator declined ${row.code}.\n\nTheir rationale:\n${rationale}\n\nYou can apply again with new evidence:\n${link}`,
      link,
      purpose: 'credential',
    });
    const body: CredentialDecisionResponse = { code: row.code, status: 'declined', mail };
    return c.json(body);
  });

  /* ---------- Admin: adjudication ---------- */

  const requireAdjudicator = (c: Parameters<typeof requireVerified>[0]) => {
    const user = requireVerified(c);
    const verdict = canAdjudicate(user);
    if (!verdict.allowed) throw forbidden(verdict.reason);
    return user;
  };

  app.get('/api/admin/adjudications', async (c) => {
    const ctx = c.get('ctx');
    requireAdjudicator(c);
    const rows = await ctx.db.all<ReviewRow>('SELECT * FROM reviews ORDER BY COALESCE(submitted_at, created_at) DESC, code DESC');
    const items = await Promise.all(rows.map((row) => adjudicationQueueItem(ctx, row)));
    const body: AdjudicationQueueResponse = {
      awaiting: items.filter((item) => item.status === 'submitted').reverse(),
      returned: items.filter((item) => item.status === 'returned'),
      inProgress: items.filter((item) => item.status === 'requested' || item.status === 'draft'),
      finalized: items.filter((item) => item.status === 'finalized'),
    };
    return c.json(body);
  });

  const adjudicationDetail = async (ctx: AppContext, admin: UserRow, bundle: ReviewBundle): Promise<AdjudicationDetailResponse> => {
    const { review, task, version, domain, owner, expert } = bundle;
    const evidence = await loadEvidence(ctx, bundle);
    const evidenceVerified = evidence.length > 0 && evidence.every((item) => item.verified);
    const visible = review.status === 'submitted' || review.status === 'returned' || review.status === 'finalized';
    const recommendations = visible ? parseRecommendations(review.recommendations) : {};
    const decisions = await adjudicationHistory(ctx, review.id);
    const { code, preview } = await adjudicationCodeFor(ctx, review.id);
    const report = await reportFor(ctx, review.id);
    const submissions = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_submissions WHERE review_id = ?', [review.id]);
    const scores: ExpertScoreDto[] = evidence.map((item) => ({
      modelId: item.modelId,
      displayName: item.displayName,
      score: recommendedTotal(recommendations[item.code]),
      sealedScore: item.totalScore,
      label: item.scoreLabel,
      evidenceCode: item.code,
      verified: item.verified,
    }));
    const finalDecision = decisions.find((decision) => decision.decision === 'accept') ?? null;
    return {
      reviewCode: review.code,
      status: review.status,
      task: { code: task.code, version: version.version, label: bundle.label, title: version.title, domainName: domain.name, ownerName: owner.name },
      runCode: bundle.run.code,
      expertName: expert?.name ?? null,
      adjudicationCode: code,
      adjudicationCodeIsPreview: preview,
      reportCode: report?.code ?? `RPT-${task.code}`,
      reportVersion: report?.version ?? version.version,
      scores,
      finding: visible ? review.finding : '',
      rationale: visible ? review.rationale : '',
      assessment: visible ? review.assessment : '',
      conflictAck: visible && review.conflict_ack === 1,
      submittedAt: review.submitted_at,
      evidenceVerified,
      submissions: submissions?.n ?? 0,
      decisions,
      finalDecision,
      report,
      adminName: finalDecision?.adminName ?? admin.name,
      actions: adjudicationVerdicts(admin, bundle, evidenceVerified),
    };
  };

  app.get('/api/admin/adjudications/:code', async (c) => {
    const ctx = c.get('ctx');
    const admin = requireAdjudicator(c);
    const bundle = await loadBundle(ctx, c.req.param('code'));
    if (!bundle) throw notFound('This review does not exist.');
    return c.json(await adjudicationDetail(ctx, admin, bundle));
  });

  app.post('/api/admin/adjudications/:code', async (c) => {
    const ctx = c.get('ctx');
    const admin = requireAdjudicator(c);
    const bundle = await loadBundle(ctx, c.req.param('code'));
    if (!bundle) throw notFound('This review does not exist.');
    const input = await readJson(
      c,
      z.object({
        decision: z.enum(['accept', 'return'], { error: 'Choose a decision.' }),
        rationale: rationaleField,
        checksAck: z.boolean().default(false),
      }),
    );
    const evidence = await loadEvidence(ctx, bundle);
    const evidenceVerified = evidence.length > 0 && evidence.every((item) => item.verified);
    const verdicts = adjudicationVerdicts(admin, bundle, evidenceVerified);
    const verdict = input.decision === 'accept' ? verdicts.finalize : verdicts.returnToExpert;
    if (!verdict.allowed) {
      const reason = verdict.reason as string;
      // Who you are is a permission problem; where the review stands is a conflict.
      if (bundle.review.expert_id === admin.id || bundle.task.owner_id === admin.id) throw forbidden(reason);
      throw conflict(reason, evidenceVerified ? 'conflict' : 'hash_mismatch');
    }

    if (input.decision === 'accept') {
      if (!input.checksAck) throw invalid({ checksAck: 'Confirm the evidence, reviewer eligibility and provenance checks are complete.' });
      const result = await finalizeReview(ctx, admin, bundle, evidence, input.rationale, true);
      const body: AdjudicationResponse = { reviewCode: bundle.review.code, status: 'finalized', adjudicationCode: result.code, decision: 'accept', report: { code: result.reportCode, version: bundle.version.version, sha256: result.sha256 }, mail: null };
      return c.json(body);
    }

    const now = ctx.now().toISOString();
    const code = await ctx.db.tx(async () => {
      const moved = await ctx.db.run(`UPDATE reviews SET status = 'returned', returned_note = ? WHERE id = ? AND status = 'submitted'`, [input.rationale, bundle.review.id]);
      if (moved.changes === 0) throw conflict('This review is no longer waiting for a decision. Reload to see the latest.');
      const planned = await adjudicationCodeFor(ctx, bundle.review.id);
      const assigned = planned.preview ? `ADJ-${pad3(await nextCounter(ctx.db, 'adjudication', 1))}` : planned.code;
      await ctx.db.run(
        `INSERT INTO adjudications (id, code, review_id, task_version_id, admin_id, decision, rationale, checks_ack, report_id, created_at) VALUES (?, ?, ?, ?, ?, 'return', ?, ?, NULL, ?)`,
        [newId(), assigned, bundle.review.id, bundle.version.id, admin.id, input.rationale, input.checksAck, now],
      );
      await audit(ctx, { actorId: admin.id, action: 'adjudication.returned', subjectType: 'review', subjectId: bundle.review.id, subjectCode: bundle.review.code, workspaceId: bundle.task.workspace_id, detail: { adjudication: assigned, rationale: input.rationale } });
      return assigned;
    });
    let mail: MailOutcome = { sent: false, reason: 'This review has no expert to notify.' };
    if (bundle.expert) {
      const link = `${ctx.config.publicUrl}/review/${bundle.review.code}`;
      mail = await notify(ctx, {
        to: bundle.expert.email,
        subject: `${bundle.review.code} was returned to you`,
        text: `Hello ${bundle.expert.name},\n\nAn administrator returned ${bundle.review.code} (${bundle.label}) for changes.\n\nTheir note:\n${input.rationale}\n\nYour earlier submission is kept. Reopen the review here:\n${link}`,
        link,
        purpose: 'review',
      });
    }
    const body: AdjudicationResponse = { reviewCode: bundle.review.code, status: 'returned', adjudicationCode: code, decision: 'return', report: null, mail };
    return c.json(body);
  });
}
