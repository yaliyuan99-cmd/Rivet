import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import type { SessionResponse, SessionUser } from '../../shared/types/session.ts';
import { api } from './api.ts';

export function useSession() {
  return useQuery<SessionResponse, Error>({
    queryKey: ['session'],
    queryFn: () => api.get<SessionResponse>('/api/session'),
    staleTime: 30_000,
  });
}

/** For pages inside the verified app routes, where a user is guaranteed. */
export function useUser(): SessionUser {
  const { data } = useSession();
  if (!data?.user) throw new Error('useUser requires a signed-in user');
  return data.user;
}

export function useDemo(): boolean {
  return useSession().data?.demo ?? false;
}

function SessionGate({ children }: { children: (session: SessionResponse) => React.ReactNode }) {
  const session = useSession();
  if (session.isPending) return <div className="page" role="status" aria-label="Loading your session" />;
  if (session.isError || !session.data) {
    return (
      <div className="page">
        <p role="alert">Rivet could not reach the server. Reload the page to try again.</p>
      </div>
    );
  }
  return <>{children(session.data)}</>;
}

/** Tasks, datasets and reports require a verified account. */
export function RequireVerified() {
  const location = useLocation();
  return (
    <SessionGate>
      {({ user }) => {
        if (!user) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
        if (!user.emailVerified) return <Navigate to="/verify" replace />;
        return <Outlet />;
      }}
    </SessionGate>
  );
}

/** Only ever follows a path on this site, so a crafted link cannot send someone elsewhere after sign-in. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

/** Sign-up and sign-in send people who are already in to the app, or to where they were heading. */
export function RedirectIfSignedIn() {
  const [params] = useSearchParams();
  return (
    <SessionGate>
      {({ user }) => (user?.emailVerified ? <Navigate to={safeNext(params.get('next'))} replace /> : <Outlet />)}
    </SessionGate>
  );
}
