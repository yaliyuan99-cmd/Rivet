import type { SliceRoutes } from '../../lib/routes.ts';
import { page } from '../../lib/routes.ts';

export const datasetRoutes: SliceRoutes = {
  app: [
    { path: 'datasets', lazy: page(() => import('./DatasetsPage.tsx')) },
    { path: 'datasets/upload', lazy: page(() => import('./UploadPage.tsx')) },
    { path: 'datasets/:code', lazy: page(() => import('./DatasetDetailPage.tsx')) },
    { path: 'datasets/:code/delete', lazy: page(() => import('./DeleteDatasetPage.tsx')) },
  ],
};
