import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { CredentialDecisionResponse, CredentialDetailResponse } from '../../../shared/types/expert.ts';
import { Actions, ActionsBelow, AdminTabs, Alert, Button, Checkbox, ContextRail, DisabledAction, FieldSelect, FieldStatic, FieldTextarea, HashMismatch, LinkButton, Modal, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useDemo } from '../../lib/session.tsx';
import { APPLICATION_STATUS, EYEBROW } from './shared.tsx';
import './expert.css';

function CredentialRail({ data, unavailable }: { data: CredentialDetailResponse; unavailable?: { action: string; reason: string } | null }) {
  const { application } = data;
  const demo = useDemo();
  return (
    <ContextRail>
      <RailItem term="Applicant">{data.applicantName}</RailItem>
      <RailItem term="Reviewer request">{application.code}</RailItem>
      <RailItem term="Certificate">
        {application.evidence ? (
          <a className="text-link" href={application.evidence.downloadUrl} download>
            {application.evidence.filename}
          </a>
        ) : (
          'None uploaded'
        )}
      </RailItem>
      <RailItem term="Admin">{data.adminName}</RailItem>
      <RailNote>{data.application.isSynthetic || demo ? 'Credential documents and affiliations are synthetic. ' : ''}Every decision is retained in the credential audit log.</RailNote>
      {unavailable ? <RailUnavailable action={unavailable.action} reason={unavailable.reason} /> : null}
    </ContextRail>
  );
}

function EvidenceSection({ data }: { data: CredentialDetailResponse }) {
  return (
    <Section title={`Credential evidence / ${data.application.code}`}>
      <Pairs
        items={data.evidenceRows.map((row) => ({
          key: row.key,
          term: row.term,
          detail:
            row.key === 'document' && data.application.evidence ? (
              <>
                <a className="text-link" href={data.application.evidence.downloadUrl} download>
                  {data.application.evidence.filename}
                </a>
                {row.detail.slice(data.application.evidence.filename.length)}
              </>
            ) : (
              row.detail
            ),
        }))}
      />
    </Section>
  );
}

function DecidedCredential({ data }: { data: CredentialDetailResponse }) {
  const { application, credential } = data;
  const status = APPLICATION_STATUS[application.status];
  return (
    <Page title="Verify a domain credential">
      <PageHeader eyebrow={EYEBROW} title="Verify a domain credential" subtitle={`${application.code} · ${data.applicantName} · ${application.domain.name}`} status={`Admin / Credential ${status.label.toLowerCase()}`} statusTone={status.tone} />
      <AdminTabs />
      <Alert tone={application.status === 'verified' ? 'accent' : 'neutral'}>
        {application.status === 'verified'
          ? `Verified ${formatDateTime(application.decidedAt)}${application.decidedByName ? ` by ${application.decidedByName}` : ''}. This decision is read-only.`
          : application.status === 'declined'
            ? `Declined ${formatDateTime(application.decidedAt)}${application.decidedByName ? ` by ${application.decidedByName}` : ''}. This decision is read-only.`
            : 'The applicant withdrew this application. There is nothing to decide.'}
      </Alert>
      {data.documentVerified === false ? <HashMismatch>The stored document differs from what the applicant uploaded. Do not rely on it.</HashMismatch> : null}
      <Workspace rail={<CredentialRail data={data} />}>
        <EvidenceSection data={data} />
        {application.status === 'withdrawn' ? null : (
          <Section title="Admin verification" kind="form">
            {credential ? <FieldStatic label="Approved domain">{credential.domainName}</FieldStatic> : null}
            <FieldStatic label="Rationale">{credential?.rationale ?? application.adminNote ?? ''}</FieldStatic>
            {credential?.revokedAt ? <p className="fine-print">Revoked {formatDateTime(credential.revokedAt)}.</p> : null}
          </Section>
        )}
        {application.status === 'verified' ? (
          <Section title="Verification basis">
            <Checkbox checked onChange={() => undefined} disabled>
              I inspected the source documents and recorded the verification rationale.
            </Checkbox>
          </Section>
        ) : null}
      </Workspace>
      <Actions>
        <LinkButton to="/admin/credentials">Back to credential queue</LinkButton>
      </Actions>
    </Page>
  );
}

