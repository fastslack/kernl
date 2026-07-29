/** Parse the numeric major.minor.patch core, ignoring a leading `v` and any
 *  -prerelease / +build suffix. Missing/garbage components become 0. */
function core(v: string): [number, number, number] {
  const cleaned = String(v).trim().replace(/^v/i, "").split(/[-+]/, 1)[0] ?? "";
  const parts = cleaned.split(".");
  const n = (i: number) => {
    const x = Number.parseInt(parts[i] ?? "0", 10);
    return Number.isFinite(x) ? x : 0;
  };
  return [n(0), n(1), n(2)];
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const ca = core(a);
  const cb = core(b);
  for (let i = 0; i < 3; i++) {
    if (ca[i] < cb[i]) return -1;
    if (ca[i] > cb[i]) return 1;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}
