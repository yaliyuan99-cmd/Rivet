import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/app.ts';
import { loadConfig, type Config } from '../../server/config.ts';
import type { AppContext } from '../../server/context.ts';
import { migrate, openDb } from '../../server/db/index.ts';
import { DEMO_PASSWORD } from '../../server/db/seed/backbone.ts';
import { seedIfEmpty, seedReference } from '../../server/db/seed/index.ts';
import { hashPassword } from '../../server/lib/crypto.ts';
import { newId } from '../../server/lib/ids.ts';
import { localStorage } from '../../server/lib/storage.ts';

export { DEMO_PASSWORD };

export interface TestApp {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  /** Moves the clock the app reads; use it to test expiry rules. */
  setNow: (date: Date | string) => void;
  advance: (ms: number) => void;
  close: () => void;
}

/**
 * A fresh app on a temp database. seed: true loads the whole demo story; false gives an empty
 * instance with reference data only. Stage delay is 0 so runs finish immediately.
 */
export async function makeTestApp(options: { seed?: boolean; config?: Partial<Config> } = {}): Promise<TestApp> {
  const dir = mkdtempSync(path.join(tmpdir(), 'rivet-test-'));
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv, { dataDir: dir, demo: options.seed ?? false, stageMs: 0, publicUrl: 'http://localhost:8787', ...options.config });
  const db = openDb(path.join(dir, 'rivet.db'));
  await migrate(db);
  let current: Date | null = null;
  const ctx: AppContext = { db, config, storage: localStorage(dir), now: () => current ?? new Date() };
  if (options.seed) await seedIfEmpty(ctx);
  else await seedReference(ctx);
  return {
    ctx,
    app: createApp(ctx),
    setNow: (date) => {
      current = new Date(date);
    },
    advance: (ms) => {
      current = new Date((current ?? new Date()).getTime() + ms);
    },
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A browser stand-in: keeps cookies and sends the header every write needs. */
export class Client {
  private cookies = new Map<string, string>();
  private test: TestApp;

  constructor(test: TestApp) {
    this.test = test;
  }

  async request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const isForm = body instanceof FormData;
    const res = await this.test.app.request(url, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { 'X-Rivet-Request': '1' }),
        ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, value] = (pair as string).split('=');
      if (value) this.cookies.set(name as string, value);
      else this.cookies.delete(name as string);
    }
    return res;
  }

  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, body: unknown = {}) {
    return this.request('POST', url, body);
  }
  put(url: string, body: unknown = {}) {
    return this.request('PUT', url, body);
  }
  patch(url: string, body: unknown = {}) {
    return this.request('PATCH', url, body);
  }
  delete(url: string, body?: unknown) {
    return this.request('DELETE', url, body);
  }

  /** Signs in as a seeded demo account or any account made with makeUser. */
  async signIn(email: string, password = DEMO_PASSWORD): Promise<this> {
    const res = await this.post('/api/auth/signin', { email, password });
    if (!res.ok) throw new Error(`Sign-in failed for ${email}: ${res.status} ${await res.text()}`);
    return this;
  }
}

export const TEST_PASSWORD = DEMO_PASSWORD;

/** Inserts a verified account directly, for tests about something other than sign-up. */
export async function makeUser(test: TestApp, spec: { name?: string; email: string; role?: 'member' | 'admin'; verified?: boolean }): Promise<string> {
  const id = newId();
  const now = test.ctx.now().toISOString();
  await test.ctx.db.run(
    `INSERT INTO users (id, email, name, password_hash, email_verified_at, role, terms_accepted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, spec.email, spec.name ?? spec.email.split('@')[0], await hashPassword(TEST_PASSWORD), spec.verified === false ? null : now, spec.role ?? 'member', now, now, now],
  );
  return id;
}

/** A workspace owned by a user, active for them. */
export async function makeWorkspace(test: TestApp, ownerId: string, name = 'Test Lab'): Promise<string> {
  const id = newId();
  const now = test.ctx.now().toISOString();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 6)}`;
  await test.ctx.db.run(`INSERT INTO workspaces (id, code, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, `WS-${id.slice(0, 6).toUpperCase()}`, name, slug, ownerId, now]);
  await test.ctx.db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)`, [newId(), id, ownerId, now]);
  await test.ctx.db.run(`UPDATE users SET active_workspace_id = ? WHERE id = ?`, [id, ownerId]);
  return id;
}

/** Latest message sent to an address (the dev outbox). */
export async function lastMail(test: TestApp, to: string) {
  return test.ctx.db.get<{ subject: string; body_text: string; link: string | null; purpose: string }>(`SELECT subject, body_text, link, purpose FROM outbox WHERE to_email = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, [to]);
}
