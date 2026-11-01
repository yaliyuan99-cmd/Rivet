import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { ApplicationDto, ApplicationInput, ApplicationsResponse, UploadDto } from '../../../shared/types/expert.ts';
import { Actions, Alert, Button, Checkbox, FieldFile, FieldInput, FieldSelect, FieldTextarea, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { formatSize } from '../../lib/format.ts';
import { useApiMutation } from '../../lib/query.ts';
import { keepEnterFromSubmitting } from './shared.tsx';

const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp';
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * The reviewer application's fields, used for a new application, a saved draft and an application
 * an admin sent back. Files upload as soon as they are chosen, so the draft only ever points at real bytes.
 */
export function ApplicationForm({
  application,
  data,
  header,
  before,
  rail,
  submitLabel,
  saveLabel,
  savedTitle,
  extraActions,
  onSubmitted,
}: {
  application: ApplicationDto | null;
  data: ApplicationsResponse;
  /** Receives the chosen domain's name, which the frame's subtitle states. */
  header: (domainName: string, code: string | null) => ReactNode;
  before?: ReactNode;
  rail: ReactNode;
  submitLabel: string;
  saveLabel: string;
  savedTitle: string;
  extraActions?: ReactNode;
  onSubmitted: (application: ApplicationDto) => void;
}) {
  const toast = useToast();
  const domainLocked = application?.status === 'more_evidence';
  const firstAvailable = data.domains.find((domain) => domain.available)?.id ?? data.domains[0]?.id ?? '';
  const [code, setCode] = useState<string | null>(application?.code ?? null);
  const [domainId, setDomainId] = useState(application?.domain.id ?? firstAvailable);
  const [legalName, setLegalName] = useState(application?.legalName || data.defaults.legalName);
  const [institutionalEmail, setInstitutionalEmail] = useState(application?.institutionalEmail || data.defaults.institutionalEmail);
  const [researchBackground, setResearchBackground] = useState(application?.researchBackground ?? '');
  const [researchProfileUrl, setResearchProfileUrl] = useState(application?.researchProfileUrl ?? '');
  const [commitmentAck, setCommitmentAck] = useState(application?.commitmentAck ?? false);
  const [evidence, setEvidence] = useState<UploadDto | null>(application?.evidence ?? null);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // Remounting the input lets someone pick the same file again after a failed upload.
  const [fileAttempt, setFileAttempt] = useState(0);

  const domainName = useMemo(() => data.domains.find((domain) => domain.id === domainId)?.name ?? '', [data.domains, domainId]);

  const body = (): ApplicationInput => ({ legalName, institutionalEmail, domainId, researchBackground, evidenceUploadId: evidence?.id ?? null, researchProfileUrl, commitmentAck });
  const write = async (): Promise<ApplicationDto> => {
    const saved = code ? await api.put<ApplicationDto>(`/api/applications/${code}`, body()) : await api.post<ApplicationDto>('/api/applications', body());
    setCode(saved.code);
    return saved;
  };

  const upload = useApiMutation(
    (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload<UploadDto>('/api/uploads', form);
    },
    {
      onSuccess: (saved) => {
        setEvidence(saved);
        setPendingFile(null);
      },
      onError: (error) => {
        setPendingFile(null);
        setFileError(error.fields.file ?? error.message);
        setFileAttempt((attempt) => attempt + 1);
      },
    },
  );

  const chooseFile = (file: File | null) => {
    if (!file) return;
    setFileError(null);
    if (file.size > MAX_BYTES) {
      setFileError('This file is larger than the 10 MB limit for credential evidence. Upload a smaller PDF or image.');
      setFileAttempt((attempt) => attempt + 1);
      return;
    }
    setPendingFile(file.name);
    upload.mutate(file);
  };

  const save = useApiMutation(write, {
    invalidate: ['/api/applications'],
    onSuccess: () => toast.success(savedTitle, 'Your application is saved. Nothing has been sent to an admin.'),
  });
  const submit = useApiMutation(
    async () => {
      const saved = await write();
      return api.post<ApplicationDto>(`/api/applications/${saved.code}/submit`);
    },
    {
      invalidate: ['/api/applications', '/api/reviews', ['session']],
      onSuccess: (submitted) => {
        toast.success(`Application ${submitted.code} submitted`, 'An admin will inspect the credential evidence.');
        onSubmitted(submitted);
      },
    },
  );

  const errors = { ...save.fieldErrors, ...submit.fieldErrors };
  const formError = submit.formError ?? save.formError;
  const shownCode = application?.hasCode ? application.code : null;

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit.mutate();
      }}
      onKeyDown={keepEnterFromSubmitting}
      noValidate
      style={{ display: 'contents' }}
    >
      {header(domainName, shownCode)}
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <Workspace rail={rail}>
        {before}
        <Section title="Your domain expertise" kind="form">
          <FieldInput label="Legal name" value={legalName} onChange={setLegalName} autoComplete="name" required error={errors.legalName} />
          <FieldInput label="Institutional email" type="email" value={institutionalEmail} onChange={setInstitutionalEmail} autoComplete="email" required error={errors.institutionalEmail} />
          <FieldSelect
            label="Domain requested"
            value={domainId}
            onChange={setDomainId}
            disabled={domainLocked}
            error={errors.domainId}
            hint={domainLocked ? 'The requested domain cannot change after submission.' : undefined}
            options={data.domains.map((domain) => ({
              value: domain.id,
              label: `${domain.name} / ${domain.field}${domain.available || domain.id === application?.domain.id ? '' : ` · ${domain.reason}`}`,
              disabled: !domain.available && domain.id !== application?.domain.id,
            }))}
          />
          <FieldTextarea label="Research background" value={researchBackground} onChange={setResearchBackground} rows={2} required error={errors.researchBackground} />
          <FieldFile
            key={fileAttempt}
            label="Credential evidence"
            accept={ACCEPT}
            fileName={pendingFile ?? evidence?.filename ?? null}
            meta={pendingFile ? 'Uploading…' : evidence ? `${formatSize(evidence.size)} · Uploaded` : undefined}
            onFile={chooseFile}
            error={fileError ?? errors.evidenceUploadId}
            hint="PDF, PNG, JPEG or WebP, up to 10 MB. Only you and Rivet admins can open it."
          />
          <FieldInput label="Research profile" value={researchProfileUrl} onChange={setResearchProfileUrl} autoComplete="url" required error={errors.researchProfileUrl} />
        </Section>
        <Section title="Independent review commitment">
          <Checkbox checked={commitmentAck} onChange={setCommitmentAck} error={errors.commitmentAck}>
            I will declare conflicts and never review my own tasks.
          </Checkbox>
        </Section>
      </Workspace>
      <Actions>
        <Button type="submit" variant="primary" busy={submit.isPending} busyLabel="Submitting your application" disabled={upload.isPending}>
          {submitLabel}
        </Button>
        <Button busy={save.isPending} busyLabel="Saving your application" disabled={upload.isPending} onClick={() => save.mutate()}>
          {saveLabel}
        </Button>
        {extraActions}
      </Actions>
    </form>
  );
}
