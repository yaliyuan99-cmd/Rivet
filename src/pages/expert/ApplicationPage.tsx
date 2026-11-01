import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { ApplicationDto, ApplicationsResponse } from '../../../shared/types/expert.ts';
import { Actions, ActionsBelow, Alert, Button, ContextRail, DisabledAction, LinkButton, Modal, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime, formatSize } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { ApplicationForm } from './ApplicationForm.tsx';
import { APPLICATION_STATUS, EYEBROW } from './shared.tsx';
import './expert.css';

const lockedReason = (application: ApplicationDto) => `Verified ${application.domain.name} credential required`;

function ApplicationRail({ application }: { application: ApplicationDto }) {
  const open = application.status === 'pending' || application.status === 'more_evidence';
  return (
    <ContextRail>
      <RailItem term="Applicant">{application.legalName}</RailItem>
      <RailItem term="Requested domain">{application.domain.name}</RailItem>
      <RailItem term="Application">{application.code}</RailItem>
      <RailItem term="Evidence">{application.isSynthetic ? 'Synthetic PhD and publication fixtures' : (application.evidence?.filename ?? 'None uploaded')}</RailItem>
      <RailNote>Expert access is domain-specific. A workspace role never grants review credentials.</RailNote>
      {open ? <RailUnavailable action="Open review queue" reason={lockedReason(application)} /> : null}
    </ContextRail>
  );
}

function ViewApplicationModal({ application, open, onClose }: { application: ApplicationDto; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={`Application ${application.code}`} size="wide" actions={<Button onClick={onClose}>Close</Button>}>
      <div className="modal-pairs">
        <Pairs
          items={[
            { term: 'Legal name', detail: application.legalName },
            { term: 'Institutional email', detail: application.institutionalEmail },
            { term: 'Domain requested', detail: `${application.domain.name} / ${application.domain.field}` },
            { term: 'Research background', detail: application.researchBackground },
            {
              term: 'Credential evidence',
              detail: application.evidence ? (
                <>
                  <a className="text-link" href={application.evidence.downloadUrl} download>
                    {application.evidence.filename}
                  </a>{' '}
                  · {formatSize(application.evidence.size)}
                </>
              ) : (
                'None uploaded'
              ),
            },
            { term: 'Research profile', detail: application.researchProfileUrl },
            { term: 'Independent review commitment', detail: application.commitmentAck ? 'I will declare conflicts and never review my own tasks.' : 'Not acknowledged' },
            { term: 'Submitted', detail: formatDateTime(application.submittedAt) },
          ]}
        />
      </div>
    </Modal>
  );
}

function useWithdraw(application: ApplicationDto) {
  const toast = useToast();
  const navigate = useNavigate();
  return useApiMutation(() => api.post<ApplicationDto>(`/api/applications/${application.code}/withdraw`), {
    invalidate: ['/api/applications', '/api/reviews', ['session']],
    onSuccess: () => {
      toast.success(`Application ${application.code} withdrawn`, 'You can apply again whenever you are ready.');
      navigate('/review/apply');
    },
  });
}

