// DTOs for workspaces, invitations, profile, connected accounts and Home.
import type { AccountRole, CredentialSummary, WorkspaceRole } from './session.ts';

/** A permission answer the page can render: allowed, or disabled with this exact reason. */
export type Verdict = { allowed: true } | { allowed: false; reason: string };

export type Visibility = 'private' | 'shared';
export type ProviderId = 'github' | 'linkedin' | 'huggingface';

/* ---------- Create ---------- */

/** GET /api/workspaces/slug-check?slug= */
export interface SlugCheck {
  slug: string;
  /** Host of the configured public URL, e.g. rivet.example. */
  host: string;
  status: 'empty' | 'available' | 'taken' | 'invalid';
  /** Why the slug cannot be used; null when it can. */
  reason: string | null;
  /** The code this slug would receive, e.g. WS-HELIX. */
  code: string | null;
}

export interface WorkspaceDetail {
  id: string;
  code: string;
  name: string;
  slug: string;
  /** rivet.example/w/helix-lab */
  url: string;
  researchFocus: string;
  defaultVisibility: Visibility;
  ownerName: string;
  createdAt: string;
}

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  researchFocus: string;
  defaultVisibility: Visibility;
  keepPrivate: boolean;
}

/* ---------- Members ---------- */

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  isSelf: boolean;
  isCreator: boolean;
  joinedAt: string;
  remove: Verdict;
}

export interface InvitationRow {
  id: string;
  email: string;
  /** Display name when this address belongs to a verified account. */
  name: string | null;
  role: WorkspaceRole;
  state: 'sent' | 'expired';
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  revoke: Verdict;
}

/** GET /api/workspaces/current. workspace is null for someone with no active membership. */
export interface MembersData {
  workspace: WorkspaceDetail | null;
  viewerRole: WorkspaceRole | null;
  manage: Verdict;
  members: MemberRow[];
  invitations: InvitationRow[];
}

/** POST /api/workspaces/:id/invitations/preview: what the invite form would do for this address. */
export interface InvitationPreview {
  email: string;
  /** Display name, only for a verified account with exactly this address. */
  name: string | null;
  credentials: string[];
  state: 'new' | 'member' | 'pending';
}

export interface InvitationSent {
  id: string;
  email: string;
  role: WorkspaceRole;
  expiresAt: string;
}

/** GET /api/invitations/:token. Public: holding the link is what proves it was delivered. */
export interface InvitationView {
  state: 'valid' | 'expired' | 'revoked' | 'accepted';
  workspaceName: string;
  workspaceCode: string;
  invitedBy: string;
  email: string;
  role: WorkspaceRole;
  expiresAt: string;
  viewer: {
    signedIn: boolean;
    email: string | null;
    emailVerified: boolean;
    emailMatches: boolean;
  };
  accept: Verdict;
}

/* ---------- Profile ---------- */

export interface ConnectionRow {
  provider: ProviderId;
  label: string;
  connected: boolean;
  /** @mayachen-demo, or a display name where a provider has no handle. */
  handle: string | null;
  profileUrl: string | null;
  visibilityNote: string | null;
  isSynthetic: boolean;
  connectedAt: string | null;
  connect: Verdict;
  /** A server route that redirects to the provider. Null while connect is refused. */
  connectHref: string | null;
}

export interface AiClientRow {
  /** oauth_tokens.id, the id POST /api/oauth/connections/:id/revoke takes. */
  id: string;
  clientName: string;
  /** BIO-042 only */
  resource: string;
  /** Read/query */
  access: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
}

export interface ProfileData {
  name: string;
  email: string;
  emailVerified: boolean;
  bio: string;
  accountRole: AccountRole;
  workspace: { name: string; role: WorkspaceRole } | null;
  credentials: CredentialSummary[];
  connections: ConnectionRow[];
  aiClients: AiClientRow[];
  reviewBiology: Verdict;
  serverNow: string;
}

/* ---------- Home ---------- */

export type AttentionKind = 'interrupted_run' | 'active_run' | 'review' | 'draft' | 'application' | 'invitation';

export interface AttentionItem {
  kind: AttentionKind;
  code: string | null;
  title: string;
  detail: string;
  /** ISO time the detail refers to, labelled by atLabel ("Saved", "Interrupted"). */
  at: string | null;
  atLabel: string | null;
  /** Null where there is nothing to open here, e.g. an invitation only its email link can accept. */
  href: string | null;
  action: string | null;
}

export interface RecentTask {
  code: string;
  title: string;
  /** Frozen v1.0 or Draft 0.1 */
  state: string;
  updatedAt: string;
  isSynthetic: boolean;
  href: string;
}

export interface RecentReport {
  code: string;
  version: string;
  taskCode: string;
  headline: string;
  frozenAt: string;
  isSynthetic: boolean;
  href: string;
}

export interface HomeData {
  firstRun: boolean;
  workspace: { name: string; role: WorkspaceRole; defaultVisibility: Visibility } | null;
  starter: {
    title: string;
    /** Biology / Microbiology */
    domain: string;
    /** Aster 3.2 · Meridian 2.1 · Lumen 4 Mini; empty when no model is enabled. */
    models: string;
  };
  /** Runs this person has started, so "No evaluations yet" is only ever said when true. */
  evaluations: number;
  attention: AttentionItem[];
  counts: { tasks: number; reports: number };
  recentTasks: RecentTask[];
  recentReports: RecentReport[];
  credentials: CredentialSummary[];
  reviewBiology: Verdict;
}
