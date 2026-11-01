import { useParams } from 'react-router-dom';
import { Actions, AnchorButton, ContextRail, HashMismatch, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailStat, RailTamper, Section, Workspace } from '../../components/index.ts';
import type { EvidenceDetailResponse } from '../../../shared/types/evaluation.ts';
import { useApiQuery } from '../../lib/query.ts';
import './evaluation.css';

function EvidenceContent({ data }: { data: EvidenceDetailResponse }) {
  const verified = data.tamper.verified;
  const { sources } = data;
  return (
    <Page title={data.code}>
      <PageHeader
        eyebrow="02 Evaluation"
        title="Evidence, not just a score."
        subtitle={`${data.code} · ${data.model.displayName} · ${data.task.label}`}
        status={verified ? `Output snapshot / ${data.code}` : `Quarantined / ${data.code}`}
        statusTone={verified ? 'accent' : 'danger'}
      />
      {verified ? null : <HashMismatch />}
      <Workspace
        rail={
          <ContextRail>
            <RailStat tone={verified ? undefined : 'danger'}>{data.totalScore}</RailStat>
            <RailItem term="Model">{data.model.displayName}</RailItem>
            <RailItem term="Pinned revision">{data.model.revision}</RailItem>
            <RailItem term="Rubric">
              {data.totalScore} / 100 {data.scoreLabel} · {data.scores.length} {data.scores.length === 1 ? 'criterion' : 'criteria'}
            </RailItem>
            <RailItem term="Task">{data.task.label}</RailItem>
            <RailTamper evidence={data.tamper} fullHash />
            {data.settingsNotes.map((note) => (
              <RailNote key={note}>{note}</RailNote>
            ))}
          </ContextRail>
        }
      >
        <Section title="The model’s answer">
          <p className="eval-quote">“{data.outputText}”</p>
        </Section>
        <Section title={sources.label ? `Sources / ${sources.label}` : 'Sources'}>
          {sources.records.length > 0 ? <Pairs items={sources.records.map((record) => ({ key: record.id, term: record.label ? `${record.id} / ${record.label}` : record.id, detail: record.observation }))} /> : null}
          {sources.note ? <p>{sources.note}</p> : null}
        </Section>
        <Section title="Reviewer annotation">
          <p>{data.annotation ? data.annotation.text : data.annotationEmpty}</p>
        </Section>
        <Section title={`Rubric score / ${data.totalScore} of 100 ${data.scoreLabel}`}>
          <Pairs items={data.scores.map((entry) => ({ key: entry.name, term: `${entry.name} / ${entry.points}`, detail: `${entry.score} · ${entry.rationale}` }))} />
        </Section>
      </Workspace>
      <Actions>
        <AnchorButton variant="primary" href={data.downloadUrl} download>
          Download evidence
        </AnchorButton>
        <LinkButton to={`/runs/${data.runCode}`}>Back to comparison</LinkButton>
      </Actions>
    </Page>
  );
}

export default function EvidencePage() {
  const { code = '' } = useParams();
  const query = useApiQuery<EvidenceDetailResponse>(`/api/evidence/${code}`, { staleTime: 0 });
  return <QueryBoundary query={query}>{(data) => <EvidenceContent data={data} />}</QueryBoundary>;
}
