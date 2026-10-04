import { rt } from '../runtime.js';
import { esc } from '../esc.js';
import type { RoomInfo } from '../types.js';
import { WALL_H } from './_shared.js';
import { applyPBR } from './_materials.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/** Minimal repo descriptor used by buildDataCenterOffice to label racks +
 *  the wall directory. Comes from /api/dashboard/repos (channel: repos). */
export interface RepoBookmark {
  id: string;
  name: string;
  path?: string;
  default_branch?: string;
  language?: string;
  tags?: string;
}

/**
 * DATA CENTER (vintage) decor for the Repos Office. Drops a wall of mainframe-
 * style server racks against the far wall (one rack per registered repo plus
 * spares), a CRT terminal cluster on a side wall, mainframe console + tape-reel
 * cabinet + UPS + KVM + patch panel + ops chair + printout pile in the corners,
 * and a backlit "DIRECTORY" panel on the wall listing every registered repo.
 *
 * Repos list arrives via the `repos` arg — left empty just renders empty/dark
 * racks. Caller is expected to call `buildDataCenterOffice` again whenever the
 * registry changes (the scene rebuild path already does this on flow refresh).
 */
export interface DataCenterHandles {
  /** Invisible hitboxes over each FREE rack. Tag with `userData.isFreeRepoRack`
   *  + `userData.rackIndex`. Caller pushes these into the raycaster targets
   *  so click opens the "register a repo here" modal. */
  freeRackHitboxes: any[];
  /** Invisible hitbox over the NOC desk. Tagged with `userData.isDevopsTerminal`
   *  and carrying `userData.nocAction` (the same action as the desk's title:
   *  /devops when the extension is active, the power grid otherwise). */
  devopsTerminalHitbox: any;
  /** Free floor spot for the master power console (infra-power.ts): against the
   *  patch-panel wall, door side, clear of the desk grid. `face` is the unit
   *  vector the console's front (and its operator) points to. */
  powerConsoleSpot: { x: number; z: number; face: { x: number; z: number } };
}

/** What the clickable in-world titles do. Every one is optional: a label whose
 *  action is missing renders as plain (non-interactive) text. */
export interface DataCenterActions {
  /** Open one registered repo (rack nameplate, directory row). */
  openRepo?: (repo: RepoBookmark) => void;
  /** Open the whole repo registry (directory header). */
  openRepos?: () => void;
  /** Open the register-a-repo modal (free racks chip, directory footer). */
  registerRepo?: () => void;
  /** Open the DevOps control panel (NOC desk title). Only pass it when the
   *  paid DevOps extension is active — otherwise /devops is a dead end. */
  openDevops?: () => void;
  /** Fallback for the NOC desk without the DevOps extension: show the power
   *  grid of every office (infra-power.ts board). */
  openPowerGrid?: () => void;
}

// LED materials that blink on occupied racks — ticked by updateDataCenter().
// Module-level like infra-power's console state: one data center per scene,
// reset on every rebuild.
let blinkMats: Array<{ mat: any; base: any; speed: number; phase: number }> = [];

/** Per-frame: flicker the activity LEDs on occupied racks. */
export function updateDataCenter(timeSec: number): void {
  for (const b of blinkMats) {
    const s = Math.sin(timeSec * b.speed + b.phase);
    // Mostly on, with short dark blips — reads as disk/network activity.
    b.mat.color.copy(b.base).multiplyScalar(s > 0.55 ? 0.25 : 1);
  }
}

// Hover/focus styles for the clickable CSS2D titles. Inline styles can't carry
// :hover, so one stylesheet is injected the first time an office is built.
function ensureDcStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('dc-office-css')) return;
  const st = document.createElement('style');
  st.id = 'dc-office-css';
  st.textContent = `
    .dc-click{pointer-events:auto;cursor:pointer;transition:filter .12s,box-shadow .12s;}
    .dc-click:hover,.dc-click:focus-visible{filter:brightness(1.35);box-shadow:0 0 0 1px #ffffff40,0 0 10px #ffffff26;outline:none;}
    .dc-row{pointer-events:auto;cursor:pointer;display:flex;gap:6px;align-items:baseline;
      padding:1px 4px;margin:0 -4px;border-radius:2px;white-space:nowrap;}
    .dc-row:hover,.dc-row:focus-visible{background:#ffb84a22;outline:none;}
    .dc-row:hover .dc-go,.dc-row:focus-visible .dc-go{opacity:1;}
    .dc-go{margin-left:auto;color:#ffb84a;opacity:.35;}
  `;
  document.head.appendChild(st);
}

/** Wire a CSS2D element as a button: click + Enter/Space, without letting the
 *  pointer reach the canvas underneath (orbit drag, desk picking). */
function makeClickable(el: HTMLElement, label: string, fn: () => void): void {
  el.classList.add('dc-click');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', label);
  el.title = label;
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); fn(); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
  });
}

