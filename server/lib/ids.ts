import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.ts';

export const newId = () => randomUUID();

/**
 * Next value of a named counter. The first call returns `initial`; seeds set counters past the
 * authored fixtures so BIO-044 follows BIO-043 and RUN-1043 follows RUN-1042.
 */
export async function nextCounter(db: Db, name: string, initial = 1): Promise<number> {
  const row = await db.get<{ value: number }>(
    `INSERT INTO counters (name, value) VALUES (?, ?)
     ON CONFLICT (name) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [name, initial],
  );
  return row!.value;
}

export async function setCounter(db: Db, name: string, value: number): Promise<void> {
  await db.run(`INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value`, [name, value]);
}

export const pad3 = (n: number) => String(n).padStart(3, '0');
