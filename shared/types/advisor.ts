// Audit Advisor: threads per user and frozen task version.

export interface AdvisorCitation {
  n: number;
  label: string;
  detail: string;
  /** A real page in the app, e.g. /evidence/EV-1042-A */
  to: string;
}

/** retrieval: extractive, no model call. llm: the constrained model mode. authored: part of the demo seed. */
export type AdvisorMode = 'retrieval' | 'llm' | 'authored';

export interface AdvisorMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: AdvisorCitation[];
  insufficient: boolean;
  mode: AdvisorMode;
  modeNote: string | null;
  createdAt: string;
}

export interface AdvisorTaskOption {
  code: string;
  version: string;
  /** BIO-042 v1.0 */
  label: string;
  title: string;
  latest: boolean;
}

export interface AdvisorTaskList {
  items: AdvisorTaskOption[];
  /** The task of this user's newest thread, else the first readable one. */
  defaultTask: { code: string; version: string } | null;
}

export interface AdvisorTamper {
  code: string;
  runCode: string;
  taskLabel: string;
  sha256: string;
  capturedAt: string;
  runnerVersion: string;
  /** Recomputed on this request. */
  verified: boolean;
}

export interface AdvisorThread {
  task: { code: string; version: string; label: string; title: string; synthetic: boolean };
  sourcePack: string | null;
  /** Set when the task pins a dataset this user may not read, so its records were left out. */
  sourcePackWithheld: boolean;
  runCode: string | null;
  /** What will answer the next question on this server. */
  mode: 'retrieval' | 'llm';
  messages: AdvisorMessage[];
  tamper: AdvisorTamper | null;
  /** Evidence codes left out of retrieval because their seal no longer verifies. */
  quarantined: string[];
  recordCount: number;
  askerName: string;
}

export interface AdvisorQueryResponse {
  question: AdvisorMessage;
  answer: AdvisorMessage;
}
