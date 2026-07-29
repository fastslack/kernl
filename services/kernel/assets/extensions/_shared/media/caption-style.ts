/// <reference lib="dom" />
// Browser module living in the kernel repo: the kernel's own tsconfig is
// server-side and ships no DOM libs, so the requirement is declared here
// rather than widening the global config for everything else.

/**
 * Caption appearance — font, size, colour, background, edge, position.
 *
 * Lifted out of the cinema player, which was the only one of the three that
 * let a viewer style their subtitles. Making it shared means TV and torrents
 * inherit it instead of cinema being downgraded to their (nonexistent)
 * styling when everything moved onto one player.
 *
 * Rendering captions OURSELVES rather than letting the browser paint the
 * TextTrack is what makes this possible at all: the native renderer exposes
 * almost nothing to CSS. So the track is kept at `mode:'hidden'` — which still
 * fires `cuechange` — and the active cue text is painted into an overlay.
 */

export type CaptionFamily = "sans" | "serif" | "mono";
export type CaptionEdge = "none" | "outline" | "shadow";
export type CaptionPosition = "bottom" | "top";

export interface CaptionStyle {
  fontSize: number;
  fontFamily: CaptionFamily;
  textColor: string;
  bgOpacity: number;
  edge: CaptionEdge;
  position: CaptionPosition;
}

export const CAPTION_FAMILIES: Record<CaptionFamily, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'var(--font-mono, ui-monospace), "JetBrains Mono", monospace',
};

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontSize: 28,
  fontFamily: "sans",
  textColor: "#ffffff",
  bgOpacity: 0.55,
  edge: "shadow",
  position: "bottom",
};

const STORAGE_KEY = "kernl.captionStyle";

/** Read the viewer's saved preference. Shared across every Kernl player. */
export function loadCaptionStyle(): CaptionStyle {
  if (typeof window === "undefined") return { ...DEFAULT_CAPTION_STYLE };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CAPTION_STYLE };
    const parsed = JSON.parse(raw) as Partial<CaptionStyle>;
    return {
      ...DEFAULT_CAPTION_STYLE,
      ...parsed,
      // Never trust stored numbers — a bad value would make captions unreadable
      // with no obvious way for the viewer to recover.
      fontSize: clamp(Number(parsed.fontSize) || DEFAULT_CAPTION_STYLE.fontSize, 14, 72),
      bgOpacity: clamp(Number(parsed.bgOpacity ?? DEFAULT_CAPTION_STYLE.bgOpacity), 0, 1),
    };
  } catch {
    return { ...DEFAULT_CAPTION_STYLE };
  }
}

export function saveCaptionStyle(style: CaptionStyle): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(style));
  } catch {
    /* private mode / quota — styling just won't persist */
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** The inline style for the caption text box. */
export function captionInlineStyle(s: CaptionStyle): string {
  const family = CAPTION_FAMILIES[s.fontFamily] ?? CAPTION_FAMILIES.sans;
  let textShadow = "none";
  if (s.edge === "shadow") {
    textShadow = "0 2px 6px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.95)";
  } else if (s.edge === "outline") {
    textShadow =
      "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000," +
      " -2px 0 0 #000, 2px 0 0 #000, 0 -2px 0 #000, 0 2px 0 #000";
  }
  return [
    `font-family:${family}`,
    `font-size:${s.fontSize}px`,
    `color:${s.textColor}`,
    `background:${s.bgOpacity > 0 ? `rgba(0,0,0,${s.bgOpacity.toFixed(2)})` : "transparent"}`,
    `text-shadow:${textShadow}`,
  ].join(";");
}
