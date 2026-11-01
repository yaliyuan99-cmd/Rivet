import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const DEMO_PASSWORD = 'rivet-demo-2026';
export const MAYA = 'maya@helixlab.example';
export const SAMIRA = 'samira@northbridge.example';
export const ALEX = 'alex@rivet.example';
export const LENA = 'lena@northbridge.example';

const WRITE = { 'X-Rivet-Request': '1' };

/** Signs in through the API for tests about something other than the sign-in form. */
export async function signIn(page: Page, email: string, password = DEMO_PASSWORD) {
  const res = await page.request.post('/api/auth/signin', { headers: WRITE, data: { email, password } });
  expect(res.ok(), `sign in as ${email}`).toBeTruthy();
}

export async function signOut(page: Page) {
  await page.request.post('/api/auth/signout', { headers: WRITE });
}

/** The newest link in the dev outbox for an address and purpose. */
export async function outboxLink(request: APIRequestContext, to: string, purpose?: string): Promise<string> {
  const res = await request.get('/api/dev/outbox');
  const { messages } = (await res.json()) as { messages: { to: string; link: string | null; purpose: string }[] };
  const message = messages.find((m) => m.to === to && (!purpose || m.purpose === purpose));
  if (!message?.link) throw new Error(`No outbox link for ${to}`);
  const url = new URL(message.link);
  return `${url.pathname}${url.search}`;
}

/** A unique address, since end-to-end tests share one database. */
export function uniqueEmail(prefix = 'e2e') {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@lab.example`;
}

export async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((value) => localStorage.setItem('rivet-theme', value), theme);
}
