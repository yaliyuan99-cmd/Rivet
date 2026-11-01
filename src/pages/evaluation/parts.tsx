import { DisabledAction, LinkButton, RailUnavailable } from '../../components/index.ts';
import type { ReviewAction, VerdictDto } from '../../../shared/types/evaluation.ts';

/** "Review this task": a real link when there is a review to open, otherwise disabled with the server's reason. */
export function ReviewActionButton({ action }: { action: ReviewAction }) {
  if (action.verdict.allowed && action.href) return <LinkButton to={action.href}>{action.label}</LinkButton>;
  return <DisabledAction reason={action.verdict.reason ?? 'Unavailable'}>{action.label}</DisabledAction>;
}

export function ReviewUnavailable({ action }: { action: ReviewAction }) {
  if (action.verdict.allowed) return null;
  return <RailUnavailable action={action.label} reason={action.verdict.reason} />;
}

export function VerdictUnavailable({ action, verdict }: { action: string; verdict: VerdictDto }) {
  if (verdict.allowed) return null;
  return <RailUnavailable action={action} reason={verdict.reason} />;
}
