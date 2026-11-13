// office3d/engine-room.ts
// A4 · Relate's engine room, on a free lot: one rack — the memory engine —
// with two lanes up its front, reads (blue) and writes (amber). Every
// statement the kernel runs climbs its lane as a pulse, longer the longer the
// engine took, red when slow or failed. An amber beacon on top lights when the
// planner warns of a missing index.
//
// Two walls behind it: the PROFILE plan of the statement picked in the panel
// (as a tree, operator by operator) and C4 · the graph's blueprint (labels,
// relationship types, counts, indexes). C5 · a question's shortest path floats
// above the rack as a chain of nodes.

import { rt } from './runtime.js';
import { textSprite, disposeObj } from './hologram.js';

export interface EnginePulse { write: boolean; ms: number | null; failed: boolean }
export interface PlanNodeView { operator: string; details: string; rows: number; dbHits: number; ms: number; start: string | null; children: PlanNodeView[] }
export interface BlueprintView {
  labels: Array<{ label: string; count: number; indexes: Array<{ type: string; properties: string[] }> }>;
  relationships: Array<{ type: string; from: string; to: string; count: number }>;
}
export interface PathView { nodes: Array<{ label: string; name: string }>; rels: Array<{ type: string }> }

export interface EngineRoomHandle {
  group: any;
  pulse(items: EnginePulse[]): void;
  setStats(text: { reads: string; writes: string }): void;
  setWarning(on: boolean): void;
  showPlan(title: string, tree: PlanNodeView | null, footer: string): void;
  showBlueprint(bp: BlueprintView | null): void;
  showPath(p: PathView | null): void;
  tick(dt: number, t: number): void;
  dispose(): void;
}

const RACK_H = 6.2;
const LANE_X = 0.42;
const SLOW_MS = 50;

/** A wall screen: a plane with a canvas texture the caller redraws. */
function screen(T: any, w: number, h: number, px = 1024) {
  const c = document.createElement('canvas');
  c.width = px;
  c.height = Math.round(px * (h / w));
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace ?? tex.colorSpace;
  const mesh = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ map: tex, transparent: true, side: T.DoubleSide }));
  return { mesh, canvas: c, ctx: c.getContext('2d')!, tex };
}

function frame(g: CanvasRenderingContext2D, w: number, h: number, title: string, accent: string): void {
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(6, 10, 20, 0.92)';
  g.beginPath(); g.roundRect(0, 0, w, h, 26); g.fill();
  g.strokeStyle = accent; g.lineWidth = 4;
  g.beginPath(); g.roundRect(2, 2, w - 4, h - 4, 24); g.stroke();
  g.fillStyle = accent;
  g.font = '700 34px Inter, system-ui, sans-serif';
  g.textBaseline = 'top';
  g.fillText(title, 32, 26);
}

const fmtN = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString('en-US'));

