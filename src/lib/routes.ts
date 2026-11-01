import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router-dom';

/**
 * Each slice exports its routes so no slice edits the central router.
 * app: inside the workspace shell, verified accounts only.
 * access: no workspace navigation; signed-out visitors may reach these.
 * guest: as access, but people already signed in are sent Home.
 */
export interface SliceRoutes {
  app?: RouteObject[];
  access?: RouteObject[];
  guest?: RouteObject[];
}

/** Lazy-loads a page module's default export, keeping each slice out of the first bundle. */
export function page(load: () => Promise<{ default: ComponentType }>) {
  return async () => ({ Component: (await load()).default });
}
