/**
 * SRT ⇄ WebVTT helpers + translation orchestration.
 *
 * SubRip (.srt) and WebVTT (.vtt) are nearly identical line-based formats.
 * Browser <video> + <track> only consumes WebVTT, so the translate endpoint
 * always emits VTT regardless of input.
 */

export interface SubCue {
  index: number;     // 1-based; preserved from SRT, optional in VTT
  start: number;     // seconds
  end: number;       // seconds
  text: string;      // may contain inline newlines
}

const TIMING_RE =
  /(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

function tsToSeconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

function secondsToTs(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

/**
 * Parse SRT or VTT text. Tolerates BOM, CRLF, blank-block separators, missing
 * index numbers (VTT-style), and comma/period timestamp separators.
 */
export function parseSubs(raw: string): SubCue[] {
  // Strip BOM and WEBVTT header if present.
  let text = raw.replace(/^﻿/, "");
  text = text.replace(/^WEBVTT[^\n]*\n(NOTE[^\n]*\n)*/i, "");
  // Normalize line endings.
  text = text.replace(/\r\n?/g, "\n");

  const cues: SubCue[] = [];
  const blocks = text.split(/\n{2,}/);
  let autoIdx = 0;
  for (const block of blocks) {
    const lines = block.split("\n").filter(l => l.length > 0);
    if (lines.length === 0) continue;

    let idx = autoIdx + 1;
    let timingLine = lines[0];
    let textStart = 1;
    if (/^\d+$/.test(lines[0])) {
      idx = Number(lines[0]);
      timingLine = lines[1] ?? "";
      textStart = 2;
    }
    const m = TIMING_RE.exec(timingLine);
    if (!m) continue;
    const start = tsToSeconds(m[1], m[2], m[3], m[4]);
    const end = tsToSeconds(m[5], m[6], m[7], m[8]);
    const cueText = lines.slice(textStart).join("\n").trim();
    if (!cueText) continue;
    cues.push({ index: idx, start, end, text: cueText });
    autoIdx = idx;
  }
  return cues;
}

/**
 * Drop hallucination loops: runs of the same cue text repeated back-to-back.
 * Every speech engine (whisper.cpp, Xenova transformers, Groq) can get stuck
 * emitting one caption — "[Music]", "Thank you.", "♪♪♪" — for minutes on end
 * when the audio is non-speech or noisy. A run of >= minRun identical
 * consecutive cues is virtually never real dialogue, so we drop the whole run
 * (leaving a gap = "no subtitle", which is correct: the engine produced no
 * real text there). The whisper.cpp flags -mc 0 / -sns prevent most of this at
 * the source; this is the engine-agnostic backstop.
 */
export function dropRepeatRuns(cues: SubCue[], minRun = 4): SubCue[] {
  const norm = (t: string) => t.trim().toLowerCase();
  const out: SubCue[] = [];
  let i = 0;
  while (i < cues.length) {
    let j = i + 1;
    while (j < cues.length && norm(cues[j].text) === norm(cues[i].text)) j++;
    if (j - i < minRun) {
      for (let k = i; k < j; k++) out.push(cues[k]);
    } // else: drop the whole repeated run as a hallucination loop
    i = j;
  }
  // Re-index so downstream (SRT export, translation pairing) stays sequential.
  return out.map((c, idx) => ({ ...c, index: idx + 1 }));
}

/** Encode cues as WebVTT. */
export function encodeVtt(cues: SubCue[]): string {
  const lines: string[] = ["WEBVTT", ""];
  for (const c of cues) {
    lines.push(`${secondsToTs(c.start)} --> ${secondsToTs(c.end)}`);
    lines.push(c.text);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * NLLB language codes (BCP-47-ish): "eng_Latn", "spa_Latn", "fra_Latn", etc.
 * Map common ISO-639-1 codes to NLLB Flores-200 codes.
 */
const NLLB_BY_ISO: Record<string, string> = {
  en: "eng_Latn",
  es: "spa_Latn",
  pt: "por_Latn",
  fr: "fra_Latn",
  de: "deu_Latn",
  it: "ita_Latn",
  ja: "jpn_Jpan",
  zh: "zho_Hans",
  ru: "rus_Cyrl",
  ko: "kor_Hang",
  ar: "arb_Arab",
};

export function nllbCode(iso: string): string {
  // Already a Flores-200 code? pass through.
  if (/^[a-z]{3}_[A-Z][a-z]{3}$/.test(iso)) return iso;
  return NLLB_BY_ISO[iso.toLowerCase()] ?? `${iso}_Latn`;
}

/** Friendly name for UI labels. */
export function langName(iso: string): string {
  const m: Record<string, string> = {
    en: "English", es: "Español", pt: "Português", fr: "Français",
    de: "Deutsch", it: "Italiano", ja: "日本語", zh: "中文",
    ru: "Русский", ko: "한국어", ar: "العربية",
  };
  return m[iso.toLowerCase()] ?? iso.toUpperCase();
}
