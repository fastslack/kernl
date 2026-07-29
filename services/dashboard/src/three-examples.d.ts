// Ambient declarations for three.js example (jsm) modules that ship without
// bundled .d.ts files. The office3d scene treats THREE objects as `any`
// (loaded via the shared dynamic runtime), so a minimal `any`-typed
// RoundedBoxGeometry surface is enough to keep `tsc --noEmit` green.
declare module 'three/examples/jsm/geometries/RoundedBoxGeometry.js' {
  export class RoundedBoxGeometry {
    constructor(
      width?: number,
      height?: number,
      depth?: number,
      segments?: number,
      radius?: number,
    );
  }
}
