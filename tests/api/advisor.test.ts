import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdvisorQueryResponse, AdvisorTaskList, AdvisorThread } from '../../shared/types/advisor.ts';
import { Client, makeTestApp, makeUser, type TestApp } from '../helpers/app.ts';

let test: TestApp;
let maya: Client;

beforeEach(async () => {
  test = await makeTestApp({ seed: true });
  maya = await new Client(test).signIn('maya@helixlab.example');
});
afterEach(() => test.close());

const FRAME_QUESTION = 'Why did Aster lose points on evidence attribution? Does the inhibitor result prove efflux caused resistance?';
const FRAME_ANSWER =
  'No. E03 supports an efflux hypothesis, but not pump-specific causality. Aster received 25/30 for attribution because it omitted inhibitor off-target effects. No pump deletion or rescue control is present. [1]\n\nThe expert upheld the deduction. E01’s MIC shift and E02’s increased acrB expression are consistent with the hypothesis, but alternatives remain. A deletion-and-complementation experiment would be more discriminating. [2, 3]';

async function ask(client: Client, question: string, task = 'BIO-042') {
  const res = await client.post('/api/advisor/query', { task, question });
  expect(res.status).toBe(200);
  return ((await res.json()) as AdvisorQueryResponse).answer;
}

const thread = async (client: Client, task = 'BIO-042') => (await (await client.get(`/api/advisor/thread?task=${task}`)).json()) as AdvisorThread;

/** Every citation must link to a real page of the kind it names. */
function expectRealLinks(citations: { n: number; label: string; to: string }[]) {
  citations.forEach((citation, index) => {
    expect(citation.n).toBe(index + 1);
    expect(citation.to).toMatch(/^\/(evidence\/EV-|datasets\/DS-|review\/REVIEW-|reports\/RPT-)/);
  });
}

describe('the seeded thread', () => {
  it('holds the frame’s exact question and answer, at 15:38 UTC, with its three citations', async () => {
    const data = await thread(maya);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]).toMatchObject({ role: 'user', content: FRAME_QUESTION, createdAt: '2026-10-15T15:38:00.000Z' });
    expect(data.messages[1]).toMatchObject({ role: 'assistant', content: FRAME_ANSWER, insufficient: false, mode: 'authored', createdAt: '2026-10-15T15:38:00.000Z' });
    expect(data.messages[1]?.citations).toEqual([
      { n: 1, label: 'EV-1042-A', detail: 'Attribution rationale / 25 of 30', to: '/evidence/EV-1042-A' },
      { n: 2, label: 'DS-BIO-07 v1.0', detail: 'E01–E03 synthetic source records', to: '/datasets/DS-BIO-07' },
      { n: 3, label: 'REVIEW-042', detail: 'Dr. Samira Patel / Verified Biology', to: '/review/REVIEW-042' },
    ]);
    expect(data).toMatchObject({ sourcePack: 'DS-BIO-07 v1.0', sourcePackWithheld: false, runCode: 'RUN-1042', mode: 'retrieval', quarantined: [], askerName: 'Maya Chen' });
    expect(data.task).toMatchObject({ code: 'BIO-042', version: '1.0', label: 'BIO-042 v1.0', synthetic: true });
  });

  it('has a tamper block that was really recomputed, for the first cited evidence', async () => {
    const { tamper } = await thread(maya);
    expect(tamper).toMatchObject({ code: 'EV-1042-A', runCode: 'RUN-1042', taskLabel: 'BIO-042 v1.0', runnerVersion: '2.4', capturedAt: '2026-10-15T14:32:11.000Z', verified: true });
    expect(tamper?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is Maya’s alone', async () => {
    const samira = await new Client(test).signIn('samira@northbridge.example');
    expect((await thread(samira)).messages).toEqual([]);
  });
});

