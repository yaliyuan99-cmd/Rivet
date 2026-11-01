import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditorNewResponse, EvidenceDetailResponse, FreezeResponse, FreezeResult, RunDetailResponse, RunStartResponse } from '../../shared/types/evaluation.ts';
import { createAnthropicAdapter } from '../../server/engine/anthropicAdapter.ts';
import { overrideAdapter, startEngine, waitForIdle, waitForRun } from '../../server/engine/runner.ts';
import { Client, makeTestApp, type TestApp } from '../helpers/app.ts';

interface MockReply {
  status?: number;
  body?: unknown;
  /** Never answers, so the client's timeout fires. */
  hang?: boolean;
}

/** A local stand-in for the Messages API. It records every request so tests can inspect exactly what was sent. */
class MockAnthropic {
  requests: Record<string, any>[] = [];
  private server: Server;
  reply: (body: Record<string, any>) => MockReply = () => ({ body: textMessage('A real-looking answer citing [E01], [E02] and [E03].') });

  constructor() {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, any>;
        this.requests.push({ ...body, __path: req.url, __credential: req.headers['x-api-key'] ?? req.headers.authorization });
        const reply = this.reply(body);
        if (reply.hang) return;
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', 'request-id': 'req_mock' });
        res.end(JSON.stringify(reply.body));
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

function textMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 80 },
    ...overrides,
  };
}

const judgeAnswer = (body: Record<string, any>) => {
  const payload = JSON.parse(body.messages[0].content) as { rubric: { name: string; max_points: number }[] };
  return JSON.stringify({ criteria: payload.rubric.map((criterion) => ({ name: criterion.name, score: criterion.max_points - 5, rationale: `Lost five points on ${criterion.name}.` })) });
};

let test: TestApp;
let mock: MockAnthropic;
let client: Client;

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

const defaultReply = (body: Record<string, any>): MockReply => (body.output_config?.format ? { body: textMessage(judgeAnswer(body)) } : { body: textMessage('A real-looking answer citing [E01], [E02] and [E03].') });

/** Puts Claude on BIO-043 alongside Aster, freezes it, and starts a run. */
async function startClaudeRun() {
  const { options } = await json<EditorNewResponse>(await client.get('/api/tasks/editor-options'));
  expect(options.models.find((model) => model.id === 'claude-opus-5-5')?.available).toBe(true);
  const draft = (await json<{ draft: Record<string, unknown> }>(await client.get('/api/tasks/BIO-043/draft'))).draft;
  await json(await client.put('/api/tasks/BIO-043/draft', { ...draft, modelIds: ['aster-3.2', 'claude-opus-5-5'] }));
  const preview = await json<FreezeResponse>(await client.post('/api/tasks/BIO-043/scan'));
  await json<FreezeResult>(await client.post('/api/tasks/BIO-043/freeze', { scanCode: preview.scan?.code, acknowledgeFindings: true, acknowledgeRetention: true }), 201);
  return (await json<RunStartResponse>(await client.post('/api/tasks/BIO-043/runs'), 201)).code;
}

beforeEach(async () => {
  mock = new MockAnthropic();
  const url = await mock.start();
  mock.reply = defaultReply;
  test = await makeTestApp({ seed: true, config: { anthropicKey: 'test-key', anthropicBaseUrl: url } });
  await startEngine(test.ctx);
  client = await new Client(test).signIn('maya@helixlab.example');
});
afterEach(async () => {
  overrideAdapter(test.ctx, null);
  await waitForIdle(test.ctx);
  test.close();
  await mock.stop();
});

