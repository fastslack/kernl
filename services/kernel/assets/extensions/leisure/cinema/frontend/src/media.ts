/**
 * archive.org files and URLs: which file of an item to play, whether it needs
 * the transcoder, and how to reach it (and its artwork) through the kernel.
 */
import type { ArchiveItem, PlayFile } from './types.js';

export const TRANSCODABLE = ['mpg', 'mpeg', 'm2v', 'avi', 'wmv', 'flv', 'rm', 'rmvb', 'asf', 'vob'];
export function fileKind(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'].includes(ext)) return 'video';
  if (TRANSCODABLE.includes(ext)) return 'video';
  if (['mp3', 'flac', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) return 'image';
  if (['txt', 'md', 'log', 'json', 'csv', 'xml', 'srt', 'vtt', 'yaml', 'yml'].includes(ext)) return 'text';
  return 'other';
}
// Display order in the modal file list: videos always first, then audio,
// images, text, anything else last.
export const KIND_ORDER: Record<string, number> = {
  video: 0, audio: 1, image: 2, text: 3, other: 4,
};
/**
 * What archive.org's `format` field tells us about browser decodability.
 *
 * The extension is not the answer: an archive.org item routinely ships
 * several .mp4 files and only some of them hold h264. "About Bananas" has
 * three — `AboutBan1935.mp4` (h264 640x480), `AboutBan1935_512kb.mp4` (h264
 * 320x240) and `AboutBan1935_edit.mp4` (MPEG-4 Part 2, which no browser
 * decodes). Picking by extension and size took the third: it is the largest,
 * so it won, and every playback of that item went through a live transcode
 * that cannot keep up with the source download.
 *
 * The names mislead in both directions, so these were verified with ffprobe
 * rather than read off the label — `512Kb MPEG4` is h264 despite the name,
 * while `HiRes MPEG4` really is Part 2. Match exact-ish formats: a loose
 * /mpeg4/ test would reject the one derivative that works.
 *
 * `Ogg Video` used to sit in this table as decodable, and that is no longer
 * true — Chromium dropped Theora in M123. It is worse than a plain miss,
 * because archive.org's Theora derivative is routinely LARGER than the
 * original it was made from: "Battle of the Worlds" ships a 374 MB .ogv
 * beside the 335 MB .mp4 it derives from, and the item carries no h264 at
 * all, so ranking Theora above the bare `MPEG4` label of an unrecognised
 * original chose the biggest undecodable file in the item. The browser
 * showed black, the codec fallback re-encoded all 374 MB before a frame
 * played, and whisper pulled the same oversized file for its audio. It now
 * lives in OPAQUE_FORMAT: an item whose only video is Theora goes straight
 * to the transcoder instead of failing a load first.
 */
export const BROWSER_FORMAT_RANK: Array<{ test: RegExp; rank: number }> = [
  { test: /^h\.?\s*264/i,        rank: 0 },   // archive.org's primary mp4 derivative
  { test: /^512kb\s+mpeg4$/i,    rank: 1 },   // h264 despite the label (verified)
  { test: /^webm/i,              rank: 2 },
];
/** Formats we know the browser cannot decode — these force the transcoder. */
export const OPAQUE_FORMAT = /^(hi\s*res\s+mpeg4|mpeg\s*-?\s*[12]|ogg\s+video|theora|cinepack|cinepak|windows\s+media|quicktime|divx|xvid|asf|matroska|3gp)/i;

/** Rank for sorting: lower is better, unknown formats sit between good and bad. */
export function formatRank(format: string): number {
  const f = (format ?? '').trim();
  for (const { test, rank } of BROWSER_FORMAT_RANK) if (test.test(f)) return rank;
  if (OPAQUE_FORMAT.test(f)) return 90;
  return 50;                                   // unknown — try it before a known-bad one
}

/** True when this file will need the transcoder to reach the browser. */
export function needsTranscodeFor(file: PlayFile | undefined): boolean {
  if (!file) return false;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (TRANSCODABLE.includes(ext)) return true;
  return OPAQUE_FORMAT.test((file.format ?? '').trim());
}

export function pickDefaultPlayIdx(files: PlayFile[]): number {
  const videos = files
    .map((f, idx) => ({ f, idx }))
    .filter((e) => e.f.kind === 'video');

  if (videos.length > 0) {
    // Best decodable format first; among equals the biggest, which on
    // archive.org is reliably the higher-resolution derivative.
    const best = videos
      .slice()
      .sort((a, b) => {
        const ra = formatRank(a.f.format);
        const rb = formatRank(b.f.format);
        if (ra !== rb) return ra - rb;
        return (b.f.size ?? 0) - (a.f.size ?? 0);
      })[0];
    if (best && formatRank(best.f.format) < 90) return best.idx;
    // Everything is opaque: fall through and let the old extension order
    // choose, then the transcoder earns its keep.
  }

  // Prefer mp4 > webm > mov > mkv > ogv > mpg/avi (transcoded) > audio
  const order = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'mpg', 'mpeg', 'avi', 'm2v', 'mp3', 'flac', 'ogg', 'opus'];
  for (const ext of order) {
    const idx = files.findIndex(f => f.name.toLowerCase().endsWith('.' + ext));
    if (idx >= 0) return idx;
  }
  return 0;
}
// archive.org needs literal "/" between subdirectories (Alf/Specials/...).
// encodeURIComponent on a whole file path turns those into %2F and the
// upstream silently 404s / hangs ffprobe. Encode segment-by-segment so
// spaces and unicode are escaped but separators stay intact.
export function archiveDownloadUrl(identifier: string, filename: string): string {
  const encodedFile = filename.split('/').map(encodeURIComponent).join('/');
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodedFile}`;
}
/**
 * Hand the captioning routes the source length we already know.
 *
 * The kernel otherwise discovers it by running ffprobe against the upstream
 * with a 5s cap. That cap is there so a slow CDN can't delay the start of a
 * run, but when it fires the extract phase loses its denominator and the
 * progress bar sits at exactly 0% for the whole audio pull — on a degraded
 * archive.org node that was nine and a half minutes of a bar that looked
 * dead while the run was in fact healthy. `length` comes back with every
 * file in the item metadata, so there is no reason to go and ask again.
 */
export function setDurationParam(params: URLSearchParams, file: PlayFile | undefined): void {
  const secs = Number(file?.length);
  if (Number.isFinite(secs) && secs > 0) params.set('dur', String(secs));
}
// `<video src=…>` bypasses our global fetch interceptor, so the browser
// can't add an Authorization header. The kernel accepts `?auth=<token>`
// as a query-string fallback for exactly this case (src/core/auth.ts).
export function authQuery(): string {
  if (typeof window === 'undefined') return '';
  const t = localStorage.getItem('kernel_auth_token');
  return t ? `&auth=${encodeURIComponent(t)}` : '';
}
export function buildPlayUrl(item: ArchiveItem, file: PlayFile, forceTranscode = false): { src: string; needsTranscode: boolean } {
  const upstream = archiveDownloadUrl(item.identifier, file.name);
  // Format, not just extension: a .mp4 holding MPEG-4 Part 2 is not
  // playable either, and discovering that by letting the browser fail and
  // reloading costs a visible stall on every single play.
  const needsTranscode = forceTranscode || needsTranscodeFor(file);
  const origin = (typeof window !== 'undefined' ? window.location.origin : '');
  const endpoint = needsTranscode ? '/api/cinema/media/transcode' : '/api/cinema/media/webseed-proxy';
  return { src: `${origin}${endpoint}?url=${encodeURIComponent(upstream)}${authQuery()}`, needsTranscode };
}

export function thumbUrl(identifier: string): string {
  return `https://archive.org/services/img/${encodeURIComponent(identifier)}`;
}

/**
 * The same artwork, but same-origin, for the `<video poster>`.
 *
 * The player carries `crossorigin="anonymous"` so its cross-origin captions
 * work. That attribute applies to the POSTER too, which turns a plain image
 * load into a CORS request — and archive.org sends no
 * `Access-Control-Allow-Origin`. So every film logged a CORS failure and
 * fell back to the black rectangle the poster exists to prevent. Grid cards
 * are plain `<img>` with no crossorigin, so they load directly and stay off
 * the proxy.
 */
export function posterUrl(identifier: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const upstream = thumbUrl(identifier);
  return `${origin}/api/cinema/media/webseed-proxy?url=${encodeURIComponent(upstream)}${authQuery()}`;
}

export function onPosterError(e: Event) {
  const img = e.target as HTMLImageElement | null;
  if (img) img.style.opacity = '0.05';
}
