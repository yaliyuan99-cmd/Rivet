/**
 * Keeps an invitation link across signing in, or signing up and verifying, which all end on Home.
 * The accept page remembers the link while its visitor cannot accept yet; Home sends them back.
 * Browser storage can be refused: without it, reopening the email link still works.
 */
const KEY = 'rivet-pending-invitation';
const LIFETIME_MS = 60 * 60 * 1000;

export function rememberInvitation(path: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    // Nothing to do: see above.
  }
}

export function forgetInvitation(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: see above.
  }
}

export function pendingInvitation(): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { path?: unknown; at?: unknown } | null;
    if (typeof stored?.path !== 'string' || !stored.path.startsWith('/invitations/')) return null;
    return typeof stored.at === 'number' && Date.now() - stored.at < LIFETIME_MS ? stored.path : null;
  } catch {
    return null;
  }
}
