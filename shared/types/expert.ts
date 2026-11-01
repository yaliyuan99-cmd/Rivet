// DTOs for reviewer applications, the review queue, expert reviews, credential decisions and adjudication.
import type { CredentialSummary } from './session.ts';

export interface VerdictDto {
  allowed: boolean;
  /** Set when refused: the exact reason the page shows. */
  reason?: string;
}

export interface DomainDto {
  id: string;
  name: string;
  field: string;
}

export interface PairDto {
  term: string;
  detail: string;
}

export interface MailOutcome {
  sent: boolean;
  /** Why the email did not go out. The decision itself still stands. */
  reason: string | null;
}

/* ---------- Uploads ---------- */

export interface UploadDto {
  id: string;
  filename: string;
  size: number;
  mime: string;
  sha256: string;
  createdAt: string;
  /** Permission-checked on each request: the owner or an admin. */
  downloadUrl: string;
}

/* ---------- Applications ---------- */

export type ApplicationStatus = 'draft' | 'pending' | 'more_evidence' | 'verified' | 'declined' | 'withdrawn';

export interface ApplicationDto {
  /** APP-030 once submitted; a placeholder while it is still a draft. */
  code: string;
  /** False while a draft: a real APP-n is assigned at submission. */
  hasCode: boolean;
  status: ApplicationStatus;
  domain: DomainDto;
  /** The domain an admin granted, which may differ from the one requested. */
  approvedDomain: DomainDto | null;
  legalName: string;
  institutionalEmail: string;
  researchBackground: string;
  researchProfileUrl: string;
  commitmentAck: boolean;
  evidence: UploadDto | null;
  adminNote: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  isSynthetic: boolean;
  createdAt: string;
  updatedAt: string;
  /** Computed from the row on each request. */
  timeline: PairDto[];
}

export interface ApplyDomainOption extends DomainDto {
  available: boolean;
  /** Why this domain cannot be chosen: an open application or a credential already held. */
  reason: string | null;
}

export interface ApplicationsResponse {
  items: ApplicationDto[];
  /** The draft the apply screen continues. */
  draft: ApplicationDto | null;
  /** The application /review/application shows when no code is named. */
  active: ApplicationDto | null;
  domains: ApplyDomainOption[];
  credentials: CredentialSummary[];
  defaults: { legalName: string; institutionalEmail: string };
}

export interface ApplicationInput {
  legalName: string;
  institutionalEmail: string;
  domainId: string;
  researchBackground: string;
  evidenceUploadId: string | null;
  researchProfileUrl: string;
  commitmentAck: boolean;
}

/* ---------- Reviews ---------- */

export type ReviewStatus = 'requested' | 'draft' | 'submitted' | 'returned' | 'finalized';

export interface ReviewQueueItem {
  code: string;
  status: ReviewStatus;
  taskCode: string;
  taskVersion: string;
  /** BIO-042 v1.0 */
  taskLabel: string;
  title: string;
  domainId: string;
  domainName: string;
  ownerName: string;
  createdAt: string;
  draftSavedAt: string | null;
  submittedAt: string | null;
  returnedNote: string | null;
  report: { code: string; version: string } | null;
  claim: VerdictDto;
}

export interface ReviewsResponse {
  /** What /review shows: the apply screen, your application or the queue. */
  state: 'apply' | 'application' | 'queue';
  credentials: CredentialSummary[];
  /** Domains you hold no credential in. */
  lockedDomains: string[];
  requested: ReviewQueueItem[];
  /** Claimed by you and still being written, including reviews an admin returned. */
  drafts: ReviewQueueItem[];
  /** Submitted by you, including those since finalized. */
  submitted: ReviewQueueItem[];
  openApplication: { code: string; domainName: string } | null;
}

export interface RecommendationCriterion {
  name: string;
  short: string;
  points: number;
  score: number | null;
  note: string;
}

export interface Recommendation {
  annotation: string;
  criteria: RecommendationCriterion[];
}

export interface RubricCriterion {
  name: string;
  short: string;
  points: number;
  guidance: string;
}

export interface SealedCriterionScore {
  name: string;
  short: string;
  points: number;
  score: number;
  rationale: string;
}

export interface ReviewEvidenceDto {
  code: string;
  runCode: string;
  taskLabel: string;
  sha256: string;
  capturedAt: string;
  runnerVersion: string;
  /** Recomputed by the server on this request. */
  verified: boolean;
  modelId: string;
  displayName: string;
  shortName: string;
  totalScore: number;
  scoreLabel: string;
  outputText: string;
  scores: SealedCriterionScore[];
}

