import { useEffect, useState } from 'react';
import type { ExternalAdvisorAnswer, ExternalReport, ExternalTask, OAuthTokenError, OAuthTokenResponse } from '../../../shared/types/external.ts';
import { Actions, Alert, Button, ContextRail, LinkButton, Page, PageHeader, Pairs, RailItem, RailNote, Section, Skeleton, Workspace, type Tone } from '../../components/index.ts';
import './external.css';
import { ATLAS_CLIENT_ID, takePending, type AtlasPending } from './client.ts';

/**
 * The demo client's side of the boundary. It checks the state it sent, exchanges the code with its
 * verifier, and calls Rivet with the bearer token alone: cookies are left out of every request here.
 */

interface ApiCall {
  label: string;
  method: 'GET' | 'POST';
  path: string;
  status: number;
  /** What this call was expected to do, so a refusal reads as the boundary holding. */
  expected: 'allowed' | 'refused';
  summary: string;
}

type Outcome =
  | { kind: 'no_response' }
  | { kind: 'state_mismatch' }
  | { kind: 'denied'; error: string; description: string | null }
  | { kind: 'exchange_failed'; error: string; description: string }
  | { kind: 'connected'; token: string; expiresIn: number; scope: string; pending: AtlasPending; calls: ApiCall[] };

async function callExternal<T>(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: T | null; message: string }> {
  const res = await fetch(path, {
    method,
    credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (res.ok) return { status: res.status, data: parsed as T, message: '' };
  const error = (parsed as { error?: { message?: string; code?: string } } | null)?.error;
  return { status: res.status, data: null, message: error?.message ?? 'The request was refused.' };
}

/** The proof: what the token can read, and a task it cannot. */
async function exerciseToken(token: string, taskCode: string): Promise<ApiCall[]> {
  const calls: ApiCall[] = [];

  const taskPath = `/api/external/tasks/${encodeURIComponent(taskCode)}`;
  const task = await callExternal<ExternalTask>(token, 'GET', taskPath);
  calls.push({
    label: 'Read the allowed task',
    method: 'GET',
    path: taskPath,
    status: task.status,
    expected: 'allowed',
    summary: task.data ? `${task.data.code} v${task.data.version} · ${task.data.title}\nFrozen definition SHA-256 ${task.data.sha256}` : task.message,
  });

  if (task.data?.report) {
    const reportPath = `/api/external/reports/${task.data.report.code}/${task.data.report.version}`;
    const report = await callExternal<ExternalReport>(token, 'GET', reportPath);
    calls.push({
      label: 'Read report and evidence metadata',
      method: 'GET',
      path: reportPath,
      status: report.status,
      expected: 'allowed',
      summary: report.data ? `${report.data.code} v${report.data.version} · ${report.data.headline}\nEvidence metadata: ${report.data.evidence.map((item) => item.code).join(', ')}. No private source files.` : report.message,
    });
  }

  const advisorPath = '/api/external/advisor/query';
  const advisor = await callExternal<ExternalAdvisorAnswer>(token, 'POST', advisorPath, { question: 'What are the limitations of the report?' });
  calls.push({
    label: 'Ask Audit Advisor',
    method: 'POST',
    path: advisorPath,
    status: advisor.status,
    expected: 'allowed',
    summary: advisor.data ? `${advisor.data.answer}\nAnswered in ${advisor.data.mode} mode, with ${advisor.data.citations.length} ${advisor.data.citations.length === 1 ? 'citation' : 'citations'}.` : advisor.message,
  });

  const otherCode = taskCode === 'BIO-041' ? 'BIO-042' : 'BIO-041';
  const otherPath = `/api/external/tasks/${otherCode}`;
  const other = await callExternal<ExternalTask>(token, 'GET', otherPath);
  calls.push({
    label: `Try another task, ${otherCode}`,
    method: 'GET',
    path: otherPath,
    status: other.status,
    expected: 'refused',
    summary: other.data ? `Rivet returned ${other.data.code}. This should not happen.` : other.message,
  });
  return calls;
}

async function completeFlow(search: string): Promise<Outcome> {
  const params = new URLSearchParams(search);
  const pending = takePending();
  if (!pending) return { kind: 'no_response' };
  // Checked first: an unmatched response is never acted on, whether it carries a code or an error.
  if (!params.get('state') || params.get('state') !== pending.state) return { kind: 'state_mismatch' };
  const error = params.get('error');
  if (error) return { kind: 'denied', error, description: params.get('error_description') };
  const code = params.get('code');
  if (!code) return { kind: 'no_response' };

  const res = await fetch('/oauth/token', {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: ATLAS_CLIENT_ID, code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier }),
  });
  const body = (await res.json()) as OAuthTokenResponse | OAuthTokenError;
  if (!res.ok || !('access_token' in body)) {
    const failure = body as OAuthTokenError;
    return { kind: 'exchange_failed', error: failure.error, description: failure.error_description };
  }
  return { kind: 'connected', token: body.access_token, expiresIn: body.expires_in, scope: body.scope, pending, calls: await exerciseToken(body.access_token, pending.taskCode) };
}

