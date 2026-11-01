import type { AppContext } from '../../context.ts';
import { newId, setCounter } from '../../lib/ids.ts';
import { DEMO_CALLBACK_PATH, DEMO_CLIENT_ID } from '../../routes/external.ts';
import type { SeedRefs } from './backbone.ts';

/**
 * The demo OAuth client, registered against this instance so the whole flow runs on one machine.
 * No connection is seeded: the frames' OAUTH-042 is the first request someone actually makes.
 */
export async function seedExternal(ctx: AppContext, _refs: SeedRefs): Promise<void> {
  await ctx.db.run(
    `INSERT INTO oauth_clients (id, client_id, name, developer, description, redirect_uri, is_synthetic, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [newId(), DEMO_CLIENT_ID, 'Atlas Research Client', 'Atlas Tools', 'Synthetic demo integration', `${ctx.config.publicUrl}${DEMO_CALLBACK_PATH}`, '2026-10-15T09:00:00.000Z'],
  );
  await setCounter(ctx.db, 'oauth', 41);
}
