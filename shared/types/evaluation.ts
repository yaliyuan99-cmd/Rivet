// DTOs for tasks, freeze, runs and evidence. Imported by both sides with `import type` only.

/** Every permission or state check the page must show is sent as a verdict with its exact reason. */
export type VerdictDto = { allowed: true; reason?: undefined } | { allowed: false; reason: string };

export interface RubricCriterion {
  name: string;
  short: string;
  points: number;
  guidance: string;
}

export interface RunSettings {
  temperature: number;
  seed: number;
  maxOutputK: number;
}

/** A model row as frozen into a task version. */
export interface PinnedModel {
  id: string;
  displayName: string;
  shortName: string;
  letter: string;
  revision: string;
  adapter: 'demo' | 'anthropic';
  contextK: number;
  outputK: number;
}

/* ---------- Contamination scan ---------- */

export type FindingStatus = 'clear' | 'low' | 'high' | 'unknown';
export type ScanRisk = 'none' | 'low' | 'high';

export interface ScanFinding {
  status: FindingStatus;
  label: string;
  detail: string;
  phrases?: string[];
  /** Largest share of the prompt covered by shared 13-word windows, from 0 to 1. */
  maxCoverage?: number;
  /** The documents behind the finding, named only when the scanning user may read them. */
  matches?: string[];
}

export interface ScanFindings {
  exactPrompt: ScanFinding;
  nearDuplicate: ScanFinding;
  /** Absent on scans seeded before this check was shown as its own line. */
  coverage?: ScanFinding;
  sourceExposure: ScanFinding;
  trainingCoverage: ScanFinding;
  summary: string;
  acknowledgementText: string;
  retentionText: string;
  /** What was actually compared, e.g. "2 other tasks, 1 report and 23 dataset records you can access." */
  scope?: string;
}

export interface ScanDto {
  code: string;
  risk: ScanRisk;
  findings: ScanFindings;
  createdAt: string;
  /** The draft changed after this scan ran, so it cannot back a freeze. */
  stale: boolean;
}

/* ---------- Browse ---------- */

