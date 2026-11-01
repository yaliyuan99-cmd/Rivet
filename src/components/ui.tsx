import { useId, type ButtonHTMLAttributes, type ChangeEvent, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { Link, type LinkProps } from 'react-router-dom';

/* ---------- Buttons ---------- */

type Variant = 'primary' | 'secondary' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** Shows a spinner and blocks repeat clicks while a request is in flight. */
  busy?: boolean;
  /** Announced to screen readers while busy, e.g. "Freezing version". */
  busyLabel?: string;
}

export function Button({ variant = 'secondary', busy, busyLabel, children, onClick, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className="btn"
      data-variant={variant}
      aria-busy={busy || undefined}
      onClick={busy ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
      {busy && busyLabel ? <span className="sr-only">{busyLabel}</span> : null}
    </button>
  );
}

export function LinkButton({ variant = 'secondary', children, ...rest }: LinkProps & { variant?: Variant }) {
  return (
    <Link className="btn" data-variant={variant} {...rest}>
      {children}
    </Link>
  );
}

/** A real `<a>` for downloads and other server-handled URLs. */
export function AnchorButton({ variant = 'secondary', children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant }) {
  return (
    <a className="btn" data-variant={variant} {...rest}>
      {children}
    </a>
  );
}

/**
 * "Disallowed actions stay visible with a reason." Focusable, so keyboard and screen-reader
 * users meet the reason too. Pair with <RailUnavailable> in the context rail, as the frames do.
 */
export function DisabledAction({ reason, children }: { reason: string; children: ReactNode }) {
  const id = useId();
  return (
    <>
      <button type="button" className="btn" aria-disabled="true" aria-describedby={id} title={reason} onClick={(e) => e.preventDefault()}>
        {children}
      </button>
      <span id={id} className="sr-only">
        {reason}
      </span>
    </>
  );
}

/** The action row. The frames put a disabled action in its own block: use <ActionsBelow>. */
export function Actions({ children }: { children: ReactNode }) {
  return <div className="actions">{children}</div>;
}

export function ActionsBelow({ children }: { children: ReactNode }) {
  return <div className="actions-below">{children}</div>;
}

/* ---------- Status ---------- */

export type Tone = 'accent' | 'warning' | 'danger' | 'neutral';

export function Alert({ tone = 'accent', children, live }: { tone?: Tone; children: ReactNode; live?: boolean }) {
  return (
    <div className="alert" data-tone={tone} role={tone === 'danger' ? 'alert' : live ? 'status' : undefined}>
      {children}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

/* ---------- Form fields: the label sits inside the box ---------- */

interface FieldShell {
  label: string;
  error?: string;
  hint?: ReactNode;
  disabled?: boolean;
}

function FieldMessages({ id, error, hint }: { id: string; error?: string; hint?: ReactNode }) {
  if (error) {
    return (
      <p id={id} className="field-message" data-tone="danger">
        {error}
      </p>
    );
  }
  if (hint) {
    return (
      <p id={id} className="field-message">
        {hint}
      </p>
    );
  }
  return null;
}

type InputProps = FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  value: string;
  onChange: (value: string) => void;
  /** Quiet text after the value, e.g. "· Strong" on a password. */
  suffix?: ReactNode;
};

export function FieldInput({ label, error, hint, disabled, value, onChange, suffix, ...rest }: InputProps) {
  const id = useId();
  const messageId = `${id}-message`;
  return (
    <div>
      <label className="field" data-invalid={error ? 'true' : undefined} data-disabled={disabled ? 'true' : undefined}>
        <span className="field-label">{label}</span>
        <span className="field-line">
          <input
            className="field-control"
            value={value}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={error || hint ? messageId : undefined}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
            {...rest}
          />
          {suffix ? <span className="field-suffix">{suffix}</span> : null}
        </span>
      </label>
      <FieldMessages id={messageId} error={error} hint={hint} />
    </div>
  );
}

type TextareaProps = FieldShell & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & {
  value: string;
  onChange: (value: string) => void;
};

export function FieldTextarea({ label, error, hint, disabled, value, onChange, rows = 2, ...rest }: TextareaProps) {
  const id = useId();
  const messageId = `${id}-message`;
  return (
    <div>
      <label className="field" data-invalid={error ? 'true' : undefined} data-disabled={disabled ? 'true' : undefined}>
        <span className="field-label">{label}</span>
        <textarea
          className="field-control"
          value={value}
          rows={rows}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? messageId : undefined}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
        />
      </label>
      <FieldMessages id={messageId} error={error} hint={hint} />
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

type SelectProps = FieldShell & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> & {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
};

export function FieldSelect({ label, error, hint, disabled, value, onChange, options, ...rest }: SelectProps) {
  const id = useId();
  const messageId = `${id}-message`;
  return (
    <div>
      <label className="field" data-invalid={error ? 'true' : undefined} data-disabled={disabled ? 'true' : undefined}>
        <span className="field-label">{label}</span>
        <select
          className="field-control"
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? messageId : undefined}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="field-chevron" size={14} strokeWidth={1.5} aria-hidden="true" />
      </label>
      <FieldMessages id={messageId} error={error} hint={hint} />
    </div>
  );
}

/** A read-only value in the same box, e.g. a generated version number. */
export function FieldStatic({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div>
      <div className="field">
        <span className="field-label">{label}</span>
        <div className="field-static">{children}</div>
      </div>
      <FieldMessages id={id} hint={hint} />
    </div>
  );
}

export function FieldFile({
  label,
  fileName,
  meta,
  onFile,
  accept,
  error,
  hint,
  disabled,
}: FieldShell & { fileName?: string | null; meta?: string; onFile: (file: File | null) => void; accept?: string }) {
  const id = useId();
  const messageId = `${id}-message`;
  return (
    <div>
      <label className="field" data-invalid={error ? 'true' : undefined} data-disabled={disabled ? 'true' : undefined}>
        <span className="field-label">{label}</span>
        <span className="field-file">
          <span>{fileName ?? 'No file chosen'}</span>
          {meta ? <span className="field-suffix">· {meta}</span> : null}
          <span className="text-link">· {fileName ? 'Choose another' : 'Choose a file'}</span>
          <input
            type="file"
            accept={accept}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={error || hint ? messageId : undefined}
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          />
        </span>
      </label>
      <FieldMessages id={messageId} error={error} hint={hint} />
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  size,
  error,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  size?: 'small';
  error?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label className="check" data-size={size}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? id : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{children}</span>
      </label>
      {error ? (
        <p id={id} className="check-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ---------- Tabs: real links, so each view has its own URL ---------- */

export function TabLinks({ label, items }: { label: string; items: { to: string; label: string; current: boolean }[] }) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((item) => (
        <Link key={item.to} to={item.to} className="tab" aria-current={item.current ? 'page' : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
