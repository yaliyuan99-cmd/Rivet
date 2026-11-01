import type { PinnedModel, RubricCriterion, RunSettings, ScoreEntry } from '../../shared/types/evaluation.ts';
import type { SourceRecord } from './contract.ts';

/** The frozen contract an adapter works from. It never sees the task's working draft. */
export interface FrozenTask {
  code: string;
  version: string;
  title: string;
  prompt: string;
  rubric: RubricCriterion[];
  settings: RunSettings;
}

export interface GenerateInput {
  task: FrozenTask;
  model: PinnedModel;
  records: SourceRecord[];
}

export interface GenerateResult {
  text: string;
  /** Sealed into the evidence: adapter, usage, stop reason, and what was or was not applied. */
  meta: Record<string, unknown>;
}

export interface ScoreInput extends GenerateInput {
  output: string;
}

export interface ScoreResult {
  scores: ScoreEntry[];
  total: number;
  /** demo (synthetic scorer) or judge (LLM judge). Never presented as an expert finding. */
  label: 'demo' | 'judge';
  meta: Record<string, unknown>;
}

export interface ModelAdapter {
  /** Paced by RIVET_STAGE_MS. Real provider calls take their own time. */
  paced: boolean;
  generate(input: GenerateInput): Promise<GenerateResult>;
  score(input: ScoreInput): Promise<ScoreResult>;
}

/** The provider did not answer in time. The run stops safely and the owner can resume. */
export class ProviderTimeoutError extends Error {
  constructor(message = 'The provider did not respond in time.') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

/** A transient provider failure (rate limit, server error, unreadable answer). Also resumable. */
export class ProviderUnavailableError extends Error {
  constructor(message = 'The provider could not complete this request.') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/** The provider refused or rejected the request. Retrying the same contract will not help. */
export class ProviderRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRejectedError';
  }
}
