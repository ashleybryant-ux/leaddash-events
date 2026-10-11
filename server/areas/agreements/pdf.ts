/**
 * The signed agreement as a real PDF (Download PDF and the email attachment).
 * Layout follows the approved signed copy: event name and organization at the
 * top over a rule in the event's main color, the agreement text with bold
 * section labels, the two signature blocks, and the footer line.
 *
 * Fonts are the PDF standard fonts (Times for serif event fonts, Helvetica for
 * the rest). The signer's signature is the PNG drawn in the browser in the
 * signature font; the organization's countersignature is the same kind of PNG,
 * drawn when the template's signer was saved. Without one, the name is set in
 * Times Italic in the same spot.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { isHex, lookOf } from "@shared/brand";
import type { Agreement } from "../../../drizzle/schema";
import { signedCopy } from "./signed";

type Run = { text: string; bold: boolean; italic: boolean };
type Block = { kind: "h2" | "h3" | "p" | "li"; runs: Run[]; marker?: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => (ENTITIES[e] ?? (e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : m)));

/** Turns the cleaned agreement HTML (p, h2, h3, strong, em, u, lists, links, br) into blocks of styled text. */
export function htmlBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  let cur: Block | null = null;
  let bold = 0;
  let italic = 0;
  const open = (kind: Block["kind"], marker?: string) => {
    cur = { kind, runs: [], marker };
    blocks.push(cur);
  };
  const add = (text: string) => {
    if (!text) return;
    if (!cur) open("p");
    cur!.runs.push({ text, bold: bold > 0 || cur!.kind === "h2" || cur!.kind === "h3", italic: italic > 0 });
  };
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>|([^<]+)/gi)) {
    if (m[3] !== undefined) {
      add(decode(m[3]).replace(/\s+/g, " "));
      continue;
    }
    const close = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag === "strong" || tag === "b") bold += close ? -1 : 1;
    else if (tag === "em" || tag === "i") italic += close ? -1 : 1;
    else if (tag === "br") add("\n");
    else if (tag === "ul" || tag === "ol") {
      if (close) lists.pop();
      else lists.push({ ordered: tag === "ol", n: 0 });
      cur = null;
    } else if (["p", "h2", "h3", "li", "blockquote"].includes(tag)) {
      if (close) cur = null;
      else if (tag === "li") {
        const l = lists.at(-1);
        if (l) l.n++;
        open("li", l?.ordered ? `${l.n}.` : "•");
      } else open(tag === "blockquote" ? "p" : (tag as Block["kind"]));
    }
  }
  return blocks.filter((b) => b.runs.some((r) => r.text.trim()));
}

/** The standard fonts only cover Windows-1252; anything else becomes a close match or a question mark. */
const WIN_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
export function winAnsi(s: string) {
  return Array.from(s.normalize("NFC"))
    .map((c) => {
      const code = c.codePointAt(0)!;
      if (c === "\n") return c;
      if ((code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff) || WIN_EXTRA.has(c)) return c;
      if (code === 0x2010 || code === 0x2011) return "-";
      return "?";
    })
    .join("");
}

function hexColor(hex: string, fallback: string): RGB {
  const h = (isHex(hex) ? hex : fallback).slice(1);
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont; sig: PDFFont };
const pick = (f: Fonts, r: { bold: boolean; italic: boolean }) => (r.bold && r.italic ? f.boldItalic : r.bold ? f.bold : r.italic ? f.italic : f.regular);