const running = new Map<string, Promise<Outcome>>();

/** Effects run twice in development, and a one-time code must only be spent once. */
function completeOnce(search: string): Promise<Outcome> {
  const existing = running.get(search);
  if (existing) return existing;
  const started = completeFlow(search);
  running.set(search, started);
  return started;
}

function statusLine(call: ApiCall): { text: string; tone: Tone } {
  if (call.expected === 'refused') return call.status === 403 ? { text: `${call.status} · Refused, as it should be`, tone: 'accent' } : call.status === 401 ? { text: `${call.status} · Token no longer valid`, tone: 'warning' } : { text: `${call.status} · The boundary did not hold`, tone: 'danger' };
  if (call.status >= 200 && call.status < 300) return { text: `${call.status} · Allowed`, tone: 'accent' };
  return { text: `${call.status} · Refused`, tone: 'warning' };
}

function Connected({ outcome }: { outcome: Extract<Outcome, { kind: 'connected' }> }) {
  const [calls, setCalls] = useState(outcome.calls);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState(1);
  const refused = calls.some((call) => call.expected === 'allowed' && call.status >= 400);

  const again = async () => {
    setBusy(true);
    setFailure(null);
    try {
      setCalls(await exerciseToken(outcome.token, outcome.pending.taskCode));
      setLastRun((count) => count + 1);
    } catch {
      setFailure('Atlas could not reach Rivet. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Atlas is connected">
      <PageHeader eyebrow="08 External access" title="Atlas is connected" subtitle="The demo client exchanged its one-time code and called Rivet with a bearer token." status={`Atlas demo / ${outcome.pending.taskCode} only`} />
      <Alert live>
        {refused
          ? `Rivet refused calls it allowed before. The token may be revoked, expired, or the approving user may have lost access. Calls made: round ${lastRun}.`
          : `This page stands in for an external client. Everything below came back from Rivet's external API, using only the bearer token. Calls made: round ${lastRun}.`}
      </Alert>
      {failure ? <Alert tone="danger">{failure}</Alert> : null}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Access token">Bearer / {Math.round(outcome.expiresIn / 60)} minutes from issue</RailItem>
            <RailItem term="Refresh token">None issued</RailItem>
            <RailItem term="Token storage">This page's memory only</RailItem>
            <RailItem term="Cookies">Not sent with these requests</RailItem>
            <RailNote>Revoke this connection from Profile, then call the API again here: every call stops working on the next request.</RailNote>
          </ContextRail>
        }
      >
        <Section title="What Atlas received">
          <Pairs
            items={[
              { term: 'Token response', detail: `Bearer token, expires in ${outcome.expiresIn} seconds, no refresh token` },
              { term: 'Scopes', detail: outcome.scope.split(' ').join(' · ') },
            ]}
          />
        </Section>
        <Section title="Calls to the external API" kind="table">
          {calls.map((call) => {
            const line = statusLine(call);
            return (
              <div className="atlas-call" key={call.path + call.method}>
                <div className="atlas-call-line">
                  <span>{call.label}</span>
                  <span className="atlas-call-status" data-tone={line.tone}>
                    {line.text}
                  </span>
                </div>
                <span className="atlas-call-path">
                  {call.method} {call.path}
                </span>
                <p className="atlas-call-body">{call.summary}</p>
              </div>
            );
          })}
        </Section>
      </Workspace>
      <Actions>
        <Button variant="primary" busy={busy} busyLabel="Calling the API again" onClick={() => void again()}>
          Call the API again
        </Button>
        <LinkButton to="/profile">Manage connections</LinkButton>
        <LinkButton to="/atlas-demo">Start again</LinkButton>
      </Actions>
    </Page>
  );
}

function NotConnected({ title, tone, status, message, body }: { title: string; tone: Tone; status: string; message: string; body: string }) {
  return (
    <Page title={title}>
      <PageHeader eyebrow="08 External access" title={title} subtitle="This page stands in for an external client." status={status} statusTone={tone} />
      <Alert tone={tone} live>
        {message}
      </Alert>
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Access token">Not issued</RailItem>
            <RailNote>A fresh attempt needs a new OAuth state and PKCE challenge, and your explicit consent again.</RailNote>
          </ContextRail>
        }
      >
        <Section title="What happened">
          <p>{body}</p>
        </Section>
      </Workspace>
      <Actions>
        <LinkButton variant="primary" to="/atlas-demo">
          Request a new connection
        </LinkButton>
        <LinkButton to="/">Return to Rivet</LinkButton>
      </Actions>
    </Page>
  );
}

