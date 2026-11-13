// office3d/constellation.ts
// A3 · Knowledge as a sky. A canopy over the building where every lesson the
// agents keep is a star, placed by meaning (the kernel projects the
// embeddings; Relate's vector.similarity.cosine links each star to its
// closest neighbours). Brightness is confidence, colour the kind of lesson,
// size how often runs carried it; a retired lesson hangs grey and low.
// Constellations (groups of alike lessons) carry their name. When a lesson
// travels (A1), its star flares and a beam drops to the desk receiving it.

import { rt } from './runtime.js';
import { textSprite, disposeObj } from './hologram.js';

export interface StarView {
  id: string; agent_id: string; type: string; content: string; confidence: number;
  active: boolean; uses: number; x: number; y: number; group: number;
}
export interface ConstellationView {
  stars: StarView[];
  links: Array<{ a: string; b: string; s: number }>;
  groups: Array<{ id: number; name: string; size: number; x: number; y: number }>;
}

export interface ConstellationHandle {
  group: any;
  ping(learningIds: string[], to: { x: number; y: number; z: number } | null): void;
  highlight(group: number | null): void;
  /** Where the stars are: their centre and how far they spread, to frame them. */
  bounds(): { x: number; y: number; z: number; radius: number };
  tick(dt: number, t: number): void;
  dispose(): void;
}

const KIND: Record<string, number> = { avoid: 0xff6b6b, prefer: 0x5df2a0, insight: 0xffd36b, pattern: 0x7fb6ff };

