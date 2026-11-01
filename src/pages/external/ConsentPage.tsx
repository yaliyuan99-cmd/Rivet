import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import type { OAuthDecisionResponse, OAuthRequestView, OAuthReturnResponse } from '../../../shared/types/external.ts';
import { Actions, ActionsBelow, Alert, AnchorButton, Button, ContextRail, DisabledAction, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Skeleton, Workspace } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three'];
const EYEBROW = '08 External access';

const accountLine = (view: OAuthRequestView) => [view.account.name, view.account.workspaceName].filter(Boolean).join(' / ');
/** "Atlas Research Client" is "Atlas" in a sentence. */
const clientShort = (view: OAuthRequestView) => view.client.name.split(' ')[0] ?? view.client.name;

/** "Three read/query scopes", computed from what was really granted. */
function grantedScopes(view: OAuthRequestView): string {
  const count = view.scopes.length;
  const reads = view.scopes.some((item) => item.scope.endsWith(':read'));
  const queries = view.scopes.some((item) => item.scope.endsWith(':query'));
  const kind = reads && queries ? 'read/query' : reads ? 'read' : 'query';
  return `${NUMBER_WORDS[count] ?? count} ${kind} ${count === 1 ? 'scope' : 'scopes'}`;
}

function tokenLine(view: OAuthRequestView): string {
  const { token } = view;
  if (token.state === 'issued') return `Issued / Expires ${formatTime(token.expiresAt)}`;
  if (token.state === 'awaiting_exchange') return `Not issued yet / ${clientShort(view)} receives it when it exchanges the one-time code`;
  if (token.state === 'revoked') return `Revoked ${formatTime(token.revokedAt)}`;
  if (token.state === 'expired') return `Expired ${formatTime(token.expiresAt)}`;
  return 'Not issued';
}

function PendingState({ view }: { view: OAuthRequestView }) {
  const path = `/api/oauth/requests/${view.code}`;
  const client = useQueryClient();
  // The server may refuse because the link just expired. Show that state, not a stale form.
  const refresh = () => void client.invalidateQueries({ queryKey: [path] });
  const approve = useApiMutation(() => api.post<OAuthDecisionResponse>(`${path}/approve`), { invalidate: [path], onError: refresh });
  const deny = useApiMutation(() => api.post<OAuthDecisionResponse>(`${path}/deny`), { invalidate: [path], onError: refresh });
  const error = approve.formError ?? deny.formError;

  return (
    <Page title="Connect an AI client">
      <PageHeader eyebrow={EYEBROW} title="Connect an AI client" subtitle="Review exactly what this client can access." status={`${view.code} / ${accountLine(view)}`} />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Resource boundary">{view.resource.label} only</RailItem>
            <RailItem term="Token duration">1 hour / No offline access</RailItem>
            <RailItem term="Security">PKCE S256 / State verified</RailItem>
            <RailItem term="Redirect">{view.redirectDisplay}</RailItem>
            <RailNote>Approve only if you recognize this client. Current permissions are checked on every request. Revocation stops future access; it cannot retract data already received.</RailNote>
          </ContextRail>
        }
      >
        <Section title={`${view.client.name} requests access`}>
          <p>
            {view.client.clientId} · External AI client
            <br />
            Developer {view.client.developer} · {view.client.description}
          </p>
        </Section>
        <Section title={`Requested scopes / ${view.resource.taskCode} only`}>
          <Pairs items={view.scopes.map((item) => ({ key: item.scope, term: item.scope, detail: item.description }))} />
        </Section>
        <Section title="No write or destructive access">
          <p>This client cannot run, revise, delete or review tasks; manage members; or read unrelated datasets. It never receives your password.</p>
        </Section>
      </Workspace>
      <Actions>
        <Button variant="primary" busy={approve.isPending} busyLabel="Approving access" disabled={deny.isPending} onClick={() => approve.mutate()}>
          Approve access
        </Button>
        <Button busy={deny.isPending} busyLabel="Denying this request" disabled={approve.isPending} onClick={() => deny.mutate()}>
          Deny request
        </Button>
      </Actions>
    </Page>
  );
}

