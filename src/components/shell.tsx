import { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionResponse, SessionUser } from '../../shared/types/session.ts';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { useTheme } from '../lib/theme.ts';
import { useToast } from './feedback.tsx';

export const NAV_ITEMS: { to: string; label: string; match: string[] }[] = [
  { to: '/', label: 'Home', match: [] },
  { to: '/tasks', label: 'Tasks', match: ['/tasks', '/runs', '/evidence'] },
  { to: '/datasets', label: 'Datasets', match: ['/datasets'] },
  { to: '/leaderboards', label: 'Leaderboards', match: ['/leaderboards'] },
  { to: '/reports', label: 'Reports', match: ['/reports'] },
  { to: '/assurance', label: 'Agent assurance', match: ['/assurance'] },
  { to: '/review', label: 'Review queue', match: ['/review'] },
  { to: '/advisor', label: 'Audit Advisor', match: ['/advisor'] },
  { to: '/workspace', label: 'Workspace', match: ['/workspace', '/invitations'] },
  { to: '/profile', label: 'Profile', match: ['/profile'] },
  { to: '/admin', label: 'Administration', match: ['/admin'] },
];

function currentItem(pathname: string) {
  if (pathname === '/') return NAV_ITEMS[0];
  return NAV_ITEMS.find((item) => item.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)));
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" className="bar-theme" onClick={toggle} aria-label={`Theme: ${theme}. Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
      {theme}
    </button>
  );
}

/** The frames name the role that matters for what this person can do here. */
function useRoleLabel(user: SessionUser) {
  const { pathname } = useLocation();
  if (user.role === 'admin') return 'Admin';
  if (user.credentials.length > 0) return 'Expert';
  if (user.applicant) return 'Applicant';
  if (user.workspace?.role === 'owner' && pathname.startsWith('/workspace')) return 'Workspace owner';
  return 'Member';
}

function PermissionNote({ user }: { user: SessionUser }) {
  return user.role === 'admin' ? (
    <p>Admin session / Audited</p>
  ) : (
    <p>
      Administration locked
      <br />
      Admin role required
    </p>
  );
}

function useSignOut() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  return async () => {
    try {
      await api.post('/api/auth/signout');
      client.clear();
      navigate('/signin');
    } catch (error) {
      toast.error('Could not sign out', error instanceof Error ? error.message : undefined);
    }
  };
}

