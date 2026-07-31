import nodemailer, { type Transporter } from 'nodemailer';
// outbound_emails has a NULLABLE workspace_id (platform-level mail: a password
// reset belongs to a user, not a workspace), and mail is queued from pre-tenant
// flows like signup.
// eslint-disable-next-line no-restricted-imports -- outbound_emails is intentionally unscoped
import { unscopedPrisma } from '../db/unscoped.js';
import { settings } from './platform/settings.js';

/**
 * Transactional email.
 *
 * Every message is persisted to `outbound_emails` BEFORE any send is attempted, so
 * that table doubles as the retry queue and the per-workspace email quota source.
 * "Did we send it?" and "how many did they send?" are then the same question
 * against the same rows, instead of a log grep and a guess.
 *
 * With SMTP_HOST unset (local dev, CI) nothing is sent: the row is written and the
 * body is logged. That means development never needs a mail server, and — more
 * importantly — a missing SMTP config never silently swallows a message.
 */

export type EmailTemplate =
  | 'verify_email'
  | 'password_reset'
  | 'password_changed'
  | 'two_factor_changed'
  | 'workspace_invite'
  | 'website_installed'
  | 'offline_data_alert';

interface SendArgs {
  to: string;
  template: EmailTemplate;
  /** Values interpolated into the template. */
  vars: Record<string, string>;
  workspaceId?: string | null;
  relatedType?: string;
  relatedId?: string;
}

let transporter: Transporter | null = null;
/** The host the cached transporter was built for, so an ops-panel change lands. */
let transporterHost: string | null = null;

function getTransporter(): Transporter | null {
  const mail = settings().mail;
  if (!mail.host) return null;
  // Rebuilt when the host changes. Caching it unconditionally would mean an
  // operator fixing a wrong SMTP host has to restart the process to be believed.
  if (transporter && transporterHost !== mail.host) {
    transporter.close();
    transporter = null;
  }
  transporterHost = mail.host;
  transporter ??= nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    ...(mail.user ? { auth: { user: mail.user, pass: mail.password ?? undefined } } : {}),
  });
  return transporter;
}

