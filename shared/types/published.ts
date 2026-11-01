// DTOs for the leaderboard, its methodology and frozen reports.
import type { DomainDto, VerdictDto } from './expert.ts';

export interface LeaderboardRowDto {
  modelId: string;
  displayName: string;
  mean: number;
  low: number | null;
  high: number | null;
  n: number;
  /** 87.4 [83.1, 91.2] n=24 */
  summary: string;
}

export interface LeaderboardSample {
  tasks: number;
  models: number;
  missing: number;
  /** Tasks with a sealed run behind them, through a frozen report. */
  sealedReceipts: number;
  /** Tasks with no run behind them at all. */
  authoredOnly: number;
  /** Rows marked as authored fixtures, including a seeded task with a report. */
  fixtureTasks: number;
  liveReports: number;
  synthetic: boolean;
  snapshotAt: string | null;
}

export interface IncludedTask {
  /** BIO-042 v1.0 */
  label: string;
  taskCode: string;
  reportHref: string;
  /** The highest-scoring evidence, when you may open it; otherwise the report. */
  evidenceHref: string;
  canReadEvidence: boolean;
  /** Models with a score in that report. */
  modelCount: number;
  ownerName: string;
  expertName: string;
}

export interface LeaderboardResponse {
  domains: DomainDto[];
  domain: DomainDto;
  empty: boolean;
  rows: LeaderboardRowDto[];
  sample: LeaderboardSample;
  /** The band above the table. Says "Synthetic" whenever any fixture is in the sample. */
  alert: string;
  overlap: 'all' | 'some' | 'none' | 'not_applicable';
  /** The computed "Read the uncertainty" paragraph. */
  uncertainty: string;
  /** "1 sealed run receipt · 23 authored fixtures →" */
  receipts: string;
  evidenceBoundary: string;
  included: IncludedTask | null;
  /** Axis for the interval plots, wide enough for every bound. */
  axis: { min: number; max: number };
}

export interface MethodologyTaskRow {
  /** BIO-042 v1.0 */
  label: string;
  taskCode: string;
  version: string;
  source: 'fixture' | 'report';
  report: { code: string; version: string } | null;
  /** Keyed by model id; null where that model has no run. */
  scores: Record<string, number | null>;
}

export interface MethodologyResponse {
  domains: DomainDto[];
  domain: DomainDto;
  empty: boolean;
  rows: LeaderboardRowDto[];
  sample: LeaderboardSample;
  alert: string;
  resamples: number;
  seed: number;
  /** Positions in the sorted resample means, counted from zero. */
  percentiles: { low: number; high: number };
  models: { id: string; displayName: string; shortName: string }[];
  tasks: MethodologyTaskRow[];
}

export interface ReportScoreDto {
  modelId: string;
  displayName: string;
  score: number;
  label: string;
  evidenceCode: string;
  /** The total sealed in the evidence, when the expert's total differs from it. */
  sealedScore?: number;
}

export interface ReportEvidenceDto {
  code: string;
  runCode: string;
  taskLabel: string;
  sha256: string;
  capturedAt: string;
  runnerVersion: string;
  verified: boolean;
}

export interface ReportResponse {
  code: string;
  version: string;
  taskCode: string;
  taskVersion: string;
  title: string;
  domainName: string;
  frozenAt: string;
  ownerName: string;
  expertName: string;
  adminName: string;
  adjudicationCode: string;
  reviewCode: string;
  headline: string;
  summary: string;
  limitations: string;
  scores: ReportScoreDto[];
  /** Chen, M. (2026). BIO-042: … Synthetic demo report. */
  citation: string;
  /** What "Copy citation" puts on the clipboard: citation, versioned URL and hashes. */
  citationText: string;
  /** The versioned URL, from the server's public URL. */
  url: string;
  sha256: string;
  /** Recomputed on this request: the report's hash and every evidence seal. */
  verified: boolean;
  evidence: ReportEvidenceDto | null;
  isSynthetic: boolean;
  /** Private sources and outputs stay permission-checked. */
  canReadSources: boolean;
  downloadUrl: string;
  download: VerdictDto;
}

export interface ReportListItem {
  code: string;
  version: string;
  href: string;
  taskLabel: string;
  title: string;
  domainId: string;
  domainName: string;
  ownerName: string;
  expertName: string;
  frozenAt: string;
  isSynthetic: boolean;
  /** Aster 3.2 86 · Meridian 2.1 81 · Lumen 4 Mini 74 */
  scoreLine: string;
}

export interface ReportsResponse {
  items: ReportListItem[];
  /** Reports before filtering, so the page can tell "none yet" from "none match". */
  total: number;
  domains: DomainDto[];
}
