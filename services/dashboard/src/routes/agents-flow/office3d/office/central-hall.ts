import { rt } from '../runtime.js';
import { WALL_H } from './_shared.js';
import { applyWorldTexture, scaleUV } from '../textures.js';

/** Build an open central hall unified with its south-running extensions and
 *  (optionally) the entrance strip in front of the reception doors. Renders
 *  a single marble floor, continuous border, and a gold axis runner — so the
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
      color: 0x3a4a7a, roughness: 0.25, metalness: 0.3,
      polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: 0,
    }),
  );
  border.rotation.x = -Math.PI / 2; border.position.set(cx, 0.02, slabCZ);
  scene.add(border);

  // ── Polished marble floor — single slab across the whole lobby (mid layer) ──
  // Polished but NOT a mirror: roughness 0.15 + metalness 0.4 turned this slab
  // into a near-perfect reflector of the procedural env map → ugly colored
  // blotches in the reception ("alfombra"). Rougher + non-metal keeps a soft
  // polished sheen without mirroring the env panels.
  const marbleMat = new rt.THREE.MeshStandardMaterial({
    color: 0x1e2640, roughness: 0.42, metalness: 0.1,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  if ('envMapIntensity' in marbleMat) marbleMat.envMapIntensity = 0.5;
  // Veined marble map + faint normal relief — keeps the polish (normalScale
  // is tiny) while breaking up the big flat slab.
  applyWorldTexture(marbleMat, 'marble');
  const marbleGeo = new rt.THREE.PlaneGeometry(w, slabD);
  scaleUV(marbleGeo, w / 11, slabD / 11);
  const floor = new rt.THREE.Mesh(marbleGeo, marbleMat);
  floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0.03, slabCZ);
  floor.receiveShadow = true;
  scene.add(floor);

  // ── Gold runner — "red carpet" from the reception counter south to the
  //    entrance doors. Starts just south of the counter footprint (top layer). ──
  if (slabD > 2) {
    const runnerW = Math.min(1.6, w * 0.18);
    const runnerN = cz + 1.4;  // ~0.6 units south of the reception counter's south edge
    const runnerD = hallSouthZ - runnerN - 0.2;
    if (runnerD > 1) {
      const runner = new rt.THREE.Mesh(
        new rt.THREE.PlaneGeometry(runnerW, runnerD),
        new rt.THREE.MeshStandardMaterial({
          color: 0xc9a84c, roughness: 0.3, metalness: 0.55,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
        }),
      );
      runner.rotation.x = -Math.PI / 2;
      runner.position.set(cx, 0.035, runnerN + runnerD / 2);
      scene.add(runner);
    }
  }

  // ── Ceiling washes over extensions + entrance strip (softer than hall light) ──
  for (const ext of extensions ?? []) {
    const wash = new rt.THREE.PointLight(0xffeedd, 0.45, Math.max(ext.w, ext.d) * 1.3);
    wash.position.set(ext.cx, WALL_H - 0.2, ext.cz);
    wash.decay = 2;
    wash.matrixAutoUpdate = false; wash.updateMatrix();
    scene.add(wash);
  }

  // ── Ambient ceiling wash over the former Central Hall slot (the reception
  //    desk itself takes care of its own accent lighting). ──
  const lobbyLight = new rt.THREE.PointLight(0xffeedd, 0.55, Math.max(w, d) * 1.5);
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
