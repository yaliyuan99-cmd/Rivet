// OAuth consent, the demo client and the bearer API.

export type OAuthScope = 'tasks:read' | 'reports:read' | 'advisor:query';
export type OAuthRequestStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** Query parameters of /oauth/authorize, posted as they arrived. */
export interface OAuthRequestInput {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  resource?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

export interface OAuthRequestCreated {
  code: string;
  /** False when this exact state and challenge were already seen: the same request is returned. */
  created: boolean;
}

export interface OAuthClientInfo {
  clientId: string;
  name: string;
  developer: string;
  description: string;
  redirectUri: string;
  synthetic: boolean;
  scopes: OAuthScope[];
}

/**
 * not_issued: no token exists and none will. awaiting_exchange: approved, the client has not exchanged the code.
 * lapsed: approved, but the client never collected it.
 */
export type OAuthTokenState = 'not_issued' | 'awaiting_exchange' | 'lapsed' | 'issued' | 'expired' | 'revoked';

export interface OAuthRequestView {
  code: string;
  status: OAuthRequestStatus;
  client: { clientId: string; name: string; developer: string; description: string; synthetic: boolean };
  account: { name: string; workspaceName: string | null };
  scopes: { scope: OAuthScope; description: string }[];
  resource: { taskCode: string; version: string; label: string };
  /** Host and path of the registered redirect, e.g. atlas.example/oauth/callback */
  redirectDisplay: string;
  token: { state: OAuthTokenState; id: string | null; expiresAt: string | null; revokedAt: string | null };
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  /** Where "Return to Atlas" goes after a denial or expiry. Approved requests mint a code through POST .../return instead. */
  returnUrl: string | null;
  /** Whether POST .../return can mint a fresh one-time code right now, with the reason when it cannot. */
  canReturn: { allowed: true } | { allowed: false; reason: string };
  /** Live connections this user already has with this client, from earlier approvals. */
  otherActiveConnections: number;
  serverNow: string;
}

export interface OAuthDecisionResponse {
  request: OAuthRequestView;
  redirectTo: string;
}

export interface OAuthReturnResponse {
  redirectTo: string;
}

export interface OAuthRevokeResponse {
  id: string;
  revokedAt: string;
}

/** RFC 6749 section 5.1. There is never a refresh token. */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  resource: string;
}

export interface OAuthTokenError {
  error: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unsupported_grant_type';
  error_description: string;
}

/* ---------- Bearer API ---------- */

export interface ExternalTask {
  code: string;
  version: string;
  title: string;
  prompt: string;
  rubric: { name: string; short?: string; points: number; guidance?: string }[];
  models: { displayName: string; revision: string }[];
  domain: string;
  /** The pin only, and only when this user may read the dataset. Never records or bytes. */
  sourcePack: { code: string; version: string; sha256: string } | null;
  sha256: string;
  frozenAt: string;
  /** Present when the token also holds reports:read. */
  report: { code: string; version: string } | null;
  synthetic: boolean;
}

export interface ExternalReport {
  code: string;
  version: string;
  task: { code: string; version: string };
  headline: string;
  summary: string;
  limitations: string;
  scores: unknown;
  citation: string;
  sha256: string;
  frozenAt: string;
  run: string;
  review: string;
  /** Metadata only: no output text and no source files. */
  evidence: { code: string; modelRevision: string; totalScore: number; scoreLabel: string; sha256: string; capturedAt: string; verified: boolean }[];
  synthetic: boolean;
}

export interface ExternalAdvisorAnswer {
  task: string;
  answer: string;
  insufficient: boolean;
  mode: 'retrieval' | 'llm';
  citations: { n: number; label: string; detail: string; to: string; url: string }[];
}
