import type { Context as HonoContext } from 'hono';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import type { Storage } from './lib/storage.ts';

/** Shared services. Tests build one with a temp database and a controllable clock. */
export interface AppContext {
  db: Db;
  config: Config;
  storage: Storage;
  /** The clock everything uses, so expiry rules can be tested. */
  now: () => Date;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  email_verified_at: string | null;
  role: 'member' | 'admin';
  bio: string;
  active_workspace_id: string | null;
  terms_accepted_at: string | null;
  is_synthetic: number;
  created_at: string;
  updated_at: string;
}

export interface AppEnv {
  Variables: {
    ctx: AppContext;
    user: UserRow | null;
  };
}

export type C = HonoContext<AppEnv>;

export const iso = (date: Date) => date.toISOString();
export const nowIso = (ctx: AppContext) => ctx.now().toISOString();
export const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
