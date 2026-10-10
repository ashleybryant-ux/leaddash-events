import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { ENV } from "./env";

let client: SESClient | null = null;

export type SentEmail = { to: string; subject: string; text: string; html?: string; fromName?: string; replyTo?: string };

/** Emails sent during tests (and in development when SES is not reachable). */
export const outbox: SentEmail[] = [];

/**
 * Sends mail through Amazon SES with the server's AWS credentials (same
 * account and verified leaddash.io domain as LeadDash EHR and Employees).
 * `fromName` lets an event send as "NABC Conference Team <events@leaddash.io>".
 */
export async function sendEmail(msg: SentEmail) {
  if (ENV.isTest) {
    outbox.push(msg);
    return;
  }
  const name = (msg.fromName || ENV.emailFromName).replace(/["<>]/g, "");
  try {
    client ||= new SESClient({ region: ENV.sesRegion });
    await client.send(
      new SendEmailCommand({
        Source: `"${name}" <${ENV.emailFromAddress}>`,
        ReplyToAddresses: msg.replyTo ? [msg.replyTo] : undefined,
        Destination: { ToAddresses: [msg.to] },
        Message: {
          Subject: { Data: msg.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: msg.text, Charset: "UTF-8" },
            ...(msg.html ? { Html: { Data: msg.html, Charset: "UTF-8" } } : {}),
          },
        },
      })
    );
  } catch (err) {
    if (ENV.isProduction) throw err;
    outbox.push(msg);
    console.log(`[email:dev] SES unavailable (${(err as Error).message}). To: ${msg.to}\nSubject: ${msg.subject}\n${msg.text}`);
  }
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * A simple branded email layout. `blocks` are already-escaped HTML fragments.
 * Colors come from the event's branding.
 */
export function emailLayout(opts: { brand: string; accent: string; coverUrl?: string | null; title?: string; blocks: string[]; footer?: string }) {
  const cover = opts.coverUrl
    ? `<img src="${opts.coverUrl}" alt="" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0">`
    : `<div style="height:8px;background:${opts.brand}"></div>`;
  return `<!doctype html><html><body style="margin:0;background:#F8FAFB;font-family:Arial,Helvetica,sans-serif;color:#0F2A23">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border:1px solid #E1E8E5;border-radius:14px;overflow:hidden">
<tr><td>${cover}</td></tr>
<tr><td style="padding:24px 24px 8px;font-size:15px;line-height:1.55">
${opts.title ? `<h1 style="margin:0 0 12px;font-size:22px">${escapeHtml(opts.title)}</h1>` : ""}
${opts.blocks.join("\n")}
</td></tr>
<tr><td style="padding:16px 24px 24px;font-size:12px;color:#4B5B57">${opts.footer ?? "Sent with LeadDash Events"}</td></tr>
</table></td></tr></table></body></html>`;
}

export const emailButton = (label: string, url: string, accent: string) =>
  `<p style="margin:16px 0"><a href="${url}" style="display:inline-block;background:${accent};color:#1A1206;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:10px">${escapeHtml(label)}</a></p>`;
