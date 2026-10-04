/**
 * Text on its way in and out of the voice module.
 *
 * Out: the Chief answers in markdown, and a TTS engine reads every character
 * it is given — "asterisco asterisco", a forty-character URL spelled out, a
 * code block recited line by line. `toSpeakable` keeps the words and drops the
 * typography.
 *
 * In: whisper fills silence with the captions it was trained on. A press of
 * the mic with nothing said comes back as "Subtítulos realizados por la
 * comunidad de Amara.org" or "Thanks for watching!", and sending that to the
 * Chief as if the operator had said it is worse than sending nothing.
 */

/** Markdown → plain sentences a voice can read. */
export function toSpeakable(markdown: string): string {
  let s = markdown;
  // Fenced code: never read aloud. One mention is enough to say it exists.
  s = s.replace(/```[\s\S]*?(```|$)/g, " ");
  // Tables: keep the cell text, drop the rules.
  s = s.replace(/^\s*\|?\s*:?-{3,}.*$/gm, " ");
  s = s.replace(/\|/g, ", ");
  // Images vanish; links keep their label.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Bare URLs and emails are noise when spoken.
  s = s.replace(/\bhttps?:\/\/\S+/g, " ");
  s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, " ");
  // Inline code keeps its content (often a name worth hearing).
  s = s.replace(/`([^`]*)`/g, "$1");
  // Headings, quotes, list markers.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s*>\s?/gm, "");
  s = s.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "");
  // Emphasis markers.
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2");
  s = s.replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2");
  s = s.replace(/~~(.+?)~~/g, "$1");
  // Horizontal rules and leftover markup characters.
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, " ");
  s = s.replace(/[*#>`]/g, " ");
  // Pictographs: Piper spells some of them, skips others; neither helps.
  s = s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ");
  // A line break ends a thought: make it a pause the engine respects.
  s = s.replace(/([^.!?:;,\s])\s*\n+/g, "$1. ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Captions whisper produces from silence, music or a cough, normalized
 * (lower case, no accents, no punctuation). Matched as the WHOLE utterance:
 * "gracias" alone is a real answer, "gracias por ver el video" never is.
 */
const SILENCE_CAPTIONS = new Set([
  "subtitulos realizados por la comunidad de amara org",
  "subtitulos por la comunidad de amara org",
  "subtitulado por la comunidad de amara org",
  "gracias por ver",
  "gracias por ver el video",
  "gracias por vernos",
  "gracias por su atencion",
  "suscribete",
  "suscribete al canal",
  "vamos",
  "no olvides suscribirte",
  "thank you for watching",
  "thanks for watching",
  "thank you",
  "you",
  "musica",
  "music",
  "blank audio",
  "silencio",
  "aplausos",
  "applause",
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The transcript worth acting on, or "" when whisper heard nothing real.
 * Strips bracketed non-speech tags ("[Música]", "(risas)") first, then drops
 * the result if what is left is one of the known silence captions.
 */
export function cleanTranscript(text: string, prompt?: string): string {
  const stripped = text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const norm = normalize(stripped);
  if (!norm) return "";
  if (SILENCE_CAPTIONS.has(norm)) return "";
  // Caption credits come in endless variants ("Subtítulos por la Iglesia de
  // Jesucristo…", "subtitulado por …"); none is ever something the operator said.
  // Caption credits, in any wording: "Subtítulos en español de la Iglesia de
  // Jesucristo…" was sent to the Chief as if the operator had said it.
  if (/^(subtitul|subtitles|captions)/.test(norm)) return "";
  if (/iglesia de jesucristo|amara org|transcripcion realizada por|www\.|\bpunto com\b/.test(norm)) return "";
  // With a context prompt, whisper sometimes recites the prompt back.
  if (prompt && norm.length > 12 && normalize(prompt).includes(norm)) return "";
  return stripped;
}