function WorkspaceIdentity({ user }: { user: SessionUser }) {
  const client = useQueryClient();
  const toast = useToast();
  const workspace = user.workspace;
  if (!workspace) {
    return (
      <div>
        <p className="nav-workspace-name">{user.role === 'admin' ? 'Rivet administration' : 'No workspace'}</p>
        <p>
          {user.role === 'admin' ? (
            'No workspace'
          ) : (
            <Link to="/workspace/new" className="quiet-link">
              Create a workspace
            </Link>
          )}
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="nav-workspace-name">{workspace.name}</p>
      {user.workspaces.length > 1 ? (
        <>
          <label className="sr-only" htmlFor="workspace-switch">
            Switch workspace
          </label>
          <select
            id="workspace-switch"
            className="nav-workspace-select"
            value={workspace.id}
            onChange={async (e) => {
              try {
                await api.post('/api/workspaces/switch', { workspaceId: e.target.value });
                await client.invalidateQueries();
              } catch (error) {
                toast.error('Could not switch workspace', error instanceof Error ? error.message : undefined);
              }
            }}
          >
            {user.workspaces.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p>{workspace.defaultVisibility === 'private' ? 'Private workspace' : 'Shared workspace'}</p>
      )}
    </div>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const active = currentItem(pathname);
  return (
    <ul className="nav-list">
      {NAV_ITEMS.map((item) => (
        <li key={item.to}>
          <Link to={item.to} className="nav-link" aria-current={active?.to === item.to ? 'page' : undefined} onClick={onNavigate}>
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function WorkspaceNav({ user }: { user: SessionUser }) {
  const signOut = useSignOut();
  const role = useRoleLabel(user);
  return (
    <nav className="nav" aria-label="Workspace navigation">
      <WorkspaceIdentity user={user} />
      <NavLinks />
      <div className="nav-user">
        <p>{user.name}</p>
        <p>{role}</p>
      </div>
      <div className="nav-note">
        <PermissionNote user={user} />
      </div>
      <button type="button" className="nav-signout" onClick={() => void signOut()}>
        Sign out
      </button>
    </nav>
  );
}

function AppBar({ user, demo, menuOpen, onMenu }: { user: SessionUser; demo: boolean; menuOpen: boolean; onMenu: () => void }) {
  const { pathname } = useLocation();
  const section = currentItem(pathname)?.label ?? 'Rivet';
  return (
    <header className="bar">
      <div className="bar-identity">
        <Link to="/" className="brand" aria-label="Rivet home">
          rivet
        </Link>
        <div className="bar-crumbs">
          <span className="bar-sep-lead" aria-hidden="true">
            /
          </span>
          <span>
            {user.workspace ? `${user.workspace.name} / ` : ''}
            {section}
          </span>
          <span className="bar-break" aria-hidden="true" />
          {demo ? (
            <>
              <span className="bar-sep-lead" aria-hidden="true">
                /
              </span>
              <span>Synthetic demo</span>
              <span aria-hidden="true">/</span>
            </>
          ) : (
            <span className="bar-sep-lead" aria-hidden="true">
              /
            </span>
          )}
          <ThemeToggle />
        </div>
      </div>
      <button type="button" className="bar-menu" aria-expanded={menuOpen} aria-controls="menu-panel" aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'} onClick={onMenu}>
        {menuOpen ? <X size={20} strokeWidth={1} aria-hidden="true" /> : <Menu size={20} strokeWidth={1} aria-hidden="true" />}
      </button>
    </header>
  );
}

/** Mobile frames repeat the workspace navigation as a block at the foot of each page. */
function FootNav({ user }: { user: SessionUser }) {
  const { pathname } = useLocation();
  const active = currentItem(pathname);
  const signOut = useSignOut();
  const role = useRoleLabel(user);
  return (
    <nav className="foot-nav" aria-label="Workspace navigation">
      <h2 className="foot-nav-title">{user.workspace ? `${user.workspace.name} / ` : ''}Workspace navigation</h2>
      <div className="foot-nav-links">
        {NAV_ITEMS.map((item) => (
          <Link key={item.to} to={item.to} aria-current={active?.to === item.to ? 'page' : undefined}>
            {item.label}
          </Link>
        ))}
      </div>
      <div className="foot-nav-group">
        <p>{user.name}</p>
        <p>{role}</p>
      </div>
      <div className="foot-nav-group">
        <PermissionNote user={user} />
      </div>
      <button type="button" className="nav-signout" style={{ marginTop: 0 }} onClick={() => void signOut()}>
        Sign out
      </button>
    </nav>
  );
}

/** Moves focus to the page on navigation so keyboard and screen-reader users land on the new content. */
function useRouteFocus() {
  const { pathname } = useLocation();
  const ref = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    ref.current?.focus({ preventScroll: true });
  }, [pathname]);
  return ref;
}

function SkipLink() {
  return (
    <a className="skip-link" href="#main">
      Skip to content
    </a>
  );
}

/** Signed-in layout: navigation, bar, page, foot navigation on small screens. */
export function AppShell() {
  const { data } = useSession() as { data: SessionResponse };
  const user = data.user as SessionUser;
  const mainRef = useRouteFocus();
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const role = useRoleLabel(user);

  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        document.querySelector<HTMLButtonElement>('.bar-menu')?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="app" data-shell="workspace">
      <SkipLink />
      <WorkspaceNav user={user} />
      <div className="app-main">
        <AppBar user={user} demo={data.demo} menuOpen={menuOpen} onMenu={() => setMenuOpen((open) => !open)} />
        <div id="menu-panel" className="menu-panel" data-open={menuOpen ? 'true' : 'false'} hidden={!menuOpen}>
          <NavLinks onNavigate={() => setMenuOpen(false)} />
        </div>
        <p className="subbar">
          {user.workspace ? `${user.workspace.name.toUpperCase()} · ${user.workspace.defaultVisibility === 'private' ? 'Private workspace' : 'Shared workspace'}` : 'No workspace'}
          <br />
          {user.name} / {role}
        </p>
        <main id="main" ref={mainRef} tabIndex={-1} style={{ outline: 'none' }}>
          <Outlet />
        </main>
        <FootNav user={user} />
      </div>
    </div>
  );
}

/** Sign-up has its own compact bar on phones ("rivet / DEMO"); other access screens stack like the app bar. */
const COMPACT_ACCESS = ['/signup', '/signin', '/forgot', '/reset'];

/** Screens without workspace navigation: sign-up, sign-in, verification, OAuth consent, legal. */
export function AccessShell() {
  const { data } = useSession();
  const mainRef = useRouteFocus();
  const { pathname } = useLocation();
  const demo = data?.demo ?? false;
  return (
    <div className="app" data-shell="access" data-compact={COMPACT_ACCESS.includes(pathname) ? 'true' : undefined}>
      <SkipLink />
      <div className="app-main">
        <header className="bar">
          <div className="bar-identity">
            <Link to="/" className="brand" aria-label="Rivet home">
              rivet
            </Link>
            <div className="bar-crumbs">
              <span className="bar-sep-lead" aria-hidden="true">
                /
              </span>
              <span className="crumb-long">Secure access</span>
              <span className="bar-break" aria-hidden="true" />
              {demo ? (
                <>
                  <span className="bar-sep-lead" aria-hidden="true">
                    /
                  </span>
                  <span className="crumb-long">Synthetic demo</span>
                  <span className="crumb-short">Demo</span>
                  <span aria-hidden="true">/</span>
                </>
              ) : (
                <span className="bar-sep-lead" aria-hidden="true">
                  /
                </span>
              )}
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main id="main" ref={mainRef} tabIndex={-1} style={{ outline: 'none' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
