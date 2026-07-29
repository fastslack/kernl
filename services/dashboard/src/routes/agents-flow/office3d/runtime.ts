// office3d/runtime.ts
// Shared holder for the Three.js runtime used by the office3d modules.
// Replaces the duplicated `let THREE; initX(three){THREE=three}` pattern in every module.
export const rt: { THREE: any; CSS2DObject: any } = { THREE: null, CSS2DObject: null };

export function setRuntime(three: any, css2d?: any): void {
  rt.THREE = three;
  if (css2d !== undefined) rt.CSS2DObject = css2d;
}
