import type { Hono } from 'hono';
import { z } from 'zod';
import type { AdvisorCitation, AdvisorMessage, AdvisorMode, AdvisorQueryResponse, AdvisorTamper, AdvisorTaskList, AdvisorTaskOption, AdvisorThread } from '../../shared/types/advisor.ts';
import type { AppContext, AppEnv, UserRow } from '../context.ts';
import { answerQuestion, authorizedScope, type AdvisorScope, type AdvisorTaskRow, type AdvisorVersionRow } from '../engine/advisor.ts';
import { audit } from '../lib/audit.ts';
import { requireVerified } from '../lib/auth.ts';
import { notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { canReadTask } from '../lib/permissions.ts';
import { rateLimit } from '../lib/rateLimit.ts';
import { readJson, trimmed } from '../lib/validate.ts';

interface MessageRow {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: string;
  insufficient: number;
  mode: AdvisorMode;
  mode_note: string | null;
  seq: number;
  created_at: string;
}

function messageDto(row: MessageRow): AdvisorMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    citations: JSON.parse(row.citations) as AdvisorCitation[],
    insufficient: Boolean(row.insufficient),
    mode: row.mode,
    modeNote: row.mode_note,
    createdAt: row.created_at,
  };
}

/** A task code plus an optional version; the newest frozen version when none is named. Private means 404. */
async function resolveVersion(ctx: AppContext, user: UserRow, code: string, requested?: string): Promise<{ task: AdvisorTaskRow; version: AdvisorVersionRow }> {
  const task = await ctx.db.get<AdvisorTaskRow>('SELECT * FROM tasks WHERE code = ?', [code.trim().toUpperCase()]);
  if (!task || !(await canReadTask(ctx, user, task)).allowed) throw notFound();
  const version = requested
    ? await ctx.db.get<AdvisorVersionRow>('SELECT * FROM task_versions WHERE task_id = ? AND version = ?', [task.id, requested.replace(/^v/i, '')])
    : task.latest_version_id
      ? await ctx.db.get<AdvisorVersionRow>('SELECT * FROM task_versions WHERE id = ?', [task.latest_version_id])
      : undefined;
  if (!version) throw notFound(`${task.code} has no frozen version to ask about yet.`);
  return { task, version };
}

function chooseTamper(scope: AdvisorScope, messages: AdvisorMessage[]): AdvisorTamper | null {
  const failing = scope.tamperCandidates.find((item) => !item.verified);
  if (failing) return failing;
  const lastAnswer = [...messages].reverse().find((message) => message.role === 'assistant');
  for (const citation of lastAnswer?.citations ?? []) {
    const cited = scope.tamperCandidates.find((item) => item.code === citation.label);
    if (cited) return cited;
  }
  return scope.tamperCandidates[0] ?? null;
}

