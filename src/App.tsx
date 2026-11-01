import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { AccessShell, AppShell } from './components/shell.tsx';
import { RedirectIfSignedIn, RequireVerified } from './lib/session.tsx';
import type { SliceRoutes } from './lib/routes.ts';
import { page } from './lib/routes.ts';
import { accessRoutes } from './pages/access/routes.tsx';
import { workspaceRoutes } from './pages/workspace/routes.tsx';
import { evaluationRoutes } from './pages/evaluation/routes.tsx';
import { expertRoutes } from './pages/expert/routes.tsx';
import { publishedRoutes } from './pages/published/routes.tsx';
import { datasetRoutes } from './pages/datasets/routes.tsx';
import { assuranceRoutes } from './pages/assurance/routes.tsx';
import { externalRoutes } from './pages/external/routes.tsx';
import { advisorRoutes } from './pages/advisor/routes.tsx';
import { adminRoutes } from './pages/admin/routes.tsx';

const slices: SliceRoutes[] = [
  accessRoutes,
  workspaceRoutes,
  evaluationRoutes,
  expertRoutes,
  publishedRoutes,
  datasetRoutes,
  assuranceRoutes,
  externalRoutes,
  advisorRoutes,
  adminRoutes,
];

const collect = (key: keyof SliceRoutes): RouteObject[] => slices.flatMap((slice) => slice[key] ?? []);

export const router = createBrowserRouter([
  {
    element: <RequireVerified />,
    children: [
      {
        element: <AppShell />,
        children: [...collect('app'), { path: '*', lazy: page(() => import('./pages/access/NotFoundPage.tsx')) }],
      },
    ],
  },
  {
    element: <AccessShell />,
    children: [
      ...collect('access'),
      {
        element: <RedirectIfSignedIn />,
        children: collect('guest'),
      },
    ],
  },
]);
