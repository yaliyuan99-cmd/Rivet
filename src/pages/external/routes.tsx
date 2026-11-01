import type { SliceRoutes } from '../../lib/routes.ts';
import { page } from '../../lib/routes.ts';

export const externalRoutes: SliceRoutes = {
  access: [
    { path: 'oauth/authorize', lazy: page(() => import('./AuthorizePage.tsx')) },
    { path: 'oauth/consent/:code', lazy: page(() => import('./ConsentPage.tsx')) },
    { path: 'atlas-demo', lazy: page(() => import('./AtlasDemoPage.tsx')) },
    { path: 'atlas-demo/callback', lazy: page(() => import('./AtlasCallbackPage.tsx')) },
  ],
};