export function registerAdvisor(app: Hono<AppEnv>) {
  /** Frozen versions this user may read, on this request. */
  app.get('/api/advisor/tasks', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const rows = await ctx.db.all<AdvisorTaskRow & { version_id: string; version: string; version_title: string }>(
      `SELECT t.*, tv.id AS version_id, tv.version AS version, tv.title AS version_title
       FROM task_versions tv JOIN tasks t ON t.id = tv.task_id ORDER BY tv.frozen_at DESC, t.code DESC`,
    );
    const allowed = new Map<string, boolean>();
    const items: AdvisorTaskOption[] = [];
    for (const row of rows) {
      if (!allowed.has(row.id)) allowed.set(row.id, (await canReadTask(ctx, user, row)).allowed);
      if (allowed.get(row.id)) items.push({ code: row.code, version: row.version, label: `${row.code} v${row.version}`, title: row.version_title, latest: row.latest_version_id === row.version_id });
    }
    const newest = await ctx.db.get<{ code: string; version: string }>(
      `SELECT t.code, tv.version FROM advisor_threads th
       JOIN task_versions tv ON tv.id = th.task_version_id JOIN tasks t ON t.id = tv.task_id
       WHERE th.user_id = ? ORDER BY (SELECT MAX(m.created_at) FROM advisor_messages m WHERE m.thread_id = th.id) DESC LIMIT 1`,
      [user.id],
    );
    const readableNewest = newest && items.some((item) => item.code === newest.code && item.version === newest.version) ? newest : undefined;
    const fallback = items.find((item) => item.latest) ?? items[0];
    const body: AdvisorTaskList = { items, defaultTask: readableNewest ?? (fallback ? { code: fallback.code, version: fallback.version } : null) };
    return c.json(body);
  });

  app.get('/api/advisor/thread', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const { task, version } = await resolveVersion(ctx, user, c.req.query('task') ?? '', c.req.query('version'));
    const scope = await authorizedScope(ctx, user, task, version);
    const thread = await ctx.db.get<{ id: string }>('SELECT id FROM advisor_threads WHERE user_id = ? AND task_version_id = ?', [user.id, version.id]);
    const rows = thread ? await ctx.db.all<MessageRow>('SELECT * FROM advisor_messages WHERE thread_id = ? ORDER BY seq', [thread.id]) : [];
    const messages = rows.map(messageDto);
    const body: AdvisorThread = {
      task: { code: task.code, version: version.version, label: `${task.code} v${version.version}`, title: version.title, synthetic: Boolean(task.is_synthetic) },
      sourcePack: scope.sourcePack,
      sourcePackWithheld: scope.sourcePackWithheld,
      runCode: scope.runCode,
      mode: ctx.config.anthropicKey ? 'llm' : 'retrieval',
      messages,
      tamper: chooseTamper(scope, messages),
      quarantined: scope.quarantined,
      recordCount: scope.records.length,
      askerName: user.name,
    };
    return c.json(body);
  });

  app.post('/api/advisor/query', async (c) => {
    const ctx = c.get('ctx');
    const user = requireVerified(c);
    const input = await readJson(
      c,
      z.object({
        task: trimmed('Choose a frozen task to ask about.', 40),
        version: z.string().max(20).optional(),
        question: trimmed('Enter a question to ask Audit Advisor.', 2000),
      }),
    );
    await rateLimit(ctx, `advisor:${user.id}`, 30, 60, 'Too many questions in a minute. Wait a moment and try again.');
    const { task, version } = await resolveVersion(ctx, user, input.task, input.version);
    const outcome = await answerQuestion(ctx, user, task, version, input.question);

    // The model call is over before the transaction starts. These two rows are all Advisor ever writes.
    const body = await ctx.db.tx(async () => {
      const now = ctx.now().toISOString();
      let thread = await ctx.db.get<{ id: string }>('SELECT id FROM advisor_threads WHERE user_id = ? AND task_version_id = ?', [user.id, version.id]);
      if (!thread) {
        thread = { id: newId() };
        await ctx.db.run('INSERT INTO advisor_threads (id, user_id, task_version_id, created_at) VALUES (?, ?, ?, ?)', [thread.id, user.id, version.id, now]);
      }
      const last = await ctx.db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM advisor_messages WHERE thread_id = ?', [thread.id]);
      const start = (last?.seq ?? 0) + 1;
      const question: MessageRow = { id: newId(), thread_id: thread.id, role: 'user', content: input.question, citations: '[]', insufficient: 0, mode: outcome.mode, mode_note: null, seq: start, created_at: now };
      const answer: MessageRow = { id: newId(), thread_id: thread.id, role: 'assistant', content: outcome.content, citations: JSON.stringify(outcome.citations), insufficient: outcome.insufficient ? 1 : 0, mode: outcome.mode, mode_note: outcome.modeNote, seq: start + 1, created_at: now };
      for (const row of [question, answer]) {
        await ctx.db.run(
          `INSERT INTO advisor_messages (id, thread_id, role, content, citations, insufficient, mode, mode_note, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.thread_id, row.role, row.content, row.citations, row.insufficient, row.mode, row.mode_note, row.seq, row.created_at],
        );
      }
      await audit(ctx, {
        actorId: user.id,
        action: 'advisor.query',
        subjectType: 'task',
        subjectId: task.id,
        subjectCode: `${task.code} v${version.version}`,
        workspaceId: task.workspace_id,
        detail: { mode: outcome.mode, insufficient: outcome.insufficient, citations: outcome.citations.map((citation) => citation.label) },
      });
      return { question: messageDto(question), answer: messageDto(answer) } satisfies AdvisorQueryResponse;
    });
    return c.json(body);
  });
}
