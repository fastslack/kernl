/**
 * Demo: translate 5 cinema descriptions EN → ES via OpenAI gpt-4o-mini.
 *
 * Purpose: validate quality + latency + cost of a per-description LLM
 * translation pass before building the TranslateRunner that will chew
 * through ~180k rows in the catalog. Strictly read-only on the DB.
 *
 * Run:
 *   bun scripts/demo-cinema-translate.ts
 */

import { Database } from "bun:sqlite";

const DB_PATH = "data/kernel.db";
const KERNEL_URL = "http://localhost:3086";
const KERNEL_TOKEN = process.env.KERNEL_AUTH_TOKEN ?? "";
// Optional: hint a specific model — the chain ignores it if no link can serve it.
const MODEL_HINT: string | undefined = undefined;

if (!KERNEL_TOKEN) {
  console.error("KERNEL_AUTH_TOKEN missing from env (read it from .env)");
  process.exit(1);
}

interface Row {
  identifier: string;
  title: string;
  year: number;
  description: string;
}

const db = new Database(DB_PATH, { readonly: true });

// Pick 5 titles with substantive English descriptions and no Spanish yet.
// Bias toward popular ones so the demo reflects what most users will see.
const rows = db
  .query(
    `SELECT identifier, title, year, description
     FROM cinema_titles
     WHERE deleted_at IS NULL
       AND has_torrent = 1
       AND hidden = 0
       AND description <> ''
       AND length(description) BETWEEN 200 AND 1500
       AND (description_es IS NULL OR description_es = '')
     ORDER BY downloads DESC
     LIMIT 5`,
  )
  .all() as Row[];

console.log(`Picked ${rows.length} titles to translate via kernel LLM chain.\n`);

interface ChatReply {
  text: string;
  provider: string;
  model: string;
  latency_ms: number;
  input_tokens?: number;
  output_tokens?: number;
}

async function translate(text: string): Promise<{ es: string; reply: ChatReply }> {
  const r = await fetch(`${KERNEL_URL}/api/llm/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KERNEL_TOKEN}`,
    },
    body: JSON.stringify({
      system:
        "Eres traductor profesional. Traducís sinopsis/descripciones de catálogo de cine del inglés al español neutro latinoamericano. Preservás nombres propios, títulos de películas y referencias culturales. NO inventes datos, no agregues comentarios, no uses formato — devolvé solo el texto traducido en una sola pieza.",
      user: text,
      model: MODEL_HINT,
      temperature: 0.2,
      caller: "scripts:demo-cinema-translate",
    }),
  });
  if (!r.ok) {
    throw new Error(`/api/llm/chat ${r.status}: ${(await r.text()).slice(0, 240)}`);
  }
  const reply = (await r.json()) as ChatReply;
  return { es: reply.text.trim(), reply };
}

let totalInTok = 0;
let totalOutTok = 0;
let totalMs = 0;
const providerHits = new Map<string, number>();

for (const r of rows) {
  console.log("─".repeat(78));
  console.log(`▸ ${r.identifier}  (${r.year || "????"})`);
  console.log(`  ${r.title.slice(0, 100)}`);
  console.log("");
  console.log(`  EN: ${r.description.slice(0, 300).replace(/\s+/g, " ")}${r.description.length > 300 ? "…" : ""}`);
  console.log("");
  try {
    const { es, reply } = await translate(r.description);
    totalInTok += reply.input_tokens ?? 0;
    totalOutTok += reply.output_tokens ?? 0;
    totalMs += reply.latency_ms;
    providerHits.set(`${reply.provider}/${reply.model}`, (providerHits.get(`${reply.provider}/${reply.model}`) ?? 0) + 1);
    console.log(`  ES: ${es.slice(0, 300).replace(/\s+/g, " ")}${es.length > 300 ? "…" : ""}`);
    console.log("");
    console.log(`  ▸ ${reply.latency_ms} ms · ${reply.provider}/${reply.model} · in=${reply.input_tokens ?? "?"} out=${reply.output_tokens ?? "?"}`);
  } catch (e) {
    console.log(`  ✗ failed: ${e instanceof Error ? e.message : e}`);
  }
  console.log("");
}

console.log("─".repeat(78));
console.log("Aggregate:");
console.log(`  ${rows.length} titles in ${totalMs} ms (${(totalMs / rows.length).toFixed(0)} ms/title)`);
console.log(`  ${totalInTok} input tokens, ${totalOutTok} output tokens`);
console.log(`  Provider hits:`);
for (const [k, v] of providerHits) console.log(`    ${v}× ${k}`);
console.log(
  `  Extrapolated wall time @ ${(rows.length / (totalMs / 1000)).toFixed(2)} t/s` +
    ` with no concurrency: ${((180_000 * (totalMs / rows.length)) / 1000 / 3600).toFixed(1)}h for 180k titles`,
);
