import { describe, it, expect } from "bun:test";
import { stripHtml } from "../assets/extensions/people/comms/_module/gmail-helpers.js";

// An HTML-only message has no text part, so its readable body is derived from
// the HTML. Stripping the tags but keeping what was between them put the
// stylesheet on screen: "html, body { margin: 0 !important; … }" instead of
// the mail. These are the shapes newsletters and notifications arrive in.

describe("stripHtml", () => {
  it("drops <style>, <script>, <head> and comments with their contents", () => {
    const html = `<!DOCTYPE html><html><head><title>Account Notification</title>
      <style type="text/css">/* Reset */ html, body { margin: 0 !important; } table { border-spacing: 0 }</style>
      <!--[if mso]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]-->
      </head><body><script>track()</script>
      <p>Please update your payment details.</p></body></html>`;
    const text = stripHtml(html);
    expect(text).toBe("Please update your payment details.");
    expect(text).not.toMatch(/!important|margin|Reset|track\(|OfficeDocument|Account Notification/);
  });

  it("turns block and table boundaries into line breaks", () => {
    const html = `<table><tr><td>Starts:</td><td>Sat, Oct 3</td></tr><tr><td>Ends:</td><td>Sun</td></tr></table>
      <h1>Upcoming</h1><ul><li>One</li><li>Two</li></ul>`;
    const lines = stripHtml(html).split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines).toEqual(["Starts: Sat, Oct 3", "Ends: Sun", "Upcoming", "One", "Two"]);
  });

  it("decodes named and numeric entities", () => {
    expect(stripHtml("<p>Caf&eacute; &#8364;5 &#x2014; &copy; 2026&nbsp;&amp; m&aacute;s</p>")).toBe("Café €5 — © 2026 & más");
  });

  it("collapses the whitespace layout HTML is full of", () => {
    expect(stripHtml("<div>\n   Hola\n\n\n\n   <span>Matías</span>   </div>")).toBe("Hola Matías");
  });

  it("drops the invisible preheader padding newsletters add", () => {
    expect(stripHtml("<div>Samen door Europa \u200c \u00ad \u200c \u00ad \u034f \ufeff</div><p>Hola</p>")).toBe("Samen door Europa\nHola");
  });

  it("keeps plain text untouched", () => {
    expect(stripHtml("Just text, no tags.")).toBe("Just text, no tags.");
  });
});
