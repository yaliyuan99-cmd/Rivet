import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WorkspaceRole } from '../../../shared/types/session.ts';
import type { InvitationPreview, InvitationSent, MembersData, MemberRow, WorkspaceDetail } from '../../../shared/types/workspace.ts';
import { Actions, ActionsBelow, Alert, Button, ContextRail, DisabledAction, EmptyState, FieldInput, FieldSelect, LinkButton, Modal, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace, useToast, type Pair } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDate, formatDateTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';
import { InlineButton, InlineDisabled } from './inline.tsx';

const MEMBERS_PATH = '/api/workspaces/current';
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GRANT_REASON = 'Admin role required';

const roleName = (role: WorkspaceRole) => (role === 'owner' ? 'Owner' : 'Member');

/** Dr. Samira Patel -> Dr. Patel, as the frames write it. Anyone else keeps their whole name. */
function formalName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return /^(dr|prof)\.?$/i.test(parts[0] ?? '') && parts.length > 2 ? `${parts[0]} ${parts[parts.length - 1]}` : name;
}

/** The rail's rules, also what "View access policy" shows. */
const POLICY = [
  { term: 'Manage members', detail: 'Workspace owner only' },
  { term: 'Create private tasks', detail: 'Members' },
  { term: 'Run / Resume / Revise', detail: 'Task owner only' },
  { term: 'Expert review', detail: 'Verified domain, never own task' },
  { term: 'Credential verification', detail: 'Admin only' },
];
const POLICY_NOTE = 'Invitations are auditable and email-specific. Removing membership revokes workspace access on subsequent requests.';

function PolicyRail({ cannotInvite }: { cannotInvite?: string }) {
  return (
    <ContextRail>
      {POLICY.map((item) => (
        <RailItem key={item.term} term={item.term}>
          {item.detail}
        </RailItem>
      ))}
      <RailNote>{POLICY_NOTE}</RailNote>
      {cannotInvite ? <RailUnavailable action="Send invitation" reason={cannotInvite} /> : null}
      <RailUnavailable action="Grant Biology credential" reason={GRANT_REASON} />
    </ContextRail>
  );
}

function PolicyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Access policy" actions={<Button onClick={onClose}>Close</Button>}>
      <Pairs items={POLICY.map((item) => ({ key: item.term, term: item.term, detail: item.detail }))} />
      <p>{POLICY_NOTE}</p>
    </Modal>
  );
}

function NoWorkspace() {
  const [policyOpen, setPolicyOpen] = useState(false);
  return (
    <Page title="Workspace">
      <PageHeader eyebrow="05 Workspace" title="The people behind the evidence." subtitle="You are not in a workspace yet." status="No workspace / Member access" />
      <Workspace rail={<PolicyRail />}>
        <Section title="No workspace yet">
          <EmptyState>Create a workspace to keep tasks and datasets private, or open an invitation link you were sent to join someone else's.</EmptyState>
        </Section>
      </Workspace>
      <Actions>
        <LinkButton variant="primary" to="/workspace/new">
          Create workspace
        </LinkButton>
        <Button onClick={() => setPolicyOpen(true)}>View access policy</Button>
      </Actions>
      <ActionsBelow>
        <DisabledAction reason={GRANT_REASON}>Grant Biology credential</DisabledAction>
      </ActionsBelow>
      <PolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} />
    </Page>
  );
}

function useDebouncedEmail(email: string) {
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(email.trim().toLowerCase()), 350);
    return () => window.clearTimeout(timer);
  }, [email]);
  return settled;
}

function scopeSentence(workspace: WorkspaceDetail, typed: string, preview: InvitationPreview | undefined, role: WorkspaceRole, canManage: boolean): string {
  const access = `${workspace.name} private tasks and datasets.`;
  const ownerNote = role === 'owner' && typed ? ' As an owner they can also invite and remove members.' : '';
  if (!canManage) return `People invited here receive access to ${access} Any verified credential is independent of workspace membership.`;
  if (!typed || preview?.state === 'member' || preview?.state === 'pending') return `The person you invite will receive access to ${access} Any verified credential is independent of workspace membership.`;
  const who = preview?.name ? formalName(preview.name) : typed;
  const held = preview?.credentials ?? [];
  const credential = held.length ? `Their verified ${held.join(' and ')} credential${held.length > 1 ? 's are' : ' is'} independent of workspace membership.` : 'Any verified credential is independent of workspace membership.';
  return `${who} will receive access to ${access} ${credential}${ownerNote}`;
}

