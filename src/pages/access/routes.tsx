import type { SliceRoutes } from '../../lib/routes.ts';
import { page } from '../../lib/routes.ts';

export const accessRoutes: SliceRoutes = {
  app: [{ index: true, lazy: page(() => import('./HomePage.tsx')) }],
  access: [
    { path: 'verify', lazy: page(() => import('./VerifyPage.tsx')) },
    { path: 'auth/verify', lazy: page(() => import('./VerifyLinkPage.tsx')) },
    { path: 'forgot', lazy: page(() => import('./ForgotPage.tsx')) },
    { path: 'reset', lazy: page(() => import('./ResetPage.tsx')) },
    { path: 'dev/outbox', lazy: page(() => import('./DevOutboxPage.tsx')) },
  ],
  guest: [
    { path: 'signup', lazy: page(() => import('./SignUpPage.tsx')) },
    { path: 'signin', lazy: page(() => import('./SignInPage.tsx')) },
  ],
};
