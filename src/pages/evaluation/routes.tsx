import type { SliceRoutes } from '../../lib/routes.ts';
import { page } from '../../lib/routes.ts';

export const evaluationRoutes: SliceRoutes = {
  app: [
    { path: 'tasks', lazy: page(() => import('./BrowsePage.tsx')) },
    { path: 'tasks/new', lazy: page(() => import('./EditorPage.tsx')) },
    { path: 'tasks/:code', lazy: page(() => import('./TaskPage.tsx')) },
    { path: 'tasks/:code/edit', lazy: page(() => import('./EditorPage.tsx')) },
    { path: 'tasks/:code/freeze', lazy: page(() => import('./FreezePage.tsx')) },
    { path: 'runs/:code', lazy: page(() => import('./RunPage.tsx')) },
    { path: 'evidence/:code', lazy: page(() => import('./EvidencePage.tsx')) },
  ],
};