describe('task selector', () => {
  it('lists frozen versions the user may read, and defaults to their newest thread', async () => {
    const list = (await (await maya.get('/api/advisor/tasks')).json()) as AdvisorTaskList;
    expect(list.items.map((item) => item.label).sort()).toEqual(['BIO-041 v1.0', 'BIO-042 v1.0']);
    expect(list.defaultTask).toEqual({ code: 'BIO-042', version: '1.0' });
    expect(list.items.find((item) => item.code === 'BIO-043')).toBeUndefined();
  });

  it('hides private tasks from everyone else', async () => {
    await makeUser(test, { email: 'outsider@lab.example' });
    const outsider = await new Client(test).signIn('outsider@lab.example');
    const list = (await (await outsider.get('/api/advisor/tasks')).json()) as AdvisorTaskList;
    expect(list.items.map((item) => item.label)).toEqual(['BIO-041 v1.0']);
    expect(list.defaultTask).toEqual({ code: 'BIO-041', version: '1.0' });
    expect((await outsider.get('/api/advisor/thread?task=BIO-042')).status).toBe(404);
    expect((await outsider.post('/api/advisor/query', { task: 'BIO-042', question: 'What does E02 show?' })).status).toBe(404);
    expect((await outsider.get('/api/advisor/thread?task=BIO-043')).status).toBe(404);
  });

  it('requires a verified account', async () => {
    expect((await new Client(test).get('/api/advisor/tasks')).status).toBe(401);
    expect((await new Client(test).post('/api/advisor/query', { task: 'BIO-042', question: 'Hello?' })).status).toBe(401);
    await makeUser(test, { email: 'new@lab.example', verified: false });
    const unverified = await new Client(test).signIn('new@lab.example');
    expect((await unverified.get('/api/advisor/tasks')).status).toBe(403);
  });

  it('refuses a version that does not exist', async () => {
    expect((await maya.get('/api/advisor/thread?task=BIO-042&version=9.9')).status).toBe(404);
    expect((await maya.get('/api/advisor/thread?task=BIO-042&version=v1.0')).status).toBe(200);
  });
});

