import { SESClient, SendEmailCommand, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { randomBytes } from "node:crypto";
import { ENV } from "./env";
import { FONTS, SHAPE_RADIUS, buttonInk, lookOf, readableOn, type BrandLike } from "@shared/brand";

let client: SESClient | null = null;

export type EmailAttachment = { filename: string; contentType: string; content: Buffer };

export type SentEmail = { to: string; subject: string; text: string; html?: string; fromName?: string; replyTo?: string; attachments?: EmailAttachment[] };

/** RFC 2047 encoding for a header value that may hold non-ASCII text. */
const encodeHeader = (v: string) => (/^[\x20-\x7E]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
const base64Lines = (b: Buffer) => b.toString("base64").replace(/.{1,76}/g, "$&\r\n");

/** A complete MIME message (multipart/mixed: text and HTML alternatives, then the attachments) for SES SendRawEmail. */
export function buildRawEmail(msg: SentEmail, from: { name: string; address: string }) {
  const mixed = `mixed_${randomBytes(12).toString("hex")}`;
  const alt = `alt_${randomBytes(12).toString("hex")}`;
  const lines = [
    `From: "${encodeHeader(from.name)}" <${from.address}>`,
    `To: ${msg.to}`,
    ...(msg.replyTo ? [`Reply-To: ${msg.replyTo}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(msg.text, "utf8")),
  ];
  if (msg.html) lines.push(`--${alt}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64Lines(Buffer.from(msg.html, "utf8")));
  lines.push(`--${alt}--`, "");
  for (const a of msg.attachments ?? []) {
    const name = a.filename.replace(/["\\\r\n]/g, "");
    lines.push(`--${mixed}`, `Content-Type: ${a.contentType}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", base64Lines(a.content));
  }
  lines.push(`--${mixed}--`, "");
  return Buffer.from(lines.join("\r\n"), "utf8");
}

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
    if (msg.attachments?.length) {
      // Attachments need a raw MIME message.
      await client.send(new SendRawEmailCommand({ Destinations: [msg.to], RawMessage: { Data: buildRawEmail(msg, { name, address: ENV.emailFromAddress }) } }));
      return;
    }
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
 * The email header from the event's Header setting. Solid: a band in the main
 * color with the event name. Light: white with the name in the main color and a
 * thin main-color rule. Cover: the cover image with the name over it (darkened
 * like the app header), or the solid band when there is no cover. Without an
 * event name, the cover image or a thin color bar.
 */
function emailHeader(opts: { brand: string; coverUrl?: string | null; eventName?: string | null; look?: BrandLike }) {
  const name = opts.eventName?.trim();
  if (!name) {
    return opts.coverUrl
      ? `<img src="${opts.coverUrl}" alt="" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0">`
      : `<div style="height:8px;background:${opts.brand}"></div>`;
  }
  const header = lookOf(opts.look).header;
  const title = escapeHtml(name);
  const band = (bg: string, ink: string, extra = "") =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td bgcolor="${bg}" style="background:${bg};${extra}padding:18px 24px;font-size:17px;font-weight:bold;line-height:1.3;color:${ink}">${title}</td></tr></table>`;
  if (header === "light") return band("#FFFFFF", opts.brand, `border-bottom:3px solid ${opts.brand};`);
  if (header === "cover" && opts.coverUrl) {
    const url = opts.coverUrl.replace(/"/g, "%22");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td background="${url}" bgcolor="${opts.brand}" style="background:${opts.brand} url('${url}') center/cover no-repeat;background-image:linear-gradient(rgba(0,0,0,0.45),rgba(0,0,0,0.45)),url('${url}');background-size:cover;background-position:center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:56px 24px 18px;font-size:20px;font-weight:bold;line-height:1.3;color:#FFFFFF;text-shadow:0 1px 2px rgba(0,0,0,0.4)">${title}</td></tr></table>
</td></tr></table>`;
  }
  return band(opts.brand, readableOn(opts.brand));
}

/**
 * A simple branded email layout. `blocks` are already-escaped HTML fragments.
 * Colors come from the event's branding; `look` adds its font and header style.
 * Pass `eventName` to show the event name in the header.
 */
export function emailLayout(opts: { brand: string; accent: string; coverUrl?: string | null; eventName?: string | null; title?: string; blocks: string[]; footer?: string; look?: BrandLike }) {
  const cover = emailHeader(opts);
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
