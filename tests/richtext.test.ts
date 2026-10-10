import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { asRichText, cleanRichText, richTextToPlain } from "../server/_core/richtext";
import { freshDb, setupEvent, caller, getDb, schema } from "./helpers";

describe("formatted guidelines", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("keeps headings, bold, lists and links, and drops everything else", () => {
    const html = cleanRichText(
      '<h1>Call</h1><p onclick="x()">Hi <b>there</b> <span style="font-weight:700">bold</span> <i>it</i></p><script>alert(1)</script><ul><li>One</li><li></li></ul><a href="javascript:alert(1)">bad</a> <a href="https://example.org">good</a><img src=x onerror=alert(1)>'
    );
    expect(html).toContain("<h2>Call</h2>");
    expect(html).toContain("<strong>there</strong>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain("<ul><li>One</li></ul>");
    expect(html).toContain('<a href="https://example.org" target="_blank" rel="noopener noreferrer">good</a>');
    expect(html).not.toMatch(/script|onclick|onerror|javascript|<img/);
    // Google Docs wraps pasted text in a bold tag set to normal weight.
    expect(cleanRichText('<b style="font-weight:normal"><p>Plain</p></b>')).toBe("<p>Plain</p>");
  });

  it("turns older plain text into paragraphs", () => {
    expect(asRichText("Line one\nLine two\n\nNext <para>")).toBe("<p>Line one<br />Line two</p><p>Next &lt;para&gt;</p>");
    expect(richTextToPlain("<h2>Title</h2><p>A &amp; B</p>")).toBe("Title\nA & B");
  });

  it("saves the guidelines cleaned and shows them on the proposal page", async () => {
    const { admin, event } = await setupEvent();
    const s = await admin.network.proposals.admin.settings({ eventId: event.id });
    await admin.network.proposals.admin.updateSettings({ eventId: event.id, opensOn: null, closesOn: null, intro: "<h2>Theme</h2><p>Submit <strong>by Nov 1</strong></p><script>x</script>", formats: s.formats, tracks: [], rubric: s.rubric, blind: true, reviewersPerProposal: 1 });
    const info = await caller(null).network.proposals.info({ slug: event.slug });
    expect(info.intro).toBe("<h2>Theme</h2><p>Submit <strong>by Nov 1</strong></p>");

    getDb().update(schema.cfpSettings).set({ intro: "Old intro\n\nSecond" }).where(eq(schema.cfpSettings.eventId, event.id)).run();
    expect((await admin.network.proposals.admin.settings({ eventId: event.id })).intro).toBe("<p>Old intro</p><p>Second</p>");
  });
});
