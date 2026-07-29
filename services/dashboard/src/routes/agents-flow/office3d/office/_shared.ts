import { rt } from '../runtime.js';
import { bakeVertexAO } from './_materials.js';
import { scaleUV } from '../textures.js';

// D-Generation palette
export const WALL = 0x4a6ab8;          // medium-bright blue walls (PBR will shade it down)
export const WALL_BRIGHT = 0x6080cc;   // wall top edge (lit)
export const WALL_DARK = 0x3655a0;     // darker wall side
export const FLOOR_CARPET = 0x394a78;  // carpet — lifted so rooms read as lit interiors under the glowing rim
export const CORRIDOR_CARPET = 0x303f54; // corridor — warm slate (lifted to match)
export const WALL_H = 3.5;
export const WALL_T = 0.45;

/** Make a sign DIV clickable: dispatches 'office:focus' to the window with the office bounds. */
export function makeSignClickable(
  div: HTMLDivElement,
  bounds: { cx: number; cz: number; w: number; d: number; name: string },
): void {
  div.style.cursor = 'pointer';
  div.style.pointerEvents = 'auto';
  div.setAttribute('data-office-focus', 'true');
  div.title = `Click to zoom to ${bounds.name}`;
  div.addEventListener('click', (ev) => {
    ev.stopPropagation();
    window.dispatchEvent(new CustomEvent('office:focus', { detail: bounds }));
  });
}

/** Makes the wall's top trim emit a subtle glow in its own colour, boosted by
 *  the existing bloom → the rooms read as outlined (HQ look).
 *  Idempotent on the shared top material (creates no new materials). */
function glowTopTrim(topMat: any): void {
  if (!topMat || topMat.__glow) return;
  topMat.__glow = true;
  if (topMat.emissive && topMat.color) {
    topMat.emissive.copy(topMat.color);
    topMat.emissiveIntensity = 0.9;
    topMat.needsUpdate = true;
  }
}

export function addWall(scene: any, posX: number, posZ: number, length: number, isXWall: boolean, mat: any, topMat: any) {
  const geo = isXWall
    ? new rt.THREE.BoxGeometry(length, WALL_H, WALL_T)
    : new rt.THREE.BoxGeometry(WALL_T, WALL_H, length);
  // Contact AO baked into vertex colors (BoxGeometry is centered, so the base
  // sits at -WALL_H/2). Darken vertices near the floor of the wall body.
  bakeVertexAO(geo, { floorY: -WALL_H / 2, reach: 0.7, strength: 0.4 });
  // Constant texel density for the wall texture regardless of wall length.
  scaleUV(geo, Math.max(1, length / 4), 1);
  mat.vertexColors = true; mat.needsUpdate = true;
  const wall = new rt.THREE.Mesh(geo, mat);
  wall.position.set(posX, WALL_H / 2, posZ);
  wall.castShadow = true; wall.receiveShadow = true;
  scene.add(wall);

  // Top edge highlight strip
  const topGeo = isXWall
    ? new rt.THREE.BoxGeometry(length, 0.08, WALL_T + 0.1)
    : new rt.THREE.BoxGeometry(WALL_T + 0.1, 0.08, length);
  glowTopTrim(topMat);
  const top = new rt.THREE.Mesh(topGeo, topMat);
  top.position.set(posX, WALL_H, posZ);
  scene.add(top);
}

/** Add a wall with a door gap in the center */
export function addWallWithDoor(
  scene: any, posX: number, posZ: number, length: number,
  isXWall: boolean, doorW: number, mat: any, topMat: any, doorColor: any,
) {
  glowTopTrim(topMat);
  const sideLen = (length - doorW) / 2;
  if (sideLen > 0.3) {
    // Left segment
    const offset1 = -(doorW / 2 + sideLen / 2);
    const geo1 = isXWall
      ? new rt.THREE.BoxGeometry(sideLen, WALL_H, WALL_T)
      : new rt.THREE.BoxGeometry(WALL_T, WALL_H, sideLen);
    // Contact AO baked into vertex colors — base of the wall body. Baked here so
    // geo1.clone() below inherits the color attribute. mat.vertexColors enabled.
    bakeVertexAO(geo1, { floorY: -WALL_H / 2, reach: 0.7, strength: 0.4 });
    scaleUV(geo1, Math.max(1, sideLen / 4), 1);
    mat.vertexColors = true; mat.needsUpdate = true;
    const w1 = new rt.THREE.Mesh(geo1, mat);
    w1.position.set(isXWall ? posX + offset1 : posX, WALL_H / 2, isXWall ? posZ : posZ + offset1);
    w1.castShadow = true;
    scene.add(w1);
    // Top edge
    const t1 = isXWall
      ? new rt.THREE.BoxGeometry(sideLen, 0.08, WALL_T + 0.1)
      : new rt.THREE.BoxGeometry(WALL_T + 0.1, 0.08, sideLen);
    const top1 = new rt.THREE.Mesh(t1, topMat);
    top1.position.set(isXWall ? posX + offset1 : posX, WALL_H, isXWall ? posZ : posZ + offset1);
    scene.add(top1);

    // Right segment
    const offset2 = (doorW / 2 + sideLen / 2);
    const w2 = new rt.THREE.Mesh(geo1.clone(), mat);
    w2.position.set(isXWall ? posX + offset2 : posX, WALL_H / 2, isXWall ? posZ : posZ + offset2);
    w2.castShadow = true;
    scene.add(w2);
    const top2 = new rt.THREE.Mesh(t1.clone(), topMat);
    top2.position.set(isXWall ? posX + offset2 : posX, WALL_H, isXWall ? posZ : posZ + offset2);
    scene.add(top2);
  }

  // Door frame (lintel across the top of the opening)
  const lintelGeo = isXWall
    ? new rt.THREE.BoxGeometry(doorW + 0.3, 0.2, WALL_T + 0.08)
    : new rt.THREE.BoxGeometry(WALL_T + 0.08, 0.2, doorW + 0.3);
  const lintelMat = new rt.THREE.MeshStandardMaterial({
    color: doorColor instanceof rt.THREE.Color ? doorColor.clone().multiplyScalar(0.5) : new rt.THREE.Color(doorColor).multiplyScalar(0.5),
    roughness: 0.5, metalness: 0.1,
  });
  const lintel = new rt.THREE.Mesh(lintelGeo, lintelMat);
  lintel.position.set(posX, WALL_H - 0.1, posZ);
  scene.add(lintel);

  // Door side posts
  for (const ds of [-1, 1]) {
    const postGeo = isXWall
      ? new rt.THREE.BoxGeometry(0.12, WALL_H, WALL_T + 0.04)
      : new rt.THREE.BoxGeometry(WALL_T + 0.04, WALL_H, 0.12);
    const post = new rt.THREE.Mesh(postGeo, lintelMat);
    const px = isXWall ? posX + ds * doorW / 2 : posX;
    const pz = isXWall ? posZ : posZ + ds * doorW / 2;
    post.position.set(px, WALL_H / 2, pz);
    scene.add(post);
  }

  // Threshold strip (colored line on the floor)
  const thGeo = isXWall
    ? new rt.THREE.BoxGeometry(doorW, 0.04, 0.3)
    : new rt.THREE.BoxGeometry(0.3, 0.04, doorW);
  const thMat = new rt.THREE.MeshBasicMaterial({
    color: doorColor instanceof rt.THREE.Color ? doorColor : new rt.THREE.Color(doorColor),
    transparent: true, opacity: 0.3,
  });
  const th = new rt.THREE.Mesh(thGeo, thMat);
  th.position.set(posX, 0.02, posZ);
  scene.add(th);
}
