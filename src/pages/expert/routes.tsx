import type { SliceRoutes } from '../../lib/routes.ts';
import { page } from '../../lib/routes.ts';

export const expertRoutes: SliceRoutes = {
  app: [
    { path: 'review', lazy: page(() => import('./ReviewQueuePage.tsx')) },
    { path: 'review/apply', lazy: page(() => import('./ApplyPage.tsx')) },
    { path: 'review/application', lazy: page(() => import('./ApplicationPage.tsx')) },
    { path: 'review/:code', lazy: page(() => import('./ExpertReviewPage.tsx')) },
    { path: 'admin/credentials', lazy: page(() => import('./CredentialQueuePage.tsx')) },
    { path: 'admin/credentials/:code', lazy: page(() => import('./CredentialPage.tsx')) },
    { path: 'admin/adjudications', lazy: page(() => import('./AdjudicationQueuePage.tsx')) },
    { path: 'admin/adjudications/:code', lazy: page(() => import('./AdjudicationPage.tsx')) },
  ],
};