describe('retrieval answers', () => {
  it('answers from real records with real citations, in the extractive mode it says it used', async () => {
    const answer = await ask(maya, 'Why did Aster lose points on evidence attribution?');
    expect(answer.mode).toBe('retrieval');
    expect(answer.insufficient).toBe(false);
    expect(answer.content).toContain('25 of 30');
    expect(answer.content).toContain('Inhibitor caveat missing');
    expect(answer.citations.some((citation) => citation.label === 'EV-1042-A' && citation.detail === 'Attribution rationale / 25 of 30')).toBe(true);
    expectRealLinks(answer.citations);
    // Every [n] in the text is a citation in the list, and the other way round.
    const used = new Set([...answer.content.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
    expect([...used].sort()).toEqual(answer.citations.map((citation) => citation.n));
  });

  it('ranks the named source record first and cites it', async () => {
    const answer = await ask(maya, 'What does E02 show?');
    expect(answer.citations[0]).toEqual({ n: 1, label: 'DS-BIO-07 v1.0', detail: 'E02 synthetic source record', to: '/datasets/DS-BIO-07' });
    expect(answer.content.startsWith('E02 in DS-BIO-07 v1.0: acrB transcript 3.1× control.')).toBe(true);
  });

  it('quotes a model’s output as that model’s, never as Advisor’s own claim', async () => {
    const answer = await ask(maya, 'What did Lumen say about AcrAB-TolC efflux?');
    expect(answer.content).toContain('Lumen 4 Mini output (EV-1042-L):');
    expect(answer.citations.some((citation) => citation.to === '/evidence/EV-1042-L')).toBe(true);
  });

  it('cites the report’s limitations', async () => {
    const answer = await ask(maya, 'What are the limitations of the report?');
    expect(answer.citations[0]).toEqual({ n: 1, label: 'RPT-BIO-042 v1.0', detail: 'Report limitations', to: '/reports/RPT-BIO-042/v1.0' });
    expect(answer.content).toContain('n = 1 task.');
  });

  it('prefers what the reviewer said, and the follow-up from the frame gets a real answer', async () => {
    const expert = await ask(maya, 'What did the expert find?');
    expect(expert.citations[0]).toMatchObject({ label: 'REVIEW-042', detail: 'Dr. Samira Patel / Verified Biology', to: '/review/REVIEW-042' });
    const followUp = await ask(maya, 'Which alternative explanation is least addressed?');
    expect(followUp.insufficient).toBe(false);
    expect(followUp.content).toMatch(/Alternative explanations/);
  });

  it('answers the frame’s own question from the records, leading with No', async () => {
    const answer = await ask(maya, FRAME_QUESTION);
    expect(answer.insufficient).toBe(false);
    expect(answer.content.startsWith('No.')).toBe(true);
    expect(answer.content).toContain('E03 is not pump-specific causal evidence');
    expect(answer.citations[0]?.label).toBe('REVIEW-042');
    expect(answer.citations.some((citation) => citation.label === 'EV-1042-A')).toBe(true);
  });

  it('answers the UI kit’s example from the records too', async () => {
    const answer = await ask(maya, 'Does E03 prove an efflux mechanism?');
    expect(answer.content.startsWith('No.')).toBe(true);
    expect(answer.content).toContain('does not establish pump specificity');
    expect(answer.insufficient).toBe(false);
  });
});

describe('the insufficient state', () => {
  it('uses the kit’s wording when a causal claim has no controls behind it', async () => {
    for (const question of ['Does efflux cause the resistance?', 'What caused the resistance?', 'Is AcrAB-TolC responsible for this phenotype?', 'Does this establish the mechanism?']) {
      const answer = await ask(maya, question);
      expect(answer.content, question).toBe('The authorized evidence does not include causal controls. I cannot establish that claim.');
      expect(answer.insufficient).toBe(true);
      expect(answer.citations).toEqual([]);
    }
  });

  it('names what is missing when key terms are not covered', async () => {
    const melting = await ask(maya, 'What is the melting point of ciprofloxacin?');
    expect(melting.content).toBe('The authorized evidence does not include information about “melting”. I cannot establish that claim.');
    const france = await ask(maya, 'What is the capital of France?');
    expect(france.content).toBe('The authorized evidence does not include information about “capital” or “France”. I cannot establish that claim.');
    expect((await ask(maya, 'Does E04 change anything?')).insufficient).toBe(true);
  });

  it('refuses conclusions the records cannot support', async () => {
    const clinical = await ask(maya, 'Is it safe to treat patients with an efflux inhibitor?');
    expect(clinical.content).toBe('The authorized evidence does not include clinical or patient data. I cannot establish that claim.');
    expect(clinical.citations).toEqual([]);
    // Naming a record does not make a clinical question answerable.
    expect((await ask(maya, 'Is E03 clinically relevant for patients?')).insufficient).toBe(true);
  });

  it('answers a generalization only with the records’ own limit on it', async () => {
    const answer = await ask(maya, 'Is Aster the best model for Biology in general?');
    expect(answer.content.startsWith('No.')).toBe(true);
    expect(answer.content).toContain('These scores cannot be generalized to Biology performance.');
    expect(answer.citations[0]?.label).toBe('REVIEW-042');
  });

  it('has nothing to say about a task with no records', async () => {
    const answer = await ask(maya, 'What did the expert find?', 'BIO-041');
    expect(answer.content).toBe('The authorized evidence does not include any records you may read for this task. I cannot establish that claim.');
    expect(answer.insufficient).toBe(true);
    const data = await thread(maya, 'BIO-041');
    expect(data).toMatchObject({ sourcePack: null, runCode: null, tamper: null, recordCount: 0 });
  });

  it('does not answer a what-question with a No', async () => {
    const answer = await ask(maya, 'According to the evidence, what caused the resistance?');
    expect(answer.insufficient).toBe(false);
    expect(answer.content.startsWith('The authorized records do not establish that.')).toBe(true);
  });

  it('never tells a design question that it is a claim', async () => {
    const answer = await ask(maya, 'What experiment would establish causality?');
    expect(answer.insufficient).toBe(false);
    expect(answer.content).toMatch(/deletion/i);
  });

  it('is not fooled by a general question', async () => {
    expect((await ask(maya, 'What does it say?')).insufficient).toBe(true);
  });
});

describe('authorization', () => {
  it('cites only what this user may read: an expert outside the workspace gets no dataset records', async () => {
    const samira = await new Client(test).signIn('samira@northbridge.example');
    const data = await thread(samira);
    expect(data).toMatchObject({ sourcePack: null, sourcePackWithheld: true, runCode: 'RUN-1042' });

    const answer = await ask(samira, 'What does E02 show?');
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations.every((citation) => !citation.to.startsWith('/datasets/'))).toBe(true);
    expect(answer.content).not.toContain('E02 in DS-BIO-07');

    // qPCR appears only in the dataset. Maya can be told; Samira cannot, and nothing leaks the term's source.
    expect((await ask(maya, 'Which source used qPCR?')).citations[0]?.to).toBe('/datasets/DS-BIO-07');
    expect((await ask(samira, 'Which source used qPCR?')).content).toBe('The authorized evidence does not include information about “qPCR”. I cannot establish that claim.');
  });

  it('keeps a submitted review from readers a shared task merely reaches, until it is finalized', async () => {
    await test.ctx.db.run(`UPDATE tasks SET visibility = 'shared' WHERE code = 'BIO-042'`);
    await test.ctx.db.run(`UPDATE reviews SET status = 'submitted' WHERE code = 'REVIEW-042'`);
    await makeUser(test, { email: 'reader@lab.example' });
    const reader = await new Client(test).signIn('reader@lab.example');
    const answer = await ask(reader, 'What did the reasoning rationale say about Aster?');
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations.every((citation) => citation.to.startsWith('/evidence/') || citation.to.startsWith('/reports/'))).toBe(true);
    expect((await ask(reader, 'What did Dr. Samira Patel find?')).insufficient).toBe(true);
    expect((await thread(reader)).sourcePackWithheld).toBe(true);
    // The owner's side can use it while it waits for a decision.
    expect((await ask(maya, 'What did Dr. Samira Patel find?')).citations[0]?.label).toBe('REVIEW-042');

    // Finalized, it goes with the task, as on the review page itself.
    await test.ctx.db.run(`UPDATE reviews SET status = 'finalized' WHERE code = 'REVIEW-042'`);
    expect((await ask(reader, 'What did Dr. Samira Patel find?')).citations[0]?.label).toBe('REVIEW-042');
    expect((await reader.get('/api/reviews/REVIEW-042')).status).toBe(200);
  });

  it('lets the assigned reviewer and an administrator use the review', async () => {
    const samira = await new Client(test).signIn('samira@northbridge.example');
    expect((await ask(samira, 'What did the expert find?')).citations[0]?.label).toBe('REVIEW-042');
    const alex = await new Client(test).signIn('alex@rivet.example');
    expect((await ask(alex, 'What did the expert find?')).citations[0]?.label).toBe('REVIEW-042');
    // An administrator is still not a Helix member, so the dataset stays closed.
    expect((await thread(alex)).sourcePackWithheld).toBe(true);
  });

  it('stops at the next question when membership is removed', async () => {
    const memberId = await makeUser(test, { email: 'lab@helix.example' });
    const workspace = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-HELIX'`)) as { id: string };
    await test.ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m-lab', ?, ?, 'member', ?)`, [workspace.id, memberId, test.ctx.now().toISOString()]);
    const member = await new Client(test).signIn('lab@helix.example');
    expect((await ask(member, 'What does E02 show?')).citations[0]?.to).toBe('/datasets/DS-BIO-07');
    await maya.post(`/api/workspaces/${workspace.id}/members/${memberId}/remove`);
    expect((await member.post('/api/advisor/query', { task: 'BIO-042', question: 'What does E02 show?' })).status).toBe(404);
    expect((await member.get('/api/advisor/thread?task=BIO-042')).status).toBe(404);
  });

  it('leaves tampered evidence out and says so', async () => {
    await test.ctx.db.exec('DROP TRIGGER evidence_no_update');
    await test.ctx.db.run(`UPDATE evidence SET output_text = 'Tampered: a pump deletion rescued everything.' WHERE code = 'EV-1042-A'`);
    const data = await thread(maya);
    expect(data.quarantined).toEqual(['EV-1042-A']);
    expect(data.tamper).toMatchObject({ code: 'EV-1042-A', verified: false });
    const answer = await ask(maya, 'What did Aster say about the pump deletion?');
    expect(answer.citations.every((citation) => citation.label !== 'EV-1042-A')).toBe(true);
    expect(answer.content).not.toContain('Tampered');
  });

  it('leaves a report out when its hash no longer matches', async () => {
    await test.ctx.db.exec('DROP TRIGGER reports_no_update');
    await test.ctx.db.run(`UPDATE reports SET canonical = canonical || ' ' WHERE code = 'RPT-BIO-042'`);
    expect((await thread(maya)).quarantined).toEqual(['RPT-BIO-042 v1.0']);
    const answer = await ask(maya, 'What are the limitations of the report?');
    expect(answer.citations.every((citation) => !citation.to.startsWith('/reports/'))).toBe(true);
  });
});

