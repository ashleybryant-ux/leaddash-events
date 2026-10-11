/**
 * How an event's attendee-facing pages look: colors, header, button shape,
 * font, page background and text size. Used by the app, the checkout page,
 * the call for proposals page, emails, badges and certificates.
 *
 * Everything here is plain math on hex colors so the server (emails) and the
 * client (CSS variables, the admin preview) share one set of rules.
 */

export const LOOK_HEADERS = ["solid", "cover", "light"] as const;
export const LOOK_SHAPES = ["rounded", "square", "pill"] as const;
export const LOOK_FONTS = ["jakarta", "inter", "lora", "montserrat"] as const;
export const LOOK_BUTTON_TEXT = ["auto", "white", "dark"] as const;
export const LOOK_BACKGROUNDS = ["gray", "white"] as const;
export const LOOK_TEXT_SIZES = ["standard", "larger"] as const;

export type LookHeader = (typeof LOOK_HEADERS)[number];
export type LookShape = (typeof LOOK_SHAPES)[number];
export type LookFont = (typeof LOOK_FONTS)[number];
export type LookButtonText = (typeof LOOK_BUTTON_TEXT)[number];
export type LookBackground = (typeof LOOK_BACKGROUNDS)[number];
export type LookTextSize = (typeof LOOK_TEXT_SIZES)[number];

export type Look = {
  header: LookHeader;
  buttonShape: LookShape;
  font: LookFont;
  buttonText: LookButtonText;
  background: LookBackground;
  textSize: LookTextSize;
};

export const DEFAULT_LOOK: Look = { header: "solid", buttonShape: "rounded", font: "jakarta", buttonText: "auto", background: "gray", textSize: "standard" };

/** Any branding object: only the two colors are required; look fields fall back to the defaults. */
export type BrandLike = { colorPrimary: string; colorAccent: string; colorHighlight?: string } & Partial<Look>;

export const FONTS: Record<LookFont, { label: string; css: string; google: string | null }> = {
  jakarta: { label: "Plus Jakarta Sans", css: '"Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif', google: null },
  inter: { label: "Inter", css: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif', google: "Inter:wght@400;500;600;700;800" },
  lora: { label: "Lora", css: '"Lora", Georgia, "Times New Roman", serif', google: "Lora:wght@400;500;600;700" },
  montserrat: { label: "Montserrat", css: '"Montserrat", system-ui, -apple-system, "Segoe UI", sans-serif', google: "Montserrat:wght@400;500;600;700;800" },
};

export const HEADER_LABELS: Record<LookHeader, string> = { solid: "Solid color", cover: "Cover image", light: "White with logo" };
export const SHAPE_LABELS: Record<LookShape, string> = { rounded: "Rounded", square: "Square", pill: "Pill" };
export const SHAPE_RADIUS: Record<LookShape, string> = { rounded: "10px", square: "4px", pill: "999px" };
export const BUTTON_TEXT_LABELS: Record<LookButtonText, string> = { auto: "Automatic", white: "White", dark: "Dark" };
export const BACKGROUND_LABELS: Record<LookBackground, string> = { gray: "Light gray", white: "White" };
export const TEXT_SIZE_LABELS: Record<LookTextSize, string> = { standard: "Standard", larger: "Larger" };

/** Ready-made color sets: main color, button color and highlight color. */
export const THEMES: { name: string; colorPrimary: string; colorAccent: string; colorHighlight: string }[] = [
  { name: "Forest", colorPrimary: "#1F5F4A", colorAccent: "#E88A3A", colorHighlight: "#2C8C99" },
  { name: "Ocean", colorPrimary: "#1D4E89", colorAccent: "#2BB3C0", colorHighlight: "#D9822B" },
  { name: "Plum", colorPrimary: "#5B2A6E", colorAccent: "#E2B33C", colorHighlight: "#2A9D8F" },
  { name: "Crimson", colorPrimary: "#8C1D2C", colorAccent: "#1F2A44", colorHighlight: "#B8860B" },
  { name: "Charcoal", colorPrimary: "#2B2F36", colorAccent: "#3FA36B", colorHighlight: "#C2410C" },
  { name: "Royal", colorPrimary: "#2F2A8A", colorAccent: "#F2C14E", colorHighlight: "#D6336C" },
];

/** The highlight color, or the main color when none is set. */
export function highlightOf(b: Pick<BrandLike, "colorPrimary" | "colorHighlight">) {
  return b.colorHighlight && isHex(b.colorHighlight) ? b.colorHighlight : isHex(b.colorPrimary) ? b.colorPrimary : "#1F5F4A";
}

/** The highlight color made dark enough to read as text on white. */
export function highlightText(hex: string) {
  let c = hex;
  for (let i = 0; i < 6 && contrast(c, WHITE) < 4.5; i++) c = mix(c, "#000000", 0.18);
  return c;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHex = (v: string) => HEX.test(v);

const INK = "#0F2A23";
const DARK_TEXT = "#1A1206";
const WHITE = "#FFFFFF";

function rgb(hex: string): [number, number, number] {
  const h = isHex(hex) ? hex.slice(1) : "000000";
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const toHex = (c: number[]) => "#" + c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("").toUpperCase();

/** Mixes a color toward another: amount 0 keeps `a`, 1 gives `b`. */
export function mix(a: string, b: string, amount: number) {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * amount));
}

/** Relative luminance (WCAG). */
export function luminance(hex: string) {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two colors (1 to 21). */
export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
}

/** White or dark text, whichever reads better on this color. */
export function readableOn(bg: string) {
  return contrast(bg, WHITE) >= contrast(bg, DARK_TEXT) ? WHITE : DARK_TEXT;
}

/** The text color on buttons, from the event's Button text choice. */
export function buttonInk(b: BrandLike) {
  const choice = b.buttonText ?? "auto";
  if (choice === "white") return WHITE;
  if (choice === "dark") return DARK_TEXT;
  return readableOn(b.colorAccent);
}

export function lookOf(b: Partial<Look> | null | undefined): Look {
  const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : d);
  return {
    header: pick(b?.header, LOOK_HEADERS, DEFAULT_LOOK.header),
    buttonShape: pick(b?.buttonShape, LOOK_SHAPES, DEFAULT_LOOK.buttonShape),
    font: pick(b?.font, LOOK_FONTS, DEFAULT_LOOK.font),
    buttonText: pick(b?.buttonText, LOOK_BUTTON_TEXT, DEFAULT_LOOK.buttonText),
    background: pick(b?.background, LOOK_BACKGROUNDS, DEFAULT_LOOK.background),
    textSize: pick(b?.textSize, LOOK_TEXT_SIZES, DEFAULT_LOOK.textSize),
  };
}