export interface ReviewDetailResponse {
  code: string;
  status: ReviewStatus;
  task: {
    code: string;
    version: string;
    label: string;
    title: string;
    prompt: string;
    rubric: RubricCriterion[];
    domainId: string;
    domainName: string;
    ownerName: string;
  };
  runCode: string;
  expertName: string | null;
  isExpert: boolean;
  /** Whether you hold this domain's credential and do not own the task. */
  eligible: boolean;
  /** False while the review's text is private to its expert. */
  contentVisible: boolean;
  assessment: string;
  rationale: string;
  finding: string;
  conflictAck: boolean;
  recommendations: Record<string, Recommendation>;
  returnedNote: string | null;
  draftSavedAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  evidence: ReviewEvidenceDto[];
  evidenceVerified: boolean;
  lockedDomains: string[];
  /** BIOLOGY VERIFIED / NO OWNERSHIP CONFLICT, or why not. */
  statusLine: string;
  report: { code: string; version: string } | null;
  actions: {
    claim: VerdictDto;
    /** Save, reopen and submit. */
    edit: VerdictDto;
    publish: VerdictDto;
  };
}

export interface ReviewInput {
  assessment: string;
  rationale: string;
  finding: string;
  conflictAck: boolean;
  recommendations: Record<string, { annotation: string; criteria: { score: number | null; note: string }[] }>;
}

/* ---------- Admin: credentials ---------- */

export interface CredentialQueueItem {
  code: string;
  status: ApplicationStatus;
  applicantName: string;
  domainName: string;
  submittedAt: string | null;
  decidedAt: string | null;
}

export interface CredentialQueueResponse {
  awaiting: CredentialQueueItem[];
  decided: CredentialQueueItem[];
}

export interface EvidenceRowDto {
  key: 'email' | 'document' | 'profile' | 'background' | 'identity';
  term: string;
  detail: string;
  /** Whether Rivet confirmed this row. Null where it can only show what was supplied. */
  confirmed: boolean | null;
}

export interface CredentialDetailResponse {
  application: ApplicationDto;
  applicantName: string;
  applicantEmail: string;
  evidenceRows: EvidenceRowDto[];
  /** Null when no document was uploaded. False when the stored bytes fail their hash. */
  documentVerified: boolean | null;
  domains: DomainDto[];
  adminName: string;
  credential: { domainName: string; rationale: string; grantedAt: string; grantedByName: string | null; revokedAt: string | null } | null;
  actions: {
    verify: VerdictDto;
    requestEvidence: VerdictDto;
    decline: VerdictDto;
  };
}

export interface CredentialDecisionResponse {
  code: string;
  status: ApplicationStatus;
  mail: MailOutcome;
}

/* ---------- Admin: adjudication ---------- */

export type AdjudicationDecision = 'accept' | 'return';

export interface AdjudicationDto {
  code: string;
  decision: AdjudicationDecision;
  rationale: string;
  checksAck: boolean;
  adminName: string;
  createdAt: string;
  report: { code: string; version: string } | null;
}

export interface AdjudicationQueueItem {
  reviewCode: string;
  status: ReviewStatus;
  taskLabel: string;
  title: string;
  domainName: string;
  expertName: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  report: { code: string; version: string } | null;
}

export interface AdjudicationQueueResponse {
  awaiting: AdjudicationQueueItem[];
  returned: AdjudicationQueueItem[];
  inProgress: AdjudicationQueueItem[];
  finalized: AdjudicationQueueItem[];
}

export interface ExpertScoreDto {
  modelId: string;
  displayName: string;
  /** The expert's recommended total. */
  score: number | null;
  /** The total sealed in the evidence, which never changes. */
  sealedScore: number;
  label: string;
  evidenceCode: string;
  verified: boolean;
}

export interface AdjudicationDetailResponse {
  reviewCode: string;
  status: ReviewStatus;
  task: { code: string; version: string; label: string; title: string; domainName: string; ownerName: string };
  runCode: string;
  expertName: string | null;
  /** ADJ-043. Assigned at the first decision, so before that this is the next free number. */
  adjudicationCode: string;
  adjudicationCodeIsPreview: boolean;
  reportCode: string;
  reportVersion: string;
  scores: ExpertScoreDto[];
  /** Empty until the expert submits: a draft stays private to the expert. */
  finding: string;
  rationale: string;
  assessment: string;
  conflictAck: boolean;
  submittedAt: string | null;
  evidenceVerified: boolean;
  submissions: number;
  decisions: AdjudicationDto[];
  finalDecision: AdjudicationDto | null;
  report: { code: string; version: string; sha256: string } | null;
  adminName: string;
  actions: {
    finalize: VerdictDto;
    returnToExpert: VerdictDto;
  };
}

export interface AdjudicationResponse {
  reviewCode: string;
  status: ReviewStatus;
  adjudicationCode: string;
  decision: AdjudicationDecision;
  report: { code: string; version: string; sha256: string } | null;
  mail: MailOutcome | null;
}