/** Escape interpolated values — a workspace name is attacker-controlled text. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Rendered {
  subject: string;
  html: string;
  text: string;
}

function layout(heading: string, body: string, cta?: { label: string; url: string }): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f9fafb;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#111827">
  <table role="presentation" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px">
    <tr><td style="padding:28px">
      <div style="font-weight:700;letter-spacing:-0.01em;font-size:18px;margin-bottom:20px">Nestled</div>
      <h1 style="font-size:20px;line-height:1.3;margin:0 0 12px">${heading}</h1>
      <div style="font-size:14px;line-height:1.6;color:#4b5563">${body}</div>
      ${
        cta
          ? `<div style="margin-top:24px"><a href="${cta.url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;font-size:14px">${esc(cta.label)}</a></div>
             <div style="margin-top:16px;font-size:12px;color:#9ca3af;word-break:break-all">Or paste this link into your browser:<br>${cta.url}</div>`
          : ''
      }
    </td></tr>
  </table>
</body></html>`;
}

function render(template: EmailTemplate, v: Record<string, string>): Rendered {
  switch (template) {
    case 'verify_email':
      return {
        subject: 'Confirm your email address',
        html: layout(
          'Confirm your email address',
          `<p>Hi ${esc(v.name ?? 'there')}, welcome to Nestled. Confirm this address to finish setting up your account.</p>
           <p>This link expires in 24 hours.</p>`,
          { label: 'Confirm email', url: v.url! },
        ),
        text: `Confirm your email address: ${v.url}\n\nThis link expires in 24 hours.`,
      };
    case 'password_reset':
      return {
        subject: 'Reset your password',
        html: layout(
          'Reset your password',
          `<p>Someone asked to reset the password for this account. If that was you, choose a new one below.</p>
           <p>This link expires in 1 hour. If it wasn't you, you can ignore this email — nothing has changed.</p>`,
          { label: 'Choose a new password', url: v.url! },
        ),
        text: `Reset your password: ${v.url}\n\nThis link expires in 1 hour. If you didn't ask for this, ignore this email.`,
      };
    case 'password_changed':
      return {
        subject: 'Your password was changed',
        html: layout(
          'Your password was changed',
          `<p>The password for your Nestled account was just changed, and every other signed-in session was signed out.</p>
           <p><b>If this wasn't you</b>, reset your password immediately and contact us.</p>`,
          { label: 'Go to Nestled', url: settings().urls.app },
        ),
        text: `Your Nestled password was changed and all other sessions were signed out. If this wasn't you, reset your password immediately.`,
      };
    /*
      Sent on both directions of the change, and sent even though the person who made
      it is looking at the screen. The recipient of interest is the one who did NOT
      make it: turning the second factor off is what an attacker with a live session
      does first, and this email is the only place that surfaces outside the session.
    */
    case 'two_factor_changed':
      return {
        subject: `Two-step verification was ${v.action ?? 'changed'}`,
        html: layout(
          `Two-step verification was ${esc(v.action ?? 'changed')}`,
          `<p>Two-step verification on your Nestled account was just ${esc(v.action ?? 'changed')}.</p>
           <p><b>If this wasn't you</b>, change your password straight away — whoever did it was signed in as you.</p>`,
          { label: 'Review your security settings', url: `${settings().urls.app}/account/security` },
        ),
        text: `Two-step verification on your Nestled account was ${v.action ?? 'changed'}. If this wasn't you, change your password immediately.`,
      };
    case 'workspace_invite':
      return {
        subject: `${v.inviterName ?? 'A teammate'} invited you to ${v.workspaceName ?? 'a workspace'} on Nestled`,
        html: layout(
          `You've been invited to ${esc(v.workspaceName ?? 'a workspace')}`,
          `<p>${esc(v.inviterName ?? 'A teammate')} invited you to join <b>${esc(v.workspaceName ?? '')}</b> on Nestled as ${esc(v.role ?? 'an agent')}.</p>
           <p>This invitation expires in 7 days.</p>`,
          { label: 'Accept invitation', url: v.url! },
        ),
        text: `${v.inviterName} invited you to ${v.workspaceName} on Nestled as ${v.role}. Accept: ${v.url}`,
      };
    case 'website_installed':
      return {
        subject: `${v.websiteName ?? 'Your website'} is live on Nestled`,
        html: layout(
          "You're live",
          `<p>We just saw the Nestled widget load on <b>${esc(v.host ?? '')}</b>. Visitors can start chatting with you now.</p>`,
          { label: 'Open your inbox', url: v.url ?? settings().urls.app },
        ),
        text: `The Nestled widget is live on ${v.host}. Open your inbox: ${v.url ?? settings().urls.app}`,
      };
    /*
      Someone left their details while nobody was there to read them.

      The DETAILS are the message, so they lead — a subject and a body that only said
      "you have a new conversation" would be a notification about a notification, and the
      reader is on their phone deciding whether this is worth opening a laptop for.

      `<pre>` for the block, not a table: the values come from a customer's own bot flow
      and pre-chat form, so the field names and their number are unknown here. Preformatted
      text renders any of them, in every mail client, without a layout to get wrong. It is
      escaped like everything else — a visitor typed most of it.
    */
    case 'offline_data_alert':
      return {
        subject: `${v.who ?? 'A visitor'} left their details — ${v.websiteName ?? 'your website'}`,
        html: layout(
          `${esc(v.who ?? 'A visitor')} left their details`,
          `<p>Nobody was online on <b>${esc(v.websiteName ?? 'your website')}</b>, so this is what they gave us:</p>
           <pre style="margin:16px 0;padding:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:#111827">${esc(v.details ?? '')}</pre>`,
          { label: 'Open the conversation', url: v.url ?? settings().urls.app },
        ),
        text: `${v.who ?? 'A visitor'} left their details on ${v.websiteName ?? 'your website'} while nobody was online.\n\n${v.details ?? ''}\n\nOpen the conversation: ${v.url ?? settings().urls.app}`,
      };
  }
}

/**
 * Queue and attempt an email. Never throws into the request path: a failed send
 * leaves a `failed` row for the retry sweep rather than failing the signup that
 * triggered it.
 */
export async function sendEmail(args: SendArgs): Promise<void> {
  const { subject, html, text } = render(args.template, args.vars);

  const row = await unscopedPrisma.outbound_emails.create({
    data: {
      workspace_id: args.workspaceId ?? null,
      to_email: args.to.toLowerCase(),
      template: args.template,
      subject,
      status: 'queued',
      related_type: args.relatedType ?? null,
      related_id: args.relatedId ?? null,
    },
    select: { id: true },
  });

  const tx = getTransporter();
  if (!tx) {
    // No SMTP configured. Log the link so local flows are completable, and leave
    // the row queued rather than marking it sent — claiming a send that never
    // happened is worse than an obviously pending row.
    // eslint-disable-next-line no-console
    console.log(`[email] (no SMTP) ${args.template} -> ${args.to}\n${text}`);
    return;
  }

  try {
    const info = await tx.sendMail({ from: settings().mail.from, to: args.to, subject, text, html });
    await unscopedPrisma.outbound_emails.update({
      where: { id: row.id },
      data: {
        status: 'sent',
        sent_at: new Date(),
        provider_message_id: info.messageId ?? null,
        attempts: { increment: 1 },
      },
    });
  } catch (err) {
    await unscopedPrisma.outbound_emails.update({
      where: { id: row.id },
      data: { status: 'failed', error: (err as Error).message.slice(0, 500), attempts: { increment: 1 } },
    });
    // eslint-disable-next-line no-console
    console.error(`[email] send failed (${args.template} -> ${args.to})`, err);
  }
}

