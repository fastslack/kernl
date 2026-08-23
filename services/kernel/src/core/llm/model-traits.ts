/**
 * Classify a model ID into "is this chat? + what capabilities does it
 * have?" so the /models dropdown can:
 *
 *   - hide non-chat models (embeddings, audio, image, reranker, safety
 *     classifiers, protein/biomed specialists) — relevant especially for
 *     NVIDIA NIM which advertises 120+ models of every shape in its
 *     /v1/models response.
 *   - badge the survivors with iconography (vision / reasoning / fast /
 *     long-context) so the user can pick a model that fits the task at
 *     a glance.
 *
 * Heuristics are name-based — no upstream API tells us "this model has
 * vision". Patterns are conservative; when in doubt, the model is left
 * un-annotated rather than mis-tagged. Update the lists below when new
 * model families arrive.
 */

export interface ModelTraits {
  /** Suitable for chat completion (text in, text out). False excludes the
   *  model from the dropdown entirely. */
  chat: boolean;
  // ── Non-chat categories — present when chat=false to explain WHY ─
  embedding?: boolean;
  audio?: boolean;
  image?: boolean;
  reranker?: boolean;
  safety?: boolean;
  // ── Chat capability badges (only meaningful when chat=true) ────────
  /** Accepts image input alongside text. */
  vision?: boolean;
  /** Has built-in chain-of-thought / reasoning mode. */
  reasoning?: boolean;
  /** Small/fast tier — under ~10B params or marketed as "fast"/"mini"/"haiku". */
  fast?: boolean;
  /** ≥100k context window (best-effort from name). */
  longContext?: boolean;
}

export function classifyModel(slug: string, modelId: string): ModelTraits {
  const id = modelId.toLowerCase();

  // ── Hard exclusions: not chat ─────────────────────────────────────
  if (/(^|[\W_])(embed|embedding|text-embedding|nv-embed|nemoretriever|search-|retrieval-)/i.test(id)) {
    return { chat: false, embedding: true };
  }
  if (/(^|[\W_])(whisper|tts|speech|audio|voice|parakeet|canary)/i.test(id)) {
    return { chat: false, audio: true };
  }
  if (/(dall-?e|stable-diffusion|sdxl|flux\b|midjourney|kandinsky|imagen|playground|cosmos-1[._]predict|edify)/i.test(id)) {
    return { chat: false, image: true };
  }
  if (/(rerank|reranker)/i.test(id)) {
    return { chat: false, reranker: true };
  }
  if (/(guard|moderation|nemoguard|llamaguard|shield|safety|classifier)/i.test(id)) {
    return { chat: false, safety: true };
  }
  // Specialized scientific / domain models — not general chat
  if (/(protein|esm[12]?\b|alphafold|biomedclip|molmim|diffdock|rfdiffusion)/i.test(id)) {
    return { chat: false };
  }
  // OpenAI models that live on a different endpoint than /v1/chat/completions.
  //
  // This used to be anchored on `gpt-4o-*`, the 2024 naming. Everything OpenAI
  // has shipped since under a bare `gpt-` prefix — gpt-realtime (WebSocket /
  // WebRTC), gpt-transcribe and gpt-live-transcribe (/v1/audio/transcriptions),
  // gpt-image (/v1/images/generations) — sailed through as chat models. On a
  // live account that put 11 of them in the picker, every one a guaranteed 400
  // the first time an agent used it.
  //
  // Anchored with ^ and matched on whole segments so the rule can't reach a
  // chat model: `gpt-5.6-terra` and `gpt-5.1-codex-max` must survive it.
  if (
    /^(chatgpt|gpt)-image/i.test(id) ||
    /^gpt-realtime/i.test(id) ||
    /^gpt-(live-)?transcribe/i.test(id) ||
    /^gpt-4o(-mini)?-(audio|transcribe|tts|search)/i.test(id)
  ) {
    return {
      chat: false,
      image: /image/.test(id),
      audio: /audio|tts|transcribe|realtime/.test(id),
    };
  }

  // ── It's a chat model. Now annotate capability badges. ────────────
  const traits: ModelTraits = { chat: true };

  // VISION — multimodal text+image
  // Anthropic: all Claude 3+ accept images.
  // OpenAI: gpt-4o, gpt-4-turbo (vision), gpt-4.1 family.
  // Grok: grok-2-vision, grok-3-vision, grok-4 family.
  // Open / NIM: llama-vision, pixtral, llava, vl-, *-vl-, qwen-vl, internvl, etc.
  if (
    /(^|[\W_])(vision|multimodal|vl)([\W_]|$)/i.test(id) ||
    /(pixtral|llava|internvl|cogvlm|minicpm-v|fuyu)/i.test(id) ||
    /(claude-(3|sonnet|opus|haiku|4))/i.test(id) ||
    /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|chatgpt-4)/i.test(id) ||
    /(grok-[234])/i.test(id) ||
    /(gemini-[12]|gemini-pro|gemini-flash)/i.test(id)
  ) {
    traits.vision = true;
  }

  // REASONING — explicit chain-of-thought
  if (
    /(reasoning|thinking|cot\b)/i.test(id) ||
    /(^|[\W_])(o[13])([\W_]|$)/i.test(id) ||
    /(deepseek-r\d|deepseek-reasoner|qwq|grok-.*reasoning|magistral)/i.test(id)
  ) {
    traits.reasoning = true;
  }

  // FAST tier
  if (
    /(mini|fast|nano|haiku|small|flash|tiny|micro|express|lite)/i.test(id) ||
    /-([1-9]b|[1-9]\.[0-9]b)(\b|-)/.test(id)
  ) {
    traits.fast = true;
  }

  // LONG-CONTEXT — name hints (these are usually 100k+)
  if (/(128k|200k|1m\b|million|long-?context|large-context)/i.test(id)) {
    traits.longContext = true;
  }

  return traits;
}

/** Short emoji string for compact UI rendering inside <option> labels. */
export function traitIcons(t: ModelTraits): string {
  if (!t.chat) return "";
  const out: string[] = [];
  if (t.vision)      out.push("👁");
  if (t.reasoning)   out.push("🧠");
  if (t.longContext) out.push("📜");
  if (t.fast)        out.push("⚡");
  return out.join("");
}
