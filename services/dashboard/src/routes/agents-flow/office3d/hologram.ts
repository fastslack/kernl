// office3d/hologram.ts
// The time machine's hologram: one subject's graph, as it stood at a moment,
// projected above the office whose agents wrote it.
//
// A projector pad on the office floor throws a beam up past the walls; on top
// of it floats the subject (a bright core) and every fact about them, each on
// a spoke by predicate. A fact's colour is its state at the chosen moment:
//
//   known    green  — true then, and Kernl knew it
//   stale    red    — Kernl believed it then, but it was no longer true
//   unknown  amber  — true then, and Kernl had not learned it yet (a ghost)
//
// A change links the new value to the one it replaced (a dashed arc). Facts
// fade in and out as the moment moves, so scrubbing the timeline reads as the
// graph changing its mind.
import { rt } from './runtime.js';
import { WALL_H } from './office/_shared.js';

export type HoloState = 'known' | 'stale' | 'unknown' | 'lesson';

export interface HoloFact {
  id: string;
  predicate: string;
  object: string;
  state: HoloState;
  writer?: string;
  replaces?: string | null;
  /** Extra lines under the node (the stale beliefs about a person, say). */
  detail?: string[];
}

export interface HoloSnapshot {
  subject: string;
  at: string;
  facts: HoloFact[];
  gaps: number;
  queryMs: number;
  /** Set on the moment an action left Kernl: what it rested on, judged now. */
  verdict?: 'consistent' | 'late_information' | 'wrong_belief';
  /** Overrides the computed second line of the header (an agent's view words it differently). */
  headline?: { text: string; bad: boolean };
  /** The centre is an agent rather than a person: it is drawn in the agent's colour. */
  centerColor?: string;
}

export interface HologramHandle {
  group: any;
  show(snap: HoloSnapshot): void;
  tick(dt: number, t: number): void;
  dispose(): void;
}

const COLORS: Record<HoloState, number> = { known: 0x3dd68c, stale: 0xff4d4d, unknown: 0xffb020, lesson: 0xb38cff };
const CSS: Record<HoloState, string> = { known: '#3DD68C', stale: '#FF4D4D', unknown: '#FFB020', lesson: '#C9A8FF' };
const WORD: Record<HoloState, string> = { known: 'KNOWN', stale: 'STALE', unknown: 'NOT YET KNOWN', lesson: 'LESSON' };

interface Node {
  fact: HoloFact;
  group: any;
  core: any;
  halo: any;
  label: any;
  spoke: any;
  /** 0..1, eases toward `want`. */
  vis: number;
  want: number;
  pos: { x: number; y: number; z: number };
}

/** A sprite with text on a transparent canvas, sized in world units by height. */
export function textSprite(lines: Array<{ text: string; color: string; size: number; bold?: boolean }>, worldH: number): any {
  const T = rt.THREE;
  const pad = 18;
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = (l: { size: number; bold?: boolean }) => `${l.bold ? '700' : '500'} ${l.size}px Inter, system-ui, sans-serif`;
  let w = 0;
  for (const l of lines) { g.font = font(l); w = Math.max(w, g.measureText(l.text).width); }
  const h = lines.reduce((s, l) => s + l.size * 1.25, 0);
  c.width = Math.ceil(w + pad * 2);
  c.height = Math.ceil(h + pad * 2);
  g.fillStyle = 'rgba(6, 14, 26, 0.72)';
  const r = 14;
  g.beginPath();
  g.roundRect(0, 0, c.width, c.height, r);
  g.fill();
  let y = pad;
  for (const l of lines) {
    g.font = font(l);
    g.fillStyle = l.color;
    g.textBaseline = 'top';
    g.fillText(l.text, pad, y);
    y += l.size * 1.25;
  }
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace ?? tex.colorSpace;
  const mat = new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  const s = new T.Sprite(mat);
  s.scale.set(worldH * (c.width / c.height), worldH, 1);
  s.renderOrder = 20;
  return s;
}

