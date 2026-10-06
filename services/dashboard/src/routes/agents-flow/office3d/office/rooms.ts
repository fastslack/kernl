import type { RoomInfo } from '../types.js';
import { rt } from '../runtime.js';
import {
  WALL, WALL_BRIGHT, WALL_DARK, FLOOR_CARPET, WALL_H, WALL_T,
  makeSignClickable, addOfficeOffLine, paintOfficePower, addWall, addWallWithDoor,
} from './_shared.js';
import { applyPBR } from './_materials.js';
import { applyWorldTexture, scaleUV, getWhiteboardTexture } from '../textures.js';

/** Build rooms — 4 walls with door on the wall facing the corridor.
 *  `counts` (keyed like `rooms`, i.e. flow id) enriches the door sign with
 *  the office headcount: "N AGENTS · M ON". */
export function buildRooms(
  scene: any,
  rooms: Map<string, RoomInfo>,
  counts?: Map<string, { total: number; active: number }>,
  /** Offices switched off (agent_flows.paused) and the sign's "OFF" label. */
  power?: { paused: ReadonlySet<string>; offLabel: string },
): void {
  const doorW = 2.5;
  // Whiteboard materials — shared across every room (textures are cached).
  const boardFrameMat = new rt.THREE.MeshStandardMaterial({ color: 0x9aa3b2, roughness: 0.4, metalness: 0.5 });
  applyPBR(boardFrameMat, 'metal');
  const boardMats = [0, 1].map(v => new rt.THREE.MeshStandardMaterial({
    map: getWhiteboardTexture(v), roughness: 0.35, metalness: 0,
  }));
  let roomIdx = 0;
  const wallMat = new rt.THREE.MeshStandardMaterial({ color: WALL, roughness: 0.8, metalness: 0 });
  applyWorldTexture(wallMat, 'wall');
  const wallBright = new rt.THREE.MeshStandardMaterial({ color: WALL_BRIGHT, roughness: 0.7, metalness: 0 });
  const wallDark = new rt.THREE.MeshStandardMaterial({ color: WALL_DARK, roughness: 0.85, metalness: 0 });

  for (const [roomKey, room] of rooms) {
    const { cx, cz, w, d, color, name } = room;
    // Each office lives in its own group, every piece tagged with what it is,
    // so the construction stage can raise the walls of a new office and pop
    // its furniture in (construction/stage.ts) without rebuilding anything.
    const g = new rt.THREE.Group();
    g.userData.flowId = roomKey;
    scene.add(g);
    const tag = (from: number, part: 'floor' | 'wall' | 'decor' | 'sign') => {
      for (let i = from; i < g.children.length; i++) g.children[i].userData.part = part;
    };
    let mark = 0;
    const dd = (room as any).doorDir || (room.side === 1 ? 'top' : 'bottom');
    const col = new rt.THREE.Color(color);

    // ── Room carpet ──
    const floorCol = new rt.THREE.Color(FLOOR_CARPET).lerp(col.clone().multiplyScalar(0.08), 0.3);
    const floorMat = new rt.THREE.MeshStandardMaterial({ color: floorCol, roughness: 0.95, metalness: 0 });
    applyPBR(floorMat, 'carpet');
    applyWorldTexture(floorMat, 'carpet');
    const carpetGeo = new rt.THREE.PlaneGeometry(w, d);
    scaleUV(carpetGeo, w / 6, d / 6); // 1 tile ≈ 6u — large enough that the repeat never reads as a grid
    const rf = new rt.THREE.Mesh(
      carpetGeo,
      floorMat,
    );
    rf.rotation.x = -Math.PI / 2; rf.position.set(cx, 0.02, cz); rf.receiveShadow = true;
    g.add(rf);
    tag(mark, 'floor'); mark = g.children.length;

    // ── 4 walls — door on the wall facing the hall ──
    const roomWalls = [
      { id: 'top',    px: cx,         pz: cz + d / 2, len: w, isX: true  },
      { id: 'bottom', px: cx,         pz: cz - d / 2, len: w, isX: true  },
      { id: 'left',   px: cx - w / 2, pz: cz,         len: d, isX: false },
      { id: 'right',  px: cx + w / 2, pz: cz,         len: d, isX: false },
    ];
    for (const rw of roomWalls) {
      if (rw.id === dd) {
        addWallWithDoor(g, rw.px, rw.pz, rw.len, rw.isX, doorW, wallMat, wallBright, col);
      } else {
        addWall(g, rw.px, rw.pz, rw.len, rw.isX, wallMat, wallBright);
      }
      for (let i = mark; i < g.children.length; i++) g.children[i].userData.wallId = rw.id;
      tag(mark, 'wall'); mark = g.children.length;
    }

    // ── Whiteboard — on the wall opposite the door, with scribbles/chart ──
    // Makes every office read as a real working room and gives each a touch
    // of identity (2 alternating board layouts).
    {
      const opposite: Record<string, string> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
      const bw = opposite[dd] ?? 'top';
      const inset = WALL_T / 2 + 0.04;
      const BW = Math.min(2.4, w * 0.35), BH = 1.25;
      let bx = cx, bz = cz, rotY = 0;
      if (bw === 'top')    { bz = cz + d / 2 - inset; rotY = Math.PI; }
      if (bw === 'bottom') { bz = cz - d / 2 + inset; rotY = 0; }
      if (bw === 'left')   { bx = cx - w / 2 + inset; rotY = Math.PI / 2; }
      if (bw === 'right')  { bx = cx + w / 2 - inset; rotY = -Math.PI / 2; }
      const board = new rt.THREE.Mesh(new rt.THREE.PlaneGeometry(BW, BH), boardMats[roomIdx % 2]);
      board.position.set(bx, 1.75, bz);
      board.rotation.y = rotY;
      g.add(board);
      const frame = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(BW + 0.12, BH + 0.12, 0.03), boardFrameMat);
      frame.position.set(bx, 1.75, bz);
      frame.rotation.y = rotY;
      frame.translateZ(-0.02); // behind the board face
      g.add(frame);
      // Marker tray
      const tray = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(BW * 0.5, 0.04, 0.08), boardFrameMat);
      tray.position.set(bx, 1.75 - BH / 2 - 0.06, bz);
      tray.rotation.y = rotY;
      tray.translateZ(0.05);
      g.add(tray);
    }
    roomIdx++;

    // ── Ceiling light — emissive panel ──
    const panelGeo = new rt.THREE.PlaneGeometry(Math.min(w * 0.4, 3), Math.min(d * 0.3, 2));
    const panelMat2 = new rt.THREE.MeshBasicMaterial({ color: 0xffeedd, transparent: true, opacity: 0.15 });
    const cPanel = new rt.THREE.Mesh(panelGeo, panelMat2);
    cPanel.rotation.x = Math.PI / 2;
    cPanel.position.set(cx, WALL_H - 0.05, cz);
    g.add(cPanel);

    // ── Floor standing lamp — placed in a back corner, opposite the door ──
    const cornerInset = 0.9;
    const lx = dd === 'left'
      ? cx + w / 2 - cornerInset
      : cx - w / 2 + cornerInset;
    const lz = dd === 'bottom'
      ? cz + d / 2 - cornerInset
      : cz - d / 2 + cornerInset;
    const baseLampMat = new rt.THREE.MeshStandardMaterial({ color: 0x1a1d2a, roughness: 0.4, metalness: 0.5 });
    const poleMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a2d3a, roughness: 0.3, metalness: 0.6 });
    const shadeMat = new rt.THREE.MeshStandardMaterial({
      color: 0xffeedd, emissive: new rt.THREE.Color(0xffeedd), emissiveIntensity: 0.5,
      roughness: 0.4, transparent: true, opacity: 0.85,
    });
    const lampBase = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.25, 0.28, 0.06, 12), baseLampMat);
    lampBase.position.set(lx, 0.03, lz);
    g.add(lampBase);
    const lampPole = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.03, 0.03, 1.6, 8), poleMat);
    lampPole.position.set(lx, 0.83, lz);
    g.add(lampPole);
    const lampShade = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.15, 0.18, 0.3, 12), shadeMat);
    lampShade.position.set(lx, 1.78, lz);
    g.add(lampShade);
    const lampGlowDisc = new rt.THREE.Mesh(
      new rt.THREE.CircleGeometry(1.2, 12),
      new rt.THREE.MeshBasicMaterial({ color: 0xffeedd, transparent: true, opacity: 0.04, side: 2 }),
    );
    lampGlowDisc.rotation.x = -Math.PI / 2;
    lampGlowDisc.position.set(lx, 0.015, lz);
    g.add(lampGlowDisc);

    // ── Room sign (above door wall) — name + live headcount subline ──
    const dw = roomWalls.find(rw => rw.id === dd)!;
    const signDiv = document.createElement('div');
    signDiv.textContent = name;
    signDiv.style.cssText = `font:600 12px 'Manrope',sans-serif;color:#f0f0ed;letter-spacing:0;
      border-left:3px solid ${color};box-shadow:0 2px 8px #0005;
      background:rgba(23,24,27,0.94);padding:6px 10px;border-radius:6px;text-align:left;max-width:160px;white-space:normal;`;
    const rc = counts?.get(roomKey);
    if (rc && rc.total > 0) {
      const sub = document.createElement('div');
      // data-room-sub lets AgentWorld3D live-patch the counts on active
      // toggles without rebuilding the static scene.
      sub.setAttribute('data-room-sub', roomKey);
      sub.textContent = `${rc.total} ${rc.total === 1 ? 'AGENT' : 'AGENTS'} · ${rc.active} ON`;
      sub.style.cssText = `font:500 9px 'Manrope',sans-serif;letter-spacing:0;margin-top:3px;
        color:${rc.active > 0 ? '#9fe8c0' : '#6a7390'};text-shadow:none;`;
      signDiv.appendChild(sub);
    }
    // Infra power state line — live-patched by AgentWorld3D from
    // `office:infra:changed`. Starts hidden; shown once a state is known.
    const infra = document.createElement('div');
    infra.setAttribute('data-infra-sign', roomKey);
    infra.style.cssText = `font:700 8px 'Fira Code',monospace;letter-spacing:1px;margin-top:2px;
      display:none;color:#667;text-shadow:none;`;
    signDiv.appendChild(infra);
    signDiv.setAttribute('data-office-sign', roomKey);
    if (power) {
      addOfficeOffLine(signDiv, roomKey, power.offLabel);
      paintOfficePower(signDiv, power.paused.has(roomKey));
    }
    makeSignClickable(signDiv, { cx, cz, w, d, name: name.toUpperCase() });
    tag(mark, 'decor'); mark = g.children.length;
    const lbl = new rt.CSS2DObject(signDiv);
    lbl.position.set(dw.px, WALL_H + 0.4, dw.pz);
    g.add(lbl);
    tag(mark, 'sign');
  }
}
