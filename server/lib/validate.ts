import { z } from 'zod';
import type { C } from '../context.ts';
import { badRequest, invalid } from './errors.ts';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || 'form';
    if (!fields[key]) fields[key] = issue.message;
  }
  throw invalid(fields);
}

/** Reads and validates a JSON body. Zod messages are shown to the user, so write them as sentences. */
export async function readJson<T extends z.ZodType>(c: C, schema: T): Promise<z.output<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('The request body must be JSON.');
  }
  return parse(schema, body);
}

export const trimmed = (message: string, max = 500) => z.string({ error: message }).trim().min(1, message).max(max, `Keep this under ${max} characters.`);
