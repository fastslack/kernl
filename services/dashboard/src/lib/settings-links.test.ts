import { describe, it, expect } from 'bun:test';
import { parseDescription } from './settings-links.js';

/** Convenience: the visible text, which must always survive intact. */
const flatten = (s: string) =>
  parseDescription(s)
    .map((t) => t.text)
    .join("");

const links = (s: string) =>
  parseDescription(s)
    .filter((t) => t.kind === "link")
    .map((t) => ({ text: t.text, href: (t as { href: string }).href }));

describe("settings description links", () => {
  it("links the explicit markdown form", () => {
    const out = links(
      "Se saca del panel de [one.dash.cloudflare.com](https://one.dash.cloudflare.com).",
    );
    expect(out).toEqual([
      { text: "one.dash.cloudflare.com", href: "https://one.dash.cloudflare.com/" },
    ]);
  });

  it("keeps the sentence readable around the link", () => {
    const text = "Se crea en [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens). Usá un token acotado.";
    expect(flatten(text)).toBe(
      "Se crea en dash.cloudflare.com/profile/api-tokens. Usá un token acotado.",
    );
  });

  it("autolinks a bare https url", () => {
    expect(links("Ver https://example.com/docs para más.")).toEqual([
      { text: "https://example.com/docs", href: "https://example.com/docs" },
    ]);
  });

  it("leaves closing punctuation out of the address", () => {
    // "(ver https://example.com)." used to produce a link ending in ")." —
    // which 404s at the far end.
    const out = links("(ver https://example.com).");
    expect(out).toEqual([{ text: "https://example.com", href: "https://example.com/" }]);
    expect(flatten("(ver https://example.com).")).toBe("(ver https://example.com).");
  });

  it("does not turn filenames into links", () => {
    // `.ts` and `.io` are real TLDs, so a "looks like a hostname" rule links
    // these. A settings hint that sends you to a website when it meant a file
    // is worse than one that links nothing.
    expect(links("Se configura en index.ts y en service.io.")).toEqual([]);
    expect(flatten("Se configura en index.ts y en service.io.")).toBe(
      "Se configura en index.ts y en service.io.",
    );
  });

  it("does not link in-app navigation", () => {
    expect(links("Se configura más cómodo desde Sistema → Cloudflare.")).toEqual([]);
  });

  it("refuses a javascript: url and shows the text instead", () => {
    // Descriptions come from extension manifests, which can be installed from
    // a marketplace. A hostile one must not get a scripted href.
    const raw = "[clic acá](javascript:alert(1))";
    expect(links(raw)).toEqual([]);
    expect(flatten(raw)).toBe(raw);
  });

  it("refuses other schemes too", () => {
    expect(links("[archivo](file:///etc/passwd)")).toEqual([]);
    expect(links("[correo](mailto:a@b.c)")).toEqual([]);
  });

  it("handles several links in one description", () => {
    const out = links(
      "Panel en [uno](https://a.example) y tokens en [dos](https://b.example/x).",
    );
    expect(out.map((l) => l.text)).toEqual(["uno", "dos"]);
  });

  it("returns nothing for an empty description", () => {
    expect(parseDescription("")).toEqual([]);
  });

  it("leaves plain prose as a single text token", () => {
    const out = parseDescription("Apagado por defecto.");
    expect(out).toEqual([{ kind: "text", text: "Apagado por defecto." }]);
  });
});
