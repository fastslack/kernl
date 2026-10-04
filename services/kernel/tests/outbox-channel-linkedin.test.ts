import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { linkedinChannel, linkedinAccountsView } from "../assets/extensions/social/linkedin/_module/outbox-channel.js";

describe("linkedin_post channel", () => {
  const root = mkdtempSync(join(tmpdir(), "li-"));
  mkdirSync(join(root, "heural", "assets"), { recursive: true });
  writeFileSync(join(root, "heural", "assets", "img.png"), "x");
  const img = join(root, "heural", "assets", "img.png");
  const calls: Array<[string, unknown]> = [];
  let fail = "";
  const service = {
    getAccount: (id: string) => (id === "A1" ? { id, access_token: "t", status: "active" } : id === "OFF" ? { id, status: "disabled" } : undefined),
    createTextPost: async (i: unknown) => { if (fail) throw new Error(fail); calls.push(["text", i]); return { id: "p1", post_urn: "urn:li:share:1" }; },
    createImagePost: async (i: unknown) => { calls.push(["image", i]); return { id: "p2", post_urn: "urn:li:share:2" }; },
  };
  const ch = linkedinChannel({ service: () => service as never, projectAssetsRoot: root });

  it("validates length, account and image location", () => {
    expect(ch.validate({ text: "Hola" }, "linkedin:A1")).toEqual({ ok: true });
    expect(ch.validate({ text: "" }, "linkedin:A1").ok).toBe(false);
    expect(ch.validate({ text: "x".repeat(3001) }, "linkedin:A1").ok).toBe(false);
    expect(ch.validate({ text: "Hola" }, "linkedin:ZZ").ok).toBe(false);
    expect(ch.validate({ text: "Hola" }, "linkedin:OFF").ok).toBe(false);
    expect(ch.validate({ text: "Hola", image_path: "/etc/passwd" }, "linkedin:A1").ok).toBe(false);
    expect(ch.validate({ text: "Hola", image_path: join(root, "heural", "assets", "..", "..", "x.png") }, "linkedin:A1").ok).toBe(false);
    expect(ch.validate({ text: "Hola", image_path: img }, "linkedin:A1")).toEqual({ ok: true });
  });

  it("publishes text or image posts and returns the urn", async () => {
    expect((await ch.send({ text: "Hola", article_url: "https://x.ar" }, "linkedin:A1")).ref).toBe("urn:li:share:1");
    expect((await ch.send({ text: "Hola", image_path: img }, "linkedin:A1")).ref).toBe("urn:li:share:2");
    expect(calls.map((c) => c[0])).toEqual(["text", "image"]);
    expect(calls[0][1]).toMatchObject({ account_id: "A1", text: "Hola", article_url: "https://x.ar" });
  });

  it("turns token errors into a reconnect message", async () => {
    fail = "LinkedIn API 401: token expired";
    await expect(ch.send({ text: "Hola" }, "linkedin:A1")).rejects.toThrow(/necesita reconectarse/);
    fail = "";
  });

  it("the accounts view never carries tokens or secrets", () => {
    const view = linkedinAccountsView([{ id: "A1", display_name: "Heural", status: "active", token_expires_at: "2027-01-01", access_token: "SECRET", refresh_token: "R", client_secret: "S" } as never]);
    expect(view).toEqual([{ id: "A1", display_name: "Heural", status: "active", token_expires_at: "2027-01-01" }]);
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });
});
