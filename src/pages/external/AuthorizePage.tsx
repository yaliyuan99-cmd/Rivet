import { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { OAuthRequestCreated, OAuthRequestInput } from '../../../shared/types/external.ts';
import { Actions, Alert, AnchorButton, ContextRail, LinkButton, Page, PageHeader, RailItem, RailNote, Section, Skeleton, Workspace } from '../../components/index.ts';
import { ApiError, api } from '../../lib/api.ts';
import { useSession } from '../../lib/session.tsx';

const inflight = new Map<string, Promise<OAuthRequestCreated>>();

/** React runs effects twice in development; the same query string must still make one request. */
function submitOnce(search: string, input: OAuthRequestInput): Promise<OAuthRequestCreated> {
  const running = inflight.get(search);
  if (running) return running;
  const started = api.post<OAuthRequestCreated>('/api/oauth/requests', input).finally(() => inflight.delete(search));
  inflight.set(search, started);
  return started;
}

function Refused({ error }: { error: Error }) {
  const refused = error instanceof ApiError ? error : null;
  const code = refused?.code ?? 'request_failed';
  const returnTo = refused?.fields.returnTo;
  const neverRedirect = code === 'invalid_client' || code === 'invalid_redirect_uri';
  return (
    <Page title="This connection cannot continue">
      <PageHeader eyebrow="08 External access" title="This connection cannot continue" subtitle="Rivet stopped before showing a consent screen." status={`Authorization error / ${code.replace(/_/g, ' ')}`} statusTone="danger" />
      <Alert tone="danger">{error.message}</Alert>
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Granted scopes">None</RailItem>
            <RailItem term="Access token">Not issued</RailItem>
            <RailItem term="Redirect">{neverRedirect ? 'Refused' : 'Registered address only'}</RailItem>
            <RailNote>Rivet only ever sends people back to an address registered for the client.</RailNote>
          </ContextRail>
        }
      >
        <Section title="No access was granted">
          <p>
            {neverRedirect
              ? 'This request does not match a registered client and redirect address, so Rivet will not send you anywhere. If you did not expect this page, close it.'
              : 'The client asked for something Rivet cannot grant. You can return to the client, which will receive this error, and start again.'}
          </p>
        </Section>
      </Workspace>
      <Actions>
        <LinkButton variant="primary" to="/">
          Return to Rivet
        </LinkButton>
        {returnTo && !neverRedirect ? <AnchorButton href={returnTo}>Return to the client</AnchorButton> : null}
      </Actions>
    </Page>
  );
}

/** /oauth/authorize: sign in if needed, then turn the query string into a consent request. */
export default function AuthorizePage() {
  const { data: session, isPending, isError } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [failure, setFailure] = useState<Error | null>(null);
  const ready = Boolean(session?.user?.emailVerified);

  const input = useMemo<OAuthRequestInput>(
    () => ({
      response_type: params.get('response_type') ?? undefined,
      client_id: params.get('client_id') ?? undefined,
      redirect_uri: params.get('redirect_uri') ?? undefined,
      scope: params.get('scope') ?? undefined,
      resource: params.get('resource') ?? undefined,
      state: params.get('state') ?? undefined,
      code_challenge: params.get('code_challenge') ?? undefined,
      code_challenge_method: params.get('code_challenge_method') ?? undefined,
    }),
    [params],
  );

  useEffect(() => {
    if (!ready) return;
    let active = true;
    submitOnce(location.search, input)
      .then((created) => {
        if (active) navigate(`/oauth/consent/${created.code}`, { replace: true });
      })
      .catch((error: unknown) => {
        if (active) setFailure(error instanceof Error ? error : new Error('The request could not be completed.'));
      });
    return () => {
      active = false;
    };
  }, [ready, location.search, input, navigate]);

  if (isError) return <Refused error={new Error('Rivet could not reach the server. Reload the page to try again.')} />;
  if (isPending) return <Skeleton />;
  if (!session?.user) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!session.user.emailVerified) return <Navigate to="/verify" replace />;
  if (failure) return <Refused error={failure} />;
  return <Skeleton />;
}
