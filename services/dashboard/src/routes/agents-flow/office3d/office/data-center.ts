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
  /** Invisible hitbox over the DevOps workstation (desk + monitor). Tagged with
   *  `userData.isDevopsTerminal`. Caller pushes it into the raycaster targets so
   *  click navigates to the DevOps control panel (/devops). */
  devopsTerminalHitbox: any;
}

export function buildDataCenterOffice(scene: any, room: RoomInfo, repos: RepoBookmark[] = []): DataCenterHandles {
  const freeRackHitboxes: any[] = [];
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
          : ((h % 17 === 0) ? labelRed : ((h % 3 === 0) ? labelAmber : labelGreen));
        const led = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.05, 0.05, 0.02), tint);
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
    // CSS2D label floating above the rack. Click-through; the per-rack hitbox
    // (above) is what carries the action.
    if (rt.CSS2DObject) {
      const labelDiv = document.createElement('div');
      const txt = (repo?.name ?? 'FREE').toUpperCase().slice(0, 14);
      labelDiv.textContent = txt;
      labelDiv.title = occupied ? `${repo!.name} · ${repo!.path ?? ''}` : 'Free rack — register a repo with kernel_repos_register';
      labelDiv.style.cssText = occupied
        ? `font:700 9px 'Syne',sans-serif;color:#ffb84a;letter-spacing:1.5px;
           text-shadow:0 0 6px #ffb84a80;background:rgba(0,0,8,0.78);
           padding:2px 6px;border-radius:2px;border:1px solid #ffb84a40;
           pointer-events:none;white-space:nowrap;`
        : `font:600 8px 'Syne',sans-serif;color:#3a3a3a;letter-spacing:1.5px;
           background:rgba(0,0,8,0.5);padding:2px 6px;border-radius:2px;
           border:1px solid #2a2a2a;pointer-events:none;white-space:nowrap;`;
      const lbl = new rt.CSS2DObject(labelDiv);
      lbl.position.set(
        rx + (isX ? 0 : -farWall.nx * 0.05),
        rackBaseY + rackH + 0.18,
        rz + (isX ? -farWall.nz * 0.05 : 0),
      );
      scene.add(lbl);
    }
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
  const upsX = consoleX + (doorWall.id === 'left' || doorWall.id === 'right' ? 0 : 1.55);
  const upsZ = consoleZ + (doorWall.id === 'top' || doorWall.id === 'bottom' ? 0 : 1.55);
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
    const dirDiv = document.createElement('div');
    const lines: string[] = repos.length === 0
      ? ['<em style="color:#5a5a5a">(empty registry)</em><br><span style="color:#7a7a7a;font-size:8px">click a FREE rack to register</span>']
      : repos.slice(0, 18).map((r) => {
          const br = r.default_branch ? ` <span style="color:#4cff7a">[${esc(r.default_branch)}]</span>` : '';
          const lang = r.language ? ` <span style="color:#7a7a7a">·${esc(r.language)}</span>` : '';
          return `<span style="color:#ffb84a">${esc(r.name)}</span>${br}${lang}`;
        });
    if (repos.length > 18) lines.push(`<span style="color:#7a7a7a">…+${repos.length - 18} more</span>`);
    dirDiv.innerHTML = `
      <div style="font:700 9px 'Syne',sans-serif;color:#ffb84a;letter-spacing:2.5px;
        text-shadow:0 0 6px #ffb84a80;border-bottom:1px solid #ffb84a30;
        padding-bottom:2px;margin-bottom:4px;text-align:center;opacity:.85;">
        DIRECTORY
      </div>
      <div style="font:600 9px 'IBM Plex Mono',monospace;color:#c8b48a;
        line-height:1.45;letter-spacing:0.5px;">
        ${lines.join('<br>')}
      </div>`;
    dirDiv.style.cssText = `background:rgba(0,0,8,0.82);padding:6px 10px;border-radius:3px;
      border:1px solid #ffb84a35;box-shadow:0 0 14px #ffb84a20, inset 0 0 5px #1a1410;
      min-width:150px;max-width:230px;pointer-events:none;`;
    const dirLbl = new rt.CSS2DObject(dirDiv);
    // Anchor on the patch-panel wall, head-height, pushed slightly INSIDE the
    // room so it visually attaches to the inside wall face. Different wall
    // from the door sign + lower than wall-top = no longer reads as a title.
    const ppWallRef = WALLS[sideWallIds[1]];
    dirLbl.position.set(
      ppWallRef.midX + ppWallRef.nx * 0.15,
      WALL_H * 0.72,
      ppWallRef.midZ + ppWallRef.nz * 0.15,
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
  const accentLight = new rt.THREE.PointLight(accent.getHex(), 0.4, Math.max(w, d) * 1.1);
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

  // ── DevOps terminal — a clickable workstation that opens the control panel.
  // Desk + monitor with a glowing accent screen + a floating label. The
  // invisible hitbox is returned so the raycaster routes clicks → /devops.
  const dvx = cx - w / 2 + 1.9;
  const dvz = cz - d / 2 + 1.9;
  const dvDeskMat = new rt.THREE.MeshStandardMaterial({ color: 0x1b2233, roughness: 0.7, metalness: 0.3 });
  const dvDesk = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(1.3, 0.08, 0.7), dvDeskMat);
  dvDesk.position.set(dvx, 0.75, dvz);
  scene.add(dvDesk);
  for (const lx of [-0.55, 0.55]) for (const lz of [-0.28, 0.28]) {
    const dvLeg = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.06, 0.75, 0.06), dvDeskMat);
    dvLeg.position.set(dvx + lx, 0.375, dvz + lz);
    scene.add(dvLeg);
  }
  // Monitor: dark bezel + emissive screen in the office accent.
  const dvBezel = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.98, 0.6, 0.05), new rt.THREE.MeshStandardMaterial({ color: 0x0a0d16, roughness: 0.5 }));
  dvBezel.position.set(dvx, 1.28, dvz - 0.15);
  scene.add(dvBezel);
  const dvScreen = new rt.THREE.Mesh(new rt.THREE.PlaneGeometry(0.88, 0.5), new rt.THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.1, roughness: 0.3 }));
  dvScreen.position.set(dvx, 1.28, dvz - 0.121);
  scene.add(dvScreen);
  const dvStand = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.08, 0.35, 0.08), dvDeskMat);
  dvStand.position.set(dvx, 0.97, dvz - 0.15);
  scene.add(dvStand);
  const dvGlow = new rt.THREE.PointLight(accent, 0.9, 4);
  dvGlow.position.set(dvx, 1.35, dvz + 0.2);
  scene.add(dvGlow);
  // Invisible hitbox over the whole workstation → click routes to /devops.
  const dvTerm = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(1.4, 1.7, 0.9), new rt.THREE.MeshBasicMaterial({ visible: false }));
  dvTerm.position.set(dvx, 0.85, dvz);
  dvTerm.userData.isDevopsTerminal = true;
  scene.add(dvTerm);
  if (rt.CSS2DObject) {
    const dvEl = document.createElement('div');
    dvEl.textContent = '🛠 DevOps — open panel';
    dvEl.style.cssText = 'font:600 11px/1.2 system-ui;color:#fff;background:rgba(99,102,241,.85);padding:3px 8px;border-radius:6px;white-space:nowrap;pointer-events:none;';
    const dvLbl = new rt.CSS2DObject(dvEl);
    dvLbl.position.set(dvx, 1.85, dvz);
    scene.add(dvLbl);
  }

  return { freeRackHitboxes, devopsTerminalHitbox: dvTerm };
}
