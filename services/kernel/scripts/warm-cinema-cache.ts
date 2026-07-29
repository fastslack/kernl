/**
 * warm-cinema-cache — recorre las colecciones curadas que muestra /cinema y
 * llena el caché SQLite (`archive_search_cache`) con varias páginas de cada
 * una. No es un agente LLM: solo es un cliente HTTP que pega al endpoint
 * `/api/torrents/import-archive/preview` del kernel; ese endpoint ya hace
 * cache-or-fetch contra archive.org y persiste en SQLite.
 *
 * Re-correrlo es seguro y barato: las entradas con menos de 6h se devuelven
 * desde la DB sin pegarle a archive.org.
 *
 * Uso:
 *   npx tsx scripts/warm-cinema-cache.ts
 *   KERNEL_URL=http://localhost:3086 PAGES=5 ROWS=60 npx tsx scripts/warm-cinema-cache.ts
 *
 * Variables de entorno:
 *   KERNEL_URL  — base URL del kernel (default http://localhost:3086)
 *   PAGES       — cuántas páginas por colección (default 5)
 *   ROWS        — items por página (default 60, mismo que el frontend)
 *   DELAY_MS    — pausa entre requests upstream (default 1500ms)
 *   COLLECTIONS — lista separada por comas; sobreescribe la curada
 */

const KERNEL_URL = (process.env.KERNEL_URL ?? "http://localhost:3086").replace(/\/$/, "");
const PAGES = Math.max(1, parseInt(process.env.PAGES ?? "5", 10));
const ROWS = Math.max(1, Math.min(200, parseInt(process.env.ROWS ?? "60", 10)));
const DELAY_MS = Math.max(0, parseInt(process.env.DELAY_MS ?? "1500", 10));

// Mismo set que el chip bar de /cinema (ver dashboard/src/routes/cinema/+page.svelte).
const DEFAULT_COLLECTIONS = [
  "feature_films",
  "silent_films",
  "classic_cartoons",
  "classic_tv",
  "film_noir",
  "horror",
  "sci-fi_horror",
  "prelinger",
  "opensource_movies",
];

const COLLECTIONS = (process.env.COLLECTIONS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TARGETS = COLLECTIONS.length > 0 ? COLLECTIONS : DEFAULT_COLLECTIONS;

interface PreviewResponse {
  items?: unknown[];
  cached?: boolean;
  error?: string;
}

async function warmOne(collection: string, page: number): Promise<{
  count: number;
  cached: boolean;
  upstream: boolean;
}> {
  const r = await fetch(`${KERNEL_URL}/api/torrents/import-archive/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ collection, rows: ROWS, page }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as PreviewResponse;
    throw new Error(body.error ?? `http ${r.status}`);
  }
  const body = (await r.json()) as PreviewResponse;
  const count = Array.isArray(body.items) ? body.items.length : 0;
  const cached = body.cached === true;
  return { count, cached, upstream: !cached };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n, " ");
}

async function main(): Promise<void> {
  console.log(
    `▮ warming ${TARGETS.length} collections × ${PAGES} pages (${ROWS} rows) → ${KERNEL_URL}`,
  );
  console.log(`  delay between upstream fetches: ${DELAY_MS}ms\n`);

  let totalRequests = 0;
  let totalUpstream = 0;
  let totalItems = 0;
  let totalErrors = 0;
  const startedAt = Date.now();

  for (const collection of TARGETS) {
    for (let page = 1; page <= PAGES; page++) {
      totalRequests++;
      try {
        const { count, cached, upstream } = await warmOne(collection, page);
        totalItems += count;
        if (upstream) totalUpstream++;
        const tag = cached ? "cache" : "fetch";
        console.log(
          `  [${tag}] ${pad(collection, 22)} p${pad(page, 2)} → ${count} items`,
        );
        // Solo aplicar delay cuando realmente fuimos al upstream — los hits
        // de caché son DB-only y no le pegan a archive.org.
        if (upstream && DELAY_MS > 0) await sleep(DELAY_MS);
      } catch (err) {
        totalErrors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [error] ${collection} p${page}: ${msg}`);
        // En caso de error de red/upstream, esperamos un poco más para no
        // empeorarlo.
        await sleep(DELAY_MS * 2);
      }
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\n✓ done · ${totalRequests} requests · ${totalUpstream} upstream · ${totalItems} items · ${totalErrors} errors · ${elapsed}s`,
  );
  if (totalErrors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
