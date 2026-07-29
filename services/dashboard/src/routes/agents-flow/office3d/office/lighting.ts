// office3d/office/lighting.ts
// Global lighting — key/fill/rim scheme. Same light count (4) as the
// bloque inline original. NO agrega luces.
import { rt } from '../runtime.js';

export function setupLighting(
  scene: any,
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number },
): void {
  const THREE = rt.THREE;
  // Low fill: let the key define the shapes (more architectural contrast).
  scene.add(new THREE.HemisphereLight(0x6a90d8, 0x0a0e1a, 0.42));
  scene.add(new THREE.AmbientLight(0x2c3c5c, 0.14));

  // Strong, warm KEY → pronounced shadows that draw the walls/rooms.
  const key = new THREE.DirectionalLight(0xfff1dc, 2.05);
  key.position.set(48, 88, 26);
  key.castShadow = true;
  // 2048² + frustum ajustado al mundo real (edificio + anillo de calle) en
  // instead of a fixed ±120: shadow texel density improves 2–4× in worlds
  // small rooms without clipping the large ones. Still ONE shadow-casting light.
  const STREET_MARGIN = 26; // plinto + vereda + calle + portal
  let half = 120;
  if (bounds) {
    half = Math.max(
      Math.abs(bounds.minX), Math.abs(bounds.maxX),
      Math.abs(bounds.minZ), Math.abs(bounds.maxZ),
    ) + STREET_MARGIN;
    half = Math.min(170, Math.max(60, half));
  }
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -half; key.shadow.camera.right = half;
  key.shadow.camera.top = half; key.shadow.camera.bottom = -half;
  // The light sits ~104u from the origin; far covers the opposite frustum corner.
  key.shadow.camera.near = 1; key.shadow.camera.far = 140 + half * 2;
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  scene.add(key);

  // Cool, more present RIM → separates silhouettes/edges from the dark background.
  const rim = new THREE.DirectionalLight(0x4a7df0, 0.55);
  rim.position.set(-58, 30, -52);
  scene.add(rim);
}
