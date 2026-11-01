import type { KeyboardEvent } from 'react';
import type { ApplicationStatus, ReviewStatus } from '../../../shared/types/expert.ts';
import type { Tone } from '../../components/index.ts';

export const EYEBROW = '03 Expert review';

/** Where a record sits, in the words the queues print. */
export const APPLICATION_STATUS: Record<ApplicationStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending: { label: 'Pending', tone: 'warning' },
  more_evidence: { label: 'More evidence', tone: 'warning' },
  verified: { label: 'Verified', tone: 'accent' },
  declined: { label: 'Declined', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};

export const REVIEW_STATUS: Record<ReviewStatus, { label: string; tone: Tone }> = {
  requested: { label: 'Requested', tone: 'warning' },
  draft: { label: 'Draft', tone: 'neutral' },
  submitted: { label: 'Submitted', tone: 'accent' },
  returned: { label: 'Returned', tone: 'warning' },
  finalized: { label: 'Finalized', tone: 'accent' },
};

export const reportPath = (report: { code: string; version: string }) => `/reports/${report.code}/v${report.version}`;

export const lockedNote = (domains: string[]) => (domains.length ? `Other domains remain locked: ${domains.map((name) => `Verified ${name} credential required.`).join(' ')}` : null);

/** Submitting is consequential on these forms, so pressing Enter in a field must not do it by accident. */
export function keepEnterFromSubmitting(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
}
