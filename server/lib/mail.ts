import type { AppContext } from '../context.ts';
import { unavailable } from './errors.ts';
import { newId } from './ids.ts';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** The one action the message exists for: shown on /dev/outbox. */
  link?: string;
  purpose: string;
}

/** Sends through Resend when configured; otherwise the message waits on /dev/outbox (non-production). */
export async function sendMail(ctx: AppContext, mail: Mail): Promise<void> {
  const { resendKey, mailFrom, allowDevOutbox } = ctx.config;
  let providerId: string | null = null;
  if (resendKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: mailFrom, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw unavailable('The email provider refused the message. Try again in a moment.', 'mail_failed');
    providerId = ((await res.json()) as { id?: string }).id ?? null;
  } else if (!allowDevOutbox) {
    throw unavailable('Email delivery is not configured on this server.', 'mail_not_configured');
  }
  await ctx.db.run(
    `INSERT INTO outbox (id, to_email, subject, body_text, link, purpose, delivered_via, provider_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), mail.to, mail.subject, mail.text, mail.link ?? null, mail.purpose, resendKey ? 'resend' : 'dev', providerId, ctx.now().toISOString()],
  );
}
