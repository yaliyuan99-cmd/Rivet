import { ContextRail, LinkButton, Actions, Page, PageHeader, RailItem, RailNote, RailUnavailable, Section, Workspace } from '../../components/index.ts';
import { useUser } from '../../lib/session.tsx';

/** What a signed-in member sees on any Administration route. The API refuses them too. */
export function AdminLocked() {
  const user = useUser();
  return (
    <Page title="Administration locked">
      <PageHeader eyebrow="11 Administration" title="Administration locked" subtitle="Admin role required" status="Administration / Locked" statusTone="warning" />
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Account role">{user.role === 'admin' ? 'Admin' : 'Member'}</RailItem>
            <RailItem term="Workspace role">{user.workspace ? (user.workspace.role === 'owner' ? 'Owner' : 'Member') : 'None'}</RailItem>
            <RailNote>A workspace role never grants administration. Administrators are assigned at the account level.</RailNote>
            <RailUnavailable action="Administration" reason="Admin role required" />
          </ContextRail>
        }
      >
        <Section title="This area is for Rivet administrators">
          <p>Credential decisions, adjudication, model metadata and system checks are limited to accounts with the admin role, and every action there is audited.</p>
        </Section>
      </Workspace>
      <Actions>
        <LinkButton variant="primary" to="/">
          Return to Home
        </LinkButton>
      </Actions>
    </Page>
  );
}
