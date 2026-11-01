import type { SliceRoutes } from '../../lib/routes.ts';
import { page } from '../../lib/routes.ts';

export const adminRoutes: SliceRoutes = {
  app: [
    { path: 'admin', lazy: page(() => import('./AdminIndexPage.tsx')) },
    { path: 'admin/models', lazy: page(() => import('./ModelsPage.tsx')) },
    { path: 'admin/checks', lazy: page(() => import('./ChecksPage.tsx')) },
  ],
};
