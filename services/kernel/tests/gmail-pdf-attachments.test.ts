import { describe, it, expect } from "bun:test";
import { pdfAttachmentRefs } from "../assets/extensions/people/comms/_module/gmail-helpers.js";
import { readPdfAttachments, type AttachmentClient } from "../assets/extensions/integration/google-sync/_module/importers/gmail-attachments.js";

// 07/11: a ferry booking's date lived only in the attached e-ticket; the agenda never saw it.
const message = {
  mimeType: "multipart/mixed",
  parts: [
    { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { size: 10, data: "aG9sYQ" } }] },
    { mimeType: "application/pdf", filename: "eticket.pdf", body: { size: 80_000, attachmentId: "A1" } },
    { mimeType: "application/octet-stream", filename: "Factura.PDF", body: { size: 40_000, attachmentId: "A2" } },
    { mimeType: "image/png", filename: "logo.png", body: { size: 5_000, attachmentId: "A3" } },
    { mimeType: "application/pdf", filename: "huge.pdf", body: { size: 9_000_000, attachmentId: "A4" } },
  ],
};

describe("pdfAttachmentRefs", () => {
  it("finds the PDFs under the size cap, by type or by name, at any depth", () => {
    expect(pdfAttachmentRefs(message as never)).toEqual([
      { attachmentId: "A1", filename: "eticket.pdf", size: 80_000 },
      { attachmentId: "A2", filename: "Factura.PDF", size: 40_000 },
    ]);
  });
  it("a mail without attachments has none", () => {
    expect(pdfAttachmentRefs({ mimeType: "text/plain", body: { size: 3, data: "eA" } } as never)).toEqual([]);
  });
});

describe("readPdfAttachments", () => {
  const client = {
    get: async (url: string) => {
      if (url.endsWith("/attachments/A1")) return { data: Buffer.from("PDF-1").toString("base64url") };
      if (url.endsWith("/attachments/A2")) throw new Error("403");
      throw new Error(`unexpected ${url}`);
    },
  } as unknown as AttachmentClient;

  it("joins each PDF's text under its name and skips the ones that fail", async () => {
    const text = await readPdfAttachments(client, "M1", message as never, async (bytes) => `texto de ${Buffer.from(bytes).toString()}`);
    expect(text).toBe("[Adjunto: eticket.pdf]\ntexto de PDF-1");
  });

  it("caps the stored text", async () => {
    const text = await readPdfAttachments(client, "M1", message as never, async () => "x".repeat(50_000));
    expect(text.length).toBeLessThanOrEqual(8_000);
  });

  it("no PDFs: empty, without calling Gmail", async () => {
    const strict = { get: async () => { throw new Error("should not be called"); } } as unknown as AttachmentClient;
    expect(await readPdfAttachments(strict, "M1", { mimeType: "text/plain" } as never, async () => "")).toBe("");
  });
});
