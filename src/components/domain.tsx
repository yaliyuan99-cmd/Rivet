import type { ReactNode } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { shortHash } from '../lib/format.ts';
import { Badge, type Tone } from './ui.tsx';

/** "86 / 100" + badge + the limits of the number. Scores use tabular mono numerals. */
export function Score({ value, max = 100, badge, badgeTone = 'neutral', note }: { value: number | string; max?: number; badge: string; badgeTone?: Tone; note?: ReactNode }) {
  return (
    <div>
      <p className="score-value">
        {value} / {max}
      </p>
      <Badge tone={badgeTone}>{badge}</Badge>
      {note ? <p className="score-note">{note}</p> : null}
    </div>
  );
}

/** The 130×24 interval plot: a baseline, whiskers at the bounds and a taller tick at the estimate. */
export function CiPlot({ estimate, low, high, min = 60, max = 100, width = 130, height = 24, label }: { estimate: number; low: number; high: number; min?: number; max?: number; width?: number; height?: number; label?: string }) {
  const x = (value: number) => ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * width;
  const mid = height / 2;
  return (
    <svg
      className="ci-plot"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? `Estimate ${estimate}, 95% interval ${low} to ${high}`}
    >
      <line x1="0" y1={mid} x2={width} y2={mid} stroke="currentColor" strokeWidth="1" opacity="0.65" />
      <line x1={x(low)} y1={mid - 5} x2={x(low)} y2={mid + 5} stroke="currentColor" strokeWidth="2" />
      <line x1={x(high)} y1={mid - 5} x2={x(high)} y2={mid + 5} stroke="currentColor" strokeWidth="2" />
      <line x1={x(estimate)} y1={mid - 9} x2={x(estimate)} y2={mid + 9} stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function Progress({ done, total, status }: { done: number; total: number; status?: { label: string; tone: Tone } }) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <p className="progress-label tabular">
        {done} / {total} stages committed
      </p>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="Run progress">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      {status ? (
        <p style={{ marginTop: 12 }}>
          <Badge tone={status.tone}>{status.label}</Badge>
        </p>
      ) : null}
    </div>
  );
}

export function EvidenceCard({ code, runCode, taskLabel, sha256 }: { code: string; runCode: string; taskLabel: string; sha256: string }) {
  return (
    <div className="evidence-card">
      <p className="evidence-card-status">
        <ShieldCheck size={16} strokeWidth={1.5} className="text-accent" aria-hidden="true" />
        Tamper-evident · hash verified
      </p>
      <p className="evidence-card-line">
        {code} · {runCode} · {taskLabel}
      </p>
      <p className="evidence-card-line">SHA-256 {shortHash(sha256)}</p>
    </div>
  );
}

export function HashMismatch({ children }: { children?: ReactNode }) {
  return (
    <div className="mismatch" role="alert">
      <ShieldAlert size={16} strokeWidth={1.5} className="text-danger" aria-hidden="true" />
      <div>
        <p className="mismatch-title">Hash mismatch · Evidence quarantined</p>
        <p className="mismatch-body">{children ?? 'The bytes differ from the frozen manifest. Do not use this artifact for scoring.'}</p>
      </div>
    </div>
  );
}

export function TaskCard({ status, statusTone = 'neutral', title, meta, action, note }: { status: string; statusTone?: Tone; title: ReactNode; meta: ReactNode; action?: ReactNode; note?: ReactNode }) {
  return (
    <article className="card">
      <Badge tone={statusTone}>{status}</Badge>
      <h3 className="card-title">{title}</h3>
      <p className="card-meta">{meta}</p>
      {action ?? null}
      {note ? <p className="field-message" style={{ marginTop: 0 }}>{note}</p> : null}
    </article>
  );
}

export function ChatBlock({ author, children, citations }: { author: string; children: ReactNode; citations?: ReactNode }) {
  return (
    <div className="chat-block">
      <p className="chat-author">{author}</p>
      <div className="chat-body">{children}</div>
      {citations ? <div className="chat-citation">{citations}</div> : null}
    </div>
  );
}
