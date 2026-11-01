import type { AppContext } from '../../context.ts';
import { newId } from '../../lib/ids.ts';
import type { SeedRefs } from './backbone.ts';

/**
 * What the workspace and profile frames need beyond the backbone: Maya's synthetic connected
 * profiles. They have no profile URL on purpose: a seeded handle must not link to a real person.
 * No invitation for Dr. Patel: the members frame shows that row as an unsent preview of the form.
 */
export async function seedWorkspaceExtras(ctx: AppContext, refs: SeedRefs): Promise<void> {
  const connections = [
    ['github', 'synthetic-github-mayachen-demo', '@mayachen-demo', 'Public identity'],
    ['huggingface', 'synthetic-huggingface-maya-helix-demo', '@maya-helix-demo', 'Public profile only'],
  ] as const;
  for (const [provider, providerUserId, handle, visibilityNote] of connections) {
    await ctx.db.run(
      `INSERT INTO connected_accounts (id, user_id, provider, provider_user_id, handle, profile_url, visibility_note, is_synthetic, connected_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?)`,
      [newId(), refs.users.maya, provider, providerUserId, handle, visibilityNote, '2026-10-15T13:25:00.000Z'],
    );
  }
}