describe('the Anthropic adapter', () => {
  it('registers the Claude models at boot, pinned, and only once', async () => {
    await startEngine(test.ctx);
    const rows = await test.ctx.db.all<Record<string, unknown>>(`SELECT * FROM models WHERE adapter = 'anthropic' ORDER BY sort`);
    expect(rows.map((row) => row.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(rows[0]).toMatchObject({ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', revision: 'claude-opus-5-5', enabled: 1, is_illustrative: 0 });
  });

  it('calls the Messages API as this model requires, and labels the score judge', async () => {
    const code = await startClaudeRun();
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('complete');

    const [modelCall, judgeCall] = mock.requests;
    expect(mock.requests).toHaveLength(2);
    for (const request of mock.requests) {
      expect(request.__path).toBe('/v1/messages');
      expect(request.__credential).toContain('test-key');
      expect(request.model).toBe('claude-opus-5-5');
      // This model returns a 400 for each of these.
      expect(request).not.toHaveProperty('temperature');
      expect(request).not.toHaveProperty('top_p');
      expect(request).not.toHaveProperty('top_k');
      expect(request).not.toHaveProperty('tool_choice');
      expect(request).not.toHaveProperty('seed');
      expect(request.thinking?.type).not.toBe('disabled');
      // A fallback would answer with a different model than the one pinned.
      expect(request).not.toHaveProperty('fallbacks');
    }
    expect(modelCall?.max_tokens).toBe(8000);
    expect(modelCall?.messages[0].content).toContain('Using E03 and the control checklist');
    expect(modelCall?.messages[0].content).toContain('[E01] MIC assay: 0.25 → 1.00 µg/mL ciprofloxacin');
    expect(judgeCall?.output_config.format.type).toBe('json_schema');
    expect(judgeCall?.system).toContain('untrusted evidence');
    expect(judgeCall?.messages[0].content).toContain('A real-looking answer');
    // The judge is never told which model wrote the answer.
    expect(judgeCall?.messages[0].content).not.toContain('Claude');
    expect(judgeCall?.messages[0].content).not.toContain('claude-opus');

    const page = await json<RunDetailResponse>(await client.get(`/api/runs/${code}`));
    const claude = page.models.find((model) => model.id === 'claude-opus-5-5');
    expect(claude).toMatchObject({ scoreLabel: 'judge', evidenceCode: `EV-${code.slice(4)}-C`, evidenceVerified: true, score: 85 });
    expect(page.models.find((model) => model.id === 'aster-3.2')?.scoreLabel).toBe('demo');
    expect(page.resultsNote).toMatch(/^Mixed scoring: demo scores are synthetic and judge scores come from an LLM judge, not an expert\./);
    expect(page.settingsNotes.join(' ')).toContain('Temperature 0.2 was not applied');
    expect(page.settingsNotes.join(' ')).toContain('Seed 42 was not applied');

    const evidence = await json<EvidenceDetailResponse>(await client.get(`/api/evidence/${claude?.evidenceCode}`));
    expect(evidence.scoreLabel).toBe('judge');
    expect(evidence.synthetic).toBe(false);
    expect(evidence.tamper.verified).toBe(true);
    expect(evidence.settingsNotes).toHaveLength(3);
    expect(evidence.scores[0]?.rationale).toMatch(/^Lost five points on /);

    const sealed = await test.ctx.db.get<{ output_meta: string }>('SELECT output_meta FROM evidence WHERE code = ?', [claude?.evidenceCode]);
    const meta = JSON.parse(sealed?.output_meta as string);
    expect(meta).toMatchObject({ adapter: 'anthropic', synthetic: false, apiModel: 'claude-opus-5-5', responseModel: 'claude-opus-5-5', stopReason: 'end_turn', pinnedSettings: { temperature: 0.2, seed: 42, maxOutputK: 8 }, appliedSettings: { maxTokens: 8000 } });
    expect(meta.scoring).toMatchObject({ scorer: 'llm-judge', judgeModel: 'claude-opus-5-5' });
  });

  it('interrupts safely when the provider times out, then resumes', async () => {
    overrideAdapter(test.ctx, (model) => (model.adapter === 'anthropic' ? createAnthropicAdapter(test.ctx, { timeoutMs: 50, maxRetries: 0 }) : null));
    mock.reply = (body) => (body.output_config?.format ? { hang: true } : { body: textMessage('An answer.') });
    const code = await startClaudeRun();
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('interrupted');
    expect(run.interrupt_reason).toBe('provider_timeout');
    const page = await json<RunDetailResponse>(await client.get(`/api/runs/${code}`));
    expect(page.interruptMessage).toMatch(/^Provider timeout at \d\d:\d\d UTC\. No evidence lost\. Resume only incomplete work\.$/);
    expect(page.models.find((model) => model.id === 'claude-opus-5-5')?.execution).toBe('Output preserved · Scoring interrupted');

    const modelCalls = mock.requests.filter((request) => !request.output_config?.format).length;
    mock.reply = defaultReply;
    await json(await client.post(`/api/runs/${code}/resume`));
    const done = await waitForRun(test.ctx, code);
    expect(done.status).toBe('complete');
    // The captured output was kept, not fetched and billed again.
    expect(mock.requests.filter((request) => !request.output_config?.format)).toHaveLength(modelCalls);
    const output = await test.ctx.db.get<{ output_text: string }>(`SELECT output_text FROM evidence e JOIN runs r ON r.id = e.run_id WHERE r.code = ? AND e.model_id = 'claude-opus-5-5'`, [code]);
    expect(output?.output_text).toBe('An answer.');
  });

  it('treats a rate limit as temporary', async () => {
    overrideAdapter(test.ctx, (model) => (model.adapter === 'anthropic' ? createAnthropicAdapter(test.ctx, { maxRetries: 0 }) : null));
    mock.reply = () => ({ status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down.' } } });
    const code = await startClaudeRun();
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('interrupted');
    expect(run.interrupt_message).toContain('The provider is rate limiting requests.');
  });

  it('fails plainly on a bad key rather than retrying forever', async () => {
    overrideAdapter(test.ctx, (model) => (model.adapter === 'anthropic' ? createAnthropicAdapter(test.ctx, { maxRetries: 0 }) : null));
    mock.reply = () => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const code = await startClaudeRun();
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('failed');
    expect(run.interrupt_message).toBe('The provider rejected this server’s API key.');
  });

  it('reports a refusal instead of quietly using another model', async () => {
    mock.reply = () => ({ body: { ...textMessage(''), content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio', explanation: 'Declined.' } } });
    const code = await startClaudeRun();
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('failed');
    expect(run.interrupt_message).toBe('Claude Opus 5.5 declined this request (category: bio). No fallback model was used, so no score was published.');
    const sealed = await test.ctx.db.get(`SELECT 1 AS ok FROM evidence e JOIN runs r ON r.id = e.run_id WHERE r.code = ? AND e.model_id = 'claude-opus-5-5'`, [code]);
    expect(sealed).toBeUndefined();
  });

  it('reports a judge refusal too, keeping the captured output', async () => {
    mock.reply = (body) => (body.output_config?.format ? { body: { ...textMessage(''), content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined.' } } } : { body: textMessage('An answer.') });
    const code = await startClaudeRun();
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('failed');
    expect(run.interrupt_message).toBe('The judge declined this request (category: cyber). No fallback model was used, so no score was published.');
    const output = await test.ctx.db.get<{ output_text: string; scores: string | null }>(`SELECT output_text, scores FROM run_outputs o JOIN runs r ON r.id = o.run_id WHERE r.code = ? AND o.model_id = 'claude-opus-5-5'`, [code]);
    expect(output).toEqual({ output_text: 'An answer.', scores: null });
  });

  it('does not publish a judge score outside the rubric', async () => {
    mock.reply = (body) => {
      if (!body.output_config?.format) return { body: textMessage('An answer.') };
      const payload = JSON.parse(body.messages[0].content) as { rubric: { name: string }[] };
      return { body: textMessage(JSON.stringify({ criteria: payload.rubric.map((criterion) => ({ name: criterion.name, score: 1000, rationale: 'Too generous.' })) })) };
    };
    const code = await startClaudeRun();
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('interrupted');
    expect(run.interrupt_message).toContain('The judge returned an invalid score');
    const output = await test.ctx.db.get<{ scores: string | null }>(`SELECT scores FROM run_outputs o JOIN runs r ON r.id = o.run_id WHERE r.code = ? AND o.model_id = 'claude-opus-5-5'`, [code]);
    expect(output?.scores).toBeNull();
  });

  it('records a truncated answer as truncated', async () => {
    mock.reply = (body) => (body.output_config?.format ? { body: textMessage(judgeAnswer(body)) } : { body: textMessage('A cut-off answ', { stop_reason: 'max_tokens' }) });
    const code = await startClaudeRun();
    await waitForRun(test.ctx, code);
    const sealed = await test.ctx.db.get<{ output_meta: string }>(`SELECT e.output_meta FROM evidence e JOIN runs r ON r.id = e.run_id WHERE r.code = ? AND e.model_id = 'claude-opus-5-5'`, [code]);
    expect(JSON.parse(sealed?.output_meta as string)).toMatchObject({ truncated: true, stopReason: 'max_tokens' });
  });

  it('fails plainly when thinking used the whole output limit', async () => {
    mock.reply = () => ({ body: textMessage('', { content: [{ type: 'thinking', thinking: '', signature: 'sig' }], stop_reason: 'max_tokens' }) });
    const code = await startClaudeRun();
    const run = await waitForRun(test.ctx, code);
    expect(run.status).toBe('failed');
    expect(run.interrupt_message).toBe('Claude Opus 5.5 used the whole 8k output limit before answering.');
  });
});

describe('without a key', () => {
  it('keeps the model visible but unselectable, and refuses to freeze or run it', async () => {
    test.ctx.config.anthropicKey = null;
    const { options } = await json<EditorNewResponse>(await client.get('/api/tasks/editor-options'));
    expect(options.models.find((model) => model.id === 'claude-opus-5-5')).toMatchObject({ available: false, reason: 'Unavailable: no Anthropic API key is set on this server.' });

    const draft = (await json<{ draft: Record<string, unknown> }>(await client.get('/api/tasks/BIO-043/draft'))).draft;
    const saved = await json<{ validation: { fields: Record<string, string> } }>(await client.put('/api/tasks/BIO-043/draft', { ...draft, modelIds: ['aster-3.2', 'claude-opus-5-5'] }));
    expect(saved.validation.fields.modelIds).toBe('Claude Opus 5.5: Unavailable: no Anthropic API key is set on this server.');
  });

  it('does not register the model at boot', async () => {
    const plain = await makeTestApp({ seed: true });
    await startEngine(plain.ctx);
    expect(await plain.ctx.db.all(`SELECT id FROM models WHERE adapter = 'anthropic'`)).toEqual([]);
    await waitForIdle(plain.ctx);
    plain.close();
  });
});
