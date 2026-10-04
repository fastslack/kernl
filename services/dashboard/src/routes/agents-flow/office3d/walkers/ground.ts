/** Ground height outside the flat floor (y=0) — stairs and streets of the
 *  buildings world plugins add, where walkers step down and back up.
 *  The scene registers it on every rebuild; null means flat everywhere. */

let groundFn: ((x: number, z: number) => number) | null = null;

export function setGroundHeight(fn: ((x: number, z: number) => number) | null): void {
  groundFn = fn;
}

export function groundHeightAt(x: number, z: number): number {
  return groundFn ? groundFn(x, z) : 0;
}
