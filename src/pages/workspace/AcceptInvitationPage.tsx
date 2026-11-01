import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { InvitationView } from '../../../shared/types/workspace.ts';
import { Actions, ActionsBelow, Alert, AnchorButton, Button, ContextRail, DisabledAction, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';
import { forgetInvitation, rememberInvitation } from './pendingInvitation.ts';
import './workspace.css';

const STATE_STATUS: Record<InvitationView['state'], string> = {
  valid: 'Invitation pending',
  expired: 'Invitation expired',
  revoked: 'Invitation revoked',
  accepted: 'Invitation already used',
};

function InvitationContent({ token, invitation }: { token: string; invitation: InvitationView }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const { data: session } = useSession();
  const path = `/invitations/${token}`;
  const { viewer, state } = invitation;
  const roleName = invitation.role === 'owner' ? 'Owner' : 'Member';

  const accept = useApiMutation(() => api.post(`/api/invitations/${token}/accept`), {
    onSuccess: async () => {
      await client.invalidateQueries();
      toast.success(`You joined ${invitation.workspaceName}`, `${invitation.workspaceName} is now your active workspace.`);
      navigate('/workspace', { replace: true });
    },
    onError: () => void client.invalidateQueries({ queryKey: [`/api/invitations/${token}`] }),
  });
  const signOut = useApiMutation(() => api.post('/api/auth/signout'), {
    onSuccess: async () => {
      await client.invalidateQueries();
    },
  });

  const reason = invitation.accept.allowed ? null : invitation.accept.reason;
  const open = state === 'valid';

  // Someone who still has to sign in or verify comes back here afterwards, by way of Home.
  const mustComeBack = open && (!viewer.signedIn || (viewer.emailMatches && !viewer.emailVerified));
  useEffect(() => {
    if (mustComeBack) rememberInvitation(path);
    else forgetInvitation();
  }, [mustComeBack, path]);

  return (
    <Page title={`Join ${invitation.workspaceName}`}>
      <PageHeader
        eyebrow="05 Workspace"
        title={`Join ${invitation.workspaceName}.`}
        subtitle={`${invitation.invitedBy} invited ${invitation.email} as ${invitation.role === 'owner' ? 'an owner' : 'a member'}.`}
        status={`${invitation.workspaceCode} / ${STATE_STATUS[state]}`}
        statusTone={open ? 'accent' : 'warning'}
      />
      {reason ? (
        <Alert tone="warning" live>
          {reason}
          {open && viewer.signedIn && !viewer.emailMatches ? ` You are signed in as ${viewer.email}.` : ''}
        </Alert>
      ) : (
        <Alert live>This invitation is for your verified address, {invitation.email}. Accept it to join.</Alert>
      )}
      {accept.formError ? <Alert tone="danger">{accept.formError}</Alert> : null}
      {signOut.formError ? <Alert tone="danger">{signOut.formError}</Alert> : null}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Workspace">{invitation.workspaceName}</RailItem>
            <RailItem term="Workspace ID">{invitation.workspaceCode}</RailItem>
            <RailItem term="Invited by">{invitation.invitedBy}</RailItem>
            <RailItem term="Workspace role">{roleName}</RailItem>
            <RailNote>Invitations are auditable and email-specific. Workspace membership does not grant administrator powers or expert domain credentials.</RailNote>
          </ContextRail>
        }
      >
        <Section title="This invitation">
          <Pairs
            items={[
              { term: 'Sent to', detail: invitation.email },
              { term: 'Access', detail: `${invitation.workspaceName} private tasks and datasets` },
              { term: state === 'expired' ? 'Expired' : 'Expires', detail: formatDateTime(invitation.expiresAt) },
            ]}
          />
        </Section>
        {open && !viewer.signedIn ? (
          <Section title="To accept">
            <p>Sign in with {invitation.email}, or create an account with that exact address and verify it. This link keeps working until it expires.</p>
          </Section>
        ) : null}
      </Workspace>
      <Actions>
        {invitation.accept.allowed ? (
          <Button variant="primary" busy={accept.isPending} busyLabel="Joining this workspace" onClick={() => accept.mutate()}>
            Accept invitation
          </Button>
        ) : !open ? (
          <LinkButton variant="primary" to="/">
            Return to Home
          </LinkButton>
        ) : !viewer.signedIn ? (
          <>
            <LinkButton variant="primary" to={`/signin?next=${encodeURIComponent(path)}`}>
              Sign in
            </LinkButton>
            <LinkButton to="/signup">Create account</LinkButton>
            {session?.features.github ? <AnchorButton href={`/api/auth/github/start?next=${encodeURIComponent(path)}`}>Continue with GitHub</AnchorButton> : null}
          </>
        ) : viewer.emailMatches ? (
          <LinkButton variant="primary" to="/verify">
            Verify your email
          </LinkButton>
        ) : (
          <Button variant="primary" busy={signOut.isPending} busyLabel="Signing out" onClick={() => signOut.mutate()}>
            Sign out to switch account
          </Button>
        )}
      </Actions>
      {open && reason && viewer.signedIn ? (
        <ActionsBelow>
          <DisabledAction reason={reason}>Accept invitation</DisabledAction>
        </ActionsBelow>
      ) : null}
    </Page>
  );
}

/** Where the one-time email link lands. Reading it changes nothing: accepting takes a deliberate click. */
export default function AcceptInvitationPage() {
  const { token = '' } = useParams();
  const session = useSession();
  // What this page says depends on who is looking, so the viewer is part of the key and nothing is reused.
  const query = useApiQuery<InvitationView>(`/api/invitations/${encodeURIComponent(token)}`, {
    key: [`/api/invitations/${token}`, session.data?.user?.id ?? 'visitor', session.data?.user?.emailVerified ?? false],
    enabled: !session.isPending,
    staleTime: 0,
    gcTime: 0,
  });
  return <QueryBoundary query={query}>{(invitation) => <InvitationContent token={token} invitation={invitation} />}</QueryBoundary>;
}