function WithdrawModal({ application, open, onClose }: { application: ApplicationDto; open: boolean; onClose: () => void }) {
  const withdraw = useWithdraw(application);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Withdraw ${application.code}?`}
      actions={
        <>
          <Button variant="danger" busy={withdraw.isPending} busyLabel="Withdrawing your application" onClick={() => withdraw.mutate()}>
            Withdraw application
          </Button>
          <Button onClick={onClose}>Keep application</Button>
        </>
      }
    >
      <p>This takes your application out of the admin queue. Member access is unchanged, and you can apply again later.</p>
      {withdraw.formError ? (
        <p className="field-message" data-tone="danger" role="alert">
          {withdraw.formError}
        </p>
      ) : null}
    </Modal>
  );
}

function OtherApplications({ items, current }: { items: ApplicationDto[]; current: string }) {
  const others = items.filter((item) => item.code !== current && item.hasCode);
  if (others.length === 0) return null;
  return (
    <Section title="Your other applications">
      <Pairs
        items={others.map((item) => ({
          key: item.code,
          term: `${item.code} · ${item.domain.name}`,
          detail: (
            <Link className="quiet-link" to={`/review/application?code=${item.code}`}>
              {APPLICATION_STATUS[item.status].label} →
            </Link>
          ),
        }))}
      />
    </Section>
  );
}

/** The pending frame, and the same layout for the outcomes that follow it. */
function ApplicationStatusView({ application, items }: { application: ApplicationDto; items: ApplicationDto[] }) {
  const [viewing, setViewing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const { status, code, domain } = application;
  const subtitle = `${code} · ${application.legalName} · ${domain.name}`;
  const pending = status === 'pending';

  const copy = {
    pending: { title: 'Your application is in review', status: `Application pending / ${code}`, tone: 'accent' as const },
    verified: { title: 'Your credential is verified', status: `Application verified / ${code}`, tone: 'accent' as const },
    declined: { title: 'Your application was declined', status: `Application declined / ${code}`, tone: 'danger' as const },
    withdrawn: { title: 'You withdrew this application', status: `Application withdrawn / ${code}`, tone: 'warning' as const },
  }[status as 'pending' | 'verified' | 'declined' | 'withdrawn'];

  return (
    <Page title={copy.title}>
      <PageHeader eyebrow={EYEBROW} title={copy.title} subtitle={subtitle} status={copy.status} statusTone={copy.tone} />
      {pending ? <Alert live>Submitted {formatDateTime(application.submittedAt)}. Member access is unchanged; expert privileges remain locked.</Alert> : null}
      {status === 'verified' && application.approvedDomain ? (
        <Alert live>
          Verified {formatDateTime(application.decidedAt)}{application.decidedByName ? ` by ${application.decidedByName}` : ''}. You can now review {application.approvedDomain.name} tasks.
        </Alert>
      ) : null}
      {status === 'verified' && !application.approvedDomain ? <Alert tone="warning">This credential has since been revoked, so review access is locked. You can apply again.</Alert> : null}
      {status === 'declined' ? (
        <Alert tone="warning" live>
          Declined {formatDateTime(application.decidedAt)}{application.decidedByName ? ` by ${application.decidedByName}` : ''}: “{application.adminNote}”
        </Alert>
      ) : null}
      {status === 'withdrawn' ? <Alert tone="neutral">You withdrew this application. It left the admin queue, and member access is unchanged.</Alert> : null}
      <Workspace rail={<ApplicationRail application={application} />}>
        <Section title="Application timeline">
          <Pairs items={application.timeline.map((item) => ({ term: item.term, detail: item.detail }))} />
        </Section>
        {pending ? (
          <Section title="What happens next">
            <p>An admin will inspect the credential evidence and record a domain-specific decision. If more evidence is needed, you will be notified. Typical response: two working days.</p>
          </Section>
        ) : null}
        <OtherApplications items={items} current={code} />
      </Workspace>
      <Actions>
        {status === 'verified' && application.approvedDomain ? (
          <LinkButton variant="primary" to="/review">
            Open review queue
          </LinkButton>
        ) : null}
        {status === 'declined' || status === 'withdrawn' || (status === 'verified' && !application.approvedDomain) ? (
          <LinkButton variant="primary" to="/review/apply">
            Apply again
          </LinkButton>
        ) : null}
        <Button variant={pending ? 'primary' : 'secondary'} onClick={() => setViewing(true)}>
          View application
        </Button>
        {pending ? <Button onClick={() => setWithdrawing(true)}>Withdraw application</Button> : null}
      </Actions>
      {pending ? (
        <ActionsBelow>
          <DisabledAction reason={lockedReason(application)}>Open review queue</DisabledAction>
        </ActionsBelow>
      ) : null}
      <ViewApplicationModal application={application} open={viewing} onClose={() => setViewing(false)} />
      {pending ? <WithdrawModal application={application} open={withdrawing} onClose={() => setWithdrawing(false)} /> : null}
    </Page>
  );
}

/** An admin asked for more: their note, then the same form, then resubmission. */
function MoreEvidenceView({ application, data }: { application: ApplicationDto; data: ApplicationsResponse }) {
  const [withdrawing, setWithdrawing] = useState(false);
  const navigate = useNavigate();
  return (
    <Page title="More evidence requested">
      <ApplicationForm
        application={application}
        data={data}
        submitLabel="Resubmit application"
        saveLabel="Save changes"
        savedTitle="Changes saved"
        rail={<ApplicationRail application={application} />}
        header={() => (
          <>
            <PageHeader eyebrow={EYEBROW} title="An admin needs more evidence" subtitle={`${application.code} · ${application.legalName} · ${application.domain.name}`} status={`More evidence requested / ${application.code}`} statusTone="warning" />
            <Alert tone="warning" live>
              An admin asked for more evidence: “{application.adminNote}”
            </Alert>
          </>
        )}
        before={
          <Section title="Application timeline">
            <Pairs items={application.timeline.map((item) => ({ term: item.term, detail: item.detail }))} />
          </Section>
        }
        extraActions={<Button onClick={() => setWithdrawing(true)}>Withdraw application</Button>}
        onSubmitted={(submitted) => navigate(`/review/application?code=${submitted.code}`, { replace: true })}
      />
      <WithdrawModal application={application} open={withdrawing} onClose={() => setWithdrawing(false)} />
    </Page>
  );
}

export default function ApplicationPage() {
  const [params] = useSearchParams();
  const code = params.get('code');
  const query = useApiQuery<ApplicationsResponse>('/api/applications', {
    // A decision arrives from an admin; notice it without a reload.
    refetchInterval: (state) => (state.state.data?.items.some((item) => item.status === 'pending') ? 15_000 : false),
  });
  return (
    <QueryBoundary query={query}>
      {(data) => {
        const application = code ? data.items.find((item) => item.code === code) : data.active;
        if (!application || application.status === 'draft') return <Navigate to="/review/apply" replace />;
        if (application.status === 'more_evidence') return <MoreEvidenceView key={application.code} application={application} data={data} />;
        return <ApplicationStatusView key={application.code} application={application} items={data.items} />;
      }}
    </QueryBoundary>
  );
}