/**
 * CSS custom properties for the event's look. Set on the root of every
 * attendee-facing page; theme.css reads them.
 */
export function themeVars(b: BrandLike, coverUrl?: string | null): Record<string, string> {
  const look = lookOf(b);
  const brand = isHex(b.colorPrimary) ? b.colorPrimary : "#1F5F4A";
  const accent = isHex(b.colorAccent) ? b.colorAccent : "#E88A3A";
  const onBrand = readableOn(brand);
  const vars: Record<string, string> = {
    "--brand": brand,
    "--brand-dark": mix(brand, "#000000", 0.2),
    "--brand-mid": mix(brand, WHITE, 0.12),
    "--brand-tint": mix(brand, WHITE, 0.88),
    "--brand-tint-2": mix(brand, WHITE, 0.95),
    "--on-brand": onBrand,
    "--accent": accent,
    "--accent-ink": buttonInk({ ...b, colorAccent: accent }),
    "--highlight": highlightOf(b),
    "--highlight-text": highlightText(highlightOf(b)),
    "--highlight-tint": mix(highlightOf(b), WHITE, 0.86),
    "--highlight-ink": readableOn(highlightOf(b)),
    "--btn-radius": SHAPE_RADIUS[look.buttonShape],
    "--app-font": FONTS[look.font].css,
    "--app-bg": look.background === "white" ? WHITE : "#F8FAFB",
    "--app-zoom": look.textSize === "larger" ? "1.1" : "1",
  };
  if (look.header === "light") {
    Object.assign(vars, {
      "--header-bg": WHITE,
      "--header-image": "none",
      "--header-ink": INK,
      "--header-sub": "#4B5B57",
      "--header-border": brand,
      "--seg-bg": mix(brand, WHITE, 0.88),
      "--seg-ink": INK,
      "--header-line": "#D5DEDA",
      "--logo-line": "#E1E8E5",
      "--pick-bg": brand,
      "--pick-ink": onBrand,
    });
  } else if (look.header === "cover" && coverUrl) {
    Object.assign(vars, {
      "--header-bg": brand,
      "--header-image": `linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.45)), url("${coverUrl.replace(/"/g, "%22")}")`,
      "--header-ink": WHITE,
      "--header-sub": "rgba(255, 255, 255, 0.85)",
      "--header-border": "transparent",
      "--seg-bg": "rgba(255, 255, 255, 0.2)",
      "--seg-ink": WHITE,
      "--header-line": "rgba(255, 255, 255, 0.35)",
      "--logo-line": "transparent",
      "--pick-bg": WHITE,
      "--pick-ink": INK,
    });
  } else {
    Object.assign(vars, {
      "--header-bg": brand,
      "--header-image": "none",
      "--header-ink": onBrand,
      "--header-sub": onBrand === WHITE ? mix(brand, WHITE, 0.75) : "#24433A",
      "--header-border": b.colorHighlight && isHex(b.colorHighlight) ? b.colorHighlight : "transparent",
      "--seg-bg": mix(brand, onBrand === WHITE ? WHITE : "#000000", 0.12),
      "--seg-ink": onBrand,
      "--header-line": onBrand === WHITE ? "rgba(255, 255, 255, 0.28)" : "rgba(0, 0, 0, 0.2)",
      "--logo-line": "transparent",
      "--pick-bg": onBrand === WHITE ? WHITE : INK,
      "--pick-ink": onBrand === WHITE ? INK : WHITE,
    });
  }
  return vars;
}