export function buildEngineRoom(scene: any, lot: { cx: number; cz: number; w: number; d: number }, face: { x: number; z: number } = { x: 0, z: 1 }): EngineRoomHandle {
  const T = rt.THREE;
  const root = new T.Group();
  root.name = 'relate-engine-room';
  root.position.set(lot.cx, 0, lot.cz);
  root.rotation.y = Math.atan2(face.x, face.z);
  scene.add(root);

  // Floor: dark raised tiles, a cyan kerb.
  const floor = new T.Mesh(new T.BoxGeometry(lot.w * 0.92, 0.1, lot.d * 0.92), new T.MeshStandardMaterial({ color: 0x0d1422, roughness: 0.5, metalness: 0.4 }));
  floor.position.y = 0.05;
  root.add(floor);
  const grid = new T.GridHelper(Math.min(lot.w, lot.d) * 0.9, 12, 0x1e88ff, 0x123050);
  grid.position.y = 0.11;
  (grid.material as any).transparent = true;
  (grid.material as any).opacity = 0.35;
  root.add(grid);

  // The rack.
  const rack = new T.Group();
  rack.position.set(0, 0.1, lot.d * 0.06);
  root.add(rack);
  const body = new T.Mesh(new T.BoxGeometry(1.6, RACK_H, 1.2), new T.MeshStandardMaterial({ color: 0x111a2a, roughness: 0.35, metalness: 0.75 }));
  body.position.y = RACK_H / 2;
  rack.add(body);
  // Blinking unit LEDs on the front.
  const ledGeo = new T.BoxGeometry(0.06, 0.03, 0.02);
  const leds: any[] = [];
  for (let i = 0; i < 26; i++) {
    const m = new T.MeshBasicMaterial({ color: i % 3 ? 0x2bd67b : 0x1e88ff });
    const led = new T.Mesh(ledGeo, m);
    led.position.set(-0.68 + (i % 2) * 0.12, 0.3 + i * 0.22, 0.61);
    rack.add(led);
    leds.push(led);
  }
  // Two lanes up the front.
  const laneMat = (c: number) => new T.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.18 });
  for (const [x, c] of [[-LANE_X + 0.1, 0x4fb3ff], [LANE_X - 0.1 + 0.2, 0xffb020]] as Array<[number, number]>) {
    const lane = new T.Mesh(new T.BoxGeometry(0.16, RACK_H - 0.3, 0.02), laneMat(c));
    lane.position.set(x, RACK_H / 2, 0.62);
    rack.add(lane);
  }
  const plate = textSprite([
    { text: 'RELATE', color: '#7cc8ff', size: 44, bold: true },
    { text: 'the memory engine · in-process', color: '#9fb4c8', size: 22 },
  ], 1.1);
  plate.position.set(0, RACK_H + 0.9, 0.2);
  rack.add(plate);
  let statsSprite: any = null;
  const laneLabelR = textSprite([{ text: 'reads', color: '#4fb3ff', size: 26, bold: true }], 0.36);
  laneLabelR.position.set(-LANE_X + 0.1, -0.05 + 0.35, 0.95);
  rack.add(laneLabelR);
  const laneLabelW = textSprite([{ text: 'writes', color: '#ffb020', size: 26, bold: true }], 0.36);
  laneLabelW.position.set(LANE_X + 0.1, -0.05 + 0.35, 0.95);
  rack.add(laneLabelW);

  // The beacon: amber when the planner warns of a missing index.
  const beaconMat = new T.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0 });
  const beacon = new T.Mesh(new T.SphereGeometry(0.22, 16, 12), beaconMat);
  beacon.position.set(0.55, RACK_H + 0.25, 0.3);
  rack.add(beacon);
  const beaconLight = new T.PointLight(0xffb020, 0, 7);
  beaconLight.position.copy(beacon.position);
  rack.add(beaconLight);
  let warning = false;

  // Pulses: pooled bars climbing the lanes.
  const pulseGeo = new T.BoxGeometry(0.2, 1, 0.08);
  type Pulse = { mesh: any; y: number; len: number; speed: number; life: number };
  const live: Pulse[] = [];
  const pool: any[] = [];
  const queue: EnginePulse[] = [];
  let emitAcc = 0;
  function spawn(p: EnginePulse): void {
    if (live.length > 140) return;
    const slow = p.failed || (p.ms ?? 0) > SLOW_MS;
    const color = slow ? 0xff4d4d : p.write ? 0xffb020 : 0x4fb3ff;
    const mesh = pool.pop() ?? new T.Mesh(pulseGeo, new T.MeshBasicMaterial({ transparent: true }));
    mesh.material.color.setHex(color);
    mesh.material.opacity = 0.95;
    // Longer the longer the engine took: 0.12 at 0.01 ms … 1.6 at 100 ms (log).
    const len = Math.max(0.12, Math.min(1.6, 0.35 + 0.28 * Math.log10(Math.max(0.01, p.ms ?? 1))));
    mesh.scale.set(1, len, 1);
    mesh.position.set(p.write ? LANE_X + 0.1 : -LANE_X + 0.1, 0.2, 0.66);
    mesh.visible = true;
    rack.add(mesh);
    live.push({ mesh, y: 0.2, len, speed: 4.2 + Math.random() * 1.2, life: 0 });
  }

  // Walls: the plan (left) and the blueprint (right), turned toward the viewer.
  // Behind the rack and to either side of it, angled in like an open book.
  const wallW = Math.min(lot.w * 0.36, 7.5);
  const wallX = wallW * 0.5 + 1.5;
  const plan = screen(T, wallW, wallW * 0.62);
  plan.mesh.position.set(-wallX, wallW * 0.31 + 0.4, -lot.d * 0.34);
  plan.mesh.rotation.y = 0.42;
  root.add(plan.mesh);
  const blue = screen(T, wallW, wallW * 0.62);
  blue.mesh.position.set(wallX, wallW * 0.31 + 0.4, -lot.d * 0.34);
  blue.mesh.rotation.y = -0.42;
  root.add(blue.mesh);

  function showPlan(title: string, tree: PlanNodeView | null, footer: string): void {
    const { canvas: c, ctx: g } = plan;
    frame(g, c.width, c.height, 'PROFILE · relate.plan/v1', '#7cc8ff');
    g.fillStyle = '#c8d6e6';
    g.font = '500 22px Inter, system-ui, sans-serif';
    g.fillText(title.slice(0, 70), 32, 72);
    if (!tree) {
      g.fillStyle = '#7d8ea3';
      g.font = '500 24px Inter, system-ui, sans-serif';
      g.fillText('Pick a statement in the panel to see its plan.', 32, 130);
    } else {
      const rows: Array<{ n: PlanNodeView; d: number }> = [];
      const walk = (n: PlanNodeView, d: number) => { rows.push({ n, d }); n.children.forEach((k) => walk(k, d + 1)); };
      walk(tree, 0);
      const maxHits = Math.max(1, ...rows.map((r) => r.n.dbHits));
      const lineH = Math.min(46, (c.height - 190) / Math.max(1, rows.length));
      rows.slice(0, 14).forEach(({ n, d }, i) => {
        const y = 118 + i * lineH;
        const x = 40 + d * 34;
        if (d > 0) { g.strokeStyle = '#2a4a6a'; g.lineWidth = 2; g.beginPath(); g.moveTo(x - 20, y - lineH / 2 + 8); g.lineTo(x - 20, y + 14); g.lineTo(x - 4, y + 14); g.stroke(); }
        g.fillStyle = '#7cc8ff';
        g.font = `700 ${Math.min(24, lineH * 0.55)}px Inter, system-ui, sans-serif`;
        g.fillText(n.operator, x, y);
        const opW = g.measureText(n.operator).width;
        g.fillStyle = '#9fb4c8';
        g.font = `500 ${Math.min(19, lineH * 0.45)}px "JetBrains Mono", monospace`;
        g.fillText(`${n.rows} rows · ${n.dbHits} hits${n.start ? ` · start: ${n.start}` : ''}`, x + opW + 14, y + 3);
        // A bar for the operator's share of db hits.
        g.fillStyle = 'rgba(79, 179, 255, 0.35)';
        g.fillRect(c.width - 230, y + 4, 190 * (n.dbHits / maxHits), lineH * 0.4);
      });
    }
    g.fillStyle = '#3dd68c';
    g.font = '600 22px "JetBrains Mono", monospace';
    g.fillText(footer, 32, c.height - 52);
    plan.tex.needsUpdate = true;
  }

  function showBlueprint(bp: BlueprintView | null): void {
    const { canvas: c, ctx: g } = blue;
    frame(g, c.width, c.height, 'THE GRAPH · db.schema.visualization', '#a66bff');
    // Blueprint grid.
    g.strokeStyle = 'rgba(166, 107, 255, 0.08)';
    g.lineWidth = 1;
    for (let x = 0; x < c.width; x += 32) { g.beginPath(); g.moveTo(x, 70); g.lineTo(x, c.height); g.stroke(); }
    for (let y = 70; y < c.height; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(c.width, y); g.stroke(); }
    if (!bp || bp.labels.length === 0) { blue.tex.needsUpdate = true; return; }
    const labels = bp.labels.slice(0, 16);
    const cx = c.width / 2, cy = (c.height + 70) / 2;
    const R = Math.min(c.width * 0.36, (c.height - 110) * 0.4);
    const pos = new Map<string, { x: number; y: number }>();
    labels.forEach((l, i) => {
      const a = (i / labels.length) * Math.PI * 2 - Math.PI / 2;
      pos.set(l.label, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R * 0.82 });
    });
    const maxRel = Math.max(1, ...bp.relationships.map((r) => r.count));
    for (const r of bp.relationships.slice(0, 40)) {
      const a = pos.get(r.from), b = pos.get(r.to);
      if (!a || !b || a === b) continue;
      g.strokeStyle = `rgba(166, 107, 255, ${0.25 + 0.6 * (r.count / maxRel)})`;
      g.lineWidth = 1.5 + 5 * (r.count / maxRel);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      if (r.count / maxRel > 0.05) {
        g.fillStyle = '#c9a8ff';
        g.font = '500 15px "JetBrains Mono", monospace';
        g.fillText(r.type, (a.x + b.x) / 2 + 4, (a.y + b.y) / 2 - 8);
      }
    }
    const maxN = Math.max(1, ...labels.map((l) => l.count));
    for (const l of labels) {
      const p = pos.get(l.label)!;
      const r = 14 + 26 * Math.sqrt(l.count / maxN);
      g.fillStyle = 'rgba(20, 12, 40, 0.95)';
      g.strokeStyle = l.indexes.some((i) => i.type !== 'LOOKUP') ? '#3dd68c' : '#a66bff';
      g.lineWidth = 3;
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#ffffff';
      g.font = '700 19px Inter, system-ui, sans-serif';
      const w = g.measureText(l.label).width;
      g.fillText(l.label, p.x - w / 2, p.y - 11);
      g.fillStyle = '#b9a6e0';
      g.font = '500 15px "JetBrains Mono", monospace';
      const cnt = fmtN(l.count);
      g.fillText(cnt, p.x - g.measureText(cnt).width / 2, p.y + 10);
    }
    g.fillStyle = '#3dd68c';
    g.font = '600 18px "JetBrains Mono", monospace';
    g.fillText('green ring = indexed property', 32, c.height - 44);
    blue.tex.needsUpdate = true;
  }

  // C5 · the path: spheres on an arc over the rack, linked, each named.
  let pathGroup: any = null;
  function showPath(p: PathView | null): void {
    if (pathGroup) { root.remove(pathGroup); disposeObj(pathGroup); pathGroup = null; }
    if (!p || p.nodes.length === 0) return;
    pathGroup = new T.Group();
    const n = p.nodes.length;
    const span = Math.min(lot.w * 0.8, 3 + n * 2.6);
    const pts = p.nodes.map((_, i) => {
      const u = n === 1 ? 0.5 : i / (n - 1);
      return new T.Vector3(-span / 2 + span * u, RACK_H + 3.2 + Math.sin(u * Math.PI) * 1.6, 1.2);
    });
    const lineMat = new T.LineBasicMaterial({ color: 0x3dd68c, transparent: true, opacity: 0.9 });
    pathGroup.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), lineMat));
    p.nodes.forEach((node, i) => {
      const s = new T.Mesh(new T.SphereGeometry(0.32, 18, 12), new T.MeshBasicMaterial({ color: i === 0 || i === n - 1 ? 0x3dd68c : 0x7cc8ff }));
      s.position.copy(pts[i]);
      s.userData.pathNode = i;
      pathGroup.add(s);
      const lab = textSprite([
        { text: node.name.slice(0, 28), color: '#ffffff', size: 28, bold: true },
        { text: `:${node.label}`, color: '#9fb4c8', size: 20 },
      ], 0.75);
      lab.position.copy(pts[i]).add(new T.Vector3(0, 0.8, 0));
      pathGroup.add(lab);
      if (i < n - 1 && p.rels[i]) {
        const rl = textSprite([{ text: p.rels[i].type, color: '#3dd68c', size: 22, bold: true }], 0.42);
        rl.position.copy(pts[i]).lerp(pts[i + 1], 0.5).add(new T.Vector3(0, -0.45, 0));
        pathGroup.add(rl);
      }
    });
    root.add(pathGroup);
  }

  showPlan('', null, '');
  showBlueprint(null);

  return {
    group: root,
    pulse(items) { queue.push(...items.slice(-120)); if (queue.length > 240) queue.splice(0, queue.length - 240); },
    setStats(text) {
      if (statsSprite) { rack.remove(statsSprite); disposeObj(statsSprite); }
      statsSprite = textSprite([
        { text: text.reads, color: '#4fb3ff', size: 24, bold: true },
        { text: text.writes, color: '#ffb020', size: 24, bold: true },
      ], 0.7);
      statsSprite.position.set(0, RACK_H + 0.15, 0.95);
      rack.add(statsSprite);
    },
    setWarning(on) { warning = on; },
    showPlan,
    showBlueprint,
    showPath,
    tick(dt, t) {
      // Let queued pulses out over the next second, not all in one frame.
      emitAcc += dt * Math.max(12, queue.length * 1.5);
      while (emitAcc >= 1 && queue.length) { emitAcc -= 1; spawn(queue.shift()!); }
      if (!queue.length) emitAcc = 0;
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        p.life += dt;
        p.y += p.speed * dt;
        p.mesh.position.y = p.y + p.len / 2;
        const top = RACK_H - 0.2 - p.len;
        if (p.y > top - 0.6) p.mesh.material.opacity = Math.max(0, (top - p.y) / 0.6) * 0.95;
        if (p.y >= top) { rack.remove(p.mesh); pool.push(p.mesh); live.splice(i, 1); }
      }
      leds.forEach((l, i) => { l.visible = Math.sin(t * (3 + (i % 5)) + i * 1.7) > -0.4 || live.length > 3; });
      const b = warning ? 0.55 + 0.45 * Math.max(0, Math.sin(t * 5)) : 0;
      beaconMat.opacity = b;
      beaconLight.intensity = b * 3;
      if (pathGroup) pathGroup.children.forEach((o: any) => { if (o.userData.pathNode !== undefined) o.scale.setScalar(1 + 0.12 * Math.sin(t * 3 + o.userData.pathNode)); });
    },
    dispose() {
      scene.remove(root);
      disposeObj(root);
      for (const m of pool) m.material?.dispose?.();
      pulseGeo.dispose();
    },
  };
}