function MembersContent({ data, workspace }: { data: MembersData; workspace: WorkspaceDetail }) {
  const { data: session } = useSession();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('member');
  const [sent, setSent] = useState<InvitationSent | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [removing, setRemoving] = useState<MemberRow | null>(null);

  const canManage = data.manage.allowed;
  const reason = data.manage.allowed ? null : data.manage.reason;
  const emailDelivered = session?.features.email ?? false;

  const settledEmail = useDebouncedEmail(email);
  const typed = LOOKS_LIKE_EMAIL.test(email.trim()) ? email.trim().toLowerCase() : '';
  // POST so the address stays out of URLs and logs. A failed lookup only loses the name, not the form.
  const previewQuery = useQuery({
    queryKey: ['invitation-preview', workspace.id, settledEmail, data.invitations.length, data.members.length],
    queryFn: () => api.post<InvitationPreview>(`/api/workspaces/${workspace.id}/invitations/preview`, { email: settledEmail }),
    enabled: canManage && LOOKS_LIKE_EMAIL.test(settledEmail),
    retry: false,
    staleTime: 0,
  });
  const preview = previewQuery.data?.email === typed ? previewQuery.data : undefined;

  const send = useApiMutation(() => api.post<InvitationSent>(`/api/workspaces/${workspace.id}/invitations`, { email, role }), {
    invalidate: [MEMBERS_PATH],
    onSuccess: (invitation) => {
      setSent(invitation);
      setEmail('');
      setRole('member');
    },
  });
  const revoke = useApiMutation((invitationId: string) => api.post(`/api/workspaces/${workspace.id}/invitations/${invitationId}/revoke`), {
    invalidate: [MEMBERS_PATH],
    onSuccess: () => {
      setSent(null);
      toast.success('Invitation revoked', 'Its link no longer works.');
    },
  });
  const remove = useApiMutation((member: MemberRow) => api.post(`/api/workspaces/${workspace.id}/members/${member.userId}/remove`), {
    invalidate: [MEMBERS_PATH],
    onSuccess: (_result, member) => {
      setRemoving(null);
      toast.success(`${member.name} removed`, `Their access to ${workspace.name} ended with this change.`);
    },
    onError: () => setRemoving(null),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canManage) send.mutate();
  };

  const people = useMemo(() => {
    const items: Pair[] = data.members.map((member) => ({
      key: member.userId,
      term: member.name,
      detail: (
        <>
          {roleName(member.role)} · Active · {member.email}
          {member.remove.allowed ? (
            <>
              {' · '}
              <InlineButton tone="danger" label={`Remove ${member.name}`} onClick={() => setRemoving(member)}>
                Remove
              </InlineButton>
            </>
          ) : reason && !member.isSelf && !member.isCreator ? (
            <>
              {' · '}
              <InlineDisabled reason={reason} label={`Remove ${member.name}`}>
                Remove
              </InlineDisabled>
            </>
          ) : null}
        </>
      ),
    }));
    for (const invitation of data.invitations) {
      items.push({
        key: invitation.id,
        term: invitation.name ?? invitation.email,
        detail: (
          <>
            {roleName(invitation.role)} · {invitation.state === 'expired' ? `Invitation expired ${formatDate(invitation.expiresAt)}` : 'Invitation sent'}
            {invitation.name ? ` · ${invitation.email}` : ''}
            {invitation.state === 'sent' ? ` · Expires ${formatDate(invitation.expiresAt)}` : ''}
            {' · '}
            {invitation.revoke.allowed ? (
              <InlineButton label={`Revoke invitation to ${invitation.email}`} busy={revoke.isPending && revoke.variables === invitation.id} onClick={() => revoke.mutate(invitation.id)}>
                Revoke
              </InlineButton>
            ) : (
              <InlineDisabled reason={invitation.revoke.reason} label={`Revoke invitation to ${invitation.email}`}>
                Revoke
              </InlineDisabled>
            )}
          </>
        ),
      });
    }
    // What is typed in the form, before anything is sent. It stops being a preview once the server has it.
    if (canManage && typed && preview?.state !== 'member' && preview?.state !== 'pending') {
      items.push({ key: 'preview', term: preview?.name ?? typed, detail: `${roleName(role)} · Invitation not yet sent` });
    }
    return items;
  }, [data.members, data.invitations, canManage, typed, preview, role, reason, revoke.isPending, revoke.variables]);

  const roleLabel = data.viewerRole === 'owner' ? 'Workspace owner' : 'Workspace member';

  return (
    <Page title="Workspace">
      <PageHeader eyebrow="05 Workspace" title="The people behind the evidence." subtitle={`${workspace.name} · Workspace settings · ${workspace.ownerName}, owner`} status={`${workspace.name} / ${roleLabel}`} />
      {sent ? (
        <Alert live>
          {emailDelivered ? (
            `Invitation sent to ${sent.email}. The one-time link expires ${formatDateTime(sent.expiresAt)}.`
          ) : (
            <>
              No email provider is configured, so the one-time link for {sent.email} is waiting in the dev outbox. It expires {formatDateTime(sent.expiresAt)}.{' '}
              {session?.features.devOutbox ? (
                <Link className="text-link" to="/dev/outbox">
                  Open dev outbox
                </Link>
              ) : null}
            </>
          )}
        </Alert>
      ) : null}
      {send.formError ? <Alert tone="danger">{send.formError}</Alert> : null}
      {revoke.formError ? <Alert tone="danger">{revoke.formError}</Alert> : null}
      {remove.formError ? <Alert tone="danger">{remove.formError}</Alert> : null}
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <Workspace rail={<PolicyRail cannotInvite={reason ?? undefined} />}>
          <Section title="Add a member by email" kind="form">
            <FieldInput
              label="Email address"
              type="email"
              value={email}
              onChange={(value) => {
                setEmail(value);
                if (sent) setSent(null);
                if (send.fieldErrors.email) send.clearErrors();
              }}
              autoComplete="off"
              required
              disabled={!canManage}
              error={send.fieldErrors.email}
              hint={
                reason
                  ? reason
                  : preview?.state === 'member'
                    ? `Already a member of ${workspace.name}.`
                    : preview?.state === 'pending'
                      ? 'An invitation to this address is already pending. Revoke it to send a new one.'
                      : undefined
              }
            />
            <FieldSelect
              label="Workspace role"
              value={role}
              onChange={(value) => setRole(value as WorkspaceRole)}
              disabled={!canManage}
              options={[
                { value: 'member', label: 'Member' },
                { value: 'owner', label: 'Owner' },
              ]}
              error={send.fieldErrors.role}
            />
          </Section>
          <Section title={`People in ${workspace.name}`}>
            <Pairs items={people} />
          </Section>
          <Section title="Invitation scope">
            <p>{scopeSentence(workspace, typed, preview, role, canManage)}</p>
          </Section>
        </Workspace>
        <Actions>
          {canManage ? (
            <Button type="submit" variant="primary" busy={send.isPending} busyLabel="Sending the invitation">
              Send invitation
            </Button>
          ) : (
            <DisabledAction reason={reason ?? ''}>Send invitation</DisabledAction>
          )}
          <Button onClick={() => setPolicyOpen(true)}>View access policy</Button>
        </Actions>
        <ActionsBelow>
          <DisabledAction reason={GRANT_REASON}>Grant Biology credential</DisabledAction>
        </ActionsBelow>
      </form>
      <p>
        <Link className="text-link" to="/workspace/new">
          Create another workspace →
        </Link>
      </p>
      <PolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} />
      <Modal
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? 'this member'}?`}
        actions={
          <>
            <Button variant="danger" busy={remove.isPending} busyLabel="Removing this member" onClick={() => removing && remove.mutate(removing)}>
              Remove member
            </Button>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
          </>
        }
      >
        <p>
          {removing?.name} loses access to {workspace.name} on their next request. Their verified credentials do not change.
        </p>
      </Modal>
    </Page>
  );
}

export default function MembersPage() {
  const query = useApiQuery<MembersData>(MEMBERS_PATH);
  return <QueryBoundary query={query}>{(data) => (data.workspace ? <MembersContent key={data.workspace.id} data={data} workspace={data.workspace} /> : <NoWorkspace />)}</QueryBoundary>;
}
