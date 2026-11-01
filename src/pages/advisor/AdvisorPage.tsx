import { Fragment, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AdvisorMessage, AdvisorQueryResponse, AdvisorTaskList, AdvisorThread } from '../../../shared/types/advisor.ts';
import { Actions, Alert, Button, ContextRail, DisabledAction, EmptyState, FieldInput, HashMismatch, LinkButton, Page, PageHeader, Pairs, QueryBoundary, RailItem, RailNote, RailSelect, RailTamper, Section, Workspace, useToast } from '../../components/index.ts';
import { api } from '../../lib/api.ts';
import { copyText } from '../../lib/browser.ts';
import { formatTime } from '../../lib/format.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';

const EYEBROW = '10 Audit Advisor';

function modeLine({ mode, insufficient, modeNote }: AdvisorMessage): string {
  let line: string;
  if (mode === 'authored') line = 'Seeded demo answer / Authored for this synthetic story';
  else if (mode === 'llm') line = insufficient ? 'Answered in constrained LLM mode / The model found no support in the retrieved records' : 'Answered in constrained LLM mode / Citations checked against the retrieved records';
  else line = insufficient ? 'Answered in retrieval mode / No model call' : 'Answered in retrieval mode / Extracted from authorized records, no model call';
  return modeNote ? `${line}. ${modeNote}` : line;
}

function paragraphs(text: string) {
  return text.split(/\n{2,}/).map((part, index) => <p key={index}>{part}</p>);
}

