import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useDemo } from '../../lib/session.tsx';
import type { ConnectionRow, ProfileData, ProviderId } from '../../../shared/types/workspace.ts';
import { Actions, ActionsBelow, Alert, Button, ContextRail, DisabledAction, EmptyState, FieldInput, FieldStatic, FieldTextarea, LinkButton, Modal, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDate, formatDateTime, formatTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { InlineButton, InlineDisabled } from './inline.tsx';

const PROFILE_PATH = '/api/profile';

const CONNECTION_ERRORS: Record<string, (label: string) => string> = {
  state: (label) => `This ${label} connection attempt expired or was started in another browser. Nothing was connected. Start again from this page.`,
  denied: (label) => `${label} did not grant access, so nothing was connected.`,
  taken: (label) => `This ${label} account is already connected to another Rivet account, so it was not connected here.`,
  unavailable: (label) => `${label} could not be reached, or it refused the connection. Nothing was connected. Try again in a moment.`,
  not_configured: (label) => `${label} connection is not configured on this server.`,
};

const PROVIDER_LABELS: Record<ProviderId, string> = { github: 'GitHub', linkedin: 'LinkedIn', huggingface: 'Hugging Face' };
const isProvider = (value: string | null): value is ProviderId => value === 'github' || value === 'linkedin' || value === 'huggingface';

/** Reads the outcome the OAuth callback redirected with, keeps it on screen and tidies the address bar. */
function useConnectionOutcome() {
  const [params, setParams] = useSearchParams();
  const [outcome] = useState(() => {
    const provider = params.get('provider') ?? params.get('connected');
    const label = isProvider(provider) ? PROVIDER_LABELS[provider] : 'That provider';
    if (params.get('connection_error')) return { tone: 'danger' as const, text: (CONNECTION_ERRORS[params.get('connection_error') as string] ?? CONNECTION_ERRORS.unavailable)(label) };
    if (params.get('connected')) return { tone: 'accent' as const, text: `${label} is connected. This does not grant private-content access or verified reviewer credentials.` };
    return null;
  });
  const cleaned = useRef(false);
  useEffect(() => {
    if (cleaned.current || !outcome) return;
    cleaned.current = true;
    setParams({}, { replace: true });
  }, [outcome, setParams]);
  return outcome;
}

/** The time alone when it falls today, as the frame prints it; the date too when it does not. */
function expiryText(expiresAt: string, serverNow: string): string {
  return expiresAt.slice(0, 10) === serverNow.slice(0, 10) ? formatTime(expiresAt) : formatDateTime(expiresAt);
}

function ProfileContent({ data }: { data: ProfileData }) {
  const demo = useDemo();
  const toast = useToast();
  const outcome = useConnectionOutcome();
  const [name, setName] = useState(data.name);
  const [bio, setBio] = useState(data.bio);
  const [disconnecting, setDisconnecting] = useState<ConnectionRow | null>(null);

  const save = useApiMutation(() => api.patch<{ name: string; bio: string }>(PROFILE_PATH, { name, bio }), {
    invalidate: [PROFILE_PATH, ['session']],
    onSuccess: (saved) => {
      setName(saved.name);
      setBio(saved.bio);
      toast.success('Profile saved');
    },
  });
  const disconnect = useApiMutation((provider: ProviderId) => api.post(`/api/profile/connections/${provider}/disconnect`), {
    invalidate: [PROFILE_PATH],
    onSuccess: (_result, provider) => {
      setDisconnecting(null);
      toast.success(`${PROVIDER_LABELS[provider]} disconnected`);
    },
    onError: () => setDisconnecting(null),
  });
  const revoke = useApiMutation((tokenId: string) => api.post(`/api/oauth/connections/${encodeURIComponent(tokenId)}/revoke`), {
    invalidate: [PROFILE_PATH],
    onSuccess: () => toast.success('Access revoked', 'This client can no longer use its token.'),
  });

  const accountRole = data.accountRole === 'admin' ? 'Admin' : 'Member';
  const workspaceRole = data.workspace?.role === 'owner' ? 'Owner' : data.workspace ? 'Member' : 'None';
  const statusRole = data.workspace ? (data.workspace.role === 'owner' ? ' / Workspace owner' : ' / Workspace member') : '';

  return (
    <Page title="Profile">
      <PageHeader
        eyebrow="09 Discovery and profile"
        title="Your identity, connected."
        subtitle={`${data.name} · ${accountRole} · ${data.workspace?.name ?? 'No workspace'}`}
        status={`${data.name} / ${accountRole}${statusRole}`}
      />
      {outcome ? (
        <Alert tone={outcome.tone} live>
          {outcome.text}
        </Alert>
      ) : null}
      {save.formError ? <Alert tone="danger">{save.formError}</Alert> : null}
      {disconnect.formError ? <Alert tone="danger">{disconnect.formError}</Alert> : null}
      {revoke.formError ? <Alert tone="danger">{revoke.formError}</Alert> : null}
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          save.mutate();
        }}
        noValidate
        style={{ display: 'contents' }}
      >
        <Workspace
          rail={
            <ContextRail>
              <RailItem term="Workspace">{data.workspace?.name ?? 'None'}</RailItem>
              <RailItem term="Workspace role">{workspaceRole}</RailItem>
              <RailItem term="Domain credentials">{data.credentials.length ? data.credentials.map((credential) => credential.domainName).join(' · ') : 'None'}</RailItem>
              <RailItem term="Account role">{accountRole}</RailItem>
              <RailNote>GitHub, LinkedIn and Hugging Face identity connections do not grant private-content access or verified reviewer credentials.</RailNote>
              {data.reviewBiology.allowed ? null : <RailUnavailable action="Review Biology tasks" reason={data.reviewBiology.reason} />}
            </ContextRail>
          }
        >
          <Section title="Research identity" kind="form">
            <FieldInput label="Display name" value={name} onChange={setName} autoComplete="name" required maxLength={120} error={save.fieldErrors.name} />
            <FieldStatic label="Email">
              {data.email} · {data.emailVerified ? 'Verified' : 'Not verified'}
            </FieldStatic>
            <FieldTextarea label="Bio" value={bio} onChange={setBio} maxLength={1000} error={save.fieldErrors.bio} />
          </Section>
          <Section title="Connected profiles">
            <Pairs
              items={data.connections.map((connection) => ({
                key: connection.provider,
                term: connection.connected ? (
                  <>
                    {connection.label} /{' '}
                    {connection.profileUrl ? (
                      <a className="quiet-link" href={connection.profileUrl} rel="noreferrer">
                        {connection.handle}
                      </a>
                    ) : (
                      connection.handle
                    )}
                  </>
                ) : (
                  connection.label
                ),
                detail: connection.connected ? (
                  <>
                    Connected · {connection.visibilityNote} ·{' '}
                    <InlineButton label={`Disconnect ${connection.label}`} onClick={() => setDisconnecting(connection)}>
                      Disconnect
                    </InlineButton>
                  </>
                ) : connection.connect.allowed ? (
                  <>
                    Not connected ·{' '}
                    <a className="text-link" href={connection.connectHref ?? undefined}>
                      Connect {connection.label} →
                    </a>
                  </>
                ) : (
                  <>
                    Not connected · <InlineDisabled reason={connection.connect.reason} showReason>Connect {connection.label}</InlineDisabled>
                  </>
                ),
              }))}
            />
          </Section>
          <Section title="Authorized AI clients">
            {data.aiClients.length ? (
              <Pairs
                items={data.aiClients.map((client) => ({
                  key: client.id,
                  term: client.clientName,
                  detail: (
                    <>
                      {client.resource} · {client.access} · Expires {expiryText(client.expiresAt, data.serverNow)} ·{' '}
                      <InlineButton label={`Revoke ${client.clientName}`} busy={revoke.isPending && revoke.variables === client.id} onClick={() => revoke.mutate(client.id)}>
                        Revoke
                      </InlineButton>
                    </>
                  ),
                }))}
              />
            ) : (
              <EmptyState
                action={
                  demo ? (
                    <Link className="text-link" to="/atlas-demo">
                      Connect the demo client →
                    </Link>
                  ) : undefined
                }
              >
                No AI clients are authorized on your account. A client appears here after you approve its access.
              </EmptyState>
            )}
          </Section>
        </Workspace>
        <Actions>
          <Button type="submit" variant="primary" busy={save.isPending} busyLabel="Saving your profile">
            Save profile
          </Button>
          <LinkButton to="/review/apply">Apply to review</LinkButton>
        </Actions>
        <ActionsBelow>
          {data.reviewBiology.allowed ? <LinkButton to="/review">Review Biology tasks</LinkButton> : <DisabledAction reason={data.reviewBiology.reason}>Review Biology tasks</DisabledAction>}
        </ActionsBelow>
      </form>
      <Modal
        open={Boolean(disconnecting)}
        onClose={() => setDisconnecting(null)}
        title={`Disconnect ${disconnecting?.label ?? 'this profile'}?`}
        actions={
          <>
            <Button variant="danger" busy={disconnect.isPending} busyLabel="Disconnecting" onClick={() => disconnecting && disconnect.mutate(disconnecting.provider)}>
              Disconnect
            </Button>
            <Button onClick={() => setDisconnecting(null)}>Cancel</Button>
          </>
        }
      >
        <p>
          {disconnecting?.connect.allowed
            ? `${disconnecting.handle} will no longer appear on your profile. You can connect again from this page.`
            : `${disconnecting?.handle} will no longer appear on your profile. ${disconnecting?.label} is not configured on this server, so you cannot connect again until it is.`}
        </p>
      </Modal>
    </Page>
  );
}

export default function ProfilePage() {
  const query = useApiQuery<ProfileData>(PROFILE_PATH);
  return <QueryBoundary query={query}>{(data) => <ProfileContent data={data} />}</QueryBoundary>;
}
