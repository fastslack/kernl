/**
 * Text out of documents: pdf (unpdf), docx (mammoth), and the plain-text
 * formats read as UTF-8.
 *
 * Every extractor stops once it has more than the cap. A small file can
 * inflate to gigabytes — a docx is a zip, a pdf stream is deflate — and the
 * cap is what keeps one upload from taking the kernel's memory with it.
 */

import { readFile } from "node:fs/promises";
import { fromBuffer, type Entry as ZipEntry } from "yauzl";
import mammoth from "mammoth";
import { getDocumentProxy } from "unpdf";

/** Characters of extracted text kept per document. */
export const TEXT_CAP = 100_000;
/** Total uncompressed size a docx may declare before it is treated as a zip bomb. */
const DOCX_MAX_UNCOMPRESSED = 200 * 1024 * 1024;

export interface Extracted {
  text: string;
  pages?: number;
  warnings: string[];
}

function truncate(text: string, marker: string): string {
  if (text.length <= TEXT_CAP) return text;
  return `${text.slice(0, TEXT_CAP)}\n[…truncado, ${marker}]`;
}

export async function extractPdf(absPath: string): Promise<Extracted> {
  const data = new Uint8Array(await readFile(absPath));
  const pdf = await getDocumentProxy(data);
  const pages = pdf.numPages;
  const parts: string[] = [];
  let length = 0;
  try {
    for (let i = 1; i <= pages && length <= TEXT_CAP; i++) {
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
  const text = parts.join("\n\n").trim();
  const warnings = text ? [] : ["el PDF no tiene texto extraíble (¿es un escaneo?)"];
  return { text: truncate(text, `${pages} páginas en total`), pages, warnings };
}

/** Sum of the uncompressed sizes the zip's central directory declares. */
function zipUncompressedSize(buf: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) { reject(err ?? new Error("zip ilegible")); return; }
      let total = 0;
      zip.on("entry", (entry: ZipEntry) => {
        total += entry.uncompressedSize;
        if (total > DOCX_MAX_UNCOMPRESSED) { zip.close(); resolve(total); return; }
        zip.readEntry();
      });
      zip.on("end", () => resolve(total));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

export async function extractDocx(absPath: string): Promise<Extracted> {
  const buf = await readFile(absPath);
  const inflated = await zipUncompressedSize(buf);
  if (inflated > DOCX_MAX_UNCOMPRESSED) {
    throw new Error(`el docx se descomprime a más de ${DOCX_MAX_UNCOMPRESSED / 1024 / 1024} MB`);
  }
  const result = await mammoth.extractRawText({ buffer: buf });
  const text = result.value.replace(/\n{3,}/g, "\n\n").trim();
  return { text: truncate(text, `${text.length} caracteres en total`), warnings: text ? [] : ["el documento no tiene texto"] };
}

export async function extractPlainText(absPath: string): Promise<Extracted> {
  const raw = (await readFile(absPath, "utf-8")).replace(/^﻿/, "");
  return { text: truncate(raw, `${raw.length} caracteres en total`), warnings: [] };
}
