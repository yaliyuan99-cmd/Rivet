import { useId, type ReactNode } from 'react';
import './workspace.css';

/** A button that sits inside a line of text, as the frames draw "Disconnect" and "Revoke". */
export function InlineButton({ children, onClick, busy, tone, label }: { children: ReactNode; onClick: () => void; busy?: boolean; tone?: 'danger'; label?: string }) {
  return (
    <button type="button" className="inline-action" data-tone={tone} aria-busy={busy || undefined} aria-label={label} onClick={busy ? undefined : onClick}>
      {children}
    </button>
  );
}

/**
 * The same, refused: stays visible and focusable with its reason, like the kit's DisabledAction.
 * showReason prints the reason in the line too, where nothing nearby already says it.
 */
export function InlineDisabled({ children, reason, showReason, label }: { children: ReactNode; reason: string; showReason?: boolean; label?: string }) {
  const id = useId();
  return (
    <>
      <button type="button" className="inline-action" aria-disabled="true" aria-describedby={id} aria-label={label} title={reason} onClick={(event) => event.preventDefault()}>
        {children}
      </button>
      {showReason ? (
        <span id={id}> · {reason}</span>
      ) : (
        <span id={id} className="sr-only">
          {reason}
        </span>
      )}
    </>
  );
}