/**
 * Send a conversation reply as mail, from one of the workspace's own addresses.
 *
 * Separate from `sendEmail` because almost everything differs: the From is the
 * customer's inbound address rather than ours, the body is an agent's words rather
 * than a template, and threading headers matter. What it shares — the transporter,
 * the `outbound_emails` ledger, and never throwing into a request — is what it
 * reuses.
 *
 * Unlike `sendEmail` this one REPORTS failure to its caller. A transactional email
 * that fails is retried by a sweep and nobody is waiting; an agent's reply that
 * fails has a person on the other end expecting an answer, and the agent has to be
 * told in the thread.
 */
export async function sendChannelEmail(args: {
  from: string;
  fromName?: string | null;
  to: string;
  subject: string;
  text: string;
  /**
   * The Message-ID of the mail we are replying to. Both headers are set from it,
   * because clients disagree about which one they thread on: Apple Mail and Outlook
   * lean on References, most others on In-Reply-To. Setting one and not the other is
   * how a reply arrives as a brand-new thread in half your customers' inboxes.
   */
  inReplyTo?: string | null;
  workspaceId: string;
  conversationId: string;
}): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  const row = await unscopedPrisma.outbound_emails.create({
    data: {
      workspace_id: args.workspaceId,
      to_email: args.to.toLowerCase(),
      template: 'channel_reply',
      subject: args.subject,
      status: 'queued',
      related_type: 'conversation',
      related_id: args.conversationId,
    },
    select: { id: true },
  });

  const tx = getTransporter();
  if (!tx) {
    await unscopedPrisma.outbound_emails.update({
      where: { id: row.id },
      data: { status: 'failed', error: 'No SMTP configured', attempts: { increment: 1 } },
    });
    // Two audiences, two sentences. `outbound_emails.error` above keeps the reason
    // an operator needs and ops → Health counts it. What is RETURNED becomes
    // `messages.delivery_error`, which an agent reads in the thread — a customer
    // being told their reply failed because "email is not configured on this
    // installation" learns our vocabulary, not what to do next.
    return { ok: false, error: 'Email replies are temporarily unavailable — this reply was not sent.' };
  }

  try {
    const info = await tx.sendMail({
      // The customer's address, so the reply lands back on the same endpoint and
      // threads. Sending as our own address would route their reply to us.
      from: args.fromName ? `"${args.fromName.replace(/"/g, '')}" <${args.from}>` : args.from,
      to: args.to,
      subject: args.subject,
      text: args.text,
      ...(args.inReplyTo
        ? { inReplyTo: args.inReplyTo, references: [args.inReplyTo] }
        : {}),
      headers: {
        // Marks this as an automated-ish reply so other systems' vacation responders
        // stay quiet. Without it, two autoresponders can talk to each other until
        // somebody notices the bill.
        'Auto-Submitted': 'auto-replied',
      },
    });
    await unscopedPrisma.outbound_emails.update({
      where: { id: row.id },
      data: {
        status: 'sent',
        sent_at: new Date(),
        provider_message_id: info.messageId ?? null,
        attempts: { increment: 1 },
      },
    });
    return { ok: true, messageId: info.messageId ?? null };
  } catch (err) {
    const error = (err as Error).message.slice(0, 500);
    await unscopedPrisma.outbound_emails.update({
      where: { id: row.id },
      data: { status: 'failed', error, attempts: { increment: 1 } },
    });
    // eslint-disable-next-line no-console
    console.error(`[email] channel reply failed -> ${args.to}`, err);
    return { ok: false, error };
  }
}

/**
 * Re-drive failed sends. Called by the jobs sweep; exported so it can be tested
 * and triggered from the ops panel.
 */
export async function retryFailedEmails(limit = 25): Promise<number> {
  const rows = await unscopedPrisma.outbound_emails.findMany({
    where: { status: 'failed', attempts: { lt: 5 } },
    orderBy: { created_at: 'asc' },
    take: limit,
    select: { id: true },
  });
  // Bodies are not stored (they contain single-use tokens that may since have been
  // consumed), so a retry is a re-queue signal for the owning flow rather than a
  // blind resend. Marking them queued makes them visible in the ops panel.
  if (rows.length > 0) {
    await unscopedPrisma.outbound_emails.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: 'queued' },
    });
  }
  return rows.length;
}