function ApprovedState({ view }: { view: OAuthRequestView }) {
  const short = clientShort(view);
  // Stays busy while the browser leaves: a second click would mint a new code and void the one on its way.
  const [leaving, setLeaving] = useState(false);
  const send = useApiMutation(() => api.post<OAuthReturnResponse>(`/api/oauth/requests/${view.code}/return`), {
    onSuccess: ({ redirectTo }) => {
      setLeaving(true);
      window.location.assign(redirectTo);
    },
  });
  const revoked = view.token.state === 'revoked';
  const lapsed = view.token.state === 'lapsed';
  const title = revoked ? 'Connection revoked' : lapsed ? 'Connection not completed' : 'Connection approved';
  const status = revoked ? 'Access revoked' : lapsed ? 'Approval not collected' : 'Access approved';
  return (
    <Page title={title}>
      <PageHeader eyebrow={EYEBROW} title={title} subtitle="You remain in control of your evidence." status={`${view.code} / ${status}`} statusTone={lapsed ? 'warning' : 'accent'} />
      {revoked ? (
        <Alert tone="neutral" live>
          Access was revoked at {formatTime(view.token.revokedAt)}. {short} can no longer use this connection.
        </Alert>
      ) : lapsed ? (
        <Alert tone="warning" live>
          {short} did not collect this approval in time. No token was issued.
        </Alert>
      ) : (
        <Alert live>
          {grantedScopes(view)} granted for {view.resource.taskCode}. You can revoke access at any time.
        </Alert>
      )}
      {send.formError ? <Alert tone="danger">{send.formError}</Alert> : null}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Decision">Approved</RailItem>
            <RailItem term="Request">{view.code}</RailItem>
            <RailItem term="Token lifetime">1 hour</RailItem>
            <RailItem term="Offline access">Not granted</RailItem>
            <RailNote>Rivet checks both the token scope and your current workspace permission on every API request.</RailNote>
            {view.canReturn.allowed ? null : <RailUnavailable action={`Return to ${short}`} reason={view.canReturn.reason} />}
          </ContextRail>
        }
      >
        <Section title="Authorization receipt">
          <Pairs
            items={[
              { term: 'Client', detail: `${view.client.name} / ${view.client.clientId}` },
              { term: 'Account', detail: accountLine(view) },
              { term: 'Scopes', detail: view.scopes.map((item) => item.scope).join(' · ') },
              { term: 'Resource boundary', detail: `${view.resource.label} only` },
              { term: 'Access token', detail: tokenLine(view) },
            ]}
          />
        </Section>
        <Section title="Keep control of your evidence">
          <p>Manage or revoke this connection from Profile → Authorized AI clients. Private source-file download and write actions were not granted.</p>
        </Section>
      </Workspace>
      <Actions>
        {view.canReturn.allowed ? (
          <Button variant="primary" busy={send.isPending || leaving} busyLabel={`Returning to ${short}`} onClick={() => send.mutate()}>
            Return to {short}
          </Button>
        ) : null}
        <LinkButton variant={view.canReturn.allowed ? 'secondary' : 'primary'} to="/profile">
          Manage connections
        </LinkButton>
      </Actions>
      {view.canReturn.allowed ? null : (
        <ActionsBelow>
          <DisabledAction reason={view.canReturn.reason}>Return to {short}</DisabledAction>
        </ActionsBelow>
      )}
    </Page>
  );
}

