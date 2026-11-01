// Administration: index, model registry and system checks.

export interface AdminPerson {
  name: string;
  role: string;
}

export interface AdminSummary {
  pendingCredentials: number;
  pendingAdjudications: number;
  models: { total: number; enabled: number };
  latestCheck: { finishedAt: string; passed: number; warnings: number; failed: number; message: string; tone: CheckTone } | null;
  operator: AdminPerson;
}

export interface ModelRevisionEntry {
  id: string;
  editor: string | null;
  rationale: string;
  /** field -> { from, to } */
  changes: Record<string, { from: string | boolean; to: string | boolean }>;
  createdAt: string;
}

export interface AdminModel {
  id: string;
  displayName: string;
  shortName: string;
  revision: string;
  adapter: string;
  adapterLabel: string;
  contextK: number;
  outputK: number;
  cutoffDisclosure: string;
  enabled: boolean;
  illustrative: boolean;
  updatedAt: string;
  history: ModelRevisionEntry[];
}

export interface AdminModelsResponse {
  items: AdminModel[];
  editor: AdminPerson;
}

export type CheckStatus = 'passed' | 'warning' | 'failed';
export type CheckTone = 'accent' | 'warning' | 'danger';

export interface CheckFailure {
  subject: string;
  reason: string;
}

export interface CheckReceipt {
  code: string;
  key: string;
  label: string;
  status: CheckStatus;
  /** Passed · 72 of 72 verified */
  detail: string;
  failures: CheckFailure[];
  createdAt: string;
}

export interface CheckRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  operator: AdminPerson;
  receipts: CheckReceipt[];
  /** Computed from the receipts, never authored. */
  message: string;
  tone: CheckTone;
}

export interface OperationalEvent {
  id: string;
  subject: string;
  message: string;
  at: string;
}

export interface ChecksResponse {
  latest: CheckRun | null;
  events: OperationalEvent[];
  operator: AdminPerson;
}