export default function AtlasCallbackPage() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const search = window.location.search;
    completeOnce(search)
      .then((result) => {
        if (!active) return;
        setOutcome(result);
        // The code has been spent. Do not leave it in the address bar or the history entry.
        window.history.replaceState(window.history.state, '', window.location.pathname);
      })
      .catch(() => {
        if (active) setFailure('Atlas could not reach Rivet. Check your connection and request a new connection.');
      });
    return () => {
      active = false;
    };
  }, []);

  if (failure) return <NotConnected title="Atlas could not finish" tone="danger" status="Atlas demo / Network error" message={failure} body="The authorization response arrived, but the demo client could not complete the exchange." />;
  if (!outcome) return <Skeleton />;
  if (outcome.kind === 'connected') return <Connected outcome={outcome} />;
  if (outcome.kind === 'denied') {
    return <NotConnected title="Atlas was not connected" tone="warning" status={`Atlas demo / ${outcome.error}`} message={`Rivet returned ${outcome.error}. ${outcome.description ?? ''}`.trim()} body="Atlas received no code and no token, so it can read nothing." />;
  }
  if (outcome.kind === 'state_mismatch') {
    return <NotConnected title="Atlas refused this response" tone="danger" status="Atlas demo / State mismatch" message="The state in this response does not match the one this tab sent, so Atlas did not use it." body="A response that does not match the request it answers could have come from somewhere else. The code, if there was one, was not exchanged." />;
  }
  if (outcome.kind === 'exchange_failed') {
    return <NotConnected title="Atlas could not exchange the code" tone="danger" status={`Atlas demo / ${outcome.error}`} message={outcome.description} body="Rivet refused the token request, so Atlas holds no token." />;
  }
  return <NotConnected title="Nothing to complete here" tone="neutral" status="Atlas demo / No pending request" message="This tab is not waiting for an authorization response." body="The demo client keeps its state in this tab and uses it once. A reloaded or reopened callback has nothing to match, so it does nothing." />;
}
