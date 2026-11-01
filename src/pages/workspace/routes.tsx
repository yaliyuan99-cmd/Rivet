import type { SliceRoutes } from '../../lib/routes.ts';
import { page } from '../../lib/routes.ts';

export const workspaceRoutes: SliceRoutes = {
  app: [
    { path: 'workspace', lazy: page(() => import('./MembersPage.tsx')) },
    { path: 'workspace/new', lazy: page(() => import('./CreateWorkspacePage.tsx')) },
    { path: 'w/:slug', lazy: page(() => import('./WorkspaceUrlPage.tsx')) },
    { path: 'profile', lazy: page(() => import('./ProfilePage.tsx')) },
  ],
  access: [
    // Reachable signed out: someone invited may not have an account yet.
    { path: 'invitations/:token', lazy: page(() => import('./AcceptInvitationPage.tsx')) },
    { path: 'legal/terms', lazy: page(() => import('./LegalPage.tsx')) },
    { path: 'legal/privacy', lazy: page(() => import('./LegalPage.tsx')) },
    { path: 'auth/github/failed', lazy: page(() => import('./GitHubFailedPage.tsx')) },
  ],
};
