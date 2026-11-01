// Agent assurance DTOs: traces, adjudications, regressions and release gates.
import type { Verdict } from './datasets.ts';

export type { Verdict };

export type GateCheckGroup = 'claim' | 'source' | 'private' | 'integrity';
export type CheckSeverity = 'high' | 'medium' | 'low';
export type RegressionPolicy = 'block_high' | 'block_any';
export type GateState = 'not_run' | 'blocked' | 'passed';

/** One step as a harness records it. The status is the harness's claim; the gate checks it independently. */
export interface TraceStep {
  n: number;
  title: string;
  call?: string;
  claim?: string;
  detail?: string;
  sources?: string[];
  status: string;
}

export interface GateCheckResult {
  id: string;
  group: GateCheckGroup;
  label: string;
  status: 'passed' | 'failed';
  detail: string;
  required: boolean;
  severity: CheckSeverity;
  /** The active regression holding this check, e.g. REG-BIO-042. */
  regressions?: string[];
  /** True when this failure, on its own, makes the candidate ineligible. */
  blocking: boolean;
  step?: number;
}

export interface GateGroupResult {
  id: GateCheckGroup;
  /** "REG-BIO-042 / Claim consistency" */
  title: string;
  status: 'passed' | 'failed';
  /** "TRACE-042, step 03" */
  detail: string;
  passed: number;
  total: number;
}

export interface RegressionPin {
  code: string;
  version: number;
  name: string;
  rule: string;
  policy: RegressionPolicy;
  severity: CheckSeverity;
}

export interface SelectChoice {
  value: string;
  label: string;
}

export interface TraceStepView {
  n: number;
  /** "01 / Retrieve sources" */
  heading: string;
  /** "read_dataset(DS-BIO-07, v1.0) · Allowed" */
  detail: string;
  status: string;
  flagged: boolean;
}

export interface TraceAdjudication {
  id: string;
  code: string;
  kind: 'finding' | 'clarification';
  finding: string;
  severity: CheckSeverity;
  /** "High / Release-blocking" */
  severityLabel: string;
  rationale: string;
  reviewerName: string;
  createdAt: string;
  regressionCode: string | null;
  canCreateRegression: Verdict;
}

export interface TraceDetail {
  code: string;
  agentLabel: string;
  /** "Aster 3.2" */
  agentShort: string;
  harnessVersion: string;
  candidate: string | null;
  /** BIO-042 v1.0 */
  taskLabel: string | null;
  /** DS-BIO-07 v1.0 */
  datasetLabel: string | null;
  domainName: string;
  ownerName: string;
  isSynthetic: boolean;
  createdAt: string;
  sha256: string;
  /** Recomputed on this request. */
  verified: boolean;
  steps: TraceStepView[];
  flagged: boolean;
  adjudications: TraceAdjudication[];
  /** ADJ-TRACE-042, the latest confirmed finding. */
  decisionCode: string | null;
  /** The code the next confirmed finding would get. */
  nextDecisionCode: string;
  /** Who the rail names as reviewer: the viewer when they may review, else the latest reviewer. */
  reviewerName: string | null;
  canReview: Verdict;
  /** "This is a separate agent-harness fixture. It does not overwrite…" */
  separationNote: string;
  findingChoices: SelectChoice[];
  severityChoices: SelectChoice[];
  gate: { code: string; candidate: string; state: GateState } | null;
}

export interface AdjudicationResponse {
  code: string;
  kind: 'finding' | 'clarification';
  /** For a clarification: whether the owner could actually be emailed. */
  emailed?: boolean;
  emailError?: string;
}

export interface RegressionVersionView {
  version: number;
  name: string;
  passCondition: string;
  policy: RegressionPolicy;
  policyLabel: string;
  scopeAck: boolean;
  createdByName: string;
  createdAt: string;
  isCurrent: boolean;
}

export interface RegressionDetail {
  code: string;
  status: 'draft' | 'active';
  name: string;
  /** BIO-042 v1.0 / DS-BIO-07 v1.0 */
  pinnedEvaluation: string;
  passCondition: string;
  policy: RegressionPolicy;
  policyChoices: SelectChoice[];
  rule: string;
  scope: string;
  scopeAck: boolean;
  currentVersion: number;
  activatedAt: string | null;
  source: {
    code: string;
    finding: string;
    severityLabel: string;
    /** "High severity" */
    severityShort: string;
    reviewerName: string;
    traceCode: string;
  } | null;
  target: string | null;
  gateCode: string | null;
  ownerName: string;
  canEdit: Verdict;
  versions: RegressionVersionView[];
}

export interface GateDetail {
  gate: { code: string; target: string; suite: string; suiteSize: number; workspaceName: string };
  candidate: string;
  state: GateState;
  trace: { code: string; harnessVersion: string; verified: boolean; agentLabel: string };
  run: {
    passedCount: number;
    totalCount: number;
    groups: GateGroupResult[];
    checks: GateCheckResult[];
    regressions: RegressionPin[];
    blockingReason: string | null;
    createdAt: string;
    createdByName: string;
  } | null;
  decision: { decidedByName: string; createdAt: string } | null;
  /** Active regressions on this gate right now, or those pinned by the run. */
  regressions: { code: string; status: string }[];
  previous: { candidate: string; state: 'blocked' | 'passed' } | null;
  canRun: Verdict;
  canApprove: Verdict;
  /** "What changed in rc.19" */
  whatChanged: string | null;
  /** "Required before retry" */
  requiredBeforeRetry: string | null;
  /** "One high-severity regression failed. Release is not eligible and cannot be bypassed." */
  alert: string;
  reportPath: string | null;
}

export interface AssuranceTraceItem {
  code: string;
  agentLabel: string;
  harnessVersion: string;
  candidate: string | null;
  taskLabel: string | null;
  /** Awaiting adjudication | Confirmed finding | Clarification requested | No flags */
  state: string;
  flagged: boolean;
  decisionCode: string | null;
  isSynthetic: boolean;
  createdAt: string;
  workspaceName: string;
}

export interface AssuranceRegressionItem {
  code: string;
  name: string;
  status: 'draft' | 'active';
  policyLabel: string;
  currentVersion: number;
  sourceCode: string | null;
}

export interface AssuranceCandidateItem {
  candidate: string;
  traceCode: string;
  harnessVersion: string;
  state: GateState;
  passedCount: number | null;
  totalCount: number | null;
  approved: boolean;
}

export interface AssuranceGateItem {
  code: string;
  target: string;
  suite: string;
  suiteSize: number;
  candidates: AssuranceCandidateItem[];
}

export interface AssuranceIndex {
  workspace: { id: string; name: string } | null;
  canImport: Verdict;
  gates: AssuranceGateItem[];
  traces: AssuranceTraceItem[];
  regressions: AssuranceRegressionItem[];
  /** Flagged traces outside your workspace that your verified credentials let you adjudicate. */
  reviewQueue: AssuranceTraceItem[];
  /** The suite a new Biology gate runs. */
  suite: string;
  importExample: string;
}

export interface ImportTraceResponse {
  code: string;
  sha256: string;
}
