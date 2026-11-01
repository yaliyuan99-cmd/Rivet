// The session payload every page can rely on (GET /api/session).
export type AccountRole = 'member' | 'admin';
export type WorkspaceRole = 'owner' | 'member';

export interface WorkspaceSummary {
  id: string;
  code: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  defaultVisibility: 'private' | 'shared';
}

export interface CredentialSummary {
  domainId: string;
  domainName: string;
  grantedAt: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: AccountRole;
  bio: string;
  workspace: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  credentials: CredentialSummary[];
  /** An open reviewer application: the frames label this person "Applicant" in the navigation. */
  applicant: boolean;
}

export interface Features {
  github: boolean;
  linkedin: boolean;
  huggingface: boolean;
  email: boolean;
  anthropic: boolean;
  devOutbox: boolean;
}

export interface SessionResponse {
  demo: boolean;
  user: SessionUser | null;
  features: Features;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
}
