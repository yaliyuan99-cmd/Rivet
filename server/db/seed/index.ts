import type { AppContext } from '../../context.ts';
import { seedBackbone } from './backbone.ts';
import { seedWorkspaceExtras } from './workspace.ts';
import { seedPublished } from './published.ts';
import { seedAssurance } from './assurance.ts';
import { seedExternal } from './external.ts';
import { seedAdmin } from './admin.ts';

/** The synthetic demo story from the frames. Runs once, on an empty database, when RIVET_DEMO is on. */
export async function seedIfEmpty(ctx: AppContext): Promise<void> {
  await seedReference(ctx);
  if (!ctx.config.demo) return;
  if (await ctx.db.get('SELECT 1 AS ok FROM users LIMIT 1')) return;
  const refs = await seedBackbone(ctx);
  await seedWorkspaceExtras(ctx, refs);
  await seedPublished(ctx, refs);
  await seedAssurance(ctx, refs);
  await seedExternal(ctx, refs);
  await seedAdmin(ctx, refs);
}

/** Reference data every instance needs, demo or not. */
export async function seedReference(ctx: AppContext): Promise<void> {
  const domains = [
    ['biology', 'Biology', 'Microbiology', 'BIO', 1],
    ['chemistry', 'Chemistry', 'Analytical chemistry', 'CHEM', 2],
    ['computer-science', 'Computer science', 'Software systems', 'CS', 3],
  ] as const;
  for (const [id, name, field, prefix, sort] of domains) {
    await ctx.db.run(`INSERT INTO domains (id, name, field, prefix, sort) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`, [id, name, field, prefix, sort]);
  }
}
