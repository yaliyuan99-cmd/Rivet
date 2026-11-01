import { Link, useNavigate } from 'react-router-dom';
import type { ApplicationsResponse } from '../../../shared/types/expert.ts';
import { Alert, ContextRail, Page, PageHeader, QueryBoundary, RailItem, RailNote, Section, Workspace, LinkButton, Actions } from '../../components/index.ts';
import { useApiQuery } from '../../lib/query.ts';
import { useDemo } from '../../lib/session.tsx';
import { ApplicationForm } from './ApplicationForm.tsx';
import { EYEBROW } from './shared.tsx';
import './expert.css';

function ApplyRail() {
  const demo = useDemo();
  return (
    <ContextRail>
      <RailItem term="Identity evidence">Required</RailItem>
      <RailItem term="Domain evidence">Admin verification required</RailItem>
      <RailItem term="Review scope">Verified domains only</RailItem>
      <RailItem term="Final decisions">Admin adjudication</RailItem>
      <RailNote>{demo ? 'Synthetic application: names, institution and credential documents are demo fixtures, not real credential claims.' : 'Only you and Rivet admins can open your credential documents.'}</RailNote>
    </ContextRail>
  );
}

function ApplyContent({ data }: { data: ApplicationsResponse }) {
  const navigate = useNavigate();
  const canStart = data.draft !== null || data.domains.some((domain) => domain.available);

  if (!canStart) {
    return (
      <Page title="Apply to review">
        <PageHeader eyebrow={EYEBROW} title="Bring your expertise to the evidence." subtitle="Credentials are verified by an admin." status="Reviewer application / None available" />
        <Alert tone="neutral">You already hold a credential or have an open application in every domain.</Alert>
        <Workspace rail={<ApplyRail />}>
          <Section title="Your applications">
            <p>
              <Link className="text-link" to="/review/application">
                Open your application →
              </Link>
            </p>
          </Section>
        </Workspace>
        <Actions>
          <LinkButton variant="primary" to="/review">
            Open review queue
          </LinkButton>
        </Actions>
      </Page>
    );
  }

  return (
    <Page title="Apply to review">
      <ApplicationForm
        application={data.draft}
        data={data}
        submitLabel="Submit application"
        saveLabel="Save draft"
        savedTitle="Draft saved"
        rail={<ApplyRail />}
        header={(domainName) => (
          <PageHeader
            eyebrow={EYEBROW}
            title="Bring your expertise to the evidence."
            subtitle={`Apply to review ${domainName} evaluations. Credentials are verified by an admin.`}
            status={`Reviewer application / ${data.draft ? 'Draft' : 'New'}`}
          />
        )}
        onSubmitted={(application) => navigate(`/review/application?code=${application.code}`)}
      />
    </Page>
  );
}

export default function ApplyPage() {
  const query = useApiQuery<ApplicationsResponse>('/api/applications');
  return <QueryBoundary query={query}>{(data) => <ApplyContent data={data} />}</QueryBoundary>;
}
