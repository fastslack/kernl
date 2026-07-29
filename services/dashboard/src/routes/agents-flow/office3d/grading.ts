// office3d/grading.ts
import { rt } from './runtime.js';

export const GRADING = {
  clearColor: 0x05070f,
  // Tonemapper: 'agx' (modern filmic, more natural highlights, somewhat
  // flatter/desaturated) | 'aces' (the previous one, more contrast/saturation) |
  // 'neutral'. Changing this one word is all it takes to switch back.
  // 'neutral' = best quality/cost ratio: cheaper than AgX, good highlight
  // rolloff, and WITHOUT AgX's desaturation. 'aces' = fastest and the most
  // contrasty/saturated. 'agx' = filmic but pricier and a little flat.
  toneMapping: 'neutral' as 'agx' | 'aces' | 'neutral',
  // Exposure per tonemapper. The brightness people liked was the exposure, not
  // AgX → raised across all three so any of them comes out luminous.
  exposure: { agx: 1.55, aces: 1.45, neutral: 1.5 },
  fogColor: 0x0e1932,        // ~horizonte del sky dome → el piso lejano se funde sin banda oscura
  fogDensity: 0.0013,        // menos haze cercano (menos "muddy"), conserva profundidad lejana
  environmentIntensity: 1.4, // metal/glass reflections more present
  bloom: { strength: 0.22, radius: 0.34, threshold: 0.80 },
};

export function applyRendererGrading(renderer: any): void {
  const THREE = rt.THREE;
  const tm = GRADING.toneMapping;
  renderer.toneMapping =
    tm === 'agx' ? THREE.AgXToneMapping :
    tm === 'neutral' ? THREE.NeutralToneMapping :
    THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = GRADING.exposure[tm];
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(GRADING.clearColor, 1);
}

export function applySceneGrading(scene: any): void {
  const THREE = rt.THREE;
  scene.fog = new THREE.FogExp2(GRADING.fogColor, GRADING.fogDensity);
  if ('environmentIntensity' in scene) scene.environmentIntensity = GRADING.environmentIntensity;
}
