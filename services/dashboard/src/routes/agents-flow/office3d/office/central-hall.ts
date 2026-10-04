import { rt } from '../runtime.js';
import { WALL_H } from './_shared.js';
import { applyWorldTexture, scaleUV } from '../textures.js';
import { applyPBR } from './_materials.js';

/** Build an open central hall unified with its south-running extensions and
 *  (optionally) the entrance strip in front of the reception doors. Renders
 *  a single carpeted floor, continuous border, and a runner carpet — so the
 *  hall reads as one grand lobby from the Central Hall down to the entrance. */
export function buildCentralHall(
  scene: any,
  room: { cx: number; cz: number; w: number; d: number },
  extensions?: Array<{ cx: number; cz: number; w: number; d: number }>,
  southEndZ?: number,
): void {
  const { cx, cz, w, d } = room;

  // ── Unified floor bounds: Central Hall + extensions (all in the same column,
  //    they share cx/w) + optional south strip down to the entrance doors.
  const hallNorthZ = cz - d / 2;
  let hallSouthZ = cz + d / 2;
  for (const ext of extensions ?? []) {
    hallSouthZ = Math.max(hallSouthZ, ext.cz + ext.d / 2);
  }
  if (southEndZ !== undefined) hallSouthZ = Math.max(hallSouthZ, southEndZ);
  const slabCZ = (hallNorthZ + hallSouthZ) / 2;
  const slabD = hallSouthZ - hallNorthZ;

  // These three lobby planes are large and near-coplanar (border under floor
  // under runner). With far=600 the depth buffer can't separate sub-0.01 gaps
  // once the camera pulls back → z-fighting renders as floor "noise". Fix:
  // bias each layer in DEPTH space with polygonOffset (distance-independent,
  // unlike a Y gap) so the draw order is deterministic at any zoom, and keep a
  // small Y stagger so shadows/AO still read correctly up close. Lower
  // polygonOffsetUnits = pulled toward the camera = wins the depth test.

  // ── Floor border accent — one unified ring (bottom layer) ──
  const border = new rt.THREE.Mesh(
    new rt.THREE.PlaneGeometry(w + 0.3, slabD + 0.3),
    new rt.THREE.MeshStandardMaterial({
      color: 0x3a4a7a, roughness: 0.85, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: 0,
    }),
  );
  border.rotation.x = -Math.PI / 2; border.position.set(cx, 0.02, slabCZ);
  scene.add(border);

  // ── Lobby carpet — one piece across the whole lobby (mid layer) ──
  // Was polished marble: with the photographic layer it lit up as a white,
  // glossy strip from the entrance to the reception. A dark woven carpet keeps
  // the lobby calm and matte under the hall lights.
  const lobbyMat = new rt.THREE.MeshStandardMaterial({
    color: 0x262f48,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  applyPBR(lobbyMat, 'carpet');
  applyWorldTexture(lobbyMat, 'carpet');
  const lobbyGeo = new rt.THREE.PlaneGeometry(w, slabD);
  scaleUV(lobbyGeo, w / 6, slabD / 6);
  const floor = new rt.THREE.Mesh(lobbyGeo, lobbyMat);
  floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0.03, slabCZ);
  floor.receiveShadow = true;
  scene.add(floor);

  // ── Runner carpet — from the reception counter south to the entrance doors,
  //    over the marble (top layers). Woven, matte and non-metal: as a polished
  //    gold strip it caught every light in the lobby and read as metal. A darker
  //    binding along the edges makes it read as a laid carpet, not paint. ──
  if (slabD > 2) {
    const runnerW = Math.min(1.6, w * 0.18);
    const runnerN = cz + 1.4;  // ~0.6 units south of the reception counter's south edge
    const runnerD = hallSouthZ - runnerN - 0.2;
    if (runnerD > 1) {
      const carpet = (color: number, width: number, depth: number, y: number, units: number) => {
        const mat = new rt.THREE.MeshStandardMaterial({
          color, polygonOffset: true, polygonOffsetFactor: units / 2, polygonOffsetUnits: units,
        });
        applyPBR(mat, 'carpet');
        applyWorldTexture(mat, 'carpet');
        const geo = new rt.THREE.PlaneGeometry(width, depth);
        scaleUV(geo, width / 1.5, depth / 1.5);
        const mesh = new rt.THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(cx, y, runnerN + runnerD / 2);
        mesh.receiveShadow = true;
        scene.add(mesh);
      };
      carpet(0x3b2716, runnerW, runnerD, 0.035, -4);               // binding
      carpet(0x6a4f26, runnerW - 0.24, runnerD - 0.24, 0.037, -6); // field
    }
  }

  // ── Ceiling washes over extensions + entrance strip (softer than hall light) ──
  for (const ext of extensions ?? []) {
    const wash = new rt.THREE.PointLight(0xffeedd, 0.9, Math.max(ext.w, ext.d) * 1.3);
    wash.position.set(ext.cx, WALL_H - 0.2, ext.cz);
    wash.decay = 2;
    wash.matrixAutoUpdate = false; wash.updateMatrix();
    scene.add(wash);
  }

  // ── Ambient ceiling wash over the former Central Hall slot (the reception
  //    desk itself takes care of its own accent lighting). ──
  const lobbyLight = new rt.THREE.PointLight(0xffeedd, 1.1, Math.max(w, d) * 1.5);
  lobbyLight.position.set(cx, WALL_H - 0.2, cz);
  lobbyLight.decay = 2;
  lobbyLight.matrixAutoUpdate = false; lobbyLight.updateMatrix();
  scene.add(lobbyLight);
}

/** Deprecated: hall extensions are now rendered as part of `buildCentralHall`
 *  (which draws one unified slab). Kept as a no-op for API compatibility. */
export function buildHallExtension(
  _scene: any,
  _cells: Array<{ cx: number; cz: number; w: number; d: number }>,
): void {
  // intentionally blank — unified hall handles everything in buildCentralHall
}
