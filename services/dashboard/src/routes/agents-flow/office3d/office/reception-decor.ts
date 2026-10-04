// office3d/office/reception-decor.ts
// Furnishing for the reception lobby: two waiting lounges flanking the runner
// (rug always; sofa, coffee table and plants as glTF props) and real models in
// place of the primitive topiaries, chandelier and counter vase.
//
// The glTF props belong to the realism layer (office3d/realism.ts, part
// 'models'): with ?realism=0 or ?realismSkip=models the primitives stay and
// the lounges are bare rugs. A stand-in is hidden only once its model has
// loaded, so a failed download leaves the old look in place.
import { rt } from '../runtime.js';
import { realismPart, registerRealismSwitch, setVisible, swapStandIn } from '../realism.js';
import { placeModel } from '../models.js';
import {
  receptionLounges, RECEPTION_LOUNGE_RUG_W, RECEPTION_LOUNGE_RUG_D,
} from './reception-geometry.js';

type P = { x: number; y: number; z: number };

export function buildReceptionDecor(scene: any, opts: {
  cx: number;
  counterZ: number;
  /** Primitive topiaries by the counter front, replaced by potted plants. */
  topiaries: Array<{ x: number; z: number; stand: any[] }>;
  /** Chandelier anchor (top of the fitting) and its primitive parts. */
  chandelier: { at: P; stand: any[] };
  /** Counter-top vase spot and its primitive parts. */
  vase: { at: P; stand: any[] };
}): void {
  const T = rt.THREE;
  const lounges = receptionLounges(opts.cx, opts.counterZ);

  // ── Lounge rugs (always): camel wool with a gold border, light enough for
  // the black leather and the marble table to stand out, and so the seating
  // areas read as places even without the furniture models.
  const rugMat = new T.MeshStandardMaterial({
    color: 0x6e5a42, roughness: 0.95, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });
  const borderMat = new T.MeshStandardMaterial({
    color: 0xb8954a, roughness: 0.5, metalness: 0.5,
    polygonOffset: true, polygonOffsetFactor: -2.5, polygonOffsetUnits: -5,
  });
  for (const l of lounges) {
    const border = new T.Mesh(new T.PlaneGeometry(RECEPTION_LOUNGE_RUG_W + 0.16, RECEPTION_LOUNGE_RUG_D + 0.16), borderMat);
    border.rotation.x = -Math.PI / 2; border.position.set(l.x, 0.04, l.z);
    border.receiveShadow = true;
    scene.add(border);
    const rug = new T.Mesh(new T.PlaneGeometry(RECEPTION_LOUNGE_RUG_W, RECEPTION_LOUNGE_RUG_D), rugMat);
    rug.rotation.x = -Math.PI / 2; rug.position.set(l.x, 0.045, l.z);
    rug.receiveShadow = true;
    scene.add(rug);
  }

  if (!realismPart('models')) return;

  // ── Lounges: chesterfield sofa on the outer edge facing the runner, round
  // marble coffee table in front, a plant at each end of the sofa.
  for (const l of lounges) {
    const s = l.side;
    // The sofa model faces +Z (its backrest is on the −Z side); turn it
    // toward the runner (−s on X).
    void placeModel(scene, 'sofa_02', { x: l.x + s * 1.1, y: 0.045, z: l.z }, { height: 0.85, ry: -s * Math.PI / 2 })
      .then((o) => { if (o) registerRealismSwitch('models', o, null, setVisible); });
    void placeModel(scene, 'coffee_table_round_01', { x: l.x - s * 0.45, y: 0.045, z: l.z }, { height: 0.5 })
      .then((o) => { if (o) registerRealismSwitch('models', o, null, setVisible); });
    for (const dz of [-1.45, 1.45]) {
      void placeModel(scene, 'potted_plant_02', { x: l.x + s * 1.2, y: 0.045, z: l.z + dz }, { height: 1.35, ry: dz * 1.7 + s })
        .then((o) => { if (o) registerRealismSwitch('models', o, null, setVisible); });
    }
  }

  // ── Real plants in place of the two topiaries by the counter front.
  opts.topiaries.forEach((t, i) => {
    void placeModel(scene, 'potted_plant_02', { x: t.x, y: 0, z: t.z }, { height: 1.5, ry: 0.8 + i * 2.4 })
      .then((o) => {
        if (!o) return;
        const data = { stand: t.stand };
        swapStandIn(o, data, true);
        registerRealismSwitch('models', o, data, swapStandIn);
      });
  });

  // ── Brass chandelier hanging over the counter (its top at the anchor).
  const ch = opts.chandelier;
  const CH_H = 1.15;
  void placeModel(scene, 'Chandelier_02', { x: ch.at.x, y: ch.at.y - CH_H, z: ch.at.z }, { height: CH_H, shadows: false })
    .then((o) => {
      if (!o) return;
      const data = { stand: ch.stand };
      swapStandIn(o, data, true);
      registerRealismSwitch('models', o, data, swapStandIn);
    });

  // ── Brass vase on the counter top.
  const v = opts.vase;
  void placeModel(scene, 'brass_vase_01', v.at, { height: 0.55 })
    .then((o) => {
      if (!o) return;
      const data = { stand: v.stand };
      swapStandIn(o, data, true);
      registerRealismSwitch('models', o, data, swapStandIn);
    });
}
