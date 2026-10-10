import { describe, it, expect } from "vitest";
import { brandWarnings, buttonInk, colorsFromPixels, contrast, lookOf, readableOn, themeVars, THEMES } from "@shared/brand";
import { emailButton, emailLayout } from "../server/_core/email";

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
});
