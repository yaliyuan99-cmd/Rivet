import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, TriangleAlert } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api.ts';
import { Button } from './ui.tsx';

/* ---------- Toasts (aria-live) ---------- */

interface ToastItem {
  id: number;
  tone: 'accent' | 'warning' | 'danger';
  title: string;
  body?: string;
}

interface ToastApi {
  success: (title: string, body?: string) => void;
  warning: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((tone: ToastItem['tone'], title: string, body?: string) => {
    const id = nextId.current++;
    setItems((current) => [...current.slice(-2), { id, tone, title, body }]);
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), tone === 'danger' ? 9000 : 5000);
  }, []);

  const value = useMemo<ToastApi>(
    () => ({
      success: (title, body) => push('accent', title, body),
      warning: (title, body) => push('warning', title, body),
      error: (title, body) => push('danger', title, body),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {items.map((item) => (
          <div key={item.id} className="toast" data-tone={item.tone === 'accent' ? undefined : item.tone}>
            {item.tone === 'accent' ? (
              <Check size={16} strokeWidth={1.5} className="text-accent" aria-hidden="true" />
            ) : item.tone === 'warning' ? (
              <TriangleAlert size={16} strokeWidth={1.5} className="text-warning" aria-hidden="true" />
            ) : (
              <CircleAlert size={16} strokeWidth={1.5} className="text-danger" aria-hidden="true" />
            )}
            <div>
              <p className="toast-title">{item.title}</p>
              {item.body ? <p className="toast-body">{item.body}</p> : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast must be used inside ToastProvider');
  return toast;
}

/* ---------- Modal (native dialog: focus trap, Escape and backdrop inert for free) ---------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  size,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  size?: 'wide';
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      data-size={size}
      aria-labelledby="modal-title"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <>
          <h2 id="modal-title" className="modal-title">
            {title}
          </h2>
          {children ? <div className="modal-body">{children}</div> : null}
          {actions ? <div className="modal-actions">{actions}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}

/* ---------- Query states ---------- */

export function Skeleton({ lines = 6 }: { lines?: number }) {
  return (
    <div className="page">
      <div className="skeleton" role="status" aria-label="Loading">
        <div className="skeleton-line" data-size="short" />
        <div className="skeleton-line" data-size="title" />
        {Array.from({ length: lines }, (_, index) => (
          <div key={index} className="skeleton-line" />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  if (api?.status === 404) {
    return (
      <div className="page">
        <div className="state-block">
          <h1 className="state-title">Not found</h1>
          <p>{api.message}</p>
          <Link className="text-link" to="/">
            Return to Home
          </Link>
        </div>
      </div>
    );
  }
  if (api?.status === 403) {
    return (
      <div className="page">
        <div className="state-block">
          <h1 className="state-title">You do not have access</h1>
          <p>{api.message}</p>
          <Link className="text-link" to="/">
            Return to Home
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="page">
      <div className="state-block" role="alert">
        <h1 className="state-title">This page could not load</h1>
        <p>{error.message}</p>
        {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
      </div>
    </div>
  );
}

/** Loading skeleton, then error (with retry) or the page. */
export function QueryBoundary<T>({ query, children, lines }: { query: UseQueryResult<T, Error>; children: (data: T) => ReactNode; lines?: number }) {
  if (query.isPending) return <Skeleton lines={lines} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}

/** Inline empty state inside a workbench section. */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="state-block">
      <p>{children}</p>
      {action ?? null}
    </div>
  );
}
