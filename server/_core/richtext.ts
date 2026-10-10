/**
 * Formatted text that organizations write (call for proposals guidelines).
 * The editor in the admin produces HTML; only a short list of tags is kept
 * (headings, bold, italic, underline, lists, links, paragraphs), so pasted
 * text from Word or Google Docs keeps its structure and nothing else.
 */
import sanitizeHtml from "sanitize-html";
import { escapeHtml } from "./email";

const ALLOWED = ["p", "br", "h2", "h3", "strong", "em", "u", "ul", "ol", "li", "a", "blockquote"];

const looksBold = (style: string | undefined) => /font-weight\s*:\s*(bold|[6-9]00)/i.test(style ?? "");
const looksItalic = (style: string | undefined) => /font-style\s*:\s*italic/i.test(style ?? "");

/** Keeps only the allowed formatting. Links open in a new tab and must be web or email links. */
export function cleanRichText(html: string) {
  const out = sanitizeHtml(html, {
    allowedTags: ALLOWED,
    allowedAttributes: { a: ["href", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      h1: "h2",
      h4: "h3",
      h5: "h3",
      h6: "h3",
      b: (_tag, attribs) => ({ tagName: /font-weight\s*:\s*(normal|400)/i.test(attribs.style ?? "") ? "span" : "strong", attribs: {} }),
      i: "em",
      div: "p",
      span: (_tag, attribs) => ({ tagName: looksBold(attribs.style) ? "strong" : looksItalic(attribs.style) ? "em" : "span", attribs: {} }),
      a: (_tag, attribs) => ({ tagName: "a", attribs: { href: attribs.href ?? "", target: "_blank", rel: "noopener noreferrer" } }),
    },
    // Empty headings and list items left behind by editing are dropped. Empty paragraphs stay as blank lines.
    exclusiveFilter: (frame) => ["li", "h2", "h3"].includes(frame.tag) && !frame.text.trim(),
  });
  return out.replace(/(<p>\s*(<br\s*\/?>)?\s*<\/p>\s*){2,}/g, "<p><br /></p>").trim();
}

/** Text saved before formatting existed (or typed without tags) becomes paragraphs. */
export function asRichText(text: string) {
  if (!text.trim()) return "";
  if (/<(p|h2|h3|ul|ol|strong|em|br|a)\b/i.test(text)) return cleanRichText(text);
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

/** Plain text of formatted text (search, emails, length checks). */
export function richTextToPlain(html: string) {
  return sanitizeHtml(html.replace(/<\/(p|h2|h3|li)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n"), { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
