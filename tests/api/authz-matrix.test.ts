import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, makeTestApp, makeUser, type TestApp } from '../helpers/app.ts';

/**
 * Walks every API route the server registers, so a route added without a permission check fails here
 * even if nobody remembered to write a test for it. Parameters point at real, private seeded rows.
 */
let test: TestApp;
let routes: { method: string; path: string }[];
let helixId: string;
let mayaId: string;
let uploadId: string;

const PUBLIC = new Set([
  'GET /api/health',
  'GET /api/session',
  'POST /api/auth/signup',
  'POST /api/auth/signin',
  'POST /api/auth/signout',
  'POST /api/auth/verify',
  'POST /api/auth/forgot',
  'POST /api/auth/reset',
  'GET /api/dev/outbox',
  'GET /api/auth/github/start',
  'GET /api/auth/github/callback',
  'POST /oauth/token',
  // An invitee may not have an account yet; the token itself is the secret, and only its hash is stored.
  'GET /api/invitations/:token',
  // The name a consent screen shows before sign-in. Nothing private.
  'GET /api/oauth/clients/:clientId',
  // Browser navigations: a visitor is redirected within this site (asserted below).
  'GET /api/profile/connections/:provider/start',
  'GET /api/profile/connections/:provider/callback',
]);

function fill(path: string): string {
  const has = (prefix: string) => path.startsWith(prefix);
  const code = has('/api/tasks') ? 'BIO-042'
    : has('/api/runs') ? 'RUN-1042'
    : has('/api/evidence') ? 'EV-1042-A'
    : has('/api/applications') || has('/api/admin/credentials') ? 'APP-029'
    : has('/api/reviews') || has('/api/admin/adjudications') ? 'REVIEW-042'
    : has('/api/reports') || has('/api/external/reports') ? 'RPT-BIO-042'
    : has('/api/datasets') ? 'DS-BIO-07'
    : has('/api/assurance/traces') ? 'TRACE-042'
    : has('/api/assurance/regressions') ? 'REG-BIO-042'
    : has('/api/assurance/gates') ? 'GATE-019'
    : has('/api/external/tasks') ? 'BIO-042'
    : 'NOPE-000';
  return path
    .replace(':code', code)
    .replace(':version', has('/api/datasets') ? '1.0' : 'v1.0')
    .replace(':candidate', 'rc.18')
    .replace(':slug', 'helix-lab')
    .replace(':provider', 'github')
    .replace(':clientId', 'client_atlas_demo')
    .replace(':userId', mayaId)
    .replace(':token', 'not-a-token')
    .replace(':invitationId', 'not-an-id')
    .replace(':id', has('/api/workspaces') ? helixId : has('/api/uploads') ? uploadId : has('/api/admin/models') ? 'aster-3.2' : 'not-an-id');
}

const key = (route: { method: string; path: string }) => `${route.method} ${route.path}`;

beforeAll(async () => {
  test = await makeTestApp({ seed: true });
  const seen = new Set<string>();
  routes = [];
  for (const route of test.app.routes) {
    if (route.method === 'ALL' || seen.has(key(route))) continue;
    seen.add(key(route));
    routes.push({ method: route.method, path: route.path });
  }
  helixId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'WS-HELIX'`))?.id as string;
  mayaId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'maya@helixlab.example'`))?.id as string;
  uploadId = (await test.ctx.db.get<{ id: string }>(`SELECT id FROM uploads WHERE filename = 'ortiz-phd-demo.pdf'`))?.id as string;
});
afterAll(() => test.close());

const send = (client: Client, route: { method: string; path: string }) => client.request(route.method, fill(route.path), route.method === 'GET' ? undefined : {});

describe('every API route', () => {
  it('has been found', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('refuses a visitor who is not signed in, unless it is meant to be public', async () => {
    const leaks: string[] = [];
    for (const route of routes) {
      if (PUBLIC.has(key(route))) continue;
      const res = await send(new Client(test), route);
      if (res.status !== 401) leaks.push(`${key(route)} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('keeps a visitor who opens a connection link on this site', async () => {
    for (const path of ['/api/profile/connections/github/start', '/api/profile/connections/github/callback']) {
      const res = await new Client(test).get(path);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toMatch(/^\/(?!\/)/);
    }
  });

  it('refuses a verified outsider everything private, and never fails with a server error', async () => {
    await makeUser(test, { email: 'outsider@lab.example', name: 'Olive Outsider' });
    const outsider = await new Client(test).signIn('outsider@lab.example');
    // Open to any verified account: their own lists and forms, published reports and the leaderboard.
    const openToVerified = new Set([
      'GET /api/auth/verification',
      'GET /api/workspaces/slug-check',
      'GET /api/workspaces/current',
      'GET /api/profile',
      'GET /api/home',
      'GET /api/tasks/editor-options',
      'GET /api/tasks/starter-pack.csv',
      'GET /api/tasks',
      'GET /api/applications',
      'GET /api/reviews',
      'GET /api/leaderboards',
      'GET /api/leaderboards/methodology',
      'GET /api/reports',
      'GET /api/reports/:code/:version',
      'GET /api/reports/:code/:version/download',
      'GET /api/datasets',
      'GET /api/datasets/upload-context',
      'GET /api/assurance',
      'GET /api/oauth/clients/:clientId',
      'GET /api/advisor/tasks',
      'GET /api/advisor/thread',
      'GET /api/profile/connections/:provider/start',
      'GET /api/profile/connections/:provider/callback',
      'PATCH /api/profile',
    ]);
    const leaks: string[] = [];
    for (const route of routes) {
      if (PUBLIC.has(key(route))) continue;
      const res = await send(outsider, route);
      if (res.status >= 500) leaks.push(`${key(route)} -> server error ${res.status}`);
      else if (res.status < 400 && !openToVerified.has(key(route))) leaks.push(`${key(route)} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('keeps every /api/admin route from a signed-in non-admin, even a workspace owner', async () => {
    const maya = await new Client(test).signIn('maya@helixlab.example');
    const leaks: string[] = [];
    for (const route of routes.filter((item) => item.path.startsWith('/api/admin'))) {
      const res = await send(maya, route);
      if (res.status !== 403) leaks.push(`${key(route)} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('refuses a write without the request header, so another site cannot forge one', async () => {
    const leaks: string[] = [];
    for (const route of routes) {
      if (route.method === 'GET' || !route.path.startsWith('/api/') || route.path.startsWith('/api/external/')) continue;
      const res = await test.app.request(fill(route.path), { method: route.method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.status !== 403) leaks.push(`${key(route)} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });
});
