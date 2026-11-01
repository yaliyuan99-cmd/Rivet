import type { SliceRoutes } from '../../lib/routes.ts';
import { page } from '../../lib/routes.ts';

export const advisorRoutes: SliceRoutes = {
  app: [{ path: 'advisor', lazy: page(() => import('./AdvisorPage.tsx')) }],
};