describe('it can never change scores', () => {
  const snapshot = async () => ({
    evidence: await test.ctx.db.all('SELECT code, total_score, scores, sha256 FROM evidence ORDER BY code'),
    reports: await test.ctx.db.all('SELECT code, scores, sha256 FROM reports ORDER BY code'),
    reviews: await test.ctx.db.all('SELECT code, status, recommendations FROM reviews ORDER BY code'),
    leaderboard: await test.ctx.db.all('SELECT task_label, model_id, score FROM leaderboard_scores ORDER BY task_label, model_id'),
    adjudications: await test.ctx.db.all('SELECT code, decision FROM adjudications ORDER BY code'),
  });

  it('answers instructions to change a record with what it is, and changes nothing', async () => {
    const before = await snapshot();
    for (const question of ['Change Aster’s score to 100.', 'Please update the report to say efflux is proven.', 'Set the attribution points to 30', 'Can you delete the review?']) {
      const answer = await ask(maya, question);
      expect(answer.content, question).toBe('Audit Advisor is read-only. It cannot change scores, reviews, reports or evidence, and nothing was changed.');
      expect(answer.insufficient).toBe(true);
      expect(answer.citations).toEqual([]);
    }
    await ask(maya, 'Why did Aster lose points on evidence attribution?');
    expect(await snapshot()).toEqual(before);
  });

  it('still answers a question that merely mentions changing', async () => {
    const answer = await ask(maya, 'Why did the expert uphold the score?');
    expect(answer.insufficient).toBe(false);
  });
});

