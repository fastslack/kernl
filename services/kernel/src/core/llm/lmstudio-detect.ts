/**
 * Talking to a local LM Studio: address normalization and live detection.
 *
 * Its own module because both the provider and the chat adapter need it, and
 * the provider already imports the adapter — putting it in either would close
 * an import cycle.
 */
/** Where LM Studio listens unless told otherwise. */
export const LMSTUDIO_DEFAULT_BASE = "http://127.0.0.1:1234/v1";

/**
 * LM Studio speaks the OpenAI *Responses* API, and only under `/v1`.
 *
 * Paste `http://127.0.0.1:1234` — which is what the app shows you, and what
 * the browser opens — and model discovery still works, because LM Studio
 * answers `/models` at either depth. Chat does not: the call goes to
 * `/responses`, LM Studio has no such route, and it replies
 * `{"error":"Unexpected endpoint or method"}` with **HTTP 200**. A provider
 * that lists sixteen models and fails every message is a hard thing to
 * diagnose, so the `/v1` is added here rather than demanded from the user.
 */
export function normalizeLmStudioBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return LMSTUDIO_DEFAULT_BASE;
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export interface LmStudioModel {
  id: string;
  /** Held in memory right now, i.e. able to answer without a load stall. */
  loaded: boolean;
  /** "llm", "vlm" (vision), "embeddings" — LM Studio's own taxonomy. */
  type: string;
  contextLength?: number;
}

export interface LmStudioDetection {
  running: boolean;
  baseUrl: string;
  /** Everything downloaded, loaded or not. */
  models: LmStudioModel[];
  /** The one to actually talk to: loaded, chat-capable, widest context. */
  activeModel: string | null;
}

/** Embeddings and OCR models answer /v1/models but cannot hold a conversation. */
function isChatCapable(m: LmStudioModel): boolean {
  if (m.type === "embeddings") return false;
  return !/(^|[-/])(embed|embedding|ocr)/i.test(m.id);
}

/**
 * Pick the model to use without asking.
 *
 * Loaded beats downloaded — an unloaded model works, but LM Studio stalls for
 * as long as it takes to page gigabytes off disk, which reads as a hang.
 * Among equals, the widest context wins: this drives kernel chat, where the
 * transcript is the payload.
 */
function chooseActive(models: LmStudioModel[]): string | null {
  const usable = models.filter(isChatCapable);
  const ranked = [...usable].sort((x, y) => {
    if (x.loaded !== y.loaded) return x.loaded ? -1 : 1;
    return (y.contextLength ?? 0) - (x.contextLength ?? 0);
  });
  return ranked[0]?.id ?? null;
}

/**
 * Is a local LM Studio up, what has it got, and what is loaded right now?
 *
 * Reads LM Studio's own `/api/v0/models`, which carries `state` and
 * `max_context_length`; the OpenAI-compatible `/v1/models` lists the same ids
 * with none of that, so it cannot tell "downloaded" from "in memory". Falls
 * back to `/v1` when the native route is absent (older builds), accepting that
 * `loaded` is then unknowable and treating every model as a candidate.
 *
 * `running` and a non-empty `models` are separate answers on purpose: LM
 * Studio idles happily with nothing loaded, and "start the server" and "load a
 * model" are different things to tell someone.
 */
export async function detectLmStudio(
  baseUrl: string = LMSTUDIO_DEFAULT_BASE,
  timeoutMs = 2_000,
): Promise<LmStudioDetection> {
  const base = normalizeLmStudioBase(baseUrl);
  const root = base.replace(/\/v\d+$/, "");
  const miss: LmStudioDetection = { running: false, baseUrl: base, models: [], activeModel: null };

  try {
    const r = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) {
      const body = (await r.json()) as {
        data?: Array<{ id?: string; state?: string; type?: string; max_context_length?: number; loaded_context_length?: number }>;
      };
      const models: LmStudioModel[] = (body.data ?? [])
        .filter((m) => m.id)
        .map((m) => ({
          id: m.id as string,
          loaded: m.state === "loaded",
          type: m.type ?? "",
          contextLength: m.loaded_context_length ?? m.max_context_length,
        }));
      return { running: true, baseUrl: base, models, activeModel: chooseActive(models) };
    }
  } catch { /* older LM Studio, or nothing there — try the OpenAI route */ }

  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return miss;
    const body = (await r.json()) as { data?: Array<{ id?: string }> };
    const models: LmStudioModel[] = (body.data ?? [])
      .filter((m) => m.id)
      .map((m) => ({ id: m.id as string, loaded: false, type: "" }));
    return { running: true, baseUrl: base, models, activeModel: chooseActive(models) };
  } catch {
    return miss;
  }
}

