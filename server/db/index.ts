import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array | boolean | undefined;

/**
 * The database seam. Everything above this file uses only these methods and portable SQL
 * (`?` placeholders, ON CONFLICT, RETURNING), so a Postgres adapter can replace SQLite here.
 */
export interface Db {
  all<T = Record<string, any>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T = Record<string, any>>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** Runs fn in one transaction. Do not await network calls inside it: writes queue behind it. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): void;
}

const schemaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema');

function bind(params: SqlValue[] = []): (string | number | bigint | null | Uint8Array)[] {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = database.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };

  // SQLite has one connection, so statements from other requests must not land inside an open
  // transaction. Work queues on a promise chain; code inside tx() runs straight through.
  const inTx = new AsyncLocalStorage<boolean>();
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T> | T): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };
  const schedule = <T>(work: () => T): Promise<T> => (inTx.getStore() ? Promise.resolve().then(work) : enqueue(work));

  return {
    all: <T>(sql: string, params?: SqlValue[]) => schedule(() => prepare(sql).all(...bind(params)) as T[]),
    get: <T>(sql: string, params?: SqlValue[]) => schedule(() => prepare(sql).get(...bind(params)) as T | undefined),
    run: (sql, params) =>
      schedule(() => {
        const result = prepare(sql).run(...bind(params));
        return { changes: Number(result.changes) };
      }),
    tx: <T>(fn: () => Promise<T>) => {
      if (inTx.getStore()) return fn();
      return enqueue(() =>
        inTx.run(true, async () => {
          database.exec('BEGIN IMMEDIATE');
          try {
            const result = await fn();
            database.exec('COMMIT');
            return result;
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
        }),
      );
    },
    exec: (sql) => schedule(() => database.exec(sql)),
    close: () => {
      statements.clear();
      database.close();
    },
  };
}

/** Applies server/db/schema/*.sql in name order. Every statement is idempotent. */
export async function migrate(db: Db): Promise<void> {
  for (const name of readdirSync(schemaDir).filter((file) => file.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(path.join(schemaDir, name), 'utf8'));
  }
}
