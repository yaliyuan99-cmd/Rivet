// Dataset DTOs and the validation receipt stored with every draft and version.
export type DatasetFormat = 'csv' | 'jsonl' | 'pdf';
export type DatasetVisibility = 'private' | 'shared';
export type DatasetFilter = 'private' | 'shared' | 'all';
export type Verdict = { allowed: true } | { allowed: false; reason: string };

export type SensitiveKind = 'email' | 'phone' | 'national_id' | 'medical_record';

export interface SensitiveFlag {
  kind: SensitiveKind;
  /** "email address", "phone number", "national ID", "medical record number" */
  label: string;
  /** Cells flagged. */
  count: number;
  /** "row 3, observation". The flagged values themselves are never stored. */
  locations: string[];
}

export interface ReceiptFailure {
  code: string;
  message: string;
}

export interface DatasetReceipt {
  format: DatasetFormat | 'unknown';
  encoding: string;
  requiredColumns: { expected: string[]; missing: string[]; passed: number; total: number; applicable?: boolean };
  /** Column names found, in file order. Absent for PDF. */
  columns?: string[];
  recordsParsed: number;
  /** Set when records were not parsed at all, e.g. for a PDF. */
  recordsNote?: string;
  duplicateSourceIds: number;
  missingSourceIds: number;
  sensitiveData: { flags: SensitiveFlag[]; note: string; scanned?: boolean };
  /** True when every record's provenance declares it authored, synthetic, a fixture or a demo. */
  synthetic?: boolean;
  /** Every reason this file cannot be used. Empty when passed. */
  failures?: ReceiptFailure[];
  passed: boolean;
}

export interface DatasetWorkspace {
  id: string;
  name: string;
  visibility: DatasetVisibility;
}

export interface DatasetListItem {
  code: string;
  name: string;
  visibility: DatasetVisibility;
  version: string;
  format: DatasetFormat;
  size: number;
  recordsCount: number;
  /** "Attached to BIO-042", "Authored demo" or "Not attached". */
  attachment: string;
  isSynthetic: boolean;
  ownerName: string;
  workspaceName: string;
  /** False for a shared dataset from another workspace. */
  inActiveWorkspace: boolean;
  downloadPath: string;
}

export interface DatasetActivityItem {
  id: string;
  kind: string;
  message: string;
  createdAt: string;
}

export interface DatasetListResponse {
  workspace: DatasetWorkspace | null;
  filter: DatasetFilter;
  items: DatasetListItem[];
  activity: DatasetActivityItem[];
  canCreate: Verdict;
}

export interface UploadDomain {
  id: string;
  name: string;
  prefix: string;
  /** The code a dataset in this domain would get now, e.g. DS-BIO-10. */
  nextCode: string;
}

export interface UploadTarget {
  code: string;
  name: string;
  domainName: string;
  provenance: string;
  latestVersion: string;
  nextVersion: string;
  versions: string[];
  canUpload: Verdict;
}

export interface UploadContext {
  workspace: DatasetWorkspace | null;
  ownerName: string;
  maxBytes: number;
  formats: string[];
  domains: UploadDomain[];
  defaultDomainId: string;
  target: UploadTarget | null;
  canCreate: Verdict;
}

export interface UploadDraft {
  id: string;
  filename: string;
  size: number;
  sha256: string;
  format: DatasetFormat | 'unknown';
  recordsCount: number;
  passed: boolean;
  receipt: DatasetReceipt;
  visibility: DatasetVisibility;
  targetCode: string | null;
  createdAt: string;
}

export interface CreateDatasetResponse {
  code: string;
  version: string;
}

export interface DatasetRow {
  key: string;
  /** "E01 / MIC assay", or the source ID alone */
  term: string;
  /** "0.25 → 1.00 µg/mL · Association, not causality", or the observation alone */
  detail: string;
}

export interface DatasetVersionSummary {
  version: string;
  filename: string;
  format: DatasetFormat;
  size: number;
  sha256: string;
  recordsCount: number;
  createdAt: string;
  createdByName: string;
  pinnedBy: string[];
  isCurrent: boolean;
}

export interface DatasetDetail {
  code: string;
  name: string;
  domainName: string;
  visibility: DatasetVisibility;
  ownerName: string;
  workspaceName: string;
  deleted: { at: string; byName: string | null } | null;
  version: {
    version: string;
    filename: string;
    format: DatasetFormat;
    size: number;
    /** The stored hash. `verified` says whether the bytes still match it on this request. */
    sha256: string;
    verified: boolean;
    recordsCount: number;
    isSynthetic: boolean;
    provenance: string;
    createdAt: string;
    createdByName: string;
    isLatest: boolean;
    receipt: DatasetReceipt;
    rows: DatasetRow[];
    rowsTotal: number;
    hasLimits: boolean;
    pinnedBy: string[];
    downloadPath: string;
    manifestPath: string;
  };
  versions: DatasetVersionSummary[];
  canDelete: Verdict;
  canUploadVersion: Verdict;
}

export interface DatasetDeletion {
  code: string;
  name: string;
  version: string;
  ownerName: string;
  canDelete: Verdict;
  references: {
    /** BIO-042 v1.0 */
    frozenTasks: string[];
    /** BIO-043 */
    draftTasks: string[];
    /** RPT-BIO-042 v1.0 */
    reports: string[];
    /** TRACE-042 */
    traces: string[];
  };
  impact: {
    library: string;
    attachments: string;
    snapshots: string;
    reports: string;
  };
}