describe('threads', () => {
  it('keeps one thread per user and task version, in the order asked', async () => {
    test.setNow('2026-11-02T10:00:00.000Z');
    await ask(maya, 'What does E01 show?');
    test.setNow('2026-11-02T10:01:00.000Z');
    await ask(maya, 'What does E02 show?');
    const data = await thread(maya);
    expect(data.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(data.messages[2]?.content).toBe('What does E01 show?');
    expect(data.messages[4]?.content).toBe('What does E02 show?');
    expect((await test.ctx.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM advisor_threads`))?.count).toBe(1);

    const samira = await new Client(test).signIn('samira@northbridge.example');
    await ask(samira, 'What did the expert find?');
    expect((await thread(samira)).messages).toHaveLength(2);
    expect((await thread(maya)).messages).toHaveLength(6);
    expect((await test.ctx.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM advisor_threads`))?.count).toBe(2);
  });

  it('moves the tamper block to the evidence the latest answer cited', async () => {
    await ask(maya, 'What did Lumen say about AcrAB-TolC efflux?');
    expect((await thread(maya)).tamper?.code).toBe('EV-1042-L');
  });

  it('validates the question on its field', async () => {
    const empty = await maya.post('/api/advisor/query', { task: 'BIO-042', question: '   ' });
    expect(empty.status).toBe(422);
    expect((await empty.json()).error.fields.question).toBe('Enter a question to ask Audit Advisor.');
    const long = await maya.post('/api/advisor/query', { task: 'BIO-042', question: 'x'.repeat(2001) });
    expect(long.status).toBe(422);
    expect((await long.json()).error.fields.question).toBe('Keep this under 2000 characters.');
    expect((await thread(maya)).messages).toHaveLength(2);
  });

  it('audits each question', async () => {
    await ask(maya, 'What does E02 show?');
    const row = await test.ctx.db.get<any>(`SELECT * FROM audit_log WHERE action = 'advisor.query'`);
    expect(row.subject_code).toBe('BIO-042 v1.0');
    expect(JSON.parse(row.detail)).toMatchObject({ mode: 'retrieval', insufficient: false });
  });
});

/* ---------- Constrained LLM mode, against a mock through ctx.config.anthropicBaseUrl ---------- */

interface MockCall {
  path: string;
  headers: IncomingMessage['headers'];
  body: any;
}

