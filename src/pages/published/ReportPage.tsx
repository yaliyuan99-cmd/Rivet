import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ReportResponse } from '../../../shared/types/published.ts';
import { Actions, Alert, AnchorButton, Button, ContextRail, DisabledAction, HashMismatch, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailTamper, RailUnavailable, Section, Workspace } from '../../components/index.ts';
import { copyText } from '../../lib/browser.ts';
import { formatDate, formatDateTime, hashLines } from '../../lib/format.ts';
import { useApiQuery } from '../../lib/query.ts';
import './published.css';

/** rivet.example/reports/ then RPT-BIO-042/v1.0, on two lines as the frame prints it. */
function VersionedUrl({ url }: { url: string }) {
  const shown = url.replace(/^https?:\/\//, '');
  const split = shown.indexOf('/reports/') + '/reports/'.length;
  return (
    <p className="rail-url">
      <a href={url}>
        {shown.slice(0, split)}
        <br />
        {shown.slice(split)}
      </a>
    </p>
  );
}

function ReportContent({ data }: { data: ReportResponse }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const label = `${data.code} v${data.version}`;
  const refusal = data.download.allowed ? null : (data.download.reason as string);
  const [hashFirst, hashSecond] = hashLines(data.sha256);

  const copy = async () => {
    setCopyFailed(false);
    if (await copyText(data.citationText)) setCopied(true);
    else setCopyFailed(true);
  };

  let status = `Frozen / Admin adjudicated / v${data.version}`;
  if (!data.verified) status = 'Frozen / Hash mismatch';
  else if (copied) status = 'Frozen / Citation copied ✓';

  return (
    <Page title={`${data.code} v${data.version}`}>
      <PageHeader eyebrow="04 Published evidence" title="A report you can cite." subtitle={`${data.code} · Frozen ${formatDate(data.frozenAt)} · Version ${data.version}`} status={status} statusTone={data.verified ? 'accent' : 'danger'} />
      {copied ? <Alert live>Citation copied. Versioned report URL and evidence hash are included.</Alert> : null}
      {copyFailed ? <Alert tone="danger">Your browser blocked the clipboard, so nothing was copied. Select the citation in the panel and copy it by hand.</Alert> : null}
      {!data.verified ? <HashMismatch>This report differs from its frozen manifest, or its evidence differs from its seal. Do not cite it.</HashMismatch> : null}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Owner">{data.ownerName}</RailItem>
            <RailItem term="Expert">{data.expertName}</RailItem>
            <RailItem term="Admin">
              {data.adminName} / {data.adjudicationCode}
            </RailItem>
            {copied ? <RailItem term="Version">{label}</RailItem> : <RailItem term="Frozen at">{formatDateTime(data.frozenAt)}</RailItem>}
            <RailItem term={copied ? 'Copied citation' : 'Citation'}>{data.citation}</RailItem>
            <VersionedUrl url={data.url} />
            {data.evidence ? <RailTamper evidence={{ ...data.evidence, verified: data.verified }} /> : null}
            <div>
              <p>Report SHA-256:</p>
              <p className="rail-hash">{hashFirst}</p>
              <p className="rail-hash">{hashSecond}</p>
            </div>
            {refusal ? <RailUnavailable action="Download frozen report" reason={refusal} /> : null}
          </ContextRail>
        }
      >
        <Section title={data.headline}>
          <p className="prewrap">{data.summary}</p>
        </Section>
        <Section title="Final, independently reviewed scores">
          <Pairs
            items={data.scores.map((score) => ({
              key: score.evidenceCode,
              term: score.displayName,
              detail: (
                <>
                  {score.score} / 100 {score.label} ·{' '}
                  {data.canReadSources ? (
                    <Link className="text-link" to={`/evidence/${score.evidenceCode}`}>
                      {score.evidenceCode}
                    </Link>
                  ) : (
                    score.evidenceCode
                  )}
                  {score.sealedScore !== undefined ? ` · Sealed ${score.sealedScore}` : ''}
                </>
              ),
            }))}
          />
          {data.canReadSources ? (
            <p>
              <Link className="text-link" to={`/review/${data.reviewCode}`}>
                Open the expert review / {data.reviewCode} →
              </Link>
            </p>
          ) : (
            <p className="fine-print">Model outputs, sources and the expert review stay private to the task’s workspace and its authorized reviewers.</p>
          )}
        </Section>
        <Section title="Scope and limitations">
          <p className="prewrap">{data.limitations}</p>
        </Section>
      </Workspace>
      <Actions>
        {refusal ? (
          <>
            <DisabledAction reason={refusal}>Copy citation</DisabledAction>
            <DisabledAction reason={refusal}>Download frozen report</DisabledAction>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={() => void copy()}>
              {copied ? 'Copied ✓' : 'Copy citation'}
            </Button>
            <AnchorButton href={data.downloadUrl} download>
              Download frozen report
            </AnchorButton>
          </>
        )}
      </Actions>
      <p>
        <Link className="text-link" to="/reports">
          All reports
        </Link>
      </p>
    </Page>
  );
}

export default function ReportPage() {
  const { code = '', version = '' } = useParams();
  const query = useApiQuery<ReportResponse>(`/api/reports/${encodeURIComponent(code)}/${encodeURIComponent(version)}`);
  return <QueryBoundary query={query}>{(data) => <ReportContent data={data} />}</QueryBoundary>;
}