export function disposeObj(o: any): void {
  o.traverse?.((x: any) => {
    x.geometry?.dispose?.();
    const m = x.material;
    for (const mm of Array.isArray(m) ? m : m ? [m] : []) { mm.map?.dispose?.(); mm.dispose?.(); }
  });
}

/**
 * Build the projector in `room` (an office's floor rectangle) and return a
 * handle the render loop ticks. Nothing shows until `show()`.
 */
export function buildHologram(scene: any, room: { cx: number; cz: number; w: number; d: number }): HologramHandle {
  const T = rt.THREE;
  const root = new T.Group();
  root.name = 'time-machine-hologram';
  root.position.set(room.cx, 0, room.cz);
  scene.add(root);

  const span = Math.max(5, Math.min(room.w, room.d));
  const R = Math.max(5.5, span * 0.62); // radius of the fact ring
  const Y = WALL_H + 6.5;               // height of the graph's plane: clear of walls and name chips

  // Projector: a glowing pad on the floor and a soft beam up to the graph.
  const pad = new T.Mesh(
    new T.CylinderGeometry(0.9, 1.1, 0.12, 40),
    new T.MeshStandardMaterial({ color: 0x0b1b2b, emissive: 0x1e88ff, emissiveIntensity: 0.8, metalness: 0.6, roughness: 0.3 }),
  );
  pad.position.y = 0.06;
  root.add(pad);
  const beamMat = new T.MeshBasicMaterial({ color: 0x4fb3ff, transparent: true, opacity: 0.13, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending });
  const beam = new T.Mesh(new T.CylinderGeometry(R * 0.85, 0.8, Y - 0.2, 48, 1, true), beamMat);
  beam.position.y = (Y - 0.2) / 2 + 0.1;
  root.add(beam);
  // The disc the graph stands on.
  const discMat = new T.MeshBasicMaterial({ color: 0x4fb3ff, transparent: true, opacity: 0.08, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending });
  const disc = new T.Mesh(new T.CircleGeometry(R * 1.12, 64), discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = Y - 0.6;
  root.add(disc);
  const ringMat = new T.MeshBasicMaterial({ color: 0x7cc8ff, transparent: true, opacity: 0.5, depthWrite: false, blending: T.AdditiveBlending });
  const ring = new T.Mesh(new T.TorusGeometry(R * 1.12, 0.03, 8, 96), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = Y - 0.6;
  root.add(ring);

  const graph = new T.Group();
  graph.position.y = Y;
  root.add(graph);

  // The subject.
  const subjectCore = new T.Mesh(
    new T.SphereGeometry(0.9, 32, 24),
    new T.MeshStandardMaterial({ color: 0xffffff, emissive: 0x9fd8ff, emissiveIntensity: 1.4, roughness: 0.2 }),
  );
  graph.add(subjectCore);
  const subjectHalo = new T.Mesh(
    new T.SphereGeometry(1.5, 24, 16),
    new T.MeshBasicMaterial({ color: 0x6fc3ff, transparent: true, opacity: 0.18, depthWrite: false, blending: T.AdditiveBlending }),
  );
  graph.add(subjectHalo);
  let subjectLabel: any = null;
  let header: any = null;

  const nodes = new Map<string, Node>();
  const links: any[] = [];
  let visible = false;
  let rootFade = 0;

  function place(snap: HoloSnapshot): Map<string, { x: number; y: number; z: number }> {
    // One spoke per predicate; values of one predicate sit side by side on it.
    const out = new Map<string, { x: number; y: number; z: number }>();
    // Lessons on an inner ring, a little higher: what the agent carries.
    const lessons = snap.facts.filter((f) => f.state === 'lesson');
    lessons.forEach((f, i) => {
      const a = (i / Math.max(1, lessons.length)) * Math.PI * 2 + Math.PI / 4;
      out.set(f.id, { x: Math.cos(a) * R * 0.42, y: 1.6, z: Math.sin(a) * R * 0.42 });
    });
    const outer = snap.facts.filter((f) => f.state !== 'lesson');
    const preds = [...new Set(outer.map((f) => f.predicate))].sort();
    preds.forEach((p, i) => {
      const a = (i / Math.max(1, preds.length)) * Math.PI * 2 - Math.PI / 2;
      const same = outer.filter((f) => f.predicate === p);
      same.forEach((f, j) => {
        const spread = (j - (same.length - 1) / 2) * 1.3;
        const rr = R * (0.78 + 0.22 * ((j % 2) ? 1 : 0));
        out.set(f.id, { x: Math.cos(a + spread / R * 2.2) * rr, y: 0.6 * j, z: Math.sin(a + spread / R * 2.2) * rr });
      });
    });
    return out;
  }

  function makeNode(f: HoloFact, pos: { x: number; y: number; z: number }): Node {
    const g = new T.Group();
    g.position.set(pos.x, pos.y, pos.z);
    const ghost = f.state === 'unknown';
    const core = new T.Mesh(
      new T.SphereGeometry(0.55, 24, 16),
      new T.MeshStandardMaterial({
        color: COLORS[f.state], emissive: COLORS[f.state], emissiveIntensity: ghost ? 0.5 : 1.1,
        transparent: true, opacity: ghost ? 0.35 : 1, wireframe: ghost, roughness: 0.3,
      }),
    );
    g.add(core);
    const halo = new T.Mesh(
      new T.SphereGeometry(1.0, 20, 14),
      new T.MeshBasicMaterial({ color: COLORS[f.state], transparent: true, opacity: 0.15, depthWrite: false, blending: T.AdditiveBlending }),
    );
    g.add(halo);
    const label = textSprite([
      { text: `${f.predicate.replace(/_/g, ' ')}`, color: '#9fb4c8', size: 26 },
      { text: f.object, color: '#ffffff', size: 34, bold: true },
      { text: `${WORD[f.state]}${f.writer ? ` · by ${f.writer}` : ''}`, color: CSS[f.state], size: 24, bold: true },
      ...(f.detail ?? []).slice(0, 3).map((d) => ({ text: d, color: f.state === 'stale' ? '#FF9A9A' : '#B8C7D6', size: 22 })),
    ], 2.1 + Math.min(3, f.detail?.length ?? 0) * 0.45);
    label.position.set(0, 1.9, 0);
    g.add(label);
    const spokeGeo = new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(pos.x, pos.y, pos.z)]);
    const spoke = new T.Line(spokeGeo, new T.LineBasicMaterial({ color: COLORS[f.state], transparent: true, opacity: ghost ? 0.25 : 0.55 }));
    graph.add(spoke);
    graph.add(g);
    g.scale.setScalar(0.001);
    return { fact: f, group: g, core, halo, label, spoke, vis: 0, want: 1, pos };
  }

  function dropNode(n: Node): void {
    graph.remove(n.group);
    graph.remove(n.spoke);
    disposeObj(n.group);
    disposeObj(n.spoke);
  }

  function show(snap: HoloSnapshot): void {
    visible = true;
    const pos = place(snap);
    const keep = new Set(snap.facts.map((f) => f.id));
    for (const [id, n] of nodes) if (!keep.has(id)) n.want = 0;
    for (const f of snap.facts) {
      const p = pos.get(f.id)!;
      const cur = nodes.get(f.id);
      if (cur && cur.fact.state === f.state && cur.fact.writer === f.writer) {
        cur.want = 1;
        cur.pos = p;
        continue;
      }
      // A fact whose state changed is rebuilt in its new colour.
      if (cur) dropNode(cur);
      nodes.set(f.id, makeNode(f, p));
    }
    // Change arcs: new value → the value it replaced, when both are on screen.
    for (const l of links.splice(0)) { graph.remove(l); disposeObj(l); }
    for (const f of snap.facts) {
      if (!f.replaces) continue;
      const a = pos.get(f.id), b = pos.get(f.replaces);
      if (!a || !b) continue;
      const mid = new T.Vector3((a.x + b.x) / 2, Math.max(a.y, b.y) + 2.0, (a.z + b.z) / 2);
      const curve = new T.QuadraticBezierCurve3(new T.Vector3(a.x, a.y, a.z), mid, new T.Vector3(b.x, b.y, b.z));
      const geo = new T.BufferGeometry().setFromPoints(curve.getPoints(24));
      const line = new T.Line(geo, new T.LineDashedMaterial({ color: 0xffffff, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.8 }));
      line.computeLineDistances();
      graph.add(line);
      links.push(line);
    }
    // Labels on the subject and the header.
    const cc = new T.Color(snap.centerColor ?? '#9fd8ff');
    subjectCore.material.emissive.copy(cc);
    subjectHalo.material.color.copy(cc);
    if (subjectLabel) { graph.remove(subjectLabel); disposeObj(subjectLabel); }
    subjectLabel = textSprite([{ text: snap.subject, color: '#ffffff', size: 40, bold: true }], 1.6);
    subjectLabel.position.set(0, 2.1, 0);
    graph.add(subjectLabel);
    if (header) { graph.remove(header); disposeObj(header); }
    const when = new Date(snap.at);
    const date = when.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const stale = snap.facts.filter((f) => f.state === 'stale').length;
    const unknown = snap.facts.filter((f) => f.state === 'unknown').length;
    header = textSprite([
      { text: `⏱ ${date}`, color: '#ffffff', size: 40, bold: true },
      snap.headline
        ? { text: snap.headline.text, color: snap.headline.bad ? '#FF8A8A' : '#3DD68C', size: 28, bold: true }
        : {
          text: snap.gaps ? `${stale} stale belief${stale === 1 ? '' : 's'} · ${unknown} truth${unknown === 1 ? '' : 's'} not yet known` : 'Kernl knew the truth',
          color: snap.gaps ? '#FF8A8A' : '#3DD68C', size: 28, bold: true,
        },
      ...(snap.verdict && snap.verdict !== 'consistent'
        ? [{ text: snap.verdict === 'late_information' ? '⚠ acted on LATE INFORMATION — not a wrong decision' : '⚠ acted on a WRONG BELIEF', color: '#FFB020', size: 30, bold: true }]
        : []),
      { text: `one Cypher query on Relate · ${snap.queryMs.toFixed(1)} ms`, color: '#7cc8ff', size: 22 },
    ], snap.verdict && snap.verdict !== 'consistent' ? 3.9 : 3.2);
    header.position.set(0, 5.2, 0);
    graph.add(header);
  }

  function tick(dt: number, t: number): void {
    rootFade += ((visible ? 1 : 0) - rootFade) * Math.min(1, dt * 3);
    root.visible = rootFade > 0.01;
    if (!root.visible) return;
    graph.rotation.y += dt * 0.08;
    beamMat.opacity = 0.1 + 0.04 * Math.sin(t * 2.1);
    ringMat.opacity = 0.35 + 0.2 * Math.sin(t * 1.3);
    subjectHalo.scale.setScalar(1 + 0.08 * Math.sin(t * 3));
    for (const [id, n] of nodes) {
      n.vis += (n.want - n.vis) * Math.min(1, dt * 4);
      if (n.want === 0 && n.vis < 0.02) { dropNode(n); nodes.delete(id); continue; }
      n.group.position.x += (n.pos.x - n.group.position.x) * Math.min(1, dt * 4);
      n.group.position.z += (n.pos.z - n.group.position.z) * Math.min(1, dt * 4);
      const pulse = n.fact.state === 'stale' ? 1 + 0.18 * Math.sin(t * 7) : n.fact.state === 'unknown' ? 1 + 0.08 * Math.sin(t * 3) : 1;
      n.group.scale.setScalar(Math.max(0.001, n.vis * pulse));
      n.halo.material.opacity = (n.fact.state === 'stale' ? 0.28 + 0.2 * Math.sin(t * 7) : 0.15) * n.vis;
      n.spoke.material.opacity = (n.fact.state === 'unknown' ? 0.25 : 0.55) * n.vis;
    }
  }

  return {
    group: root,
    show,
    tick,
    dispose() {
      scene.remove(root);
      disposeObj(root);
      nodes.clear();
    },
  };
}