function DeniedState({ view }: { view: OAuthRequestView }) {
  const short = clientShort(view);
  const stillConnected = view.otherActiveConnections > 0;
  return (
    <Page title="No access was granted">
      <PageHeader eyebrow={EYEBROW} title="No access was granted" subtitle="You declined the connection request." status={`${view.code} / Request denied`} />
      <Alert live>No access was granted. No token was issued.</Alert>
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Request">{view.code}</RailItem>
            <RailItem term="Granted scopes">None</RailItem>
            <RailItem term="Account access">Unchanged</RailItem>
            <RailItem term="Client status">{stillConnected ? 'Connected from an earlier approval' : 'Not connected'}</RailItem>
            <RailNote>The denial is recorded as an authorization audit event. It does not affect your Rivet membership.</RailNote>
          </ContextRail>
        }
      >
        <Section title="Authorization receipt">
          <Pairs
            items={[
              { term: 'Client', detail: view.client.name },
              { term: 'Account', detail: accountLine(view) },
              { term: 'Requested resource', detail: view.resource.label },
              { term: 'Decision', detail: `Denied by ${view.account.name}` },
              { term: 'Access token', detail: 'Not issued' },
            ]}
          />
        </Section>
        <Section title="Your evidence remains private">
          <p>
            {stillConnected
              ? `This request changed nothing. An earlier connection with ${short} stays active until it expires or you revoke it from Profile → Authorized AI clients.`
              : `${short} cannot access your tasks, reports, evidence or datasets. A fresh request would require your explicit consent again.`}
          </p>
        </Section>
      </Workspace>
      <Actions>
        <LinkButton variant="primary" to="/">
          Return to Rivet
        </LinkButton>
        {view.returnUrl ? <AnchorButton href={view.returnUrl}>Return to {short}</AnchorButton> : null}
      </Actions>
    </Page>
  );
}

function ExpiredState({ view }: { view: OAuthRequestView }) {
  const short = clientShort(view);
  const reason = 'A fresh authorization is required';
  return (
    <Page title="This request has expired">
      <PageHeader eyebrow={EYEBROW} title="This request has expired" subtitle="For your security, consent links are short-lived." status={`${view.code} / Request expired`} statusTone="warning" />
      <Alert tone="warning" live>
        The consent link expired at {formatTime(view.expiresAt)} after ten minutes. No token was issued.
      </Alert>
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Resource requested">{view.resource.label}</RailItem>
            <RailItem term="Decision">Expired / No authorization</RailItem>
            <RailItem term="Access token">Not issued</RailItem>
            <RailItem term="Security boundary">New request required</RailItem>
            <RailNote>Short-lived consent links reduce replay risk. Existing permissions and research data remain unchanged.</RailNote>
            <RailUnavailable action="Approve expired request" reason={reason} />
          </ContextRail>
        }
      >
        <Section title="This link can no longer approve access">
          <Pairs
            items={[
              { term: 'Client', detail: view.client.name },
              { term: 'Request', detail: `${view.code} / Expired` },
              { term: 'Account', detail: accountLine(view) },
              { term: 'Granted scopes', detail: 'None' },
            ]}
          />
        </Section>
        <Section title="Start a fresh authorization">
          <p>Return to {short} and request a new connection with a new OAuth state and PKCE challenge. Do not reuse this expired consent link.</p>
        </Section>
      </Workspace>
      <Actions>
        {view.returnUrl ? (
          <AnchorButton variant="primary" href={view.returnUrl}>
            Return to {short}
          </AnchorButton>
        ) : null}
      </Actions>
      <ActionsBelow>
        <DisabledAction reason={reason}>Approve expired request</DisabledAction>
      </ActionsBelow>
    </Page>
  );
}

function ConsentContent({ view }: { view: OAuthRequestView }) {
  // One URL, four states: when the state changes, start reading from the top of the new one.
  useEffect(() => {
    document.getElementById('main')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [view.status]);
  if (view.status === 'approved') return <ApprovedState view={view} />;
  if (view.status === 'denied') return <DeniedState view={view} />;
  if (view.status === 'expired') return <ExpiredState view={view} />;
  return <PendingState view={view} />;
}

/** /oauth/consent/:code: only the requesting user can open it; everyone else gets the API's 404. */
export default function ConsentPage() {
  const { code = '' } = useParams();
  const location = useLocation();
  const { data: session, isPending } = useSession();
  const query = useApiQuery<OAuthRequestView>(`/api/oauth/requests/${code}`, {
    enabled: Boolean(session?.user?.emailVerified),
    // A pending link expires while it sits open, and a receipt changes when the client collects its token.
    refetchInterval: ({ state }) => (state.data?.status === 'pending' || state.data?.token.state === 'awaiting_exchange' ? 15_000 : false),
  });
  if (isPending) return <Skeleton />;
  if (!session?.user) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!session.user.emailVerified) return <Navigate to="/verify" replace />;
  return <QueryBoundary query={query}>{(view) => <ConsentContent view={view} />}</QueryBoundary>;
}
