import { describe, it, expect } from "bun:test";
import { blockRemoteImages, buildSrcdoc, remoteImageCount } from "./mail-body.js";

describe("blockRemoteImages", () => {
  it("parks http(s) image sources and counts them", () => {
    const r = blockRemoteImages(`<p><img src="https://t.co/pixel.gif" width="1"><img alt="x" src="http://a.b/logo.png"></p>`);
    expect(r.blocked).toBe(2);
    expect(r.html).not.toMatch(/\ssrc="http/);
    expect(r.html).toContain('data-blocked-src="https://t.co/pixel.gif"');
    expect(r.html).toContain('alt="x" data-blocked-src="http://a.b/logo.png"');
  });

  it("leaves inline data: and cid: images alone", () => {
    const html = `<img src="data:image/png;base64,AAAA"><img src="cid:logo@x">`;
    expect(blockRemoteImages(html)).toEqual({ html, blocked: 0 });
  });

  it("does not touch link hrefs", () => {
    expect(blockRemoteImages(`<a href="https://x.y">x</a>`).blocked).toBe(0);
  });

  it("counts without rewriting", () => {
    expect(remoteImageCount(`<img src="https://a/b.png"><img src="https://a/c.png">`)).toBe(2);
  });
});

describe("buildSrcdoc", () => {
  const html = `<img src="https://a/b.png">`;

  it("keeps remote images out by rewrite and by CSP while blocked", () => {
    const doc = buildSrcdoc(html, false);
    expect(doc).toContain("img-src data: cid:;");
    expect(doc).not.toMatch(/\ssrc="https:\/\/a\/b\.png"/);
  });

  it("lets them load once the user asks", () => {
    const doc = buildSrcdoc(html, true);
    expect(doc).toContain("img-src data: cid: http: https:");
    expect(doc).toContain('src="https://a/b.png"');
  });

  it("never allows scripts and opens links outside the frame", () => {
    for (const show of [false, true]) {
      const doc = buildSrcdoc(html, show);
      expect(doc).toContain("default-src 'none'");
      expect(doc).not.toContain("script-src");
      expect(doc).toContain('<base target="_blank">');
    }
  });
});
