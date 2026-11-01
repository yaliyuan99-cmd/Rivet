import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { DatasetDetail } from '../../../shared/types/datasets.ts';
import { Actions, ActionsBelow, Alert, AnchorButton, ContextRail, DisabledAction, HashMismatch, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailUnavailable, Section, Workspace } from '../../components/index.ts';
import { formatDate, formatDateTime, formatSize, hashLines, shortHash } from '../../lib/format.ts';
import { useApiQuery } from '../../lib/query.ts';
import { formatLabel, observationCount, recordsLabel } from './shared.ts';
import './datasets.css';

function statusLine(data: DatasetDetail): { text: string; tone: 'accent' | 'warning' | 'danger' } {
  const { version } = data;
  if (!version.verified) return { text: 'Hash mismatch / Download refused', tone: 'danger' };
  if (data.deleted) return { text: 'Deleted from library / Retained for audit', tone: 'warning' };
  const parts = [version.receipt.passed ? 'Validated' : 'Not validated', data.visibility === 'private' ? 'Private' : 'Shared'];
  if (version.isSynthetic) parts.push('Synthetic');
  return { text: parts.join(' / '), tone: 'accent' };
}

function DetailContent({ data }: { data: DatasetDetail }) {
  const { version, code, name } = data;
  const [first, second] = hashLines(version.sha256);
  const format = formatLabel(version.format);
  const size = formatSize(version.size);
  const status = statusLine(data);
  const isPdf = version.format === 'pdf';
  const heading = isPdf ? 'Records not parsed.' : `${observationCount(version.rowsTotal)}.${version.hasLimits ? ' Explicit limits.' : ''}`;
  const refused = `The stored bytes no longer match this SHA-256, so this download is refused.`;

  return (
    <Page title={`${code} v${version.version}`}>
      <PageHeader eyebrow="06 Datasets" title={name} subtitle={`${code} v${version.version} · Uploaded by ${version.createdByName} · ${formatDate(version.createdAt)}`} status={status.text} statusTone={status.tone} />
      {data.deleted ? (
        <Alert tone="warning">
          Deleted from the library on {formatDateTime(data.deleted.at)}
          {data.deleted.byName ? ` by ${data.deleted.byName}` : ''}. Versions and bytes are retained for audit; new attachments and versions are prevented.
        </Alert>
      ) : null}
      {!version.isLatest ? (
        <Alert tone="neutral">
          You are viewing v{version.version}. The latest version is v{data.versions[0]?.version}.
        </Alert>
      ) : null}
      {version.verified ? null : <HashMismatch>The bytes for {code} v{version.version} differ from the SHA-256 recorded when this version was created. Do not use this artifact.</HashMismatch>}
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="Dataset">
              {code} v{version.version}
            </RailItem>
            <RailItem term="Author">{version.createdByName}</RailItem>
            <RailItem term="Pinned by">{version.pinnedBy.join(', ') || 'Not pinned'}</RailItem>
            <RailItem term="Size">
              {size} / {recordsLabel(version.format, version.recordsCount)}
            </RailItem>
            <RailItem term="Created">{formatDateTime(version.createdAt)}</RailItem>
            <RailNote>New uploads create a new dataset version. Deleting a library entry cannot erase a source snapshot referenced by frozen evidence.</RailNote>
            {data.canDelete.allowed ? null : <RailUnavailable action="Delete dataset" reason={data.canDelete.reason} />}
          </ContextRail>
        }
      >
        <Section title={heading}>
          {isPdf ? (
            <p>{version.receipt.recordsNote}</p>
          ) : (
            <>
              <Pairs items={version.rows.map((row) => ({ key: row.key, term: row.term, detail: row.detail }))} />
              {version.rowsTotal > version.rows.length ? (
                <p>
                  Showing the first {version.rows.length} of {version.rowsTotal.toLocaleString('en-US')} records. Download the file for the rest.
                </p>
              ) : null}
            </>
          )}
        </Section>
        <Section title="Source provenance">
          <p className="prewrap">{version.provenance}</p>
        </Section>
        <Section title={version.verified ? 'Verified download' : 'Download refused'}>
          <p>{format} downloads include a version manifest and checksum so downstream users can verify the exact source bytes.</p>
          <p className="ds-hash">
            SHA-256 {first}
            <br />
            {second}
          </p>
          {version.verified ? (
            <p>
              <a className="text-link" href={version.manifestPath}>
                Download version manifest and checksum
              </a>
            </p>
          ) : null}
        </Section>
        <Section title="Version history">
          <Pairs
            items={data.versions.map((row) => ({
              key: row.version,
              term: row.isCurrent ? (
                <>
                  v{row.version} / Viewing
                </>
              ) : (
                <Link className="text-link" to={`/datasets/${code}?version=${encodeURIComponent(row.version)}`}>
                  v{row.version}
                </Link>
              ),
              detail: `${row.filename} · ${formatSize(row.size)} · ${recordsLabel(row.format, row.recordsCount)} · ${row.createdByName} · ${formatDateTime(row.createdAt)} · SHA-256 ${shortHash(row.sha256)}${row.pinnedBy.length ? ` · Pinned by ${row.pinnedBy.join(', ')}` : ''}`,
            }))}
          />
          {data.canUploadVersion.allowed ? (
            <p>
              <Link className="text-link" to={`/datasets/upload?dataset=${code}`}>
                Upload new version
              </Link>
            </p>
          ) : (
            <p>Upload new version · {data.canUploadVersion.reason}</p>
          )}
        </Section>
      </Workspace>
      <Actions>
        {version.verified ? (
          <AnchorButton variant="primary" href={version.downloadPath}>
            Download {format} · {size}
          </AnchorButton>
        ) : (
          <DisabledAction reason={refused}>
            Download {format} · {size}
          </DisabledAction>
        )}
        {data.canDelete.allowed ? <LinkButton to={`/datasets/${code}/delete`}>Delete dataset…</LinkButton> : null}
      </Actions>
      {data.canDelete.allowed ? null : (
        <ActionsBelow>
          <DisabledAction reason={data.canDelete.reason}>Delete dataset…</DisabledAction>
        </ActionsBelow>
      )}
    </Page>
  );
}

export default function DatasetDetailPage() {
  const { code = '' } = useParams();
  const [params] = useSearchParams();
  const version = params.get('version');
  const query = useApiQuery<DatasetDetail>(`/api/datasets/${encodeURIComponent(code)}${version ? `?version=${encodeURIComponent(version)}` : ''}`);
  return <QueryBoundary query={query}>{(data) => <DetailContent data={data} />}</QueryBoundary>;
}
