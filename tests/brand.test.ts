import { describe, it, expect } from "vitest";
import { brandWarnings, buttonInk, colorsFromPixels, contrast, highlightOf, highlightText, lookOf, readableOn, themeVars, THEMES } from "@shared/brand";
import { emailButton, emailLayout } from "../server/_core/email";

describe("highlight color", () => {
  it("falls back to the main color, keeps text readable, and stripes the header and emails", () => {
    expect(highlightOf({ colorPrimary: "#1F5F4A" })).toBe("#1F5F4A");
    expect(highlightOf({ colorPrimary: "#1F5F4A", colorHighlight: "#D4A017" })).toBe("#D4A017");
    expect(contrast(highlightText("#F2C14E"), "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    const v = themeVars({ colorPrimary: "#5B2A6E", colorAccent: "#E2B33C", colorHighlight: "#2A9D8F" });
    expect(v).toMatchObject({ "--highlight": "#2A9D8F", "--header-border": "#2A9D8F" });
    expect(themeVars({ colorPrimary: "#5B2A6E", colorAccent: "#E2B33C" })).toMatchObject({ "--highlight": "#5B2A6E", "--header-border": "transparent" });
    expect(THEMES.every((t) => /^#[0-9A-F]{6}$/i.test(t.colorHighlight))).toBe(true);
    const html = emailLayout({ brand: "#5B2A6E", accent: "#E2B33C", eventName: "Annual Conference 2027", look: { colorPrimary: "#5B2A6E", colorAccent: "#E2B33C", colorHighlight: "#2A9D8F" }, blocks: ["<p>Hi</p>"] });
    expect(html).toContain("background:#2A9D8F");
    expect(emailLayout({ brand: "#5B2A6E", accent: "#E2B33C", eventName: "Annual Conference 2027", look: { colorPrimary: "#5B2A6E", colorAccent: "#E2B33C" }, blocks: [] })).not.toContain("height:4px");
  });
});

describe("app look", () => {
  it("picks readable text and builds the page variables", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
    expect(readableOn("#1F5F4A")).toBe("#FFFFFF");
    expect(readableOn("#F2C14E")).toBe("#1A1206");
    expect(buttonInk({ colorPrimary: "#1F5F4A", colorAccent: "#F2C14E", buttonText: "white" })).toBe("#FFFFFF");

    const v = themeVars({ colorPrimary: "#5B2A6E", colorAccent: "#E2B33C", buttonShape: "pill", font: "lora", background: "white", textSize: "larger", header: "light" });
    expect(v).toMatchObject({ "--brand": "#5B2A6E", "--btn-radius": "999px", "--app-bg": "#FFFFFF", "--app-zoom": "1.1", "--header-bg": "#FFFFFF", "--header-border": "#5B2A6E", "--accent-ink": "#1A1206" });
    expect(v["--app-font"]).toContain("Lora");
    expect(v["--brand-tint"]).not.toBe("#E6F0EC");

    // A cover header needs a cover; without one it falls back to the main color.
    expect(themeVars({ colorPrimary: "#1D4E89", colorAccent: "#2BB3C0", header: "cover" })["--header-image"]).toBe("none");
    expect(themeVars({ colorPrimary: "#1D4E89", colorAccent: "#2BB3C0", header: "cover" }, "/files/a.jpg")["--header-image"]).toContain('url("/files/a.jpg")');
    expect(lookOf({ font: "comic" as never })).toMatchObject({ font: "jakarta", header: "solid" });
  });

  it("warns about colors that are hard to read, and every theme passes", () => {
    for (const t of THEMES) expect(brandWarnings(t)).toEqual([]);
    expect(brandWarnings({ colorPrimary: "#F7F7A0", colorAccent: "#E88A3A" }).join(" ")).toMatch(/main color is light/);
    expect(brandWarnings({ colorPrimary: "#1F5F4A", colorAccent: "#F2C14E", buttonText: "white" }).join(" ")).toMatch(/Button text is hard to read/);
    expect(brandWarnings({ colorPrimary: "nope", colorAccent: "#E88A3A" })).toEqual(["Colors look like #1F5F4A."]);
  });

  it("finds a main color and a button color in a logo", () => {
    const px: number[] = [];
    const add = (rgba: number[], n: number) => {
      for (let i = 0; i < n; i++) px.push(...rgba);
    };
    add([255, 255, 255, 255], 500); // white background
    add([0, 0, 0, 0], 200); // see-through
    add([31, 95, 74, 255], 300); // green
    add([232, 138, 58, 255], 100); // orange
    const c = colorsFromPixels(px)!;
    expect(contrast(c.colorPrimary, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(c.colorPrimary).toMatch(/^#1/);
    expect(c.colorAccent).toMatch(/^#E/);
    expect(colorsFromPixels([255, 255, 255, 255])).toBeNull();
  });

  it("styles emails with the event's button color, text and shape", () => {
    const b = { colorPrimary: "#5B2A6E", colorAccent: "#E2B33C", buttonShape: "pill" as const, buttonText: "auto" as const, font: "lora" as const };
    const btn = emailButton("Get the app", "https://example.org", b);
    expect(btn).toContain("background:#E2B33C");
    expect(btn).toContain("color:#1A1206");
    expect(btn).toContain("border-radius:999px");
    expect(emailButton("Open", "https://example.org", "#1F2A44")).toContain("color:#FFFFFF");
    expect(emailLayout({ brand: b.colorPrimary, accent: b.colorAccent, blocks: [], look: b })).toContain("font-family:'Lora',Georgia,serif");
  });

  it("puts the event name in the email header in the event's header style", () => {
    const base = { brand: "#1D4E89", accent: "#2BB3C0", blocks: [], eventName: "Annual Conference 2027" };
    const solid = emailLayout({ ...base, look: { colorPrimary: "#1D4E89", colorAccent: "#2BB3C0", header: "solid" } });
    expect(solid).toContain("background:#1D4E89;padding:18px 24px");
    expect(solid).toMatch(/color:#FFFFFF">Annual Conference 2027</);
    const light = emailLayout({ ...base, look: { colorPrimary: "#1D4E89", colorAccent: "#2BB3C0", header: "light" } });
    expect(light).toContain("border-bottom:3px solid #1D4E89");
    expect(light).toMatch(/color:#1D4E89">Annual Conference 2027</);
    const cover = emailLayout({ ...base, coverUrl: "https://x.test/c.jpg", look: { colorPrimary: "#1D4E89", colorAccent: "#2BB3C0", header: "cover" } });
    expect(cover).toContain("linear-gradient(rgba(0,0,0,0.45),rgba(0,0,0,0.45)),url('https://x.test/c.jpg')");
    expect(cover).toContain("Annual Conference 2027");
    // A cover header without a cover falls back to the solid band.
    expect(emailLayout({ ...base, look: { colorPrimary: "#1D4E89", colorAccent: "#2BB3C0", header: "cover" } })).toContain("background:#1D4E89;padding:18px 24px");
    // Without an event name: the old thin color bar.
    expect(emailLayout({ brand: "#1D4E89", accent: "#2BB3C0", blocks: [] })).toContain("height:8px;background:#1D4E89");
  });
});

describe("LeadDash Events logo in emails", () => {
  it("puts the logo under the footer of every email", () => {
    const html = emailLayout({ brand: "#1F5F4A", accent: "#E88A3A", blocks: ["<p>Hi</p>"] });
    expect(html).toContain("/brand/leaddash-events.png");
    expect(html).toContain('alt="LeadDash Events"');
  });
});

describe("LeadDash Events sign-in page", () => {
  it("ships the conference photo the sign-in page uses, at a size that loads fast", async () => {
    const { statSync, readFileSync } = await import("node:fs");
    const photo = statSync(new URL("../client/public/brand/signin-conference.jpg", import.meta.url));
    expect(photo.size).toBeLessThan(400_000);
    expect(readFileSync(new URL("../client/src/ui/theme.css", import.meta.url), "utf8")).toContain('url("/brand/signin-conference.jpg")');
  });
});