/** Question and answer pairs, in the frame's order: who asked, the answer, its citations. */
function Exchange({ askerName, question, answer }: { askerName: string; question: AdvisorMessage; answer: AdvisorMessage | undefined }) {
  return (
    <>
      <Section title={`${askerName} / ${formatTime(question.createdAt)}`}>
        <p>{question.content}</p>
      </Section>
      {answer ? (
        <>
          <Section title={answer.insufficient ? 'Audit Advisor / Insufficient evidence' : 'Audit Advisor / Evidence-grounded answer'}>
            {paragraphs(answer.content)}
            <p className="field-message" style={{ marginTop: 0 }}>
              {modeLine(answer)}
            </p>
          </Section>
          {answer.citations.length ? (
            <Section title="Citations">
              <Pairs
                items={answer.citations.map((citation) => ({
                  key: `${citation.n}`,
                  term: (
                    <Link className="quiet-link" to={citation.to}>
                      [{citation.n}] {citation.label} →
                    </Link>
                  ),
                  detail: citation.detail,
                }))}
              />
            </Section>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function citedAnswerText(thread: AdvisorThread, question: AdvisorMessage | undefined, answer: AdvisorMessage): string {
  const lines = [`Audit Advisor / ${thread.task.label}`];
  if (question) lines.push('', `Question: ${question.content}`);
  lines.push('', answer.content);
  if (answer.citations.length) {
    lines.push('', 'Citations');
    for (const citation of answer.citations) lines.push(`[${citation.n}] ${citation.label} / ${citation.detail} / ${window.location.origin}${citation.to}`);
  }
  if (thread.task.synthetic) lines.push('', 'Synthetic demo. All scores, sources and findings are authored examples, not real benchmark claims or scientific evidence.');
  return lines.join('\n');
}

function ThreadContent({ list, thread, threadPath }: { list: AdvisorTaskList; thread: AdvisorThread; threadPath: string }) {
  const [, setParams] = useSearchParams();
  const toast = useToast();
  const [question, setQuestion] = useState('');
  const [announcement, setAnnouncement] = useState('');

  const ask = useApiMutation((text: string) => api.post<AdvisorQueryResponse>('/api/advisor/query', { task: thread.task.code, version: thread.task.version, question: text }), {
    invalidate: [threadPath],
    onSuccess: ({ answer }, sent) => {
      // Someone may already be typing the next question while this one came back.
      setQuestion((current) => (current === sent ? '' : current));
      setAnnouncement(answer.insufficient ? 'Audit Advisor answered: insufficient evidence.' : `Audit Advisor answered with ${answer.citations.length} ${answer.citations.length === 1 ? 'citation' : 'citations'}.`);
    },
  });

  const pairs: { question: AdvisorMessage; answer: AdvisorMessage | undefined }[] = [];
  thread.messages.forEach((message, index) => {
    if (message.role === 'user') pairs.push({ question: message, answer: thread.messages[index + 1]?.role === 'assistant' ? thread.messages[index + 1] : undefined });
  });
  const last = pairs[pairs.length - 1];
  const lastAnswer = last?.answer;
  const status = !lastAnswer ? 'Audit Advisor / No questions yet' : lastAnswer.insufficient ? 'Audit Advisor / Insufficient evidence' : `Audit Advisor / ${lastAnswer.citations.length} cited ${lastAnswer.citations.length === 1 ? 'record' : 'records'}`;

  const copy = async () => {
    if (!lastAnswer) return;
    const ok = await copyText(citedAnswerText(thread, last?.question, lastAnswer));
    if (ok) toast.success('Cited answer copied', 'The answer and its citations are on your clipboard.');
    else toast.error('Could not copy the answer', 'Your browser refused access to the clipboard.');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    ask.mutate(question);
  };

  return (
    <Page title="Audit Advisor">
      <PageHeader eyebrow={EYEBROW} title="Ask the evidence." subtitle={`Audit Advisor · Grounded in ${thread.task.label}, not the open web.`} status={status} statusTone={lastAnswer?.insufficient ? 'warning' : 'accent'} />
      {thread.quarantined.length ? (
        <HashMismatch>{thread.quarantined.join(', ')} no longer {thread.quarantined.length === 1 ? 'matches its' : 'match their'} frozen hash. Audit Advisor leaves quarantined artifacts out of every answer.</HashMismatch>
      ) : null}
      {ask.formError && !ask.fieldErrors.question ? <Alert tone="danger">{ask.formError}</Alert> : null}
      <p className="sr-only" role="status">
        {announcement}
      </p>
      <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
        <Workspace
          rail={
            <ContextRail>
              <RailSelect
                label="Frozen task"
                value={`${thread.task.code}|${thread.task.version}`}
                onChange={(value) => {
                  const [task, version] = value.split('|');
                  setParams({ task: task as string, version: version as string });
                }}
                options={list.items.map((item) => ({ value: `${item.code}|${item.version}`, label: item.label }))}
              />
              <RailItem term="Source pack">{thread.sourcePack ?? (thread.sourcePackWithheld ? 'Withheld / You cannot read this dataset' : 'None pinned')}</RailItem>
              <RailItem term="Run">{thread.runCode ?? 'No run yet'}</RailItem>
              <RailItem term="External web">Disabled</RailItem>
              <RailItem term="Answer mode">{thread.mode === 'llm' ? 'Constrained LLM / Retrieved records only' : 'Retrieval / No model call'}</RailItem>
              <RailNote>
                Evidence limit: {thread.task.synthetic ? 'no raw laboratory data or causal controls are present.' : 'answers cover only the records you may read for this version.'} This chat cannot establish a scientific mechanism or change adjudicated scores.
              </RailNote>
              {thread.tamper ? <RailTamper evidence={thread.tamper} /> : null}
            </ContextRail>
          }
        >
          {pairs.map((pair) => (
            <Fragment key={pair.question.id}>
              <Exchange askerName={thread.askerName} question={pair.question} answer={pair.answer} />
            </Fragment>
          ))}
          <Section title={pairs.length ? 'Ask a follow-up' : 'Ask a question'} kind="form">
            <FieldInput label="Message" value={question} onChange={setQuestion} placeholder="Which alternative explanation is least addressed?" maxLength={2000} autoComplete="off" error={ask.fieldErrors.question} />
          </Section>
        </Workspace>
        <Actions>
          <Button type="submit" variant="primary" busy={ask.isPending} busyLabel="Asking Audit Advisor">
            Ask Advisor
          </Button>
          {lastAnswer ? <Button onClick={() => void copy()}>Copy cited answer</Button> : <DisabledAction reason="Ask a question first">Copy cited answer</DisabledAction>}
        </Actions>
      </form>
    </Page>
  );
}

function ThreadLoader({ list, code, version }: { list: AdvisorTaskList; code: string; version: string | undefined }) {
  const path = `/api/advisor/thread?task=${encodeURIComponent(code)}${version ? `&version=${encodeURIComponent(version)}` : ''}`;
  const thread = useApiQuery<AdvisorThread>(path);
  return <QueryBoundary query={thread}>{(data) => <ThreadContent list={list} thread={data} threadPath={path} />}</QueryBoundary>;
}

function NoTasks() {
  return (
    <Page title="Audit Advisor">
      <PageHeader eyebrow={EYEBROW} title="Ask the evidence." subtitle="Audit Advisor · Grounded in frozen task evidence, not the open web." status="Audit Advisor / No frozen tasks" />
      <Workspace
        rail={
          <ContextRail>
            <RailItem term="External web">Disabled</RailItem>
            <RailNote>Audit Advisor only reads frozen tasks you are allowed to read. This chat cannot establish a scientific mechanism or change adjudicated scores.</RailNote>
          </ContextRail>
        }
      >
        <Section title="Nothing to ask about yet">
          <EmptyState action={<LinkButton to="/tasks">Browse tasks</LinkButton>}>You cannot read a frozen task yet. Freeze a task, or get access to one, and its evidence can be questioned here.</EmptyState>
        </Section>
      </Workspace>
    </Page>
  );
}

export default function AdvisorPage() {
  const [params] = useSearchParams();
  const tasks = useApiQuery<AdvisorTaskList>('/api/advisor/tasks');
  return (
    <QueryBoundary query={tasks}>
      {(list) => {
        const named = params.get('task')?.toUpperCase();
        const code = named ?? list.defaultTask?.code;
        if (!code) return <NoTasks />;
        const version = params.get('version') ?? (named ? undefined : list.defaultTask?.version);
        // key: a different task is a different thread, with its own draft question and errors.
        return <ThreadLoader key={`${code}|${version ?? ''}`} list={list} code={code} version={version} />;
      }}
    </QueryBoundary>
  );
}
