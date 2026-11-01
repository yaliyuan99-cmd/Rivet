import { useEffect, useId, type ReactNode } from 'react';
import { ChevronDown, LockKeyhole } from 'lucide-react';
import { useDemo } from '../lib/session.tsx';
import { formatDateTime, hashLines, shortHash } from '../lib/format.ts';
import type { Tone } from './ui.tsx';

/** A page: sets the document title and applies the 26px vertical rhythm. */
export function Page({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Rivet`;
  }, [title]);
  return <div className="page">{children}</div>;
}

/** Statuses are uppercase by CSS, but the frames keep version labels as written: "FROZEN / v1.0", "BLOCKED / rc.18". */
function keepVersionCase(status: ReactNode): ReactNode {
  if (typeof status !== 'string') return status;
  return status.split(/\b(v\d+(?:\.\d+)*|rc\.\d+)\b/).map((part, index) =>
    index % 2 ? (
      <span key={index} className="keep-case">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  status,
  statusTone = 'accent',
}: {
  /** e.g. "02 Evaluation" (rendered uppercase) */
  eyebrow: string;
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  statusTone?: Tone;
}) {
  return (
    <header className="page-header">
      <p className="page-eyebrow">{eyebrow}</p>
      <h1 className="page-title">{title}</h1>
      {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      {status ? (
        <p className="page-status" data-tone={statusTone} role="status">
          {keepVersionCase(status)}
        </p>
      ) : null}
    </header>
  );
}

/** Fluid evidence workbench + 300px context rail. */
export function Workspace({ rail, children }: { rail?: ReactNode; children: ReactNode }) {
  return (
    <div className="workspace">
      <div className="workbench">{children}</div>
      {rail}
    </div>
  );
}

/**
 * kind="text" (default): heading + 31.5px + prose or <Pairs>.
 * kind="form": heading + 16px + fields 16px apart, or rows 16px apart.
 * kind="table": heading with a bottom rule and contiguous <Row>s.
 */
export function Section({
  title,
  kind = 'text',
  headingLevel = 2,
  children,
}: {
  title: ReactNode;
  kind?: 'text' | 'form' | 'table';
  headingLevel?: 2 | 3;
  children: ReactNode;
}) {
  const id = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className="section" data-kind={kind} aria-labelledby={id}>
      <div className={kind === 'table' ? 'row-heading' : undefined}>
        <Heading id={id} className="section-title">
          {title}
        </Heading>
      </div>
      {kind === 'form' ? <div className="section-fields">{children}</div> : kind === 'text' ? <div className="section-body">{children}</div> : children}
    </section>
  );
}

export interface Pair {
  term: ReactNode;
  detail?: ReactNode;
  key?: string;
}

/** "Term\nDetail" pairs separated by a 21px blank line. */
export function Pairs({ items }: { items: Pair[] }) {
  return (
    <dl className="pairs">
      {items.map((item, index) => (
        <div key={item.key ?? index}>
          <dt>{item.term}</dt>
          {item.detail !== undefined ? <dd>{item.detail}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** A ruled row: 14px label, 12px mono value; the optional third column holds a CI plot. */
export function Row({ label, value, tone, extra }: { label: ReactNode; value: ReactNode; tone?: Tone; extra?: ReactNode }) {
  return (
    <div className="row" data-columns={extra ? '3' : undefined}>
      <div>{label}</div>
      <div className="row-value" data-tone={tone}>
        {value}
      </div>
      {extra ?? null}
    </div>
  );
}

/* ---------- Context rail ---------- */

export function ContextRail({ children }: { children: ReactNode }) {
  const demo = useDemo();
  return (
    <aside className="rail" aria-label="Context and provenance">
      <h2 className="rail-title">Context &amp; provenance</h2>
      {children}
      {demo ? (
        <div>
          <p>RIVET / SYNTHETIC DEMO</p>
          <p>All scores, sources and findings are authored examples. Not real benchmark claims or scientific evidence.</p>
        </div>
      ) : null}
    </aside>
  );
}

export function RailStat({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return (
    <p className="rail-stat" data-tone={tone}>
      {children}
    </p>
  );
}

export function RailItem({ term, children }: { term: string; children: ReactNode }) {
  return (
    <dl className="rail-item">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </dl>
  );
}

/** A control that belongs in the rail, such as the frozen task an answer is grounded in. */
export function RailSelect({ label, value, options, onChange, disabled }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="rail-select">
      <label htmlFor={id}>{label}</label>
      <div className="rail-select-control">
        <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="rail-select-chevron" size={14} strokeWidth={1.5} aria-hidden="true" />
      </div>
    </div>
  );
}

export function RailNote({ children }: { children: ReactNode }) {
  return <p className="rail-note">{children}</p>;
}

/** "⌑ ACTION UNAVAILABLE / Action · reason" */
export function RailUnavailable({ action, reason }: { action: string; reason: string }) {
  return (
    <div>
      <p className="rail-unavailable-title">
        <LockKeyhole size={12} strokeWidth={1.5} aria-hidden="true" />
        Action unavailable
      </p>
      <p>
        {action} · {reason}
      </p>
    </div>
  );
}

export interface TamperEvidence {
  code: string;
  runCode: string;
  /** e.g. BIO-042 v1.0 */
  taskLabel: string;
  sha256: string;
  capturedAt: string;
  runnerVersion: string;
  verified: boolean;
}

/** The tamper-evident block. Verification is the server's: pass what it computed, never assume. */
export function RailTamper({ evidence, fullHash }: { evidence: TamperEvidence; fullHash?: boolean }) {
  const [first, second] = hashLines(evidence.sha256);
  return (
    <>
      <div>
        <p>TAMPER-EVIDENT / {evidence.verified ? 'HASH VERIFIED' : <span className="text-danger">HASH MISMATCH</span>}</p>
        <p>
          {evidence.code} · {evidence.runCode} · {evidence.taskLabel}
        </p>
        <p>SHA-256 {shortHash(evidence.sha256)}</p>
        <p>Captured {formatDateTime(evidence.capturedAt)}</p>
        <p>Runner {evidence.runnerVersion} · Inputs and outputs pinned.</p>
        <p>Hash integrity does not establish truth.</p>
      </div>
      {fullHash ? (
        <div>
          <p>Full SHA-256:</p>
          <p className="rail-hash">{first}</p>
          <p className="rail-hash">{second}</p>
        </div>
      ) : null}
    </>
  );
}