function LiveCredential({ data }: { data: CredentialDetailResponse }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { application, actions } = data;
  const [domainId, setDomainId] = useState(application.domain.id);
  const [rationale, setRationale] = useState('');
  const [basisAck, setBasisAck] = useState(false);
  const [declining, setDeclining] = useState(false);
  const approvedName = data.domains.find((domain) => domain.id === domainId)?.name ?? application.domain.name;
  const invalidate = ['/api/admin/credentials', `/api/admin/credentials/${application.code}`];

  const announce = (done: CredentialDecisionResponse, title: string) => {
    if (done.mail.sent) toast.success(title, `${data.applicantName} has been emailed.`);
    else toast.warning(title, `The decision is recorded, but the email failed: ${done.mail.reason}`);
    navigate('/admin/credentials');
  };

  const verify = useApiMutation(() => api.post<CredentialDecisionResponse>(`/api/admin/credentials/${application.code}/verify`, { approvedDomainId: domainId, rationale, basisAck }), {
    invalidate,
    onSuccess: (done) => announce(done, `${approvedName} credential verified`),
  });
  const requestEvidence = useApiMutation(() => api.post<CredentialDecisionResponse>(`/api/admin/credentials/${application.code}/request-evidence`, { rationale }), {
    invalidate,
    onSuccess: (done) => announce(done, 'More evidence requested'),
  });
  const decline = useApiMutation(() => api.post<CredentialDecisionResponse>(`/api/admin/credentials/${application.code}/decline`, { rationale }), {
    invalidate,
    onSuccess: (done) => announce(done, `${application.code} declined`),
  });
  const errors = { ...verify.fieldErrors, ...requestEvidence.fieldErrors, ...decline.fieldErrors };
  const formError = verify.formError ?? requestEvidence.formError ?? decline.formError;
  const verifyLabel = `Verify ${approvedName} credential`;

  return (
    <Page title="Verify a domain credential">
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (actions.verify.allowed) verify.mutate();
        }}
        noValidate
        style={{ display: 'contents' }}
      >
        <PageHeader
          eyebrow={EYEBROW}
          title="Verify a domain credential"
          subtitle={`${application.code} · ${data.applicantName} · ${application.domain.name}`}
          status={application.status === 'more_evidence' ? 'Admin / More evidence requested' : 'Admin / Credential verification'}
          statusTone={application.status === 'more_evidence' ? 'warning' : 'accent'}
        />
        <AdminTabs />
        {application.status === 'more_evidence' ? (
          <Alert tone="warning">
            Waiting for {data.applicantName} to resubmit. You asked: “{application.adminNote}”
          </Alert>
        ) : application.adminNote ? (
          <Alert tone="neutral">Resubmitted after your request: “{application.adminNote}”</Alert>
        ) : null}
        {data.documentVerified === false ? <HashMismatch>The stored document differs from what the applicant uploaded. Do not verify from it.</HashMismatch> : null}
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        <Workspace rail={<CredentialRail data={data} unavailable={actions.verify.allowed ? null : { action: verifyLabel, reason: actions.verify.reason as string }} />}>
          <EvidenceSection data={data} />
          <Section title="Admin verification" kind="form">
            <FieldSelect label="Approved domain" value={domainId} onChange={setDomainId} error={errors.approvedDomainId} options={data.domains.map((domain) => ({ value: domain.id, label: domain.name }))} />
            <FieldTextarea label="Rationale" rows={3} value={rationale} onChange={setRationale} required error={errors.rationale} hint="Requesting more evidence or declining sends this text to the applicant." />
          </Section>
          <Section title="Verification basis">
            <Checkbox checked={basisAck} onChange={setBasisAck} error={errors.basisAck}>
              I inspected the source documents and recorded the verification rationale.
            </Checkbox>
          </Section>
        </Workspace>
        <Actions>
          {actions.verify.allowed ? (
            <Button type="submit" variant="primary" busy={verify.isPending} busyLabel="Verifying this credential">
              {verifyLabel}
            </Button>
          ) : (
            <DisabledAction reason={actions.verify.reason as string}>{verifyLabel}</DisabledAction>
          )}
          {actions.requestEvidence.allowed ? (
            <Button busy={requestEvidence.isPending} busyLabel="Requesting more evidence" onClick={() => requestEvidence.mutate()}>
              Request more evidence
            </Button>
          ) : (
            <DisabledAction reason={actions.requestEvidence.reason as string}>Request more evidence</DisabledAction>
          )}
        </Actions>
        <ActionsBelow>
          {actions.decline.allowed ? (
            <Button variant="danger" onClick={() => setDeclining(true)}>
              Decline application
            </Button>
          ) : (
            <DisabledAction reason={actions.decline.reason as string}>Decline application</DisabledAction>
          )}
        </ActionsBelow>
      </form>
      <Modal
        open={declining}
        onClose={() => setDeclining(false)}
        title={`Decline ${application.code}?`}
        actions={
          <>
            <Button variant="danger" busy={decline.isPending} busyLabel="Declining this application" onClick={() => decline.mutate(undefined, { onSettled: () => setDeclining(false) })}>
              Decline application
            </Button>
            <Button onClick={() => setDeclining(false)}>Cancel</Button>
          </>
        }
      >
        <p>{data.applicantName} will be emailed your rationale and can apply again with new evidence. No credential is created.</p>
      </Modal>
    </Page>
  );
}

export default function CredentialPage() {
  const { code = '' } = useParams();
  const query = useApiQuery<CredentialDetailResponse>(`/api/admin/credentials/${encodeURIComponent(code)}`);
  return (
    <QueryBoundary query={query}>
      {(data) => (data.application.status === 'pending' || data.application.status === 'more_evidence' ? <LiveCredential key={data.application.code} data={data} /> : <DecidedCredential data={data} />)}
    </QueryBoundary>
  );
}
