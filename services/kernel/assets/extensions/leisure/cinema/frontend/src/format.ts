/**
 * Number formatting for the /cinema cards, sheet and player.
 */

export function fmtDownloads(n?: number): string {
  if (!n) return '';
  if (n > 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n > 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function fmtRuntime(sec?: number): string {
  if (!sec || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

export function fmtBytes(n: number): string {
  if (n > 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + ' GB';
  if (n > 1_000_000) return (n / 1_000_000).toFixed(1) + ' MB';
  if (n > 1_000) return (n / 1_000).toFixed(1) + ' KB';
  return `${n} B`;
}