export function buildConstellation(scene: any, sky: { cx: number; cz: number; span: number; height: number }, c: ConstellationView): ConstellationHandle {
  const T = rt.THREE;
  const root = new T.Group();
  root.name = 'lesson-constellation';
  scene.add(root);

  const R = sky.span * 0.5;
  // A shallow dome: higher in the middle, lower at the rim.
  const place = (x: number, y: number, retired: boolean) => {
    // A soft radial squeeze keeps the rim from running away from the centre.
    const r = Math.hypot(x, y);
    const k = r > 0 ? Math.tanh(r * 1.2) / r : 0;
    const px = x * k, py = y * k;
    const r2 = px * px + py * py;
    return new T.Vector3(sky.cx + px * R, sky.height + (1 - r2) * sky.span * 0.08 - (retired ? 4 : 0), sky.cz + py * R);
  };

  // Faint dome mesh so the sky reads as a place.
  const domeMat = new T.MeshBasicMaterial({ color: 0x1a1240, transparent: true, opacity: 0.12, side: T.BackSide, depthWrite: false });
  const dome = new T.Mesh(new T.SphereGeometry(R * 1.15, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2.4), domeMat);
  dome.position.set(sky.cx, sky.height - R * 0.95, sky.cz);
  root.add(dome);

  const starGeo = new T.SphereGeometry(1, 12, 8);
  const haloGeo = new T.SphereGeometry(1, 12, 8);
  type S = { v: StarView; mesh: any; halo: any; pos: any; base: number; flare: number; phase: number };
  const stars = new Map<string, S>();
  for (const v of c.stars) {
    const pos = place(v.x, v.y, !v.active);
    const colHex = v.active ? KIND[v.type] ?? KIND.insight : 0x6b6b78;
    const size = 0.28 + 0.18 * Math.min(4, v.uses) + 0.25 * v.confidence;
    const mat = new T.MeshBasicMaterial({ color: colHex, transparent: true, opacity: 0.55 + 0.45 * v.confidence });
    const mesh = new T.Mesh(starGeo, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(size);
    root.add(mesh);
    const halo = new T.Mesh(haloGeo, new T.MeshBasicMaterial({ color: colHex, transparent: true, opacity: 0.12 * (v.active ? 1 : 0.4), depthWrite: false, blending: T.AdditiveBlending }));
    halo.position.copy(pos);
    halo.scale.setScalar(size * 2.6);
    root.add(halo);
    stars.set(v.id, { v, mesh, halo, pos, base: size, flare: 0, phase: Math.random() * 6.28 });
  }

  // Links between alike lessons.
  const linePts: any[] = [];
  const lineCols: number[] = [];
  for (const l of c.links) {
    const a = stars.get(l.a), b = stars.get(l.b);
    if (!a || !b) continue;
    linePts.push(a.pos, b.pos);
    const k = Math.max(0.15, Math.min(1, (l.s - 0.45) / 0.5));
    lineCols.push(0.65 * k, 0.55 * k, 1 * k, 0.65 * k, 0.55 * k, 1 * k);
  }
  const lineGeo = new T.BufferGeometry().setFromPoints(linePts);
  lineGeo.setAttribute('color', new T.Float32BufferAttribute(lineCols, 3));
  const lineMat = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, blending: T.AdditiveBlending, depthWrite: false });
  root.add(new T.LineSegments(lineGeo, lineMat));

  // Constellation names.
  for (const g of c.groups.slice(0, 10)) {
    if (!g.name) continue;
    const s = textSprite([{ text: g.name.toUpperCase(), color: '#cdb8ff', size: 30, bold: true }, { text: `${g.size} lessons`, color: '#8f88a8', size: 20 }], 3.2);
    const p = place(g.x, g.y, false);
    s.position.set(p.x, p.y + 3.6, p.z);
    s.userData.group = g.id;
    root.add(s);
  }

  // Beams: a lesson recalled drops a beam from its star to the receiving desk.
  type Beam = { line: any; mat: any; life: number };
  const beams: Beam[] = [];
  let lit: number | null = null;

  return {
    group: root,
    ping(ids, to) {
      for (const id of ids) {
        const s = stars.get(id);
        if (!s) continue;
        s.flare = 1;
        if (!to) continue;
        const mat = new T.LineBasicMaterial({ color: 0xc9a8ff, transparent: true, opacity: 0.9, blending: T.AdditiveBlending });
        const line = new T.Line(new T.BufferGeometry().setFromPoints([s.pos, new T.Vector3(to.x, to.y, to.z)]), mat);
        root.add(line);
        beams.push({ line, mat, life: 0 });
      }
    },
    highlight(g) { lit = g; },
    bounds() {
      const all = [...stars.values()].map((s) => s.pos);
      if (!all.length) return { x: sky.cx, y: sky.height, z: sky.cz, radius: R };
      const c = all.reduce((a, p) => ({ x: a.x + p.x / all.length, y: a.y + p.y / all.length, z: a.z + p.z / all.length }), { x: 0, y: 0, z: 0 });
      const radius = Math.max(6, ...all.map((p) => Math.hypot(p.x - c.x, p.z - c.z)));
      return { ...c, radius };
    },
    tick(dt, t) {
      for (const s of stars.values()) {
        s.flare = Math.max(0, s.flare - dt * 0.4);
        const tw = 1 + 0.12 * Math.sin(t * 2.2 + s.phase);
        const dim = lit !== null && s.v.group !== lit ? 0.25 : 1;
        s.mesh.scale.setScalar(s.base * tw * (1 + s.flare * 1.8));
        s.mesh.material.opacity = (0.55 + 0.45 * s.v.confidence) * dim;
        s.halo.scale.setScalar(s.base * 2.6 * (1 + s.flare * 3));
        s.halo.material.opacity = (0.12 + 0.5 * s.flare) * (s.v.active ? 1 : 0.4) * dim;
      }
      for (let i = beams.length - 1; i >= 0; i--) {
        const b = beams[i];
        b.life += dt;
        b.mat.opacity = Math.max(0, 0.9 - b.life / 2.8);
        if (b.life > 2.8) { root.remove(b.line); b.line.geometry.dispose(); b.mat.dispose(); beams.splice(i, 1); }
      }
      lineMat.opacity = lit !== null ? 0.25 : 0.55 + 0.15 * Math.sin(t * 0.7);
      domeMat.opacity = 0.1 + 0.03 * Math.sin(t * 0.4);
    },
    dispose() {
      scene.remove(root);
      disposeObj(root);
      stars.clear();
    },
  };
}
