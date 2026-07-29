/** Build desks, chairs, monitors, and seated workers */

import { esc } from './esc.js';
import type { AgentData, Vec3, HumanoidParts, Aabb2D, RankData } from './types.js';
import { resolveFlowColor, type FlowData } from './types.js';
import type { SittingHumanoidPool } from './humanoid-pool.js';
import type { SittingWorkerEntry } from './walkers/index.js';
import { resolveSkin } from './skins/index.js';
import { applyPBR, bakeVertexAO } from './office/_materials.js';
import { applyWorldTexture, getScreenTexture } from './textures.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

// `DEFAULT_SKIN_ID` agents go into the shared InstancedMesh pool when one is
// provided; all other skins render per-mesh (one humanoid hierarchy per
// agent). This keeps the perf win for the default crowd while letting users
// install custom skins on individual agents.
const DEFAULT_SKIN_ID = 'office-worker';

let THREE: any;
let CSS2DObject: any;

export function initFurniture(three: any, css2d: any) {
  THREE = three;
  CSS2DObject = css2d;
}

function meshAt(geo: any, mat: any, x: number, y: number, z: number): any {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

export interface DeskResult {
  deskGroups: Map<string, any>;
  deskLabels: Map<string, any>;
  sittingWorkers: Map<string, SittingWorkerEntry>;
  /** XZ footprint of each desk (desk top + chair area + humanoid margin) for walker avoidance. */
  deskAabbs: Map<string, Aabb2D>;
}

/** Build all desks with monitors, chairs, workers, and nameplates.
 *  Uses InstancedMesh for desk legs (4 per desk) and chair post/base to reduce draw calls. */
export function buildDesks(
  scene: any,
  agents: AgentData[],
  flows: FlowData[],
  deskPos: Map<string, Vec3>,
  runningAgentIds: Set<string>,
  ranks: RankData[] = [],
  /**
   * Optional InstancedMesh pool for sitting workers. When provided, all
   * seated humanoids share 13 InstancedMesh draw calls instead of 14
   * meshes per worker. Animation runs via pool.update() in the parent.
   */
  pool: SittingHumanoidPool | null = null,
): DeskResult {
  const deskGroups = new Map<string, any>();
  const deskLabels = new Map<string, any>();
  const sittingWorkers = new Map<string, SittingWorkerEntry>();
  const deskAabbs = new Map<string, Aabb2D>();
  const ranksById = new Map(ranks.map(r => [r.id, r]));

  // Bulletproof nameplate cleanup. buildDesks runs from two paths — the
  // initial (async) buildScene AND the reactive rebuildScene — which can race:
  // rebuildScene fires mid-await, creates one set, then buildScene creates
  // another and overwrites the tracking map, orphaning the first set's
  // CSS2DObjects. They stay in the scene, so CSS2DRenderer keeps re-appending
  // their <div>, showing a second offset copy of every name. Removing only the
  // *tracked* labels can't catch the orphan. So here, at the start of EVERY
  // buildDesks, purge ALL prior nameplates from the scene graph AND the DOM by
  // their marker — regardless of who created them — leaving exactly one per
  // agent after the rebuild below.
  {
    const stale: any[] = [];
    scene.traverse((o: any) => { if (o.userData?.isNameplate) stale.push(o); });
    for (const o of stale) {
      if (o.parent) o.parent.remove(o);
      o.element?.remove();
    }
  }

  // The top agent (highest rank level) is rendered EXCLUSIVELY by
  // placeTopAgent() inside the special MY OFFICE room — they get their own
  // executive desk + halo + rank nameplate. Skip them here so we don't also
  // build a regular flow-grid desk for them in their own office, which would
  // render the figure twice.
  const topRankId = ranks.find(r => r.level >= 11)?.id;

  // Count agents with positions for InstancedMesh sizing
  const agentsWithPos = agents.filter(a =>
    deskPos.has(a.id) && a.rank_id !== topRankId,
  );
  const n = agentsWithPos.length;
  if (n === 0) return { deskGroups, deskLabels, sittingWorkers, deskAabbs };

  // Shared geometries (created once)
  // Desk top + monitor bezel are the most prominent camera-facing solids →
  // subtle RoundedBoxGeometry chamfer (segments=2, radius ≈ 3-6% of smallest
  // dim) softens the hard-box silhouette without a meaningful vertex bump.
  const deskTopGeo = new RoundedBoxGeometry(2.4, 0.12, 1.3, 2, 0.02);
  const deskPanelGeo = new THREE.BoxGeometry(2.4, 0.35, 0.04);
  const monGeo = new THREE.BoxGeometry(0.85, 0.55, 0.04);
  const bezGeo = new RoundedBoxGeometry(0.9, 0.6, 0.03, 2, 0.01);
  const kbGeo = new THREE.BoxGeometry(0.5, 0.02, 0.18);
  const chairSeatGeo = new THREE.BoxGeometry(0.6, 0.06, 0.55);
  const chairBackGeo = new THREE.BoxGeometry(0.55, 0.5, 0.05);
  // Contact-shadow grounding on the chair seat + back: darken the bottom edges
  // (local bottom = -height/2) so the seat reads as occluded where it meets the
  // post and the back reads as occluded where it meets the seat. Baked at build
  // → zero per-frame cost. chairMat is dedicated to these two geometries only
  // (verified), so enabling vertexColors is safe; it multiplies with the
  // per-instance flow tint already on instanceColor.
  bakeVertexAO(chairSeatGeo, { floorY: -0.03, reach: 0.02, strength: 0.35 });
  bakeVertexAO(chairBackGeo, { floorY: -0.25, reach: 0.18, strength: 0.35 });

  // ── InstancedMesh for desk legs: 4 legs × n desks ──
  const legGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.78, 6);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x1a1d2a, metalness: 0.5 });
  applyPBR(legMat, 'metal'); // desk legs, monitor stand/base, chair post/base — structural metal
  const legInstance = new THREE.InstancedMesh(legGeo, legMat, n * 4);
  legInstance.castShadow = false; // legs are small, skip shadow
  const legOffsets: [number, number][] = [[-1.05, -0.55], [1.05, -0.55], [-1.05, 0.55], [1.05, 0.55]];

  // ── InstancedMesh for chair post: 1 per desk ──
  const chairPostGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.45, 6);
  const chairPostInstance = new THREE.InstancedMesh(chairPostGeo, legMat, n);

  // ── InstancedMesh for chair base: 1 per desk ──
  const chairBaseGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.03, 5);
  const chairBaseInstance = new THREE.InstancedMesh(chairBaseGeo, legMat, n);

  // ── InstancedMesh for monitor stand: 1 per desk ──
  const monStandGeo = new THREE.CylinderGeometry(0.03, 0.06, 0.35, 6);
  const monStandInstance = new THREE.InstancedMesh(monStandGeo, legMat, n);

  // ── InstancedMesh for monitor base: 1 per desk ──
  const monBaseGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.02, 8);
  const monBaseInstance = new THREE.InstancedMesh(monBaseGeo, legMat, n);

  // ── Tier 3: instance every other repetitive desk decoration ──
  // Panel + bezel + keyboard all share constant material colors → InstancedMesh
  // with a single material per part, no per-instance color buffer needed.
  // Mug + chair seat + chair back use a per-desk tint of the flow color
  // → InstancedMesh + setColorAt per instance.
  // Lamp's per-desk opacity (0.2 idle / 0.7 running) is collapsed to a single
  // shared opacity 0.4 — barely perceptible visually, eliminates ~70 meshes.
  // Desk top: was glossy (rough 0.4 / metal 0.15) which mirrored the procedural
  // env map as ugly blotches at grazing angles. Matte-r + non-metal kills the
  // reflection while keeping a faint sheen.
  const deskColorMat = new THREE.MeshStandardMaterial({ color: 0x3a4a7a, roughness: 0.62, metalness: 0.04 });
  if ('envMapIntensity' in deskColorMat) deskColorMat.envMapIntensity = 0.35;
  const bezMat = new THREE.MeshStandardMaterial({ color: 0x3a3a5a, roughness: 0.3 });
  applyPBR(bezMat, 'plastic'); // monitor bezel — dark plastic casing
  // Keyboard deck — very dark charcoal so the gaps between the (lighter) keycaps
  // read as real key separations instead of bare slab. Fully matte.
  const kbMat  = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.85, metalness: 0.0 });
  if ('envMapIntensity' in kbMat) kbMat.envMapIntensity = 0.1;
  const mugGeo = new THREE.CylinderGeometry(0.06, 0.05, 0.12, 8);
  const lampGeo = new THREE.SphereGeometry(0.08, 6, 6);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff8f0, transparent: true, opacity: 0.4 });

  const panelInstance     = new THREE.InstancedMesh(deskPanelGeo, deskColorMat, n);
  const bezInstance       = new THREE.InstancedMesh(bezGeo, bezMat, n);
  const kbInstance        = new THREE.InstancedMesh(kbGeo, kbMat, n);
  // Keycaps — a chunky grid of little boxes on top of the keyboard deck so it
  // reads as a keyboard (real geometry catches the key light; a texture aliased
  // into noise at this distance). All desks share ONE InstancedMesh → 1 draw
  // call for every keycap in the building.
  const KB_COLS = 8, KB_ROWS = 3, KB_KEYS = KB_COLS * KB_ROWS;
  const keycapGeo = new THREE.BoxGeometry(0.042, 0.014, 0.03);
  const keycapMat = new THREE.MeshStandardMaterial({ color: 0x3a4154, roughness: 0.8, metalness: 0.0 });
  if ('envMapIntensity' in keycapMat) keycapMat.envMapIntensity = 0.1;
  const keycapInstance = new THREE.InstancedMesh(keycapGeo, keycapMat, n * KB_KEYS);
  keycapInstance.castShadow = false;
  // Loose paper sheet per desk — near-white plane with a random yaw so no two
  // desks look identical. One InstancedMesh for all desks (1 draw call).
  const paperGeo = new THREE.PlaneGeometry(0.24, 0.32);
  paperGeo.rotateX(-Math.PI / 2);
  const paperMat = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, roughness: 0.95, metalness: 0 });
  const paperInstance = new THREE.InstancedMesh(paperGeo, paperMat, n);
  paperInstance.castShadow = false;
  paperInstance.receiveShadow = true;
  // Per-instance color (tint of flow color):
  const mugMat       = new THREE.MeshStandardMaterial({ color: 0xffffff });
  // chairMat is dedicated to chairSeatInstance + chairBackInstance, both of
  // which get bakeVertexAO above → safe to enable vertexColors (multiplies
  // with the per-instance flow tint).
  const chairMat     = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, vertexColors: true });
  chairMat.needsUpdate = true;
  const mugInstance        = new THREE.InstancedMesh(mugGeo, mugMat, n);
  const chairSeatInstance  = new THREE.InstancedMesh(chairSeatGeo, chairMat, n);
  const chairBackInstance  = new THREE.InstancedMesh(chairBackGeo, chairMat, n);
  // Tier 3 lamps only show on active desks → cap = active count, hidden slots
  // collapsed to zero-scale below.
  const lampInstance       = new THREE.InstancedMesh(lampGeo, lampMat, n);
  // Allocate per-instance color buffers for the three flow-tinted parts.
  for (const im of [mugInstance, chairSeatInstance, chairBackInstance]) {
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  }
  // Cast settings — desk-tier parts are mostly invisible to shadow at the
  // current camera distance; only the panel needs to participate so the desk
  // looks grounded.
  panelInstance.castShadow = true; panelInstance.receiveShadow = true;
  bezInstance.castShadow = false;
  kbInstance.castShadow = false;
  mugInstance.castShadow = false;
  chairSeatInstance.castShadow = true; chairSeatInstance.receiveShadow = true;
  chairBackInstance.castShadow = true;
  lampInstance.castShadow = false;

  const tempMatrix = new THREE.Matrix4();
  const tmpColor = new THREE.Color();
  const hiddenMat = new THREE.Matrix4().makeScale(0, 0, 0);
  const S = 1.3; // desk group scale

  function setLocalAt(im: any, i: number, lx: number, ly: number, lz: number) {
    tempMatrix.makeScale(S, S, S);
    tempMatrix.setPosition(0, 0, 0); // we'll set after combining with desk pos below
    // Inline: scale-then-translate
    tempMatrix.set(
      S, 0, 0, 0,
      0, S, 0, 0,
      0, 0, S, 0,
      0, 0, 0, 1,
    );
    tempMatrix.elements[12] = lx;
    tempMatrix.elements[13] = ly;
    tempMatrix.elements[14] = lz;
    im.setMatrixAt(i, tempMatrix);
  }
  function setInstColor(im: any, i: number, c: any) {
    const arr = im.instanceColor.array as Float32Array;
    const off = i * 3;
    arr[off]     = c.r;
    arr[off + 1] = c.g;
    arr[off + 2] = c.b;
  }

  let idx = 0;
  for (const agent of agentsWithPos) {
    const pos = deskPos.get(agent.id)!;
    const color = resolveFlowColor(agent.id, agents, flows);
    const isActive = agent.active === 1;
    const isRunning = runningAgentIds.has(agent.id);

    const group = new THREE.Group();
    group.position.set(pos.x, 0, pos.z);
    group.scale.setScalar(S);
    group.userData.agentId = agent.id;

    // Invisible hitbox covering desk + chair + worker — makes clicking easy.
    // Uses opacity 0 + transparent (not visible:false, which Raycaster skips).
    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 2.0, 2.0),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hitbox.position.set(0, 1.0, 0.1); // centered between desk front and chair back
    hitbox.renderOrder = -1; // render first so it doesn't z-fight
    group.add(hitbox);

    // Desk top (kept in group for raycasting)
    const deskColor = new THREE.Color(0x3a4a7a);
    const deskMat = new THREE.MeshStandardMaterial({ color: deskColor, roughness: 0.4, metalness: 0.15 });
    // Subtle laminate grain — shared cached texture, per-desk material stays
    // (needed for the hover emissive highlight).
    applyWorldTexture(deskMat, 'wood', { normalScale: 0.2 });
    const top = new THREE.Mesh(deskTopGeo, deskMat);
    top.position.y = 0.78; top.castShadow = true; top.receiveShadow = true;
    group.add(top);
    group.userData._deskTop = top; // tagged for hover highlight lookup

    // Desk legs → InstancedMesh (world-space transform)
    for (let li = 0; li < 4; li++) {
      const [lx, lz] = legOffsets[li];
      tempMatrix.makeScale(S, S, S);
      tempMatrix.setPosition(pos.x + lx * S, 0.39 * S, pos.z + lz * S);
      legInstance.setMatrixAt(idx * 4 + li, tempMatrix);
    }

    // Panel — InstancedMesh (constant color)
    setLocalAt(panelInstance, idx, pos.x + 0 * S, 0.58 * S, pos.z + (-0.63) * S);

    // Monitor — kept individual (per-frame emissiveIntensity update)
    const screenGlow = isActive ? (isRunning ? 0.7 : 0.3) : 0.05;
    const screenColor = isRunning ? 0x00ff88 : 0x2288ff;
    const monMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a18, emissive: new THREE.Color(screenColor), emissiveIntensity: screenGlow, roughness: 0.1,
      // Shared "screen content" emissiveMap (terminal / dashboard / code) so
      // monitors read as actual work up close; the per-state emissive color
      // still tints it and the per-frame intensity pulse is untouched.
      emissiveMap: getScreenTexture(idx),
    });
    applyPBR(monMat, 'screen'); // monitor screen surface (emissive); emissiveIntensity kept (per-frame driven)
    const mon = new THREE.Mesh(monGeo, monMat);
    mon.position.set(-0.3, 1.2, -0.4);
    group.add(mon);
    group.userData._monitor = mon; // tagged for animation loop lookup

    // Bezel + Keyboard → InstancedMesh (constant color)
    setLocalAt(bezInstance, idx, pos.x + (-0.3) * S, 1.2 * S, pos.z + (-0.42) * S);
    setLocalAt(kbInstance,  idx, pos.x + (-0.3) * S, 0.83 * S, pos.z + (-0.05) * S);
    // Keycaps sit on the keyboard top (deck top ≈ 0.84; cap half-height 0.006).
    // Tight grid that covers most of the 0.5×0.18 deck so little bare base
    // shows (usable 0.44×0.13, leaving a thin frame).
    for (let kr = 0; kr < KB_ROWS; kr++) {
      for (let kc = 0; kc < KB_COLS; kc++) {
        const localX = -0.22 + (kc + 0.5) * (0.44 / KB_COLS);
        const localZ = -0.065 + (kr + 0.5) * (0.13 / KB_ROWS);
        setLocalAt(
          keycapInstance, idx * KB_KEYS + kr * KB_COLS + kc,
          pos.x + (-0.3 + localX) * S, 0.847 * S, pos.z + (-0.05 + localZ) * S,
        );
      }
    }

    // Monitor stand + base → InstancedMesh
    tempMatrix.makeScale(S, S, S);
    tempMatrix.setPosition(pos.x + (-0.3) * S, 0.96 * S, pos.z + (-0.4) * S);
    monStandInstance.setMatrixAt(idx, tempMatrix);
    tempMatrix.setPosition(pos.x + (-0.3) * S, 0.79 * S, pos.z + (-0.4) * S);
    monBaseInstance.setMatrixAt(idx, tempMatrix);

    // Inactive agents render no seated worker (see below) — so the desk would
    // otherwise look identical to an active one minus the humanoid. Desaturate
    // the chair + mug to a dormant grey so a paused agent's whole station reads
    // as "off" up close, complementing the floor status ring + label dot.
    const furnColor: string | number = isActive ? color : 0x3a3f52;

    // Mug — InstancedMesh + per-instance color (flow tint × 0.5)
    setLocalAt(mugInstance, idx, pos.x + 0.7 * S, 0.88 * S, pos.z + 0.2 * S);
    tmpColor.set(furnColor).multiplyScalar(0.5);
    setInstColor(mugInstance, idx, tmpColor);

    // Paper sheet — deterministic per-desk jitter (hash of idx, no Math.random
    // so the layout is stable across rebuilds).
    {
      const h = Math.abs(Math.sin(idx * 12.9898) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin(idx * 78.233) * 12543.853) % 1;
      const yaw = (h - 0.5) * 1.1;
      const px = pos.x + (0.32 + (h2 - 0.5) * 0.18) * S;
      const pz = pos.z + (0.18 + (h - 0.5) * 0.16) * S;
      tempMatrix.makeRotationY(yaw);
      tempMatrix.scale(new THREE.Vector3(S, S, S));
      tempMatrix.setPosition(px, 0.846 * S, pz);
      paperInstance.setMatrixAt(idx, tempMatrix);
    }

    // Chair seat + back — InstancedMesh + per-instance color (flow tint × 0.8)
    setLocalAt(chairSeatInstance, idx, pos.x + 0 * S,  0.48 * S, pos.z + 0.55 * S);
    setLocalAt(chairBackInstance, idx, pos.x + 0 * S,  0.75 * S, pos.z + 0.82 * S);
    tmpColor.set(furnColor).multiplyScalar(0.8);
    setInstColor(chairSeatInstance, idx, tmpColor);
    setInstColor(chairBackInstance, idx, tmpColor);

    // Chair post + base → InstancedMesh
    tempMatrix.makeScale(S, S, S);
    tempMatrix.setPosition(pos.x, 0.23 * S, pos.z + 0.55 * S);
    chairPostInstance.setMatrixAt(idx, tempMatrix);
    tempMatrix.setPosition(pos.x, 0.03 * S, pos.z + 0.55 * S);
    chairBaseInstance.setMatrixAt(idx, tempMatrix);

    // Worker — pool path (InstancedMesh) preferred; otherwise individual mesh tree
    if (isActive) {
      // Resolve the agent's visual skin. The default goes into the pool when
      // available; alternate skins always render per-mesh.
      const skin = resolveSkin(agent.skin_id);
      const palette = skin.pickPalette(agent.id);
      const phase = Math.random() * Math.PI * 2;
      const canUsePool = pool && skin.manifest.id === DEFAULT_SKIN_ID;
      if (canUsePool && pool) {
        // The desk group has scale S=1.3 → world position = pos + 0.55*S in z;
        // also pass scale=S so the pool renders the same physical size.
        const slot = pool.add({
          pos: [pos.x, 0, pos.z + 0.55 * S],
          rotY: Math.PI,
          scale: S,
          color,
          skinColor: palette.skin,
          hairColor: palette.hair,
          pantsColor: palette.pants,
          phase,
        });
        sittingWorkers.set(agent.id, {
          group: null,
          phase,
          pooled: true,
          setVisible: (v: boolean) => pool.setHidden(slot, !v),
        });
      } else {
        const human = skin.createHumanoid({ flowColor: color, palette, scale: 1.0, walker: false });
        human.group.position.set(0, 0, 0.55);
        human.group.rotation.y = Math.PI;
        human.leftLeg.rotation.x = -1.5;
        human.rightLeg.rotation.x = -1.5;
        human.leftArm.rotation.x = -0.8;
        human.rightArm.rotation.x = -0.8;
        group.add(human.group);
        sittingWorkers.set(agent.id, {
          group: human,
          phase,
          pooled: false,
          setVisible: (v: boolean) => { human.group.visible = v; },
        });
      }
    }

    // Desk lamp — InstancedMesh; inactive desks get hidden (zero-scale).
    if (isActive) {
      setLocalAt(lampInstance, idx, pos.x + 0.8 * S, 1.1 * S, pos.z + (-0.3) * S);
    } else {
      lampInstance.setMatrixAt(idx, hiddenMat);
    }

    // ── Floor status ring — the at-any-distance active/inactive signal ──
    // Active: green glow ring. Inactive: faint grey ring. Reads from a
    // top-down/far camera even when the LOD has hidden the nameplates, so the
    // operator can scan the whole floor and see which agents are live.
    // MeshBasicMaterial = no lighting cost; static (no per-frame animation).
    const ringColor = isActive ? 0x3dd68c : 0x4a4f6a;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.86, 32),
      new THREE.MeshBasicMaterial({
        color: ringColor,
        transparent: true,
        opacity: isActive ? 0.6 : 0.28,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.04, 0.3); // local: just under the chair/worker area
    ring.renderOrder = -1;
    group.add(ring);

    scene.add(group);
    deskGroups.set(agent.id, group);

    // AABB for walker avoidance
    const sx = S * 2.4 / 2 + 0.25;
    const zFront = S * 0.65 + 0.25;
    const zBack = S * 0.9 + 0.25;
    deskAabbs.set(agent.id, { minX: pos.x - sx, maxX: pos.x + sx, minZ: pos.z - zFront, maxZ: pos.z + zBack, agentId: agent.id });

    // Nameplate — insignia (rank icon only, no rank name text) + agent name.
    // Previously rendered an UPPERCASE rank-name line above
    // the agent name; visually that read as a duplicate title alongside the
    // agent-name chip. Insignia stars carry the rank info on their own.
    const rank = agent.rank_id ? ranksById.get(agent.rank_id) : undefined;
    const nd = document.createElement('div');
    nd.className = 'agent-nameplate';   // tag so buildDesks can wipe stale copies
    let insigniaHtml = '';
    let labelHeight = 2.5;
    if (rank) {
      // Level 1→11 maps to ~7→18 px for the insignia.
      const size = Math.max(7, 6 + Math.min(rank.level, 12) * 1.0);
      // text-shadow is a SINGLE subtle drop shadow now — the previous 3-layer
      // stack (8px color glow + 2px black inner + 1px drop) created a visible
      // duplicate-looking halo when the inner wrapper was scaled up by CSS
      // transform on close-up zoom (the color glow rendered as a "second
      // smaller logo behind" the main insignia).
      insigniaHtml =
        `<div style="font:900 ${size}px 'Manrope',sans-serif;color:${rank.color};` +
        `text-shadow:0 1px 2px rgba(0,0,0,0.85);` +
        `letter-spacing:0;line-height:1;margin-bottom:2px;" title="${esc(rank.name)}">${esc(rank.insignia)}</div>`;
      // Slight raise so the badge doesn't clip into the humanoid's head
      labelHeight = 2.6 + Math.min(rank.level, 12) * 0.03;
    }
    // Pending-approval pill — shown above the agent name when the agent is
    // inactive AND was likely created automatically (active=0 + worker spawned
    // by a manager). We can't distinguish "freshly spawned, awaits approval"
    // from "paused by user" perfectly without a separate column, but the badge
    // still works as "this agent is dormant — click to do something with it".
    const pendingBadge = !isActive
      ? `<div style="display:inline-block;background:#facc15;color:#1a1a1a;` +
        `font:700 8px 'Manrope',sans-serif;letter-spacing:0.4px;` +
        `padding:1px 6px;border-radius:3px;margin-bottom:2px;` +
        `box-shadow:0 0 6px rgba(250,204,21,0.6);` +
        `text-shadow:none">PENDING</div>`
      : '';
    // Revision pill — orthogonal to PENDING. Set when the agent is flagged
    // for human review (consolidation, deprecation, etc.). Orange to read
    // against the rest of the 3D office palette.
    const revisionBadge = (agent as { under_revision?: number }).under_revision
      ? `<div style="display:inline-block;background:#fb923c;color:#1a1a1a;` +
        `font:700 8px 'Manrope',sans-serif;letter-spacing:0.4px;` +
        `padding:1px 6px;border-radius:3px;margin-bottom:2px;margin-left:3px;` +
        `box-shadow:0 0 6px rgba(251,146,60,0.65);` +
        `text-shadow:none">REVISION</div>`
      : '';
    // Status dot (green=active / grey=inactive) before the name + a power
    // chip ⏻ after it. The chip is hidden by default and revealed on hover /
    // selection by the parent (updatePowerChips); pointer-events:auto lets it
    // receive DOM clicks even though the CSS2D layer is pointer-events:none.
    // The parent wires a delegated click handler keyed on data-agent.
    const dot =
      `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;vertical-align:middle;` +
      `margin-right:5px;background:${isActive ? '#3dd68c' : '#6b7088'};` +
      `box-shadow:${isActive ? '0 0 5px #3dd68c' : 'none'}"></span>`;
    const powerChip =
      `<button class="dl-power" data-agent="${agent.id}" data-active="${isActive ? 1 : 0}" ` +
      `title="${isActive ? 'Deactivate agent' : 'Activate agent'}" ` +
      `style="pointer-events:auto;cursor:pointer;display:none;margin-left:7px;vertical-align:middle;` +
      `border:none;border-radius:4px;padding:1px 6px;font:700 10px 'Manrope',sans-serif;` +
      `background:${isActive ? 'rgba(239,68,68,0.18)' : 'rgba(61,214,140,0.20)'};` +
      `color:${isActive ? '#ff6b6b' : '#3dd68c'};">⏻</button>`;
    nd.innerHTML =
      `<div style="text-align:center">${pendingBadge}${revisionBadge}${insigniaHtml}` +
      `<div style="font:600 10px 'Manrope',sans-serif;color:${isActive ? '#e0e2ea' : '#9097a8'};white-space:nowrap;` +
      `text-shadow:0 1px 3px rgba(0,0,0,0.8);background:rgba(13,15,24,${isActive ? '0.65' : '0.45'});padding:2px 8px;` +
      `border-radius:3px;border-bottom:2px solid ${rank?.color ?? color + (isActive ? '50' : '25')};` +
      `opacity:${isActive ? 1 : 0.7}">${dot}${esc(agent.name)}${powerChip}</div></div>`;
    const nl = new CSS2DObject(nd);
    nl.userData.isNameplate = true;   // marker for the purge at the top of buildDesks
    nl.position.set(pos.x, labelHeight, pos.z);
    scene.add(nl);
    deskLabels.set(agent.id, nl);

    idx++;
  }

  // Finalize InstancedMesh matrices and add to scene
  const allInstances = [
    legInstance, chairPostInstance, chairBaseInstance,
    monStandInstance, monBaseInstance,
    panelInstance, bezInstance, kbInstance, keycapInstance,
    mugInstance, chairSeatInstance, chairBackInstance,
    lampInstance, paperInstance,
  ];
  for (const im of allInstances) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    scene.add(im);
  }

  return { deskGroups, deskLabels, sittingWorkers, deskAabbs };
}

/** Build floor hallway lines for chains */
export interface HallwayLine {
  line: any;
  sourceId: string;
  targetId: string;
  color: string;
}

export function buildHallways(
  scene: any,
  chains: { source_agent_id: string; target_agent_id: string }[],
  deskPos: Map<string, Vec3>,
  agents: AgentData[],
  flows: FlowData[],
): HallwayLine[] {
  const result: HallwayLine[] = [];
  for (const chain of chains) {
    const s = deskPos.get(chain.source_agent_id);
    const t = deskPos.get(chain.target_agent_id);
    if (!s || !t) continue;
    const col = resolveFlowColor(chain.source_agent_id, agents, flows);
    const pts = [new THREE.Vector3(s.x, 0.04, s.z), new THREE.Vector3(t.x, 0.04, t.z)];
    const lm = new THREE.LineDashedMaterial({ color: new THREE.Color(col), transparent: true, opacity: 0, dashSize: 0.5, gapSize: 0.4 });
    const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lm);
    ln.computeLineDistances();
    ln.visible = false; // hidden by default — shown on agent click
    scene.add(ln);
    result.push({ line: ln, sourceId: chain.source_agent_id, targetId: chain.target_agent_id, color: col });
  }
  return result;
}
