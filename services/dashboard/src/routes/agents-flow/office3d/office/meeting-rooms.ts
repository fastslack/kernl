import { rt } from '../runtime.js';
import {
  WALL, WALL_BRIGHT, WALL_H, WALL_T,
  makeSignClickable, addWall, addWallWithDoor,
} from './_shared.js';
import { applyPBR } from './_materials.js';
import { applyWorldTexture, scaleUV } from '../textures.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/** Build meeting rooms in empty grid cells — conference table, chairs, whiteboard.
 *  hallCenter is the position of the Central Hall — doors face toward it. */
export function buildMeetingRooms(
  scene: any,
  meetingRooms: Array<{ cx: number; cz: number; w: number; d: number }>,
  hallCenter?: { x: number; z: number },
): void {
  const names = ['MEETING ROOM A', 'MEETING ROOM B', 'MEETING ROOM C', 'MEETING ROOM D', 'WAR ROOM', 'STRATEGY'];

  for (let i = 0; i < meetingRooms.length; i++) {
    const { cx, cz, w, d } = meetingRooms[i];
    const roomName = names[i % names.length];

    // Find which of the 4 walls is closest to the hall center → put door there.
    // Walls: top (+Z), bottom (-Z), left (-X), right (+X)
    const hx = hallCenter?.x ?? cx;
    const hz = hallCenter?.z ?? (cz - 1);
    const wallCenters = [
      { id: 'top',    x: cx,         z: cz + d / 2, len: w, isX: true  },
      { id: 'bottom', x: cx,         z: cz - d / 2, len: w, isX: true  },
      { id: 'left',   x: cx - w / 2, z: cz,         len: d, isX: false },
      { id: 'right',  x: cx + w / 2, z: cz,         len: d, isX: false },
    ];
    let doorWall = wallCenters[1]; // default: bottom
    let minDist = Infinity;
    for (const wc of wallCenters) {
      const dist = (wc.x - hx) ** 2 + (wc.z - hz) ** 2;
      if (dist < minDist) { minDist = dist; doorWall = wc; }
    }

    // Floor
    const mFloorMat = new rt.THREE.MeshStandardMaterial({ color: 0x181e2e, roughness: 0.9, metalness: 0 });
    applyWorldTexture(mFloorMat, 'carpet');
    const mFloorGeo = new rt.THREE.PlaneGeometry(w, d);
    scaleUV(mFloorGeo, w / 6, d / 6);
    const rf = new rt.THREE.Mesh(mFloorGeo, mFloorMat);
    rf.rotation.x = -Math.PI / 2; rf.position.set(cx, 0.02, cz);
    rf.receiveShadow = true;
    scene.add(rf);

    // 4 walls — door on the wall closest to the hall
    const doorDW = 2.5;
    const mCol = new rt.THREE.Color(0x8899bb);
    const wallMat = new rt.THREE.MeshStandardMaterial({ color: WALL, roughness: 0.8, metalness: 0 });
    applyWorldTexture(wallMat, 'wall');
    const wallBright = new rt.THREE.MeshStandardMaterial({ color: WALL_BRIGHT, roughness: 0.7 });
    for (const wc of wallCenters) {
      if (wc.id === doorWall.id) {
        addWallWithDoor(scene, wc.x, wc.z, wc.len, wc.isX, doorDW, wallMat, wallBright, mCol);
      } else {
        addWall(scene, wc.x, wc.z, wc.len, wc.isX, wallMat, wallBright);
      }
    }

    // ── Conference table (long oval/rectangular) ──
    const tableW = Math.min(w * 0.5, 6);
    const tableD = Math.min(d * 0.3, 3);
    const tableMat = new rt.THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.4, metalness: 0.05 });
    // Conference table top — most prominent camera-facing solid → subtle
    // RoundedBox chamfer (radius 0.025 ≈ 30% of the 0.08 top thickness, the
    // smallest dim, segments=2) rounds the slab edge. Bevel only, no
    // vertexColors; sits on legs so no contact AO.
    const table = new rt.THREE.Mesh(new RoundedBoxGeometry(tableW, 0.08, tableD, 2, 0.025), tableMat);
    table.position.set(cx, 0.78, cz);
    table.castShadow = true;
    scene.add(table);
    // Table legs
    const tLegGeo = new rt.THREE.CylinderGeometry(0.06, 0.06, 0.75, 6);
    const tLegMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a1a0a });
    applyPBR(tLegMat, 'metal'); // table legs + chair leg posts — structural metal
    for (const [lx, lz] of [[-tableW/2+0.3, -tableD/2+0.2], [tableW/2-0.3, -tableD/2+0.2], [-tableW/2+0.3, tableD/2-0.2], [tableW/2-0.3, tableD/2-0.2]]) {
      const leg = new rt.THREE.Mesh(tLegGeo, tLegMat);
      leg.position.set(cx + lx, 0.375, cz + lz);
      scene.add(leg);
    }

    // ── Chairs around the table ──
    const chairMat = new rt.THREE.MeshStandardMaterial({ color: 0x2a4060, roughness: 0.6 });
    applyPBR(chairMat, 'cloth'); // upholstered meeting chairs — soft cloth role
    const numChairsSide = Math.max(2, Math.floor(tableW / 1.5));
    // Chairs along both long sides
    for (let ci = 0; ci < numChairsSide; ci++) {
      const chairX = cx - tableW / 2 + (tableW / (numChairsSide + 1)) * (ci + 1);
      for (const zSide of [-1, 1]) {
        const chairZ = cz + zSide * (tableD / 2 + 0.6);
        // Seat
        const seat = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.5, 0.05, 0.5), chairMat);
        seat.position.set(chairX, 0.47, chairZ);
        scene.add(seat);
        // Back
        const back = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.5, 0.45, 0.06), chairMat);
        back.position.set(chairX, 0.72, chairZ + zSide * 0.25);
        scene.add(back);
        // Leg post
        const cLeg = new rt.THREE.Mesh(new rt.THREE.CylinderGeometry(0.03, 0.03, 0.45, 6), tLegMat);
        cLeg.position.set(chairX, 0.225, chairZ);
        scene.add(cLeg);
      }
    }
    // Chairs at head/foot of table
    for (const xSide of [-1, 1]) {
      const hx = cx + xSide * (tableW / 2 + 0.6);
      const seat = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.5, 0.05, 0.5), chairMat);
      seat.position.set(hx, 0.47, cz);
      scene.add(seat);
      const back = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(0.06, 0.45, 0.5), chairMat);
      back.position.set(hx + xSide * 0.25, 0.72, cz);
      scene.add(back);
    }

    // ── Large screen/TV on wall opposite the door ──
    const oppWall = wallCenters.find(wc => {
      if (doorWall.id === 'top') return wc.id === 'bottom';
      if (doorWall.id === 'bottom') return wc.id === 'top';
      if (doorWall.id === 'left') return wc.id === 'right';
      return wc.id === 'left';
    })!;
    const screenW2 = Math.min(oppWall.isX ? w * 0.5 : d * 0.5, 4);
    const screenMat = new rt.THREE.MeshStandardMaterial({
      color: 0x080810, emissive: new rt.THREE.Color(0x2255aa), emissiveIntensity: 0.2,
      roughness: 0.1,
    });
    applyPBR(screenMat, 'screen'); // wall display — emissive screen surface
    const screenGeo = oppWall.isX
      ? new rt.THREE.BoxGeometry(screenW2, 1.5, 0.06)
      : new rt.THREE.BoxGeometry(0.06, 1.5, screenW2);
    const screen = new rt.THREE.Mesh(screenGeo, screenMat);
    const sOff = WALL_T / 2 + 0.02;
    screen.position.set(
      oppWall.isX ? cx : oppWall.x + (oppWall.id === 'left' ? sOff : -sOff),
      2.0,
      oppWall.isX ? oppWall.z + (oppWall.id === 'bottom' ? sOff : -sOff) : cz,
    );
    scene.add(screen);
    const bezelMat = new rt.THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4 });
    applyPBR(bezelMat, 'plastic'); // screen bezel — dark plastic casing
    const bezelGeo = oppWall.isX
      ? new rt.THREE.BoxGeometry(screenW2 + 0.15, 1.6, 0.04)
      : new rt.THREE.BoxGeometry(0.04, 1.6, screenW2 + 0.15);
    const bezel = new rt.THREE.Mesh(bezelGeo, bezelMat);
    bezel.position.copy(screen.position);
    scene.add(bezel);

    // ── Room name sign (above the door wall) ──
    const signDiv = document.createElement('div');
    signDiv.textContent = roomName;
    signDiv.style.cssText = `font:700 10px 'Syne',sans-serif;color:#8899bb;letter-spacing:2px;
      text-shadow:0 0 8px #445588;background:rgba(0,0,8,0.7);padding:3px 12px;border-radius:2px;`;
    makeSignClickable(signDiv, { cx, cz, w, d, name: roomName });
    const lbl = new rt.CSS2DObject(signDiv);
    lbl.position.set(doorWall.x, WALL_H + 0.4, doorWall.z);
    scene.add(lbl);

    // Ceiling light — single moderate PointLight per meeting room (needed for table/chair shadowing)
    const roomLight = new rt.THREE.PointLight(0xffeedd, 0.6, Math.max(w, d) * 1.2);
    roomLight.position.set(cx, WALL_H - 0.3, cz);
    roomLight.decay = 2;
    roomLight.matrixAutoUpdate = false; roomLight.updateMatrix();
    scene.add(roomLight);
  }
}
