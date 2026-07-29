import { rt } from '../runtime.js';
import { applyPBR } from './_materials.js';
import { applyWorldTexture, scaleUV } from '../textures.js';

export function buildFloor(scene: any, _bounds: { minX: number; maxX: number; minZ: number; maxZ: number }) {
  // Huge ambient slab — pushed well below the street level so the raised
  // building + sunken asphalt of buildStreets() render on top of it without
  // being occluded. Used only as a bg colour so there's no void beneath the
  // camera when orbiting outside the block.
  // Ground slab — lifted from near-black to a dark blue-grey so the block reads
  // as sitting on a surface (not floating in a void). The scene fog fades the
  // far edge back to the horizon colour, keeping the night mood + depth.
  const slabMat = new rt.THREE.MeshStandardMaterial({ color: 0x161c2c, roughness: 0.85, metalness: 0 });
  applyPBR(slabMat, 'concrete');
  // Soft mottling keeps the giant slab from reading as one flat poly; fog
  // hides any far-field tiling.
  applyWorldTexture(slabMat, 'concrete', { normalScale: 0.3 });
  const slabGeo = new rt.THREE.PlaneGeometry(500, 500);
  scaleUV(slabGeo, 500 / 18, 500 / 18);
  const slab = new rt.THREE.Mesh(
    slabGeo,
    slabMat,
  );
  slab.rotation.x = -Math.PI / 2;
  slab.position.set(0, -1.6, 0);
  slab.receiveShadow = true;
  scene.add(slab);

  buildSkyDome(scene);
}

/**
 * Gradient sky dome — replaces the flat near-black clearColor backdrop (which
 * read as a cheap empty void) with a world-locked night-sky gradient: deep blue
 * at the zenith fading to a lighter horizon band that the ground fog blends into.
 * One unlit, fog-exempt mesh; zero per-frame cost. Camera (maxDistance 300)
 * always sits inside the R=400 dome.
 */
export function buildSkyDome(scene: any): void {
  const THREE = rt.THREE;
  const R = 400;
  const geo = new THREE.SphereGeometry(R, 32, 16);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const zenith = new THREE.Color(0x06090f);   // deep night blue overhead
  const horizon = new THREE.Color(0x16243c);  // lighter blue at the horizon
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / R;                 // -1 (down) .. 1 (up)
    // Upper hemisphere gradient; everything at/below the horizon stays horizon.
    let t = Math.max(0, Math.min(1, y));
    t = t * t * (3 - 2 * t);                    // smoothstep
    c.copy(horizon).lerp(zenith, t);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.renderOrder = -1;        // paint behind everything
  dome.frustumCulled = false;
  scene.add(dome);
}
