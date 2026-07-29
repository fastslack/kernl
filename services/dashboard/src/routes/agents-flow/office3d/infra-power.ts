// office3d/infra-power.ts
// Power-control console for the Repos Office (data center). One freestanding
// master console where the responsible agent walks to switch an office's
// infrastructure on/off. Shows DETAILED live state for every office:
//   • a colour-coded breaker LED per office (3D, emissive)
//   • a digital readout of the action in progress (CSS2D)
//   • an "ops board" listing every office + its live state (CSS2D)
//   • a master lever that flips up (ON) / down (OFF) when toggled
import { rt } from './runtime.js';

export type InfraState = 'running' | 'stopped' | 'paused' | 'error' | 'booting' | 'absent';

export interface InfraOffice { flowId: string; name: string; color: string }

/** Shared state → visual mapping (LED colour, label, pulse cadence). */
export const INFRA_VIS: Record<InfraState, { hex: number; intensity: number; text: string; pulse: 0 | 1 | 2 }> = {
  running: { hex: 0x3dd68c, intensity: 1.0,  text: 'ONLINE',  pulse: 0 },
  stopped: { hex: 0x7a2e2e, intensity: 0.22, text: 'OFFLINE', pulse: 0 },
  paused:  { hex: 0xffb84a, intensity: 0.7,  text: 'PAUSED',  pulse: 1 },
  error:   { hex: 0xef4444, intensity: 0.95, text: 'ERROR',   pulse: 2 },
  booting: { hex: 0x2a8cff, intensity: 0.95, text: 'BOOTING', pulse: 2 },
  absent:  { hex: 0x333a4c, intensity: 0.14, text: '—',       pulse: 0 },
};

interface Breaker {
  mat: any;            // LED material (emissive)
  state: InfraState;
}

interface ConsoleState {
  group: any;
  leverArm: any;
  leverTarget: number; // radians (target rotation.x)
  leverCur: number;
  breakers: Map<string, Breaker>;
  readoutEl: HTMLDivElement | null;
  boardEl: HTMLDivElement | null;
  boardObj: any;            // the board's CSS2DObject (toggle .visible)
  boardVisible: boolean;
  hintMat: any;             // emissive "click me" indicator on the cabinet
  offices: InfraOffice[];
  operatorPos: { x: number; y: number; z: number };
  facePos: { x: number; y: number; z: number };
}

let con: ConsoleState | null = null;

const LEVER_ON = -0.7;  // arm tilted up = ON
const LEVER_OFF = 0.7;  // arm tilted down = OFF

/** Build the master power console inside the Repos Office. Returns the operator
 *  standing point so the caller can walk an agent there. */
