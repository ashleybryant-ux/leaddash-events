import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { ENV } from "./env";
import { FONTS, SHAPE_RADIUS, buttonInk, lookOf, readableOn, type BrandLike } from "@shared/brand";

let client: SESClient | null = null;

export type SentEmail = { to: string; subject: string; text: string; html?: string; fromName?: string; replyTo?: string };

/** Emails sent during tests (and in development when SES is not reachable). */
export const outbox: SentEmail[] = [];

/**
 * Sends mail through Amazon SES with the server's AWS credentials (same
 * account and verified leaddash.io domain as LeadDash EHR and Employees).
 * `fromName` lets an event send as "Conference Team <events@leaddash.io>".
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

/** The email font: the event's font first, then safe fallbacks for mail apps that do not load web fonts. */
function emailFont(look?: BrandLike) {
  if (!look) return "Arial,Helvetica,sans-serif";
  const f = lookOf(look).font;
  return f === "lora" ? `${FONTS.lora.css.split(",")[0]},Georgia,serif` : f === "jakarta" ? "Arial,Helvetica,sans-serif" : `${FONTS[f].css.split(",")[0]},Arial,Helvetica,sans-serif`;
}

/**
 * A simple branded email layout. `blocks` are already-escaped HTML fragments.
 * Colors come from the event's branding; `look` adds its font.
 */
export function emailLayout(opts: { brand: string; accent: string; coverUrl?: string | null; title?: string; blocks: string[]; footer?: string; look?: BrandLike }) {
  const cover = opts.coverUrl
    ? `<img src="${opts.coverUrl}" alt="" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0">`
    : `<div style="height:8px;background:${opts.brand}"></div>`;
  return `<!doctype html><html><body style="margin:0;background:#F8FAFB;font-family:${emailFont(opts.look).replace(/"/g, "'")};color:#0F2A23">
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

/** A button link. Pass the event's branding to use its button color, button text and shape. */
export function emailButton(label: string, url: string, accent: string | BrandLike) {
  const bg = typeof accent === "string" ? accent : accent.colorAccent;
  const ink = typeof accent === "string" ? readableOn(accent) : buttonInk(accent);
  const radius = typeof accent === "string" ? "10px" : SHAPE_RADIUS[lookOf(accent).buttonShape];
  return `<p style="margin:16px 0"><a href="${url}" style="display:inline-block;background:${bg};color:${ink};font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:${radius}">${escapeHtml(label)}</a></p>`;
}