export function buildDataCenterOffice(
  scene: any,
  room: RoomInfo,
  repos: RepoBookmark[] = [],
  actions: DataCenterActions = {},
): DataCenterHandles {
  const freeRackHitboxes: any[] = [];
  blinkMats = [];
  ensureDcStyles();
  const { cx, cz, w, d, color } = room;
  const dd = room.doorDir || (room.side === 1 ? 'top' : 'bottom');
  const accent = new rt.THREE.Color(color);

  // Same wall-reference helper as buildCommunicationsOffice — props hang off
  // the inside face of each wall + face the room centre.
  interface WallRef {
    id: 'top' | 'bottom' | 'left' | 'right';
    midX: number; midZ: number;
    nx: number; nz: number;
    runX: number; runZ: number;
    faceY: number;
  }
  const sidePad = 1.0;
  const innerInset = 0.32;
  const WALLS: Record<string, WallRef> = {
    top:    { id: 'top',    midX: cx,                       midZ: cz + d / 2 - innerInset, nx: 0,  nz: -1, runX: w - sidePad * 2, runZ: 0,                       faceY: Math.PI },
    bottom: { id: 'bottom', midX: cx,                       midZ: cz - d / 2 + innerInset, nx: 0,  nz:  1, runX: w - sidePad * 2, runZ: 0,                       faceY: 0 },
    left:   { id: 'left',   midX: cx - w / 2 + innerInset,  midZ: cz,                      nx: 1,  nz:  0, runX: 0,               runZ: d - sidePad * 2,         faceY: Math.PI / 2 },
    right:  { id: 'right',  midX: cx + w / 2 - innerInset,  midZ: cz,                      nx: -1, nz:  0, runX: 0,               runZ: d - sidePad * 2,         faceY: -Math.PI / 2 },
  };
  const OPPOSITE: Record<string, 'top' | 'bottom' | 'left' | 'right'> = {
    top: 'bottom', bottom: 'top', left: 'right', right: 'left',
  };
  const farWall = WALLS[OPPOSITE[dd]];
  const sideWallIds: Array<'top' | 'bottom' | 'left' | 'right'> =
    (['top', 'bottom', 'left', 'right'] as const).filter(x => x !== dd && x !== OPPOSITE[dd]);
  const terminalWall = WALLS[sideWallIds[0]];

  // Shared palette ──────────────────────────────────────────────
  const chassis = new rt.THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.55, metalness: 0.45 });
  applyPBR(chassis, 'metal'); // server rack / console / cabinet chassis — structural metal
  const chassisFront = new rt.THREE.MeshStandardMaterial({ color: 0x202329, roughness: 0.5, metalness: 0.5 });
  applyPBR(chassisFront, 'metal'); // rack front insert — structural metal
  const ventDark = new rt.THREE.MeshStandardMaterial({ color: 0x0a0b0e, roughness: 0.9 });
  const beigeMat = new rt.THREE.MeshStandardMaterial({ color: 0xc7b48a, roughness: 0.75, metalness: 0.05 });
  applyPBR(beigeMat, 'plastic'); // beige CRT terminal casing — plastic
  const labelGreen = new rt.THREE.MeshBasicMaterial({ color: 0x4cff7a });
  const labelAmber = new rt.THREE.MeshBasicMaterial({ color: 0xffb84a });
  const labelRed = new rt.THREE.MeshBasicMaterial({ color: 0xff4a3a });
  const phosphor = new rt.THREE.MeshStandardMaterial({
    color: 0x000800, emissive: new rt.THREE.Color(0x33ff66), emissiveIntensity: 0.85, roughness: 0.2,
  });
  applyPBR(phosphor, 'screen'); // CRT phosphor screen surface (emissive)
  const conduitMat = new rt.THREE.MeshStandardMaterial({ color: 0x303338, roughness: 0.4, metalness: 0.6 });
  applyPBR(conduitMat, 'metal'); // conduit / cable tray — structural metal
  const reelTapeMat = new rt.THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.6 });
  const reelHubMat = new rt.THREE.MeshStandardMaterial({ color: 0xb8babf, roughness: 0.35, metalness: 0.7 });
  applyPBR(reelHubMat, 'metal'); // silver tape-reel hub — metal
  // Deterministic-ish "random" so the LED grid is stable across renders.
  const hash = (a: number, b: number) => ((a * 2654435761) ^ (b * 40503)) >>> 0;

  // ── 1. SERVER RACK ROW against the far wall ────────────────────
  // One rack per registered repo + a few empty spares so the wall always looks
  // populated. Each rack:
  //  - chassis box
  //  - vented black front insert
  //  - 6×3 LED grid (green / amber, sparse red) — DARK on empty racks
  //  - vertical brand stripe in the flow accent colour
  //  - amber backlit nameplate at the top
  //  - CSS2D floating label with the repo name (or "FREE" placeholder)
  const isX = farWall.id === 'top' || farWall.id === 'bottom';
  const wallLen = isX ? w : d;
  const usableLen = Math.max(2, wallLen - 2.6);
  // Want at least 4 racks on screen; cap at 12 so individual racks stay readable.
  const desiredRacks = Math.max(4, Math.min(12, repos.length + 3));
  const rackW = Math.min(0.95, usableLen / desiredRacks);
  const rackCount = Math.max(4, Math.min(12, Math.floor(usableLen / rackW)));
  const rackTotalW = rackCount * rackW;
  const rackD = 0.6;
  const rackH = 2.5;
  const rackBaseY = 0.04; // sits on the floor (raised access plenum)
  // Raised floor plate under the racks — dark perforated band.
  const platformGeo = isX
    ? new rt.THREE.BoxGeometry(rackTotalW + 0.6, 0.06, rackD + 0.4)
    : new rt.THREE.BoxGeometry(rackD + 0.4, 0.06, rackTotalW + 0.6);
  const platform = new rt.THREE.Mesh(platformGeo, ventDark);
  platform.position.set(farWall.midX + farWall.nx * (rackD / 2 + 0.2), 0.06, farWall.midZ + farWall.nz * (rackD / 2 + 0.2));
  scene.add(platform);
  // Dim/dark variants for empty racks
  const labelDark = new rt.THREE.MeshStandardMaterial({ color: 0x141618, roughness: 0.9, metalness: 0 });
  const ledGeo = new rt.THREE.BoxGeometry(0.05, 0.05, 0.02);
  // Activity LEDs: a few phase-shifted copies of green/amber so occupied racks
  // flicker out of sync instead of pulsing as one block.
  const activityMats: any[] = [];
  for (let k = 0; k < 4; k++) {
    const base = new rt.THREE.Color(k % 2 === 0 ? 0x4cff7a : 0xffb84a);
    const mat = new rt.THREE.MeshBasicMaterial({ color: base.clone() });
    blinkMats.push({ mat, base, speed: 3.1 + k * 1.7, phase: k * 1.9 });
    activityMats.push(mat);
  }
  for (let i = 0; i < rackCount; i++) {
    const repo: RepoBookmark | undefined = repos[i];
    const occupied = !!repo;
    const off = -rackTotalW / 2 + (i + 0.5) * rackW;
    const rx = farWall.midX + (isX ? off : farWall.nx * rackD / 2);
    const rz = farWall.midZ + (isX ? farWall.nz * rackD / 2 : off);
    // Chassis (slightly darker when empty)
    const cabMat = occupied
      ? chassis
      : new rt.THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.7, metalness: 0.3 });
    // Server rack chassis — the most prominent camera-facing solid in this
    // room. Subtle RoundedBoxGeometry chamfer (segments=2) softens the hard
    // box silhouette. Radius clamped to ≈3% of the smallest dimension (and
    // never ≥ half of it) so narrow racks never invert. Bounded count
    // (rackCount ≤ 12) keeps the vertex bump tiny.
    const chassisMinDim = Math.min(rackW - 0.04, rackH, rackD);
    const chassisRadius = Math.min(0.02, chassisMinDim * 0.45);
    const chassisGeo = isX
      ? new RoundedBoxGeometry(rackW - 0.04, rackH, rackD, 2, chassisRadius)
      : new RoundedBoxGeometry(rackD, rackH, rackW - 0.04, 2, chassisRadius);
    const cab = new rt.THREE.Mesh(chassisGeo, cabMat);
    cab.position.set(rx, rackBaseY + rackH / 2, rz);
    cab.castShadow = true;
    scene.add(cab);
    // Front insert (vented black, slightly inset toward the room)
    const frontGeo = isX
      ? new rt.THREE.BoxGeometry(rackW - 0.18, rackH - 0.3, 0.03)
      : new rt.THREE.BoxGeometry(0.03, rackH - 0.3, rackW - 0.18);
    const front = new rt.THREE.Mesh(frontGeo, chassisFront);
    front.position.set(
      rx + (isX ? 0 : -farWall.nx * (rackD / 2 + 0.01)),
      rackBaseY + rackH / 2,
      rz + (isX ? -farWall.nz * (rackD / 2 + 0.01) : 0),
    );
    scene.add(front);
    // LED grid — 6 rows × 3 cols. DARK on empty racks.
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 3; c++) {
        const h = hash(i * 37 + c, r);
        const tint = !occupied
          ? labelDark
          : ((h % 17 === 0) ? labelRed
            : (h % 5 === 1) ? activityMats[h % activityMats.length]
            : ((h % 3 === 0) ? labelAmber : labelGreen));
        const led = new rt.THREE.Mesh(ledGeo, tint);
        const ledOff = -(rackW - 0.32) / 2 + (c + 0.5) * ((rackW - 0.32) / 3);
        const ledY = rackBaseY + 0.45 + r * 0.32;
        led.position.set(
          rx + (isX ? ledOff : -farWall.nx * (rackD / 2 + 0.025)),
          ledY,
          rz + (isX ? -farWall.nz * (rackD / 2 + 0.025) : ledOff),
        );
        scene.add(led);
      }
    }
    // Vertical accent stripe — bright when occupied, very dim when empty.
    const stripeMat = new rt.THREE.MeshStandardMaterial({
      color: 0x05080d,
      emissive: accent.clone().multiplyScalar(occupied ? 0.9 : 0.15),
      emissiveIntensity: occupied ? 0.6 : 0.15,
      roughness: 0.3,
    });
    const stripeGeo = isX
      ? new rt.THREE.BoxGeometry(0.04, rackH - 0.5, 0.02)
      : new rt.THREE.BoxGeometry(0.02, rackH - 0.5, 0.04);
    const stripe = new rt.THREE.Mesh(stripeGeo, stripeMat);
    const stripeOff = -(rackW - 0.18) / 2 + 0.05;
    stripe.position.set(
      rx + (isX ? stripeOff : -farWall.nx * (rackD / 2 + 0.025)),
      rackBaseY + (rackH - 0.5) / 2 + 0.25,
      rz + (isX ? -farWall.nz * (rackD / 2 + 0.025) : stripeOff),
    );
    scene.add(stripe);
    // Backlit nameplate at the top — bright amber when a repo lives here.
    const nameplate = new rt.THREE.Mesh(
      isX ? new rt.THREE.BoxGeometry(rackW - 0.3, 0.12, 0.02) : new rt.THREE.BoxGeometry(0.02, 0.12, rackW - 0.3),
      new rt.THREE.MeshStandardMaterial({
        color: 0x14171c,
        emissive: new rt.THREE.Color(occupied ? 0xffb84a : 0x2a2218),
        emissiveIntensity: occupied ? 0.35 : 0.12,
        roughness: 0.4,
      }),
    );
    nameplate.position.set(
      rx + (isX ? 0 : -farWall.nx * (rackD / 2 + 0.025)),
      rackBaseY + rackH - 0.18,
      rz + (isX ? -farWall.nz * (rackD / 2 + 0.025) : 0),
    );
    scene.add(nameplate);
    // Invisible hitbox over the whole rack — only for FREE racks so that
    // click → register-repo modal. Occupied racks open a future repo-detail
    // modal eventually (TODO); for now only FREE is wired.
    if (!occupied) {
      const hbGeo = isX
        ? new rt.THREE.BoxGeometry(rackW + 0.05, rackH + 0.2, rackD + 0.2)
        : new rt.THREE.BoxGeometry(rackD + 0.2, rackH + 0.2, rackW + 0.05);
      const hb = new rt.THREE.Mesh(hbGeo, new rt.THREE.MeshBasicMaterial({ visible: false }));
      hb.position.set(rx, rackBaseY + rackH / 2 + 0.05, rz);
      hb.userData.isFreeRepoRack = true;
      hb.userData.rackIndex = i;
      scene.add(hb);
      freeRackHitboxes.push(hb);
    }
    // Nameplate over each OCCUPIED rack: repo name + branch, click → that repo.
    // Free racks carry no label of their own (a dozen "FREE" tags stacked into
    // an unreadable staircase); one chip for the whole free run goes below.
    if (occupied && rt.CSS2DObject) {
      const labelDiv = document.createElement('div');
      const nm = repo!.name.toUpperCase();
      labelDiv.innerHTML = `${esc(nm.length > 14 ? nm.slice(0, 13) + '…' : nm)}`
        + (repo!.default_branch ? `<span style="color:#4cff7a;font-weight:600;margin-left:5px">${esc(repo!.default_branch)}</span>` : '');
      labelDiv.style.cssText = `font:700 9px 'Syne',sans-serif;color:#ffb84a;letter-spacing:1.5px;
           text-shadow:0 0 6px #ffb84a80;background:rgba(0,0,8,0.82);
           padding:2px 7px;border-radius:2px;border:1px solid #ffb84a55;
           pointer-events:none;white-space:nowrap;`;
      if (actions.openRepo) {
        const r = repo!;
        makeClickable(labelDiv, `Open repo ${r.name}${r.path ? ` · ${r.path}` : ''}`, () => actions.openRepo!(r));
      } else {
        labelDiv.title = `${repo!.name} · ${repo!.path ?? ''}`;
      }
      const lbl = new rt.CSS2DObject(labelDiv);
      lbl.position.set(
        rx + (isX ? 0 : -farWall.nx * 0.05),
        rackBaseY + rackH + 0.18,
        rz + (isX ? -farWall.nz * 0.05 : 0),
      );
      scene.add(lbl);
    }
  }

  // Unit vector along the rack row, and the room-facing normal of the far wall.
  const rowAxis = isX ? { x: 1, z: 0 } : { x: 0, z: 1 };
  const farN = { x: farWall.nx, z: farWall.nz };
  const rowPoint = (along: number, out: number, y: number) => new rt.THREE.Vector3(
    farWall.midX + rowAxis.x * along + farN.x * out, y, farWall.midZ + rowAxis.z * along + farN.z * out,
  );

  // One chip for the whole run of free racks: "+N free racks · register".
  const freeCount = rackCount - Math.min(repos.length, rackCount);
  if (freeCount > 0 && rt.CSS2DObject) {
    const firstFree = rackCount - freeCount;
    const midOff = -rackTotalW / 2 + ((firstFree + rackCount) / 2) * rackW;
    const chip = document.createElement('div');
    chip.innerHTML = `<span style="color:#4cff7a">＋</span> ${freeCount} FREE RACK${freeCount === 1 ? '' : 'S'}`
      + (actions.registerRepo ? ` <span style="color:#7a8396">· register a repo</span>` : '');
    chip.style.cssText = `font:700 9px 'Syne',sans-serif;color:#c8ccd6;letter-spacing:1.5px;
      background:rgba(0,0,8,0.78);padding:3px 9px;border-radius:2px;border:1px dashed #4cff7a55;
      pointer-events:none;white-space:nowrap;`;
    if (actions.registerRepo) makeClickable(chip, 'Register a repo in a free rack', actions.registerRepo);
    const chipObj = new rt.CSS2DObject(chip);
    chipObj.position.copy(rowPoint(midOff, rackD / 2, rackBaseY + rackH + 0.2));
    scene.add(chipObj);
  }

  // ── 1b. COLD AISLE — perforated raised-floor tiles + hazard line ──
  // Canvas textures, built once per office: a perforated tile grid in front of
  // the racks and a yellow/black stripe marking the edge of the rack zone.
  const aisleDepth = 1.1;
  {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    if (g) {
      g.fillStyle = '#2b3140'; g.fillRect(0, 0, 64, 64);
      g.strokeStyle = '#151922'; g.lineWidth = 2; g.strokeRect(1, 1, 62, 62);
      g.fillStyle = '#121620';
      for (let yy = 8; yy < 60; yy += 7) for (let xx = 8; xx < 60; xx += 7) g.fillRect(xx, yy, 3, 3);
    }
    const tex = new rt.THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = rt.THREE.RepeatWrapping;
    tex.repeat.set(Math.round(rackTotalW / 0.6), Math.round(aisleDepth / 0.6) || 1);
    const tiles = new rt.THREE.Mesh(
      new rt.THREE.PlaneGeometry(rackTotalW, aisleDepth),
      new rt.THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0.3 }),
    );
    tiles.rotation.x = -Math.PI / 2;
    if (!isX) tiles.rotation.z = Math.PI / 2;
    tiles.position.copy(rowPoint(0, rackD + 0.2 + aisleDepth / 2, 0.035));
    tiles.receiveShadow = true;
    scene.add(tiles);
  }
  {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 8;
    const g = c.getContext('2d');
    if (g) {
      g.fillStyle = '#f2c230'; g.fillRect(0, 0, 64, 8);
      g.fillStyle = '#111';
      for (let k = -8; k < 64; k += 16) { g.beginPath(); g.moveTo(k, 8); g.lineTo(k + 8, 0); g.lineTo(k + 16, 0); g.lineTo(k + 8, 8); g.fill(); }
    }
    const tex = new rt.THREE.CanvasTexture(c);
    tex.wrapS = rt.THREE.RepeatWrapping;
    tex.repeat.set(Math.round(rackTotalW / 0.5), 1);
    const stripeLine = new rt.THREE.Mesh(
      new rt.THREE.PlaneGeometry(rackTotalW + 0.6, 0.08),
      new rt.THREE.MeshBasicMaterial({ map: tex }),
    );
    stripeLine.rotation.x = -Math.PI / 2;
    if (!isX) stripeLine.rotation.z = Math.PI / 2;
    stripeLine.position.copy(rowPoint(0, rackD + 0.2 + aisleDepth + 0.05, 0.037));
    scene.add(stripeLine);
  }

  // ── 1c. OVERHEAD CABLE LADDER above the rack fronts ─────────────
  // Two rails + rungs, with a bundle of patch cables dropping into each
  // occupied rack — the rack row stops reading as a row of black boxes.
  {
    const ladderY = rackBaseY + rackH + 0.28;
    const ladderOut = rackD * 0.55;
    for (const edge of [-0.18, 0.18]) {
      const rail = new rt.THREE.Mesh(
        isX ? new rt.THREE.BoxGeometry(rackTotalW + 0.4, 0.05, 0.04) : new rt.THREE.BoxGeometry(0.04, 0.05, rackTotalW + 0.4),
        conduitMat,
      );
      rail.position.copy(rowPoint(0, ladderOut + edge, ladderY));
      scene.add(rail);
    }
    const rungGeo = isX ? new rt.THREE.BoxGeometry(0.03, 0.03, 0.36) : new rt.THREE.BoxGeometry(0.36, 0.03, 0.03);
    for (let off = -rackTotalW / 2; off <= rackTotalW / 2 + 1e-3; off += 0.4) {
      const rung = new rt.THREE.Mesh(rungGeo, conduitMat);
      rung.position.copy(rowPoint(off, ladderOut, ladderY - 0.01));
      scene.add(rung);
    }
    // Cable bundle resting on the ladder, the full length of the row.
    const bundle = new rt.THREE.Mesh(
      isX ? new rt.THREE.BoxGeometry(rackTotalW, 0.07, 0.22) : new rt.THREE.BoxGeometry(0.22, 0.07, rackTotalW),
      new rt.THREE.MeshStandardMaterial({ color: 0x2a5bd7, roughness: 0.7 }),
    );
    bundle.position.copy(rowPoint(0, ladderOut, ladderY + 0.05));
    scene.add(bundle);
    const dropColors = [0x2a5bd7, 0xffb84a, 0x4cff7a];
    const dropGeo = new rt.THREE.CylinderGeometry(0.025, 0.025, ladderY - (rackBaseY + rackH), 6);
    for (let i = 0; i < Math.min(repos.length, rackCount); i++) {
      const off = -rackTotalW / 2 + (i + 0.5) * rackW;
      for (let k = 0; k < 3; k++) {
        const drop = new rt.THREE.Mesh(dropGeo, new rt.THREE.MeshStandardMaterial({ color: dropColors[k], roughness: 0.6 }));
        drop.position.copy(rowPoint(off - 0.1 + k * 0.1, ladderOut, (ladderY + rackBaseY + rackH) / 2));
        scene.add(drop);
      }
    }
  }

  // ── 1d. CRAC COOLING UNIT at the end of the row away from the ops corner ──
  // Tall white precision-cooling cabinet with fan grilles and a small status
  // display. The ops corner (NOC desk + power console) sits on the
  // patch-panel wall, so the CRAC takes the opposite end of the row.
  const ppWallSign = (() => {
    const pw = WALLS[sideWallIds[1]];
    const dot = (pw.midX - cx) * rowAxis.x + (pw.midZ - cz) * rowAxis.z;
    return dot >= 0 ? 1 : -1;
  })();
  {
    const cracAlong = -ppWallSign * (rackTotalW / 2 + 1.1);
    const cracPos = rowPoint(cracAlong, 0.45, 1.0);
    const crac = new rt.THREE.Group();
    crac.position.copy(cracPos);
    crac.rotation.y = Math.atan2(farN.x, farN.z); // local +Z faces into the room
    const shellMat = new rt.THREE.MeshStandardMaterial({ color: 0xdfe3ea, roughness: 0.55, metalness: 0.2 });
    applyPBR(shellMat, 'plastic');
    const shell = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(1.4, 2.0, 0.8), shellMat);
    shell.castShadow = true;
    crac.add(shell);
    const grilleMat = new rt.THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.6, metalness: 0.5 });
    for (const fy of [0.45, -0.25]) {
      const ring = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.26, 0.26, 0.03, 20), grilleMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(0, fy, 0.41);
      crac.add(ring);
      for (let s = 0; s < 3; s++) {
        const blade = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.44, 0.03, 0.01), ventDark);
        blade.rotation.z = (s / 3) * Math.PI;
        blade.position.set(0, fy, 0.43);
        crac.add(blade);
      }
    }
    const lcd = new rt.THREE.Mesh(new rt.THREE.PlaneGeometry(0.34, 0.14),
      new rt.THREE.MeshStandardMaterial({ color: 0x001018, emissive: new rt.THREE.Color(0x2ad6ff), emissiveIntensity: 0.9 }));
    lcd.position.set(0.38, 0.85, 0.405);
    crac.add(lcd);
    scene.add(crac);
  }

  // ── 2. CRT TERMINAL CLUSTER on the side wall ───────────────────
  // 3 chunky beige CRT terminals on a long desk, with greenish phosphor
  // emissive screens. Reads as a VT100/IBM 3270 row.
  const tIsX = terminalWall.id === 'top' || terminalWall.id === 'bottom';
  const termWallLen = tIsX ? w : d;
  const deskLen = Math.min(termWallLen - 1.6, 5.0);
  const deskDepth = 0.7;
  const deskTopY = 0.78;
  const deskGeo = tIsX
    ? new rt.THREE.BoxGeometry(deskLen, 0.06, deskDepth)
    : new rt.THREE.BoxGeometry(deskDepth, 0.06, deskLen);
  const desk = new rt.THREE.Mesh(deskGeo, new rt.THREE.MeshStandardMaterial({ color: 0x4a3a26, roughness: 0.55, metalness: 0.1 }));
  desk.position.set(
    terminalWall.midX + terminalWall.nx * (deskDepth / 2 + 0.05),
    deskTopY,
    terminalWall.midZ + terminalWall.nz * (deskDepth / 2 + 0.05),
  );
  scene.add(desk);
  // Desk legs / kick panel
  const kickGeo = tIsX
    ? new rt.THREE.BoxGeometry(deskLen, deskTopY, 0.05)
    : new rt.THREE.BoxGeometry(0.05, deskTopY, deskLen);
  const kick = new rt.THREE.Mesh(kickGeo, new rt.THREE.MeshStandardMaterial({ color: 0x2c2218, roughness: 0.75 }));
  kick.position.set(
    terminalWall.midX + terminalWall.nx * (deskDepth - 0.05),
    deskTopY / 2,
    terminalWall.midZ + terminalWall.nz * (deskDepth - 0.05),
  );
  scene.add(kick);
  const termCount = 3;
  const termSpacing = deskLen / (termCount + 1);
  for (let i = 0; i < termCount; i++) {
    const off = -deskLen / 2 + (i + 1) * termSpacing;
    const tx = terminalWall.midX + (tIsX ? off : terminalWall.nx * (deskDepth / 2 + 0.05));
    const tz = terminalWall.midZ + (tIsX ? terminalWall.nz * (deskDepth / 2 + 0.05) : off);
    // Beige chassis (chunky cube, rounded look would need more verts — skip)
    const body = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.78, 0.62, 0.7), beigeMat);
    body.position.set(tx, deskTopY + 0.04 + 0.31, tz);
    body.rotation.y = terminalWall.faceY;
    scene.add(body);
    // Black bezel screen (slightly inset)
    const bezelMat = new rt.THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.4 });
    applyPBR(bezelMat, 'plastic'); // CRT black screen bezel — plastic
    const bezel = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.62, 0.46, 0.06), bezelMat);
    // Position bezel on the FRONT face of the body (toward room centre)
    bezel.position.set(tx + terminalWall.nx * 0.36, deskTopY + 0.36, tz + terminalWall.nz * 0.36);
    bezel.rotation.y = terminalWall.faceY;
    scene.add(bezel);
    // Phosphor screen
    const screen = new rt.THREE.Mesh(new rt.THREE.PlaneGeometry(0.5, 0.36), phosphor);
    screen.position.set(tx + terminalWall.nx * 0.39, deskTopY + 0.36, tz + terminalWall.nz * 0.39);
    screen.rotation.y = terminalWall.faceY;
    scene.add(screen);
    // A few amber LEDs in the chassis "logo" area below the screen
    for (let li = 0; li < 3; li++) {
      const led = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.03, 0.03, 0.02), labelAmber);
      const ledOff = -0.18 + li * 0.18;
      led.position.set(
        tx + terminalWall.nx * 0.38 + (tIsX ? ledOff : 0),
        deskTopY + 0.12,
        tz + terminalWall.nz * 0.38 + (tIsX ? 0 : ledOff),
      );
      led.rotation.y = terminalWall.faceY;
      scene.add(led);
    }
    // Detached keyboard on the desk in front of each terminal
    const kb = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(0.55, 0.04, 0.18),
      new rt.THREE.MeshStandardMaterial({ color: 0xd8c8a4, roughness: 0.8 }),
    );
    kb.position.set(tx + terminalWall.nx * 0.06, deskTopY + 0.06, tz + terminalWall.nz * 0.06);
    kb.rotation.y = terminalWall.faceY;
    scene.add(kb);
  }

  // ── 3. MAINFRAME CONSOLE in a door-side corner ─────────────────
  // Low chunky cabinet with a panel of toggles and a tilted control surface.
  const doorWall = WALLS[dd];
  const otherSide = WALLS[sideWallIds[1]];
  const consoleX = (doorWall.id === 'left' || doorWall.id === 'right')
    ? doorWall.midX + doorWall.nx * 1.5
    : otherSide.midX + otherSide.nx * 1.2;
  const consoleZ = (doorWall.id === 'top' || doorWall.id === 'bottom')
    ? doorWall.midZ + doorWall.nz * 1.5
    : otherSide.midZ + otherSide.nz * 1.2;
  const consoleBody = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(1.4, 1.0, 0.7), chassis);
  consoleBody.position.set(consoleX, 0.5, consoleZ);
  scene.add(consoleBody);
  // Tilted control surface on top
  const panelMat = new rt.THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.5, metalness: 0.35 });
  applyPBR(panelMat, 'metal'); // mainframe console control surface — metal
  const panel = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(1.35, 0.04, 0.6), panelMat);
  panel.position.set(consoleX, 1.05, consoleZ);
  panel.rotation.x = -0.35; // tilted toward the operator
  scene.add(panel);
  // Toggle row (silver dots)
  const toggleMat = new rt.THREE.MeshStandardMaterial({ color: 0xd0d4dc, roughness: 0.3, metalness: 0.7 });
  applyPBR(toggleMat, 'metal'); // silver console toggles — metal
  for (let i = 0; i < 8; i++) {
    const t = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.06, 0.06, 0.04), toggleMat);
    t.position.set(consoleX - 0.5 + i * 0.14, 1.13, consoleZ - 0.12);
    t.rotation.x = -0.35;
    scene.add(t);
  }
  // LED row on the panel (alternating green / amber)
  for (let i = 0; i < 10; i++) {
    const led = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.05, 0.05, 0.02), i % 3 === 0 ? labelAmber : labelGreen);
    led.position.set(consoleX - 0.55 + i * 0.12, 1.12, consoleZ + 0.05);
    led.rotation.x = -0.35;
    scene.add(led);
  }
  // Big red panic switch on the front face
  const panic = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.08, 0.08, 0.04, 12), new rt.THREE.MeshStandardMaterial({ color: 0xff2a1a, emissive: new rt.THREE.Color(0xff4a2a), emissiveIntensity: 0.4 }));
  panic.rotation.x = Math.PI / 2;
  panic.position.set(consoleX + 0.5, 0.5, consoleZ + 0.36);
  scene.add(panic);

  // ── 4. TAPE-REEL CABINET in the OTHER door-side corner ─────────
  const tapeX = (doorWall.id === 'left' || doorWall.id === 'right')
    ? doorWall.midX + doorWall.nx * 1.5
    : terminalWall.midX + terminalWall.nx * 1.4;
  const tapeZ = (doorWall.id === 'top' || doorWall.id === 'bottom')
    ? doorWall.midZ + doorWall.nz * 1.5
    : terminalWall.midZ + terminalWall.nz * 1.4;
  const tapeFarEnough = (tapeX - consoleX) ** 2 + (tapeZ - consoleZ) ** 2 > 4.5;
  if (tapeFarEnough) {
    const tapeCab = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(1.0, 1.7, 0.5), chassis);
    tapeCab.position.set(tapeX, 0.85, tapeZ);
    scene.add(tapeCab);
    // Tilted glass-ish viewing window (just a darker insert)
    const viewport = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.88, 0.95, 0.03), new rt.THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 0.25, metalness: 0.2 }));
    viewport.position.set(tapeX, 1.15, tapeZ + 0.26);
    scene.add(viewport);
    // Two big tape reels behind the window — flat discs with a silver hub
    for (const side of [-0.2, 0.2]) {
      const reel = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.28, 0.28, 0.04, 24), reelTapeMat);
      reel.rotation.x = Math.PI / 2;
      reel.position.set(tapeX + side, 1.3, tapeZ + 0.21);
      scene.add(reel);
      const hub = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.07, 0.07, 0.05, 16), reelHubMat);
      hub.rotation.x = Math.PI / 2;
      hub.position.set(tapeX + side, 1.3, tapeZ + 0.215);
      scene.add(hub);
      // Three spoke marks on each reel (small dark dots) — gives a sense of motion when light grazes them.
      for (let s = 0; s < 3; s++) {
        const ang = (s / 3) * Math.PI * 2;
        const spoke = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.18, 0.025, 0.005), new rt.THREE.MeshStandardMaterial({ color: 0x303338, roughness: 0.6 }));
        spoke.rotation.z = ang;
        spoke.position.set(tapeX + side + Math.cos(ang) * 0.0, 1.3 + Math.sin(ang) * 0.0, tapeZ + 0.218);
        scene.add(spoke);
      }
    }
    // Status LED strip below the window
    for (let i = 0; i < 6; i++) {
      const led = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.05, 0.05, 0.02), i % 2 === 0 ? labelGreen : labelAmber);
      led.position.set(tapeX - 0.3 + i * 0.12, 0.78, tapeZ + 0.26);
      scene.add(led);
    }
    // Cabinet base — slightly wider, dark
    const tBase = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(1.1, 0.06, 0.6), ventDark);
    tBase.position.set(tapeX, 0.03, tapeZ);
    scene.add(tBase);
  }

  // ── 5. UPS / BATTERY CABINET next to the mainframe console ─────
  // Big square cabinet with a top vent, status panel and big chunky red
  // power button. Sits flush to the console.
  // Step away from the side wall the console backs onto (toward the room),
  // not a fixed +1.55: with the console in a corner that pushed the UPS
  // halfway through the wall.
  const upsX = consoleX + (doorWall.id === 'left' || doorWall.id === 'right' ? 0 : otherSide.nx * 1.55);
  const upsZ = consoleZ + (doorWall.id === 'top' || doorWall.id === 'bottom' ? 0 : otherSide.nz * 1.55);
  const upsBody = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.85, 1.5, 0.6), chassis);
  upsBody.position.set(upsX, 0.75, upsZ);
  scene.add(upsBody);
  // Top vent grill
  const upsVent = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.78, 0.03, 0.55), ventDark);
  upsVent.position.set(upsX, 1.52, upsZ);
  scene.add(upsVent);
  // 6-bar load meter on the front (alternating green/amber, last red)
  for (let i = 0; i < 6; i++) {
    const bar = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(0.08, 0.05, 0.02),
      i >= 5 ? labelRed : (i >= 3 ? labelAmber : labelGreen),
    );
    bar.position.set(upsX - 0.3 + i * 0.12, 1.15, upsZ + 0.31);
    scene.add(bar);
  }
  // Chunky red power button
  const upsBtn = new rt.THREE.Mesh(
    new rt.THREE.CylinderGeometry(0.07, 0.07, 0.04, 12),
    new rt.THREE.MeshStandardMaterial({ color: 0xb01a0a, emissive: new rt.THREE.Color(0xff2a1a), emissiveIntensity: 0.3 }),
  );
  upsBtn.rotation.x = Math.PI / 2;
  upsBtn.position.set(upsX + 0.25, 0.7, upsZ + 0.31);
  scene.add(upsBtn);
  // "UPS / BATTERY" label
  if (rt.CSS2DObject) {
    const lDiv = document.createElement('div');
    lDiv.textContent = 'UPS';
    lDiv.style.cssText = `font:700 9px 'Syne',sans-serif;color:#ffb84a;letter-spacing:2px;
      text-shadow:0 0 4px #ffb84a80;background:rgba(0,0,0,0.6);padding:1px 4px;
      pointer-events:none;`;
    const lbl = new rt.CSS2DObject(lDiv);
    lbl.position.set(upsX, 1.65, upsZ);
    scene.add(lbl);
  }

  // ── 6. PATCH PANEL on the wall next to the terminal desk ───────
  // A 3-row patch panel with little dotted ports + a tangle of patch
  // cables drooping into a cable tray below it.
  const ppWall = WALLS[sideWallIds[1]]; // wall opposite the terminal desk
  const ppIsX = ppWall.id === 'top' || ppWall.id === 'bottom';
  const ppWidth = 1.6, ppHeight = 0.45;
  const ppGeo = ppIsX
    ? new rt.THREE.BoxGeometry(ppWidth, ppHeight, 0.05)
    : new rt.THREE.BoxGeometry(0.05, ppHeight, ppWidth);
  const ppPanelMat = new rt.THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.5, metalness: 0.5 });
  applyPBR(ppPanelMat, 'metal'); // patch panel face — metal
  const ppPanel = new rt.THREE.Mesh(ppGeo, ppPanelMat);
  ppPanel.position.set(ppWall.midX, 1.85, ppWall.midZ);
  scene.add(ppPanel);
  // 3 rows × 16 ports
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 16; c++) {
      const portOff = -(ppWidth / 2) + 0.07 + c * ((ppWidth - 0.14) / 15);
      const portMat = new rt.THREE.MeshStandardMaterial({ color: 0x0a0b0e, emissive: new rt.THREE.Color(0x33ff66), emissiveIntensity: 0.15 });
      const port = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.04, 0.04, 0.02), portMat);
      port.position.set(
        ppWall.midX + (ppIsX ? portOff : ppWall.nx * 0.04),
        1.85 + (r - 1) * 0.11,
        ppWall.midZ + (ppIsX ? ppWall.nz * 0.04 : portOff),
      );
      scene.add(port);
    }
  }
  // 4 colourful patch cables drooping out of the panel
  const cableColors = [0xff4a3a, 0x4a8aff, 0x4cff7a, 0xffb84a];
  for (let i = 0; i < 4; i++) {
    const cableMat = new rt.THREE.MeshStandardMaterial({ color: cableColors[i], roughness: 0.6, metalness: 0.1 });
    const start = new rt.THREE.Vector3(
      ppWall.midX + (ppIsX ? -0.5 + i * 0.3 : ppWall.nx * 0.06),
      1.7,
      ppWall.midZ + (ppIsX ? ppWall.nz * 0.06 : -0.5 + i * 0.3),
    );
    const end = new rt.THREE.Vector3(
      start.x + (ppIsX ? 0 : ppWall.nx * 0.35),
      1.05,
      start.z + (ppIsX ? ppWall.nz * 0.35 : 0),
    );
    const mid = new rt.THREE.Vector3(
      (start.x + end.x) / 2 + (ppIsX ? 0 : ppWall.nx * 0.05),
      (start.y + end.y) / 2 - 0.12, // sag
      (start.z + end.z) / 2 + (ppIsX ? ppWall.nz * 0.05 : 0),
    );
    const curve = new rt.THREE.QuadraticBezierCurve3(start, mid, end);
    const cableGeo = new rt.THREE.TubeGeometry(curve, 12, 0.02, 6, false);
    const cable = new rt.THREE.Mesh(cableGeo, cableMat);
    scene.add(cable);
  }
  // Cable tray below the panel
  const trayGeo = ppIsX
    ? new rt.THREE.BoxGeometry(ppWidth + 0.1, 0.06, 0.18)
    : new rt.THREE.BoxGeometry(0.18, 0.06, ppWidth + 0.1);
  const tray = new rt.THREE.Mesh(trayGeo, conduitMat);
  tray.position.set(
    ppWall.midX + (ppIsX ? 0 : ppWall.nx * 0.09),
    1.0,
    ppWall.midZ + (ppIsX ? ppWall.nz * 0.09 : 0),
  );
  scene.add(tray);

  // ── 7. KVM SWITCH on the terminal desk + OPS CHAIR ─────────────
  // KVM box + tangled cables on the terminal desk surface (between the 3
  // CRTs). Looks like a chunky 2U box with toggle indicators.
  const kvmX = terminalWall.midX + terminalWall.nx * (deskDepth / 2 + 0.05);
  const kvmZ = terminalWall.midZ + terminalWall.nz * (deskDepth / 2 + 0.05);
  const kvmDir = tIsX ? 1 : 0; // place at the far end of the desk so it doesn't collide with terminals
  const kvmBodyMat = new rt.THREE.MeshStandardMaterial({ color: 0x202329, roughness: 0.4, metalness: 0.5 });
  applyPBR(kvmBodyMat, 'metal'); // KVM switch chassis — metal
  const kvmBody = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.5, 0.16, 0.4), kvmBodyMat);
  kvmBody.position.set(
    kvmX + (tIsX ? deskLen / 2 - 0.35 : 0),
    deskTopY + 0.13,
    kvmZ + (tIsX ? 0 : deskLen / 2 - 0.35),
  );
  scene.add(kvmBody);
  // 4 tiny LEDs (which active KVM channel)
  for (let i = 0; i < 4; i++) {
    const led = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.03, 0.03, 0.02), i === 1 ? labelGreen : labelAmber);
    led.position.set(
      kvmX + (tIsX ? deskLen / 2 - 0.55 + i * 0.07 : 0),
      deskTopY + 0.21,
      kvmZ + (tIsX ? 0 : deskLen / 2 - 0.55 + i * 0.07),
    );
    scene.add(led);
  }
  // Ops chair (5-spoke base, low back) parked at the desk centre
  const chairMat2 = new rt.THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.8 });
  const chairBaseY2 = 0.45;
  const chairOffset = terminalWall.nx * 0.6 + (tIsX ? 0 : 0);
  const chairOffsetZ = terminalWall.nz * 0.6;
  const chairX = terminalWall.midX + chairOffset + (terminalWall.nx === 0 ? 0 : 0);
  const chairZ = terminalWall.midZ + chairOffsetZ;
  // Seat
  const seat2 = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.27, 0.27, 0.06, 16), chairMat2);
  seat2.position.set(chairX, chairBaseY2, chairZ);
  scene.add(seat2);
  // Backrest
  const back2 = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.45, 0.5, 0.06), chairMat2);
  back2.position.set(
    chairX - terminalWall.nx * 0.22,
    chairBaseY2 + 0.28,
    chairZ - terminalWall.nz * 0.22,
  );
  back2.rotation.y = terminalWall.faceY;
  scene.add(back2);
  // Stem
  const stem2Mat = new rt.THREE.MeshStandardMaterial({ color: 0x303338, metalness: 0.7, roughness: 0.4 });
  applyPBR(stem2Mat, 'metal'); // ops-chair stem — metal
  const stem2 = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), stem2Mat);
  stem2.position.set(chairX, chairBaseY2 - 0.22, chairZ);
  scene.add(stem2);
  // 5-spoke base + casters
  for (let s = 0; s < 5; s++) {
    const ang = (s / 5) * Math.PI * 2;
    const spoke = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.28, 0.04, 0.06), new rt.THREE.MeshStandardMaterial({ color: 0x202329, roughness: 0.5, metalness: 0.5 }));
    spoke.position.set(chairX + Math.cos(ang) * 0.14, 0.04, chairZ + Math.sin(ang) * 0.14);
    spoke.rotation.y = ang;
    scene.add(spoke);
    const caster = new rt.THREE.Mesh(new rt.THREE.SphereGeometry(0.04, 8, 6), new rt.THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.6 }));
    caster.position.set(chairX + Math.cos(ang) * 0.27, 0.04, chairZ + Math.sin(ang) * 0.27);
    scene.add(caster);
  }

  // ── 8. PRINTOUT STACK on the floor next to the tape cabinet ────
  // Pile of pale-green continuous-feed printer paper — the kind with the
  // dotted side strips. Just two stacked boxes with a slight skew.
  if (tapeFarEnough) {
    const printX = tapeX + (doorWall.id === 'left' || doorWall.id === 'right' ? -0.7 : 0);
    const printZ = tapeZ + (doorWall.id === 'top' || doorWall.id === 'bottom' ? -0.7 : 0);
    const paperMat = new rt.THREE.MeshStandardMaterial({ color: 0xe5e3c8, roughness: 0.9 });
    for (let i = 0; i < 3; i++) {
      const stack = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.4, 0.07, 0.55), paperMat);
      stack.position.set(printX + (i - 1) * 0.02, 0.08 + i * 0.07, printZ + (i - 1) * 0.015);
      stack.rotation.y = (i - 1) * 0.05;
      scene.add(stack);
    }
    // Side perforation strip (faint dark band along one edge)
    const perfMat = new rt.THREE.MeshStandardMaterial({ color: 0xc8c5a5, roughness: 0.95 });
    const perf = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.04, 0.22, 0.55), perfMat);
    perf.position.set(printX - 0.2, 0.18, printZ);
    scene.add(perf);
  }

  // ── 9. WALL "DIRECTORY" PANEL — backlit list of all registered repos ──
  // Anchored INSIDE the room on the side wall that holds the patch panel
  // (sideWallIds[1]) at chest+head height so it reads as a wall-mounted
  // print-out, NOT as a second title competing with the room's door sign.
  // Header trimmed to "DIRECTORY" (no "REPOS" prefix) for the same reason —
  // the door sign already shouts "REPOS OFFICE" loud enough.
  if (rt.CSS2DObject) {
    // Every line is a way in: header → the registry, a row → that repo,
    // footer → register one more. Built as DOM nodes (not one innerHTML blob)
    // so each row carries its own handler.
    const MAX_ROWS = 8;
    const dirDiv = document.createElement('div');
    dirDiv.style.cssText = `background:rgba(0,0,8,0.85);padding:6px 10px;border-radius:3px;
      border:1px solid #ffb84a35;box-shadow:0 0 14px #ffb84a20, inset 0 0 5px #1a1410;
      min-width:160px;max-width:240px;pointer-events:none;
      font:600 9px 'IBM Plex Mono',monospace;color:#c8b48a;line-height:1.5;letter-spacing:0.5px;`;
    const head = document.createElement('div');
    head.innerHTML = `DIRECTORY <span style="color:#7a7a7a;letter-spacing:1px">· ${repos.length} repo${repos.length === 1 ? '' : 's'}</span>`
      + (actions.openRepos ? ` <span class="dc-go" style="opacity:.7">›</span>` : '');
    head.style.cssText = `font:700 9px 'Syne',sans-serif;color:#ffb84a;letter-spacing:2.5px;
      text-shadow:0 0 6px #ffb84a80;border-bottom:1px solid #ffb84a30;
      padding-bottom:2px;margin-bottom:4px;text-align:center;`;
    if (actions.openRepos) makeClickable(head, 'Open the repo registry', actions.openRepos);
    dirDiv.appendChild(head);
    if (repos.length === 0) {
      const empty = document.createElement('div');
      empty.innerHTML = '<em style="color:#5a5a5a">(empty registry)</em>';
      dirDiv.appendChild(empty);
    }
    for (const r of repos.slice(0, MAX_ROWS)) {
      const row = document.createElement('div');
      const br = r.default_branch ? `<span style="color:#4cff7a">[${esc(r.default_branch)}]</span>` : '';
      const lang = r.language ? `<span style="color:#7a7a7a">${esc(r.language)}</span>` : '';
      row.innerHTML = `<span style="color:#ffb84a">${esc(r.name)}</span>${br}${lang}`
        + (actions.openRepo ? `<span class="dc-go">›</span>` : '');
      if (actions.openRepo) {
        row.className = 'dc-row';
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.title = `Open ${r.name}${r.path ? ` · ${r.path}` : ''}`;
        const go = () => actions.openRepo!(r);
        row.addEventListener('pointerdown', (e) => e.stopPropagation());
        row.addEventListener('click', (e) => { e.stopPropagation(); go(); });
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      } else {
        row.style.cssText = 'display:flex;gap:6px;white-space:nowrap;';
      }
      dirDiv.appendChild(row);
    }
    if (repos.length > MAX_ROWS) {
      const more = document.createElement('div');
      more.innerHTML = `<span style="color:#7a7a7a">…+${repos.length - MAX_ROWS} more</span>`;
      if (actions.openRepos) makeClickable(more, 'See every registered repo', actions.openRepos);
      dirDiv.appendChild(more);
    }
    if (actions.registerRepo) {
      const add = document.createElement('div');
      add.innerHTML = '<span style="color:#4cff7a">＋</span> register a repo';
      add.style.cssText = 'margin-top:4px;padding-top:3px;border-top:1px dashed #ffb84a25;color:#9aa3b5;';
      makeClickable(add, 'Register a repo', actions.registerRepo);
      dirDiv.appendChild(add);
    }
    const dirLbl = new rt.CSS2DObject(dirDiv);
    // Head-height, pushed slightly INSIDE the room so it attaches to the
    // inside wall face, above the CRT terminal desk: the patch-panel wall now holds the ops
    // corner (NOC desk + power console) and its readout would sit on top.
    dirLbl.position.set(
      terminalWall.midX + terminalWall.nx * 0.15,
      WALL_H * 0.72,
      terminalWall.midZ + terminalWall.nz * 0.15,
    );
    scene.add(dirLbl);
  }

  // ── 11. SIGNAGE LIGHTBOX above the rack row ────────────────────
  // A glowing amber strip ABOVE the racks — the kind of "AUTHORIZED PERSONNEL"
  // backlit sign you'd see in a 70s ops centre. Uses the flow accent colour
  // so different repos offices (if the user clones the office later) can be
  // distinguished from across the corridor.
  const signGeo = isX
    ? new rt.THREE.BoxGeometry(Math.min(2.4, rackTotalW * 0.6), 0.32, 0.05)
    : new rt.THREE.BoxGeometry(0.05, 0.32, Math.min(2.4, rackTotalW * 0.6));
  const signMat = new rt.THREE.MeshStandardMaterial({
    color: 0x0a0d18, emissive: accent.clone().multiplyScalar(0.85), emissiveIntensity: 0.7, roughness: 0.25,
  });
  applyPBR(signMat, 'trim'); // backlit signage lightbox — emissive accent trim
  const sign = new rt.THREE.Mesh(signGeo, signMat);
  sign.position.set(
    farWall.midX + farWall.nx * 0.05,
    rackBaseY + rackH + 0.45,
    farWall.midZ + farWall.nz * 0.05,
  );
  scene.add(sign);

  // ── 12. ACCENT WASH — magnetic green-tinted floor light ───────
  // Lower intensity than buildCommunicationsOffice — racks already glow.
  const accentLight = new rt.THREE.PointLight(accent.getHex(), 0.8, Math.max(w, d) * 1.1);
  accentLight.position.set(cx, WALL_H - 0.6, cz);
  accentLight.decay = 2;
  accentLight.matrixAutoUpdate = false; accentLight.updateMatrix();
  scene.add(accentLight);
  // Floor wash — a soft greenish disc near the rack row so the racks pick up
  // a hint of ground glow even when bloom is off.
  const wash = new rt.THREE.Mesh(
    new rt.THREE.CircleGeometry(Math.max(w, d) * 0.35, 24),
    new rt.THREE.MeshBasicMaterial({ color: 0x33ff66, transparent: true, opacity: 0.04, side: 2 }),
  );
  wash.rotation.x = -Math.PI / 2;
  wash.position.set(cx, 0.03, cz);
  scene.add(wash);

  // ── 13. OPS CORNER — NOC desk (→ /devops) + power console spot ──
  // Both live on the patch-panel wall, out of the desk grid: the NOC desk
  // toward the rack row, the master power console (infra-power.ts) toward the
  // door. The NOC desk is the in-world way into the DevOps control panel.
  const opsWall = WALLS[sideWallIds[1]];
  const opsN = { x: opsWall.nx, z: opsWall.nz };
  const toFar = { x: -farN.x, z: -farN.z };
  const opsAlongLen = (opsWall.id === 'top' || opsWall.id === 'bottom') ? w : d;
  const nocAlong = opsAlongLen / 2 - 3.0;
  const dvx = opsWall.midX + opsN.x * 1.15 + toFar.x * nocAlong;
  const dvz = opsWall.midZ + opsN.z * 1.15 + toFar.z * nocAlong;
  const noc = new rt.THREE.Group();
  noc.position.set(dvx, 0, dvz);
  noc.rotation.y = Math.atan2(opsN.x, opsN.z); // local +Z faces into the room
  const dvDeskMat = new rt.THREE.MeshStandardMaterial({ color: 0x1b2233, roughness: 0.7, metalness: 0.3 });
  applyPBR(dvDeskMat, 'metal');
  const dvDesk = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(2.1, 0.06, 0.85), dvDeskMat);
  dvDesk.position.set(0, 0.76, 0);
  dvDesk.castShadow = true; dvDesk.receiveShadow = true;
  noc.add(dvDesk);
  // Front edge glow strip in the office accent.
  const edge = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(2.1, 0.02, 0.02),
    new rt.THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(1.2) }));
  edge.position.set(0, 0.74, 0.43);
  noc.add(edge);
  for (const lx of [-0.98, 0.98]) {
    const side = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.06, 0.74, 0.78), dvDeskMat);
    side.position.set(lx, 0.37, 0);
    noc.add(side);
  }
  // Monitor screens: a small dashboard drawn once on a canvas — status
  // header, a latency sparkline and a row of build bars.
  const screenTex = (() => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 72;
    const g = c.getContext('2d');
    if (g) {
      g.fillStyle = '#060a14'; g.fillRect(0, 0, 128, 72);
      g.fillStyle = '#' + accent.getHexString(); g.fillRect(0, 0, 128, 9);
      g.fillStyle = '#0b1222'; g.fillRect(4, 13, 120, 30);
      g.strokeStyle = '#4cff7a'; g.lineWidth = 1.5; g.beginPath();
      for (let k = 0; k <= 24; k++) {
        const yy = 32 - Math.sin(k * 0.7) * 7 - (hash(k, 3) % 6);
        if (k === 0) g.moveTo(6 + k * 4.8, yy); else g.lineTo(6 + k * 4.8, yy);
      }
      g.stroke();
      for (let k = 0; k < 12; k++) {
        const hgt = 6 + (hash(k, 9) % 18);
        g.fillStyle = k === 7 ? '#ff4a3a' : (k % 4 === 0 ? '#ffb84a' : '#2a8cff');
        g.fillRect(6 + k * 10, 68 - hgt, 7, hgt);
      }
    }
    return new rt.THREE.CanvasTexture(c);
  })();
  const bezelMat2 = new rt.THREE.MeshStandardMaterial({ color: 0x0a0d16, roughness: 0.5 });
  const screenMat = new rt.THREE.MeshBasicMaterial({ map: screenTex });
  for (const [mx, rotY] of [[-0.68, 0.32], [0, 0], [0.68, -0.32]] as const) {
    const mon = new rt.THREE.Group();
    mon.position.set(mx, 1.2, -0.22 + Math.abs(mx) * 0.12);
    mon.rotation.y = rotY;
    const bz = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.66, 0.42, 0.04), bezelMat2);
    mon.add(bz);
    const sc = new rt.THREE.Mesh(new rt.THREE.PlaneGeometry(0.6, 0.36), screenMat);
    sc.position.z = 0.021;
    mon.add(sc);
    const st = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.05, 0.22, 0.05), dvDeskMat);
    st.position.set(0, -0.3, -0.03);
    mon.add(st);
    noc.add(mon);
  }
  // Keyboard, mouse, mug.
  const kb2 = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.5, 0.025, 0.16),
    new rt.THREE.MeshStandardMaterial({ color: 0x23293a, roughness: 0.6 }));
  kb2.position.set(0, 0.8, 0.18);
  noc.add(kb2);
  const mouse = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.06, 0.025, 0.1),
    new rt.THREE.MeshStandardMaterial({ color: 0x23293a, roughness: 0.6 }));
  mouse.position.set(0.36, 0.8, 0.2);
  noc.add(mouse);
  const mug = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.045, 0.04, 0.1, 12),
    new rt.THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.4 }));
  mug.position.set(-0.75, 0.84, 0.2);
  noc.add(mug);
  // Operator chair, pulled out a little.
  const nocChair = new rt.THREE.Group();
  nocChair.position.set(0.1, 0, 0.8);
  const ncMat = new rt.THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.8 });
  const ncSeat = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.48, 0.07, 0.46), ncMat);
  ncSeat.position.y = 0.46;
  nocChair.add(ncSeat);
  const ncBack = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.46, 0.55, 0.06), ncMat);
  ncBack.position.set(0, 0.78, 0.22);
  nocChair.add(ncBack);
  const ncStem = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.03, 0.03, 0.42, 8), stem2Mat);
  ncStem.position.y = 0.22;
  nocChair.add(ncStem);
  noc.add(nocChair);
  scene.add(noc);
  const dvGlow = new rt.THREE.PointLight(accent, 1.4, 3.5);
  dvGlow.position.set(dvx + opsN.x * 0.6, 1.4, dvz + opsN.z * 0.6);
  scene.add(dvGlow);
  // Invisible hitbox over the whole workstation → click routes to /devops.
  const dvTerm = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(2.2, 1.7, 1.0), new rt.THREE.MeshBasicMaterial({ visible: false }));
  dvTerm.position.set(0, 0.85, 0);
  dvTerm.userData.isDevopsTerminal = true;
  noc.add(dvTerm);
  // Title + action depend on whether the DevOps panel exists: with the
  // extension it's the way into /devops, without it the desk shows the
  // power grid — something real either way, never a dead link.
  const nocAction = actions.openDevops ?? actions.openPowerGrid;
  dvTerm.userData.nocAction = nocAction;
  if (rt.CSS2DObject) {
    const dvEl = document.createElement('div');
    const [nocTitle, nocSub, nocAria] = actions.openDevops
      ? ['⌘ DEVOPS CONSOLE', 'deploys · containers · logs', 'Open the DevOps control panel']
      : ['⌘ OPS CONSOLE', 'power grid of every office', 'Show / hide the power grid of every office'];
    dvEl.innerHTML = `<div style="font:700 10px 'Syne',sans-serif;letter-spacing:2px;color:#fff">${nocTitle}</div>`
      + `<div style="font:600 8px 'IBM Plex Mono',monospace;color:#aab4d4;letter-spacing:.5px;margin-top:1px">`
      + `${nocSub}${nocAction ? ' <span style="color:#fff">›</span>' : ''}</div>`;
    dvEl.style.cssText = `background:linear-gradient(180deg,#${accent.getHexString()}e6,rgba(10,13,24,.92));
      padding:4px 10px 5px;border-radius:3px;border:1px solid #${accent.getHexString()};
      box-shadow:0 0 12px #${accent.getHexString()}66;white-space:nowrap;text-align:center;pointer-events:none;`;
    if (nocAction) makeClickable(dvEl, nocAria, nocAction);
    const dvLbl = new rt.CSS2DObject(dvEl);
    dvLbl.position.set(dvx, 1.95, dvz);
    scene.add(dvLbl);
  }

  // Power console spot — same wall, toward the door, in front of the patch
  // panel's neighbour. Pulled 1.7 off the wall so its operator stands clear.
  const powerConsoleSpot = {
    x: opsWall.midX + opsN.x * 1.7 - toFar.x * 2.6,
    z: opsWall.midZ + opsN.z * 1.7 - toFar.z * 2.6,
    face: opsN,
  };

  // ── 14. FIRE EXTINGUISHER beside the door ───────────────────────
  {
    const dN = { x: doorWall.nx, z: doorWall.nz };
    const ex = doorWall.midX + dN.x * 0.2 - rowAxis.x * ppWallSign * 2.3;
    const ez = doorWall.midZ + dN.z * 0.2 - rowAxis.z * ppWallSign * 2.3;
    const redMat = new rt.THREE.MeshStandardMaterial({ color: 0xc81e1e, roughness: 0.35, metalness: 0.3 });
    const body = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.1, 0.1, 0.5, 14), redMat);
    body.position.set(ex, 0.55, ez);
    scene.add(body);
    const valve = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.035, 0.05, 0.1, 10),
      new rt.THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.6 }));
    valve.position.set(ex, 0.85, ez);
    scene.add(valve);
    const sign = new rt.THREE.Mesh(new rt.THREE.PlaneGeometry(0.22, 0.22),
      new rt.THREE.MeshStandardMaterial({ color: 0xd42020, emissive: new rt.THREE.Color(0x601010), emissiveIntensity: 0.6 }));
    sign.position.set(ex - dN.x * 0.17, 1.35, ez - dN.z * 0.17);
    sign.rotation.y = Math.atan2(dN.x, dN.z);
    scene.add(sign);
  }

  return { freeRackHitboxes, devopsTerminalHitbox: dvTerm, powerConsoleSpot };
}