export function buildPowerConsole(
  scene: any,
  room: { cx: number; cz: number; w: number; d: number; doorDir?: string },
  offices: InfraOffice[],
): { operatorPos: { x: number; y: number; z: number }; facePos: { x: number; y: number; z: number }; hitbox: any } | null {
  if (!rt.THREE) return null;
  const THREE = rt.THREE;
  const { cx, cz, w, d } = room;
  const dd = (room as any).doorDir || 'bottom';
  // Unit vector pointing toward the door (where the operator approaches from).
  const toDoor = dd === 'top' ? { x: 0, z: 1 }
    : dd === 'bottom' ? { x: 0, z: -1 }
    : dd === 'left' ? { x: -1, z: 0 }
    : { x: 1, z: 0 };

  // Console sits a bit off-center, operator stands on the door side facing it.
  const inset = Math.min(w, d) * 0.16;
  const consoleX = cx - toDoor.x * inset;
  const consoleZ = cz - toDoor.z * inset;
  const operatorPos = { x: consoleX + toDoor.x * 1.5, y: 0, z: consoleZ + toDoor.z * 1.5 };
  const facePos = { x: consoleX, y: 1.0, z: consoleZ };

  const group = new THREE.Group();
  group.position.set(consoleX, 0, consoleZ);
  // Local +Z faces the door (the operator).
  group.rotation.y = Math.atan2(toDoor.x, toDoor.z);

  // ── Cabinet ──
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x232734, roughness: 0.5, metalness: 0.55 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.0, 0.62), bodyMat);
  body.position.set(0, 0.5, 0);
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);
  // Brushed-steel kick plate + side rails
  const railMat = new THREE.MeshStandardMaterial({ color: 0x4a5060, roughness: 0.35, metalness: 0.8 });
  for (const s of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.64), railMat);
    rail.position.set(s * 0.85, 0.5, 0);
    group.add(rail);
  }
  // "Click me" indicator — a small pulsing cyan screen on the cabinet front
  // that hints the console is interactive (toggles the power-grid board).
  const hintMat = new THREE.MeshStandardMaterial({
    color: 0x0a1620, emissive: new THREE.Color(0x2ad6ff), emissiveIntensity: 0.7, roughness: 0.3,
  });
  const hint = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.03), hintMat);
  hint.position.set(0, 0.62, 0.32);
  group.add(hint);
  const hintFrame = new THREE.Mesh(
    new THREE.BoxGeometry(0.56, 0.22, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x1a2230, roughness: 0.5, metalness: 0.5 }),
  );
  hintFrame.position.set(0, 0.62, 0.305);
  group.add(hintFrame);

  // ── Tilted control panel on top (faces the operator) ──
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x161a24, roughness: 0.4, metalness: 0.4 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.62, 0.06), panelMat);
  panel.position.set(0, 1.16, 0.28);
  panel.rotation.x = -0.62; // tilt up toward the operator
  group.add(panel);

  // Helper to place something onto the tilted panel surface (panel-local).
  const panelGroup = new THREE.Group();
  panelGroup.position.copy(panel.position);
  panelGroup.rotation.copy(panel.rotation);
  group.add(panelGroup);

  // ── Per-office breaker LED grid (left 2/3 of the panel) ──
  const breakers = new Map<string, Breaker>();
  const cols = 6;
  const cellW = 0.16, cellH = 0.13;
  const gridX0 = -0.78, gridY0 = 0.2;
  const ledGeo = new THREE.BoxGeometry(0.075, 0.075, 0.03);
  const housingGeo = new THREE.BoxGeometry(0.12, 0.1, 0.02);
  const housingMat = new THREE.MeshStandardMaterial({ color: 0x0c0e15, roughness: 0.6, metalness: 0.2 });
  offices.forEach((off, i) => {
    const col = i % cols, rowi = Math.floor(i / cols);
    const lx = gridX0 + col * cellW;
    const ly = gridY0 - rowi * cellH;
    const housing = new THREE.Mesh(housingGeo, housingMat);
    housing.position.set(lx, ly, 0.035);
    panelGroup.add(housing);
    const vis = INFRA_VIS.absent;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a0c12, emissive: new THREE.Color(vis.hex), emissiveIntensity: vis.intensity, roughness: 0.3,
    });
    const led = new THREE.Mesh(ledGeo, mat);
    led.position.set(lx, ly, 0.055);
    panelGroup.add(led);
    breakers.set(off.flowId, { mat, state: 'absent' });
  });

  // ── Master lever (right side of the panel) ──
  const leverBaseMat = new THREE.MeshStandardMaterial({ color: 0x30343f, roughness: 0.4, metalness: 0.7 });
  const leverBase = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.06), leverBaseMat);
  leverBase.position.set(0.55, -0.02, 0.04);
  panelGroup.add(leverBase);
  // Slot labels ON / OFF (emissive ticks)
  const onTick = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.02), new THREE.MeshStandardMaterial({ color: 0x123a26, emissive: new THREE.Color(0x3dd68c), emissiveIntensity: 0.5 }));
  onTick.position.set(0.55, 0.08, 0.05); panelGroup.add(onTick);
  const offTick = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.02), new THREE.MeshStandardMaterial({ color: 0x3a1414, emissive: new THREE.Color(0xef4444), emissiveIntensity: 0.4 }));
  offTick.position.set(0.55, -0.12, 0.05); panelGroup.add(offTick);
  // Lever arm — pivots from the base.
  const leverArm = new THREE.Group();
  leverArm.position.copy(leverBase.position);
  leverArm.rotation.x = LEVER_OFF;
  panelGroup.add(leverArm);
  const armMat = new THREE.MeshStandardMaterial({ color: 0xb0b6c4, roughness: 0.3, metalness: 0.85 });
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.34, 8), armMat);
  arm.position.set(0, 0.17, 0); // extends up from the pivot
  leverArm.add(arm);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshStandardMaterial({ color: 0xd34a4a, roughness: 0.35, metalness: 0.4, emissive: new THREE.Color(0x551111), emissiveIntensity: 0.4 }));
  knob.position.set(0, 0.35, 0);
  leverArm.add(knob);

  scene.add(group);

  // ── CSS2D digital readout (the action currently in progress) ──
  let readoutEl: HTMLDivElement | null = null;
  let boardEl: HTMLDivElement | null = null;
  let boardObj: any = null;
  if (rt.CSS2DObject) {
    readoutEl = document.createElement('div');
    readoutEl.style.cssText = `font:800 11px 'Fira Code',monospace;color:#7fe3b0;letter-spacing:1px;
      background:linear-gradient(#0a1410,#08120d);border:1px solid #1d4a36;border-radius:3px;
      padding:3px 10px;text-shadow:0 0 6px #2fae74;white-space:nowrap;min-width:150px;text-align:center;`;
    readoutEl.textContent = 'POWER CONTROL · IDLE';
    const ro = new rt.CSS2DObject(readoutEl);
    ro.position.set(consoleX, 1.95, consoleZ);
    scene.add(ro);

    // Ops board — the full list of offices + live state. HIDDEN by default;
    // clicking the console (hitbox below) toggles it. Floats above the console.
    boardEl = document.createElement('div');
    boardEl.style.cssText = `font:600 9px 'Fira Code',monospace;color:#aab;line-height:1.45;
      background:rgba(8,11,18,0.86);border:1px solid #2a3245;border-radius:4px;padding:6px 9px;
      box-shadow:0 4px 16px rgba(0,0,0,0.5);min-width:160px;`;
    boardObj = new rt.CSS2DObject(boardEl);
    boardObj.position.set(consoleX + toDoor.x * 0.2, 2.5, consoleZ + toDoor.z * 0.2);
    boardObj.visible = false; // start hidden — revealed on console click
    scene.add(boardObj);
  }

  // ── Click hitbox over the whole console (toggles the ops board) ──
  const hitbox = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 2.0, 1.0),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  hitbox.position.set(0, 1.0, 0.1);
  hitbox.renderOrder = -1;
  hitbox.userData.isInfraConsole = true;
  group.add(hitbox);

  con = {
    group, leverArm, leverTarget: LEVER_OFF, leverCur: LEVER_OFF,
    breakers, readoutEl, boardEl, boardObj, boardVisible: false, hintMat, offices, operatorPos, facePos,
  };
  renderBoard();
  return { operatorPos, facePos, hitbox };
}