export interface TaskListItem {
  code: string;
  /** 1.0, or 0.1 for a never-frozen draft */
  version: string;
  /** BIO-042 v1.0 */
  label: string;
  title: string;
  /** Maya Chen · Private · 3 models · Run / Resume / Revise */
  meta: string;
  status: 'draft' | 'frozen';
  visibility: 'private' | 'shared';
  domainId: string;
  domainName: string;
  workspaceCode: string;
  workspaceName: string;
  isOwner: boolean;
  synthetic: boolean;
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface TaskBrowseResponse {
  items: TaskListItem[];
  /** BIOLOGY / 3 AUTHORED DEMO TASKS */
  headline: string;
  filters: {
    domains: FilterOption[];
    statuses: FilterOption[];
    scopes: FilterOption[];
  };
  counts: {
    /** Tasks this user may read, ignoring the current search and filters. */
    readable: number;
    synthetic: number;
    mine: number;
    matched: number;
  };
  viewerName: string;
  workspaceName: string | null;
  featured: {
    code: string;
    label: string;
    note: string;
    /** Review BIO-042 */
    reviewAction: ReviewAction;
  } | null;
}

/* ---------- Review state, as this slice reads it ---------- */

export interface ReviewAction {
  label: string;
  verdict: VerdictDto;
  /** Set only when allowed and a review exists to open. */
  href: string | null;
}

export type ReviewStatus = 'requested' | 'draft' | 'submitted' | 'returned' | 'finalized';

export interface RunReviewState {
  code: string;
  status: ReviewStatus;
  /** EXPERT REVIEW REQUESTED and friends, without the RUN COMPLETE prefix */
  label: string;
  href: string;
}

export interface RunReportState {
  code: string;
  version: string;
  label: string;
  href: string;
}

/* ---------- Editor ---------- */

export interface DomainOption {
  id: string;
  /** Biology / Microbiology */
  label: string;
  name: string;
  field: string;
  prefix: string;
}

export interface ModelOption {
  id: string;
  displayName: string;
  shortName: string;
  revision: string;
  adapter: 'demo' | 'anthropic';
  adapterLabel: string;
  contextK: number;
  outputK: number;
  illustrative: boolean;
  available: boolean;
  /** Why the box is disabled. Disabled models stay visible. */
  reason: string | null;
  /** Limits of the pinned run settings for this adapter. */
  settingsNote: string | null;
}

export interface DatasetOption {
  versionId: string;
  code: string;
  name: string;
  version: string;
  /** DS-BIO-07 v1.0 */
  label: string;
  recordsCount: number;
  recordIds: string[];
  format: string;
  /** Holds the records the starter prompt cites. */
  authoredPack: boolean;
}

export interface EditorOptions {
  domains: DomainOption[];
  models: ModelOption[];
  datasets: DatasetOption[];
  defaultSettings: RunSettings;
  ownerName: string;
  workspace: { id: string; name: string; defaultVisibility: 'private' | 'shared' } | null;
  /** Expert review · You own this task */
  review: VerdictDto;
  starterPackUrl: string;
}

export interface StarterDraft {
  title: string;
  domainId: string;
  prompt: string;
  rubric: RubricCriterion[];
  modelIds: string[];
  datasetVersionId: string | null;
}

export interface EditorNewResponse {
  options: EditorOptions;
  starter: StarterDraft | null;
}

export interface DraftInput {
  title: string;
  domainId: string;
  prompt: string;
  rubric: RubricCriterion[];
  modelIds: string[];
  datasetVersionId: string | null;
}

export interface DraftValidation {
  ok: boolean;
  /** Field-level reasons, keyed like Zod paths: title, prompt, rubric, rubric.0.name, modelIds, datasetVersionId */
  fields: Record<string, string>;
}

export interface DraftDto extends DraftInput {
  code: string;
  status: 'draft' | 'frozen';
  visibility: 'private' | 'shared';
  /** The label this draft carries: 0.1 before the first freeze, 1.1 while revising. */
  draftVersion: string;
  /** The version the next freeze creates. */
  freezeVersion: string;
  /** The label a later revision would take. */
  afterFreezeVersion: string;
  latestVersion: string | null;
  domainLocked: boolean;
  settings: RunSettings;
  savedAt: string | null;
}

export interface EditorDraftResponse {
  draft: DraftDto;
  options: EditorOptions;
}

export interface DraftSaveResponse {
  code: string;
  savedAt: string;
  validation: DraftValidation;
}

/* ---------- Freeze ---------- */

export interface FreezeResponse {
  code: string;
  title: string;
  /** frozen shows the record of the latest version; draft is the owner's preview of the next one. */
  status: 'draft' | 'frozen';
  /** The version a freeze creates, or the frozen version being shown. */
  version: string;
  /** BIO-042 v1.0 */
  label: string;
  validation: DraftValidation;
  /** Problems an owner should weigh that do not block the freeze. */
  warnings: string[];
  scan: ScanDto | null;
  rail: {
    /** 4 criteria / 100 points */
    promptAndRubric: string;
    sourcePack: string | null;
    /** 3 pinned revisions */
    modelRevisions: string;
  };
  /** Set when the version is frozen. */
  frozen: { sha256: string; frozenAt: string; frozenBy: string; acknowledgements: string[] } | null;
  verdict: VerdictDto;
}

export interface FreezeResult {
  code: string;
  version: string;
  label: string;
  sha256: string;
}

/* ---------- Task page ---------- */

export interface TamperDto {
  code: string;
  runCode: string;
  taskLabel: string;
  sha256: string;
  capturedAt: string;
  runnerVersion: string;
  verified: boolean;
}

export interface FrozenVersionDto {
  version: string;
  label: string;
  title: string;
  prompt: string;
  rubric: RubricCriterion[];
  models: PinnedModel[];
  settings: RunSettings;
  sourcePack: string | null;
  sha256: string;
  frozenAt: string;
  scanCode: string | null;
}

export interface RunListItem {
  code: string;
  status: RunStatus;
  /** 9 / 9 stages · Complete */
  summary: string;
  taskLabel: string;
  createdAt: string;
}

export interface TaskDetailResponse {
  code: string;
  title: string;
  status: 'draft' | 'frozen';
  visibility: 'private' | 'shared';
  synthetic: boolean;
  /** BIO-042 v1.0, or BIO-043 v0.1 for a never-frozen draft */
  label: string;
  domainName: string;
  workspaceName: string;
  ownerName: string;
  isOwner: boolean;
  /** PRIVATE / HELIX LAB / FROZEN */
  statusLine: string;
  statement: string;
  accessPolicy: { term: string; detail: string }[];
  visibilityOptions: FilterOption[];
  sourcePack: string | null;
  latestVersion: FrozenVersionDto | null;
  /** Readable only by the owner, workspace members and reviewers. */
  draft: { version: string; title: string; prompt: string; rubric: RubricCriterion[]; savedAt: string | null } | null;
  tamper: TamperDto | null;
  runs: RunListItem[];
  activeRunCode: string | null;
  nextVersion: string;
  verdicts: {
    run: VerdictDto;
    revise: VerdictDto;
    edit: VerdictDto;
    visibility: VerdictDto;
  };
  reviewAction: ReviewAction;
}

/* ---------- Runs ---------- */

export type RunStatus = 'queued' | 'running' | 'stopping' | 'interrupted' | 'complete' | 'failed';
export type InterruptReason = 'owner_stop' | 'provider_timeout' | 'server_restart';

export interface ScoreEntry {
  name: string;
  short: string;
  points: number;
  score: number;
  rationale: string;
}

export interface RunModelState {
  id: string;
  displayName: string;
  shortName: string;
  revision: string;
  adapter: 'demo' | 'anthropic';
  stagesDone: number;
  /** Output captured · Scored · EV-1042-A sealed */
  execution: string;
  evidenceCode: string | null;
  /** Recomputed on this request. Null until the output is sealed. */
  evidenceVerified: boolean | null;
  score: number | null;
  scoreLabel: string | null;
}

export interface RunLogLine {
  at: string;
  message: string;
}

export interface RubricComparisonRow {
  name: string;
  short: string;
  points: number;
  /** One entry per model, in model order; null until that model is scored. */
  scores: (number | null)[];
}

export interface RunDetailResponse {
  code: string;
  status: RunStatus;
  interruptReason: InterruptReason | null;
  /** Provider timeout at 14:34 UTC. No evidence lost. Resume only incomplete work. */
  interruptMessage: string | null;
  interruptedAt: string | null;
  stagesTotal: number;
  stagesDone: number;
  percent: number;
  attempt: number;
  checkpointCode: string | null;
  checkpointAt: string | null;
  elapsedMs: number;
  serverNow: string;
  task: {
    code: string;
    title: string;
    version: string;
    /** BIO-042 v1.0 */
    label: string;
    sourcePack: string | null;
  };
  ownerName: string;
  isOwner: boolean;
  models: RunModelState[];
  log: RunLogLine[];
  tamper: TamperDto | null;
  sealedCount: number;
  /** Evidence codes whose stored bytes no longer match their seal. */
  quarantined: string[];
  rubric: RubricComparisonRow[];
  consequentialDifference: string | null;
  /** Synthetic demo scores. n = 1 task; no population confidence interval is estimated. */
  resultsNote: string;
  /** Pinned settings this run could not honour, stated plainly. */
  settingsNotes: string[];
  review: RunReviewState | null;
  report: RunReportState | null;
  verdicts: {
    stop: VerdictDto;
    resume: VerdictDto;
    requestReview: VerdictDto;
  };
  reviewAction: ReviewAction;
}

export interface RunStartResponse {
  code: string;
}

/* ---------- Evidence ---------- */

export interface EvidenceSourceRecord {
  id: string;
  label: string;
  observation: string;
}

export interface EvidenceSources {
  /** visible: records shown. hidden: this reader may not see a private pack. none: no pack pinned. unparsed: a PDF pack. */
  state: 'visible' | 'hidden' | 'none' | 'unparsed';
  /** DS-BIO-07 v1.0 */
  label: string | null;
  datasetCode: string | null;
  sha256: string | null;
  records: EvidenceSourceRecord[];
  note: string | null;
}

export interface EvidenceDetailResponse {
  code: string;
  runCode: string;
  task: { code: string; version: string; label: string };
  model: { id: string; displayName: string; shortName: string; revision: string };
  outputText: string;
  scores: ScoreEntry[];
  totalScore: number;
  scoreLabel: string;
  synthetic: boolean;
  settingsNotes: string[];
  sources: EvidenceSources;
  annotation: { text: string; reviewCode: string } | null;
  /** Why there is no annotation yet. */
  annotationEmpty: string;
  tamper: TamperDto;
  downloadUrl: string;
}