/** Google Fonts stylesheet for the event's font, or null when the app already loads it. */
export function fontHref(font: LookFont) {
  const g = FONTS[font]?.google;
  return g ? `https://fonts.googleapis.com/css2?family=${g}&display=swap` : null;
}

/** Readability problems with a set of colors, in plain words. Empty when everything reads well. */
export function brandWarnings(b: BrandLike): string[] {
  const out: string[] = [];
  if (!isHex(b.colorPrimary) || !isHex(b.colorAccent)) return ["Colors look like #1F5F4A."];
  const look = lookOf(b);
  if (look.header !== "light" && contrast(b.colorPrimary, readableOn(b.colorPrimary)) < 4.5) out.push("The header text may be hard to read on the main color.");
  if (contrast(b.colorPrimary, WHITE) < 3) out.push("The main color is light, so links and dates will be hard to read on white.");
  if (b.colorHighlight && !isHex(b.colorHighlight)) out.push("The highlight color looks like #1F5F4A.");
  if (contrast(b.colorAccent, buttonInk(b)) < 4.5) out.push(look.buttonText === "auto" ? "Button text may be hard to read. Pick a darker or lighter button color." : "Button text is hard to read. Set Button text to Automatic.");
  return out;
}

/**
 * Two colors from a logo's pixels (RGBA bytes): the most common strong color
 * becomes the main color, and the most common color of a different hue becomes
 * the button color. Near-white, near-black, gray and see-through pixels are skipped.
 */
export function colorsFromPixels(data: ArrayLike<number>): { colorPrimary: string; colorAccent: string } | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] < 128) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 240 && min > 240) continue;
    if (max < 25) continue;
    if (max - min < 28) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    cur.n += 1;
    cur.r += r;
    cur.g += g;
    cur.b += b;
    buckets.set(key, cur);
  }
  const ranked = [...buckets.values()].sort((a, b) => b.n - a.n).map((x) => ({ n: x.n, hex: toHex([x.r / x.n, x.g / x.n, x.b / x.n]) }));
  if (!ranked.length) return null;
  const hue = (hex: string) => {
    const [r, g, b] = rgb(hex).map((v) => v / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const far = (a: string, b: string) => {
    const d = Math.abs(hue(a) - hue(b));
    return Math.min(d, 360 - d) > 35 || Math.abs(luminance(a) - luminance(b)) > 0.25;
  };
  // The main color carries white header text, so prefer a color dark enough for it.
  const main = ranked.find((x) => contrast(x.hex, WHITE) >= 4.5) ?? ranked[0];
  let mainHex = main.hex;
  if (contrast(mainHex, WHITE) < 4.5) {
    for (let k = 0.1; k <= 0.8 && contrast(mainHex, WHITE) < 4.5; k += 0.1) mainHex = mix(main.hex, "#000000", k);
  }
  const second = ranked.find((x) => x !== main && far(x.hex, main.hex));
  return { colorPrimary: mainHex, colorAccent: second ? second.hex : mix(mainHex, WHITE, 0.45) };
}