/** Toggle the power-grid board's visibility (clicking the console hitbox). */
export function toggleInfraBoard(): boolean {
  if (!con) return false;
  con.boardVisible = !con.boardVisible;
  if (con.boardObj) con.boardObj.visible = con.boardVisible;
  return con.boardVisible;
}

/** Set an office breaker LED to a state (live; no rebuild). */
export function setInfraBreaker(flowId: string, state: InfraState): void {
  if (!con) return;
  const b = con.breakers.get(flowId);
  if (!b) return;
  b.state = state;
  const vis = INFRA_VIS[state];
  b.mat.emissive.setHex(vis.hex);
  b.mat.emissiveIntensity = vis.intensity;
  renderBoard();
}

/** Current known state of an office's breaker (for the ops board / badges). */
export function getInfraBreakerState(flowId: string): InfraState | null {
  return con?.breakers.get(flowId)?.state ?? null;
}

/** Flash the readout with the action in progress. */
export function setInfraReadout(text: string, ok = true): void {
  if (!con?.readoutEl) return;
  const c = ok ? '#7fe3b0' : '#ef9a9a';
  const glow = ok ? '#2fae74' : '#b03030';
  con.readoutEl.textContent = text;
  con.readoutEl.style.color = c;
  con.readoutEl.style.textShadow = `0 0 6px ${glow}`;
}

/** Throw the master lever up (ON) or down (OFF) — animated by updateInfraConsole. */
export function flipInfraLever(on: boolean): void {
  if (!con) return;
  con.leverTarget = on ? LEVER_ON : LEVER_OFF;
}

/** Per-frame: ease the lever toward its target + pulse booting/error LEDs. */
export function updateInfraConsole(_dt: number, timeSec: number): void {
  if (!con) return;
  // Lever easing
  con.leverCur += (con.leverTarget - con.leverCur) * 0.18;
  if (con.leverArm) con.leverArm.rotation.x = con.leverCur;
  // Gently pulse the "click me" indicator so the console reads as interactive.
  if (con.hintMat) con.hintMat.emissiveIntensity = 0.55 + Math.sin(timeSec * 2.2) * 0.3;
  // Pulse breakers that are booting (fast) or error/paused.
  for (const b of con.breakers.values()) {
    const vis = INFRA_VIS[b.state];
    if (vis.pulse === 0) continue;
    const speed = vis.pulse === 2 ? 6 : 2.4;
    const amp = vis.pulse === 2 ? 0.45 : 0.25;
    b.mat.emissiveIntensity = Math.max(0.1, vis.intensity + Math.sin(timeSec * speed) * amp);
  }
}

/** Operator standing point in front of the console (walk target). */
export function getInfraOperatorPos(): { x: number; y: number; z: number } | null {
  return con?.operatorPos ?? null;
}
export function getInfraFacePos(): { x: number; y: number; z: number } | null {
  return con?.facePos ?? null;
}

/** Re-render the ops board listing (office name + coloured state word). */
function renderBoard(): void {
  if (!con?.boardEl) return;
  const rows = con.offices.map((o) => {
    const st = con!.breakers.get(o.flowId)?.state ?? 'absent';
    const vis = INFRA_VIS[st];
    const dot = `<span style="color:#${vis.hex.toString(16).padStart(6, '0')}">●</span>`;
    const nm = o.name.length > 14 ? o.name.slice(0, 13) + '…' : o.name;
    return `<div style="display:flex;justify-content:space-between;gap:10px">` +
      `<span>${dot} ${escapeHtml(nm.toUpperCase())}</span>` +
      `<span style="color:#${vis.hex.toString(16).padStart(6, '0')}">${vis.text}</span></div>`;
  }).join('');
  con.boardEl.innerHTML =
    `<div style="color:#cdd3e0;border-bottom:1px solid #2a3245;padding-bottom:3px;margin-bottom:4px;letter-spacing:1px">⚡ INFRA · POWER GRID</div>` +
    (rows || '<div style="color:#667">(no offices)</div>');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** Drop all module state (scene rebuild). The meshes live in the static group
 *  which is disposed by the caller; we just clear our handles. */
export function resetInfraConsole(): void {
  con = null;
}
