import type { SliceRoutes } from '../../lib/routes.ts';
import { page } from '../../lib/routes.ts';

export const assuranceRoutes: SliceRoutes = {
  app: [
    { path: 'assurance', lazy: page(() => import('./AssurancePage.tsx')) },
    { path: 'assurance/traces/:code', lazy: page(() => import('./TracePage.tsx')) },
    { path: 'assurance/regressions/:code', lazy: page(() => import('./RegressionPage.tsx')) },
    { path: 'assurance/gates/:code/:candidate', lazy: page(() => import('./GatePage.tsx')) },
  ],
};
