/** Helpers for the demo client. A real external client keeps these on its own side of the boundary. */

export const ATLAS_CLIENT_ID = 'client_atlas_demo';
export const ATLAS_SCOPES = 'tasks:read reports:read advisor:query';

const PENDING_KEY = 'atlas-demo:pending';

export interface AtlasPending {
  state: string;
  verifier: string;
  taskCode: string;
  redirectUri: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const randomValue = () => base64Url(crypto.getRandomValues(new Uint8Array(32)));

/** Web Crypto's digest only exists on https and localhost. */
export const webCryptoAvailable = () => typeof crypto !== 'undefined' && Boolean(crypto.subtle);

/** A new RFC 7636 verifier, its S256 challenge, and a new state. */
export async function createAttempt(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = randomValue();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)), state: randomValue() };
}

export function savePending(pending: AtlasPending): void {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

/** One use: whoever reads it clears it, so a response can only be matched once. */
export function takePending(): AtlasPending | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as AtlasPending) : null;
  } catch {
    return null;
  }
}