/** Builds the signed PDF for one agreement. */
export async function agreementPdf(a: Agreement): Promise<Uint8Array> {
  const copy = signedCopy(a);
  const pdf = await PDFDocument.create();
  pdf.setTitle(winAnsi(`${copy.title} - ${copy.eventName}`));
  pdf.setProducer("LeadDash Events");
  pdf.setCreator("LeadDash Events");
  const serif = lookOf(copy.branding).font === "lora";
  const fonts: Fonts = {
    regular: await pdf.embedFont(serif ? StandardFonts.TimesRoman : StandardFonts.Helvetica),
    bold: await pdf.embedFont(serif ? StandardFonts.TimesRomanBold : StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(serif ? StandardFonts.TimesRomanItalic : StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(serif ? StandardFonts.TimesRomanBoldItalic : StandardFonts.HelveticaBoldOblique),
    sig: await pdf.embedFont(StandardFonts.TimesRomanItalic),
  };
  const ink = rgb(0.07, 0.07, 0.07);
  const gray = rgb(0.4, 0.4, 0.4);
  const sigInk = rgb(0.1, 0.17, 0.3);
  const brand = hexColor(copy.branding.colorPrimary, "#1F5F4A");
  const accent = hexColor(copy.branding.colorAccent, "#E88A3A");

  const W = 612;
  const H = 792;
  const M = 48;
  const width = W - M * 2;
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;
  const ensure = (need: number) => {
    if (y - need < M + 20) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
  };

  // Header: logo (or a round mark in the event colors), event name and organization, then a rule in the main color.
  let logoDrawn = false;
  if (copy.logo) {
    try {
      const img = copy.logo.mime === "image/png" ? await pdf.embedPng(copy.logo.data) : await pdf.embedJpg(copy.logo.data);
      const s = Math.min(30 / img.width, 30 / img.height);
      page.drawImage(img, { x: M + (30 - img.width * s) / 2, y: y - 30 + (30 - img.height * s) / 2, width: img.width * s, height: img.height * s });
      logoDrawn = true;
    } catch {
      logoDrawn = false;
    }
  }
  if (!logoDrawn) {
    page.drawCircle({ x: M + 15, y: y - 15, size: 15, color: brand });
    page.drawRectangle({ x: M + 10, y: y - 20, width: 10, height: 10, color: accent });
  }
  page.drawText(winAnsi(copy.eventName), { x: M + 40, y: y - 12, size: 10, font: fonts.bold, color: ink });
  page.drawText(winAnsi(copy.orgName), { x: M + 40, y: y - 25, size: 10, font: fonts.regular, color: gray });
  y -= 40;
  page.drawRectangle({ x: M, y: y - 2.5, width, height: 2.5, color: brand });
  y -= 24;

  // The agreement text, wrapped word by word with bold and italic runs kept.
  for (const b of htmlBlocks(copy.html)) {
    const size = b.kind === "h2" ? 13 : b.kind === "h3" ? 11.5 : 9.75;
    const lead = size * 1.55;
    const indent = b.kind === "li" ? 14 : 0;
    type Word = { text: string; font: PDFFont; w: number; space: number; br?: boolean };
    const words: Word[] = [];
    for (const r of b.runs) {
      const font = pick(fonts, r);
      const parts = winAnsi(r.text).split(/(\n| +)/);
      for (const p of parts) {
        if (p === "\n") words.push({ text: "", font, w: 0, space: 0, br: true });
        else if (/^ +$/.test(p)) {
          if (words.length) words[words.length - 1].space = font.widthOfTextAtSize(" ", size);
        } else if (p) words.push({ text: p, font, w: font.widthOfTextAtSize(p, size), space: 0 });
      }
    }
    const lines: Word[][] = [[]];
    let lw = 0;
    for (const w of words) {
      const line = lines[lines.length - 1];
      if (w.br) {
        lines.push([]);
        lw = 0;
        continue;
      }
      const prevSpace = line.length ? line[line.length - 1].space : 0;
      if (line.length && lw + prevSpace + w.w > width - indent) {
        lines.push([w]);
        lw = w.w;
      } else {
        lw += prevSpace + w.w;
        line.push(w);
      }
    }
    if (b.kind === "h2" || b.kind === "h3") ensure(lead * 3);
    lines.forEach((line, i) => {
      ensure(lead);
      if (i === 0 && b.marker) page.drawText(b.marker, { x: M + 2, y: y - size, size, font: fonts.regular, color: ink });
      let x = M + indent;
      for (const w of line) {
        if (w.text) page.drawText(w.text, { x, y: y - size, size, font: w.font, color: ink });
        x += w.w + w.space;
      }
      y -= lead;
    });
    y -= b.kind === "li" ? 2 : 6;
  }

  // Signatures: the signer's drawn signature and the organization's countersignature, side by side.
  ensure(110);
  y -= 14;
  const colW = (width - 32) / 2;
  const sigTop = y;
  const block = async (x: number, s: (typeof copy.signatures)[number]) => {
    let lineY = sigTop - 34;
    // A typed name sits where the drawn PNG's text sits (the PNG is 1.5 times the font size tall, with a 12px left margin, drawn 32pt tall).
    const typed = () => page.drawText(winAnsi(s.name), { x: x + 4, y: lineY + 12, size: 21, font: fonts.sig, color: sigInk });
    if (s.png) {
      try {
        const img = await pdf.embedPng(s.png);
        const scale = Math.min(32 / img.height, colW / img.width);
        page.drawImage(img, { x, y: lineY + 2, width: img.width * scale, height: img.height * scale });
      } catch {
        typed();
      }
    } else if (s.name) typed();
    page.drawLine({ start: { x, y: lineY }, end: { x: x + colW, y: lineY }, thickness: 0.75, color: rgb(0.2, 0.2, 0.2) });
    lineY -= 14;
    const nameW = fonts.bold.widthOfTextAtSize(winAnsi(s.name || " "), 8.5);
    page.drawText(winAnsi(s.name || ""), { x, y: lineY, size: 8.5, font: fonts.bold, color: ink });
    if (s.title) page.drawText(winAnsi(`, ${s.title}`), { x: x + nameW, y: lineY, size: 8.5, font: fonts.regular, color: ink });
    for (const extra of [s.company, s.when]) {
      lineY -= 13;
      if (extra) page.drawText(winAnsi(extra), { x, y: lineY, size: 8.5, font: fonts.regular, color: ink });
    }
    return lineY;
  };
  let low = sigTop;
  for (const [i, s] of copy.signatures.entries()) low = Math.min(low, await block(M + i * (colW + 32), s));
  y = low - 22;

  // Footer line under a thin rule.
  ensure(30);
  page.drawLine({ start: { x: M, y }, end: { x: M + width, y }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
  y -= 12;
  const footer = winAnsi(copy.footer);
  const fsize = 7.5;
  let line = "";
  for (const word of footer.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (fonts.regular.widthOfTextAtSize(next, fsize) > width) {
      page.drawText(line, { x: M, y, size: fsize, font: fonts.regular, color: gray });
      y -= 11;
      line = word;
    } else line = next;
  }
  if (line) page.drawText(line, { x: M, y, size: fsize, font: fonts.regular, color: gray });

  return pdf.save();
}
