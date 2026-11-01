import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { AppContext, AppEnv } from './context.ts';
import { csrfProtection, loadUser } from './lib/auth.ts';
import { HttpError } from './lib/errors.ts';
import { registerAuth } from './routes/auth.ts';
import { registerDev } from './routes/dev.ts';
import { registerWorkspaces } from './routes/workspaces.ts';
import { registerProfile } from './routes/profile.ts';
import { registerHome } from './routes/home.ts';
import { registerTasks } from './routes/tasks.ts';
import { registerRuns } from './routes/runs.ts';
import { registerExpert } from './routes/expert.ts';
import { registerPublished } from './routes/published.ts';
import { registerDatasets } from './routes/datasets.ts';
import { registerAssurance } from './routes/assurance.ts';
import { registerExternal } from './routes/external.ts';
import { registerAdvisor } from './routes/advisor.ts';
import { registerAdmin } from './routes/admin.ts';

const MB = 1024 * 1024;
/** Paths that accept file uploads; everything else is a small JSON body. */
const UPLOAD_PATHS = ['/api/datasets/uploads', '/api/uploads'];

export function createApp(ctx: AppContext) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('ctx', ctx);
    c.set('user', null);
    await next();
  });
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use('/api/*', async (c, next) => {
    const isUpload = UPLOAD_PATHS.some((prefix) => c.req.path.startsWith(prefix));
    return bodyLimit({
      maxSize: isUpload ? 105 * MB : 2 * MB,
      onError: () => {
        throw new HttpError(413, 'too_large', isUpload ? 'This file is larger than the 100 MB upload limit.' : 'This request is too large.');
      },
    })(c, next);
  });

  // /api/external is authenticated by bearer token, so cookies and CSRF do not apply there.
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/external/')) return next();
    return csrfProtection(c, next);
  });
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/external/')) return next();
    return loadUser(c, next);
  });

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  registerAuth(app);
  registerDev(app);
  registerWorkspaces(app);
  registerProfile(app);
  registerHome(app);
  registerTasks(app);
  registerRuns(app);
  registerExpert(app);
  registerPublished(app);
  registerDatasets(app);
  registerAssurance(app);
  registerExternal(app);
  registerAdvisor(app);
  registerAdmin(app);

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: { code: 'not_found', message: 'This API route does not exist.' } }, 404);
    return c.text('Not found', 404);
  });

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: { code: error.code, message: error.message, fields: error.fields } }, error.status as 400);
    }
    console.error(`[${c.req.method} ${c.req.path}]`, error);
    return c.json({ error: { code: 'server_error', message: 'Something went wrong on the server. Your data was not changed unless this page says otherwise.' } }, 500);
  });

  return app;
}

export type RivetApp = ReturnType<typeof createApp>;
