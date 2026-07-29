// office3d/office/_materials.ts
// Helpers reutilizables de tratamiento PBR + AO por vertex-color.
// They create NO new per-instance geometry or materials: they adjust in place.
import { rt } from '../runtime.js';

export type PbrRole =
  | 'carpet' | 'asphalt' | 'concrete' | 'metal' | 'glass'
  | 'screen' | 'skin' | 'cloth' | 'trim' | 'plastic';

const PRESETS: Record<PbrRole, { roughness: number; metalness: number; envMapIntensity: number }> = {
  carpet:   { roughness: 0.92, metalness: 0.0,  envMapIntensity: 0.4 },
  asphalt:  { roughness: 0.82, metalness: 0.0,  envMapIntensity: 0.6 },
  concrete: { roughness: 0.72, metalness: 0.0,  envMapIntensity: 0.7 },
  metal:    { roughness: 0.38, metalness: 0.85, envMapIntensity: 1.3 },
  glass:    { roughness: 0.08, metalness: 0.0,  envMapIntensity: 1.8 },
  screen:   { roughness: 0.30, metalness: 0.0,  envMapIntensity: 0.5 },
  skin:     { roughness: 0.70, metalness: 0.0,  envMapIntensity: 0.5 },
  cloth:    { roughness: 0.88, metalness: 0.0,  envMapIntensity: 0.4 },
  trim:     { roughness: 0.45, metalness: 0.6,  envMapIntensity: 1.1 },
  plastic:  { roughness: 0.55, metalness: 0.0,  envMapIntensity: 0.6 },
};

/** Adjusts an existing MeshStandardMaterial in place according to its role. */
export function applyPBR(material: any, role: PbrRole): any {
  const p = PRESETS[role];
  if (!material) return material;
  material.roughness = p.roughness;
  material.metalness = p.metalness;
  if ('envMapIntensity' in material) material.envMapIntensity = p.envMapIntensity;
  material.needsUpdate = true;
  return material;
}

/**
 * Bakes vertex-colour AO onto an EXISTING geometry: darkens vertices
 * cuya Y local esté cerca de `floorY` (base de muros), sombra de contacto sin
 * SSAO. Precomputo en build: cero costo por frame, mismos draw calls.
 * El material asociado debe tener `vertexColors = true`.
 */
export function bakeVertexAO(
  geometry: any,
  opts: { floorY?: number; reach?: number; strength?: number } = {},
): void {
  const THREE = rt.THREE;
  const floorY = opts.floorY ?? 0;
  const reach = opts.reach ?? 0.6;
  const strength = opts.strength ?? 0.45;
  const pos = geometry.attributes.position;
  if (!pos) return;
  const n = pos.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    const t = Math.min(1, Math.max(0, (y - floorY) / reach));
    const shade = 1 - strength * (1 - t);
    colors[i * 3] = shade; colors[i * 3 + 1] = shade; colors[i * 3 + 2] = shade;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
