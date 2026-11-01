import { useState, type FormEvent } from 'react';
import type { OAuthClientInfo } from '../../../shared/types/external.ts';
import { Actions, Alert, AnchorButton, Button, ContextRail, DisabledAction, FieldInput, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, Section, Workspace } from '../../components/index.ts';
import { useApiQuery } from '../../lib/query.ts';
import { ATLAS_CLIENT_ID, ATLAS_SCOPES, createAttempt, savePending, webCryptoAvailable } from './client.ts';

function AtlasContent({ client }: { client: OAuthClientInfo }) {
  const [taskCode, setTaskCode] = useState('BIO-042');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const secure = webCryptoAvailable();
  const registeredOrigin = new URL(client.redirectUri).origin;
  const sameOrigin = registeredOrigin === window.location.origin;
  const short = client.name.split(' ')[0] ?? client.name;

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    const code = taskCode.trim().toUpperCase();
    if (!code) {
      setFieldError('Enter a task code to continue.');
      return;
    }
    setFieldError(undefined);
    setFormError(null);
    setBusy(true);
    try {
      const attempt = await createAttempt();
      savePending({ state: attempt.state, verifier: attempt.verifier, taskCode: code, redirectUri: client.redirectUri });
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: ATLAS_CLIENT_ID,
        redirect_uri: client.redirectUri,
        scope: ATLAS_SCOPES,
        resource: `task:${code}`,
        state: attempt.state,
        code_challenge: attempt.challenge,
        code_challenge_method: 'S256',
      });
      window.location.assign(`/oauth/authorize?${query.toString()}`);
    } catch {
      setBusy(false);
      setFormError('This browser could not generate a PKCE challenge. Try another browser.');
    }
  };

  return (
    <Page title={client.name}>
      <PageHeader eyebrow="08 External access" title={client.name} subtitle="A demo client page, standing in for an external AI client." status={`${client.clientId} / ${client.description}`} />
      <Alert>This page stands in for an external client, so the whole OAuth flow can run on one machine. {short} is fictional. It reaches Rivet only through OAuth and the bearer API.</Alert>
      {!secure ? <Alert tone="danger">Web Crypto is not available here. Open this page on https or localhost to generate a PKCE challenge.</Alert> : null}
      {!sameOrigin ? (
        <Alert tone="warning">
          This client is registered on {registeredOrigin}, so Rivet will return there. Open this page at that address, or the callback will not find the state kept in this tab.
        </Alert>
      ) : null}
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <form onSubmit={(event) => void connect(event)} noValidate style={{ display: 'contents' }}>
        <Workspace
          rail={
            <ContextRail>
              <RailItem term="Client ID">{client.clientId}</RailItem>
              <RailItem term="Developer">{client.developer}</RailItem>
              <RailItem term="Registered redirect">{client.redirectUri}</RailItem>
              <RailNote>The PKCE verifier and state stay in this tab's session storage and are cleared when Rivet sends you back.</RailNote>
            </ContextRail>
          }
        >
          <Section title={`Connect ${short} to Rivet`} kind="form">
            <FieldInput label="Task code" value={taskCode} onChange={setTaskCode} autoComplete="off" spellCheck={false} required error={fieldError} hint={`${short} asks for access to one frozen task, nothing else.`} />
          </Section>
          <Section title={`What ${short} will send`}>
            <Pairs
              items={[
                { term: 'Scopes', detail: client.scopes.join(' · ') },
                { term: 'PKCE', detail: 'A new verifier and S256 challenge, generated in this browser for this attempt.' },
                { term: 'State', detail: 'A new random value, checked again when Rivet sends you back.' },
                { term: 'Next', detail: 'Rivet asks you to sign in if needed, then shows exactly what is being requested. Nothing is granted until you approve it.' },
              ]}
            />
          </Section>
        </Workspace>
        <Actions>
          {secure ? (
            <Button type="submit" variant="primary" busy={busy} busyLabel="Preparing the request">
              Connect to Rivet
            </Button>
          ) : (
            <DisabledAction reason="Web Crypto needs https or localhost">Connect to Rivet</DisabledAction>
          )}
          {sameOrigin ? null : <AnchorButton href={`${registeredOrigin}/atlas-demo`}>Open at the registered address</AnchorButton>}
          <LinkButton to="/">Return to Rivet</LinkButton>
        </Actions>
      </form>
    </Page>
  );
}

export default function AtlasDemoPage() {
  const query = useApiQuery<OAuthClientInfo>(`/api/oauth/clients/${ATLAS_CLIENT_ID}`);
  return <QueryBoundary query={query}>{(client) => <AtlasContent client={client} />}</QueryBoundary>;
}
