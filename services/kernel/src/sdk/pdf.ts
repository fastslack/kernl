/**
 * @kernl/extension-sdk/pdf — text out of a PDF.
 *
 * Kept off the main entry for the same reason as /html: pdf.js (through unpdf) is heavy, and anything on the main
 * entry lands in every extension bundle that loads part of itself lazily. The kernel's own document reader
 * (modules/attachments/extract.ts) uses this too.
 */

import { getDocumentProxy } from "unpdf";

/** Page by page until `cap` characters; `text` is '' when the PDF has none (a scan). Throws on a non-PDF. */
export async function extractPdfFromBytes(data: Uint8Array, cap = 100_000): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(data);
  const pages = pdf.numPages;
  const parts: string[] = [];
  let length = 0;
  try {
    for (let i = 1; i <= pages && length <= cap; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== "string") continue;
        pageText += item.str + (item.hasEOL ? "\n" : "");
      }
      pageText = pageText.trim();
      parts.push(pageText);
      length += pageText.length + 2;
    }
  } finally {
    // unpdf's typings leave out destroy(); pdf.js has it and it frees the worker-side document.
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => {});
  }
  return { text: parts.join("\n\n").trim(), pages };
}

/** The PDF's text, '' when it has none. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  return (await extractPdfFromBytes(data)).text;
}
