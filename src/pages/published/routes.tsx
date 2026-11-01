import type { SliceRoutes } from '../../lib/routes.ts';
import { page } from '../../lib/routes.ts';

export const publishedRoutes: SliceRoutes = {
  app: [
    { path: 'leaderboards', lazy: page(() => import('./LeaderboardPage.tsx')) },
    { path: 'leaderboards/methodology', lazy: page(() => import('./MethodologyPage.tsx')) },
    { path: 'reports', lazy: page(() => import('./ReportsPage.tsx')) },
    { path: 'reports/:code/:version', lazy: page(() => import('./ReportPage.tsx')) },
  ],
};
