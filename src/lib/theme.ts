import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

const listeners = new Set<() => void>();

function current(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f6f8f6' : '#101618');
  try {
    localStorage.setItem('rivet-theme', theme);
  } catch {
    // Private windows may refuse storage; the theme still applies for this page.
  }
  for (const listener of listeners) listener();
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, current, () => 'dark' as Theme);
  const toggle = useCallback(() => setTheme(current() === 'dark' ? 'light' : 'dark'), []);
  return { theme, toggle };
}