function mockAnthropic(reply: (call: MockCall) => { status?: number; body: unknown }) {
  const calls: MockCall[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const call = { path: req.url ?? '', headers: req.headers, body: JSON.parse(raw) };
      calls.push(call);
      const { status = 200, body } = reply(call);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise<{ url: string; calls: MockCall[]; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, calls, close: () => server.close() });
    });
  });
}

const messageWith = (text: string, stopReason = 'end_turn') => ({
  id: 'msg_mock',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text }],
  stop_reason: stopReason,
  stop_details: null,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

const modelAnswer = (answer: string, citations: number[], insufficient = false, missing = '') => JSON.stringify({ answer, citations, insufficient, missing });

describe('constrained LLM mode', () => {
  async function llmApp(reply: (call: MockCall) => { status?: number; body: unknown }) {
    const mock = await mockAnthropic(reply);
    const app = await makeTestApp({ seed: true, config: { anthropicKey: 'test-key', anthropicBaseUrl: mock.url } });
    const close = () => {
      app.close();
      mock.close();
    };
    return { app, mock, close, maya: await new Client(app).signIn('maya@helixlab.example') };
  }

  it('sends only the retrieved records, and shows an answer whose citations check out', async () => {
    const llm = await llmApp((call) => {
      const records = [...(call.body.messages[0].content as string).matchAll(/<record n="(\d+)" source="([^"]+)"/g)];
      const first = records[0];
      const second = records.find((record) => record[2] !== first?.[2]);
      return { body: messageWith(modelAnswer(`The expert found this [${second?.[1]}]. Aster's output says that [${first?.[1]}, ${second?.[1]}].`, [Number(first?.[1]), Number(second?.[1])])) };
    });
    try {
      const answer = await ask(llm.maya, 'What did the expert find about Aster?');
      expect(answer.mode).toBe('llm');
      expect(answer.modeNote).toBeNull();
      // Renumbered from 1 in the order the answer used them.
      expect(answer.content).toBe('The expert found this [1]. Aster\'s output says that [2, 1].');
      expect(answer.citations.map((citation) => citation.n)).toEqual([1, 2]);
      expectRealLinks(answer.citations);

      expect(llm.mock.calls).toHaveLength(1);
      const { body, headers, path } = llm.mock.calls[0] as MockCall;
      expect(path).toContain('/v1/messages');
      expect(String(headers['x-api-key'] ?? headers.authorization)).toContain('test-key');
      expect(String(headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
      expect(body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'medium', format: { type: 'json_schema' } } });
      expect(body.system).toContain('using only the numbered records');
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('tools');
      expect(body.messages[0].content).toContain('What did the expert find about Aster?');
      expect((await (await llm.maya.get('/api/advisor/thread?task=BIO-042')).json()).mode).toBe('llm');
    } finally {
      llm.close();
    }
  });

  it('gives two records from one source one citation', async () => {
    const llm = await llmApp((call) => {
      const records = [...(call.body.messages[0].content as string).matchAll(/<record n="(\d+)" source="([^"]+)" kind="([^"]+)"/g)];
      const sameSource = records.filter((record) => record[2] === 'REVIEW-042');
      expect(sameSource.length).toBeGreaterThan(1);
      return { body: messageWith(modelAnswer(`One [${sameSource[0]?.[1]}]. Two [${sameSource[1]?.[1]}]. Both [${sameSource[0]?.[1]}, ${sameSource[1]?.[1]}].`, [])) };
    });
    try {
      const answer = await ask(llm.maya, 'What did the expert find?');
      expect(answer.mode).toBe('llm');
      expect(answer.content).toBe('One [1]. Two [1]. Both [1].');
      expect(answer.citations).toEqual([{ n: 1, label: 'REVIEW-042', detail: 'Dr. Samira Patel / Verified Biology', to: '/review/REVIEW-042' }]);
    } finally {
      llm.close();
    }
  });

  it('receives nothing the asker may not read', async () => {
    const llm = await llmApp(() => ({ body: messageWith(modelAnswer('Nothing to add [1].', [1])) }));
    try {
      const samira = await new Client(llm.app).signIn('samira@northbridge.example');
      await ask(samira, 'What does E02 show?');
      const prompt = llm.mock.calls[0]?.body.messages[0].content as string;
      expect(prompt).not.toContain('DS-BIO-07');
      expect(prompt).toContain('EV-1042');
      await ask(llm.maya, 'What does E02 show?');
      expect(llm.mock.calls[1]?.body.messages[0].content).toContain('DS-BIO-07');
    } finally {
      llm.close();
    }
  });

  it('discards an answer citing a record it was not given, and says retrieval answered', async () => {
    const llm = await llmApp(() => ({ body: messageWith(modelAnswer('The deletion control rescued the phenotype [99].', [99])) }));
    try {
      const answer = await ask(llm.maya, 'What does E02 show?');
      expect(answer.mode).toBe('retrieval');
      expect(answer.modeNote).toContain('does not match a retrieved record');
      expect(answer.content).not.toContain('rescued');
      expect(answer.citations[0]?.label).toBe('DS-BIO-07 v1.0');
    } finally {
      llm.close();
    }
  });

  it('discards an answer with no citations, a citation list out of range, and unparsable output', async () => {
    let turn = 0;
    const replies = [modelAnswer('Efflux explains it.', []), modelAnswer('Efflux explains it [1].', [1, 77]), 'not json', JSON.stringify({ answer: 'x' })];
    const llm = await llmApp(() => ({ body: messageWith(replies[turn++] as string) }));
    try {
      for (let index = 0; index < replies.length; index += 1) {
        const answer = await ask(llm.maya, 'What does E02 show?');
        expect(answer.mode, replies[index]).toBe('retrieval');
        expect(answer.modeNote, replies[index]).toContain('retrieval answered');
        expect(answer.content.startsWith('E02 in DS-BIO-07 v1.0')).toBe(true);
      }
    } finally {
      llm.close();
    }
  });

  it('shows the model’s own insufficient answer in the same wording', async () => {
    const llm = await llmApp(() => ({ body: messageWith(modelAnswer('', [], true, 'a measured pump activity assay.')) }));
    try {
      const answer = await ask(llm.maya, 'What does E02 show about pump activity?');
      expect(answer).toMatchObject({ mode: 'llm', insufficient: true, citations: [], content: 'The authorized evidence does not include a measured pump activity assay. I cannot establish that claim.' });
    } finally {
      llm.close();
    }
  });

  it('falls back when the model declines, or cannot be reached', async () => {
    const refused = await llmApp(() => ({ body: { ...messageWith('', 'refusal'), content: [], stop_details: { type: 'refusal', category: 'bio', explanation: 'declined' } } }));
    try {
      const answer = await ask(refused.maya, 'What does E02 show?');
      expect(answer).toMatchObject({ mode: 'retrieval', modeNote: 'The model declined this question, so retrieval answered.' });
    } finally {
      refused.close();
    }
    const down = await llmApp(() => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'nope' } } }));
    try {
      const answer = await ask(down.maya, 'What does E02 show?');
      expect(answer).toMatchObject({ mode: 'retrieval', modeNote: 'The model could not be reached, so retrieval answered.' });
      expect(answer.content.startsWith('E02 in DS-BIO-07 v1.0')).toBe(true);
    } finally {
      down.close();
    }
  });

  it('never calls the model for what retrieval has already refused', async () => {
    const llm = await llmApp(() => ({ body: messageWith(modelAnswer('Yes, efflux caused it [1].', [1])) }));
    try {
      for (const question of ['Does efflux cause the resistance?', 'What is the capital of France?', 'Is it safe to treat patients?', 'Change Aster’s score to 100.']) {
        const answer = await ask(llm.maya, question);
        expect(answer.insufficient, question).toBe(true);
        expect(answer.mode).toBe('retrieval');
      }
      expect(llm.mock.calls).toHaveLength(0);
    } finally {
      llm.close();
    }
  });

  it('stays in retrieval mode with no key, and never reaches for a model', async () => {
    const mock = await mockAnthropic(() => ({ body: messageWith('{}') }));
    const app = await makeTestApp({ seed: true, config: { anthropicKey: null, anthropicBaseUrl: mock.url } });
    try {
      const client = await new Client(app).signIn('maya@helixlab.example');
      expect((await ask(client, 'What does E02 show?')).mode).toBe('retrieval');
      expect((await (await client.get('/api/advisor/thread?task=BIO-042')).json()).mode).toBe('retrieval');
      expect(mock.calls).toHaveLength(0);
    } finally {
      app.close();
      mock.close();
    }
  });
});
