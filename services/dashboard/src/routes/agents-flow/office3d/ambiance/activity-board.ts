/**
 * Activity board — a TV screen mounted on the reception back wall that shows a
 * live feed of agent events, rendered onto an offscreen canvas.
 */

import { rt } from '../runtime.js';

let boardCanvas: HTMLCanvasElement | null = null;
let boardCtx: CanvasRenderingContext2D | null = null;
let boardTexture: any = null;
let boardEvents: Array<{ agent: string; text: string; color: string; time: string }> = [];

/** Build the activity board as a TV screen mounted on the reception back wall,
 *  centred under the RECEPTION sign and facing the entrance doors. */
export function buildActivityBoard(scene: any, hallCx: number, hallCz: number, _hallD: number): void {
  if (!rt.THREE) return;

  // Reception counter sits at (hallCx, hallCz) with counterD=1.6. The back
  // wall is pushed 2.5u behind the counter (office.ts:WALL_GAP_BEHIND_COUNTER)
  // — keep this constant in sync if it ever changes there. Mount the TV on
  // the south face of that pushed-back wall.
  const COUNTER_D = 1.6;
  const BACK_WALL_T = 0.1;
  const WALL_GAP = 2.5;
  const backWallCenterZ = hallCz - COUNTER_D / 2 - WALL_GAP;
  const backWallSouthFaceZ = backWallCenterZ + BACK_WALL_T / 2;

  const BOARD_W = 2.4, BOARD_H = 1.2;
  const BOARD_Y = 1.95; // below the RECEPTION sign at y=2.55, above the counter top at ~1.25

  // Frame
  const frameMat = new rt.THREE.MeshStandardMaterial({ color: 0x3a4a6a, roughness: 0.3, metalness: 0.5 });
  const frame = new rt.THREE.Mesh(new rt.THREE.BoxGeometry(BOARD_W + 0.14, BOARD_H + 0.14, 0.05), frameMat);
  frame.position.set(hallCx, BOARD_Y, backWallSouthFaceZ + 0.025);
  scene.add(frame);

  // Create offscreen canvas for the TV content
  boardCanvas = document.createElement('canvas');
  boardCanvas.width = 512;
  boardCanvas.height = 256;
  boardCtx = boardCanvas.getContext('2d');

  renderBoard();

  boardTexture = new rt.THREE.CanvasTexture(boardCanvas);
  boardTexture.minFilter = rt.THREE.LinearFilter;
  boardTexture.magFilter = rt.THREE.LinearFilter;

  const screenMat = new rt.THREE.MeshStandardMaterial({
    map: boardTexture,
    emissiveMap: boardTexture,
    emissive: new rt.THREE.Color(0xffffff),
    emissiveIntensity: 0.4,
    roughness: 0.1,
    metalness: 0.0,
  });
  // Screen mounted on the south face of the back wall, facing +Z (toward the
  // doors). A PlaneGeometry renders from its normal; rotate so the face points
  // south.
  const screen = new rt.THREE.Mesh(new rt.THREE.PlaneGeometry(BOARD_W, BOARD_H), screenMat);
  screen.position.set(hallCx, BOARD_Y, backWallSouthFaceZ + 0.055);
  // PlaneGeometry default normal is +Z — leave rotation.y=0 so the screen faces +Z.
  scene.add(screen);
}

/** Render the activity board content onto the canvas */
function renderBoard(): void {
  if (!boardCtx || !boardCanvas) return;
  const ctx = boardCtx;
  const W = boardCanvas.width, H = boardCanvas.height;

  // Background
  ctx.fillStyle = '#080c18';
  ctx.fillRect(0, 0, W, H);

  // Header bar
  ctx.fillStyle = '#1a2040';
  ctx.fillRect(0, 0, W, 32);
  ctx.fillStyle = '#4a6ab8';
  ctx.font = 'bold 14px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('LIVE ACTIVITY', W / 2, 22);

  // Divider line
  ctx.strokeStyle = '#2a3555';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(10, 34); ctx.lineTo(W - 10, 34); ctx.stroke();

  // Event rows
  if (boardEvents.length === 0) {
    ctx.fillStyle = '#4a4f6a';
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for activity...', W / 2, H / 2);
    return;
  }

  ctx.textAlign = 'left';
  const rowH = 30;
  const maxRows = Math.min(boardEvents.length, 7);
  for (let i = 0; i < maxRows; i++) {
    const e = boardEvents[i];
    const y = 50 + i * rowH;

    // Status dot
    ctx.fillStyle = e.color || '#8a8fa8';
    ctx.beginPath(); ctx.arc(18, y, 4, 0, Math.PI * 2); ctx.fill();

    // Agent name
    ctx.fillStyle = e.color || '#8a8fa8';
    ctx.font = 'bold 11px "Segoe UI", sans-serif';
    ctx.fillText(e.agent.slice(0, 14), 30, y + 4);

    // Action text
    ctx.fillStyle = '#c0c5d8';
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.fillText(e.text.slice(0, 30), 140, y + 4);

    // Time
    ctx.fillStyle = '#4a4f6a';
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(e.time, W - 15, y + 4);
    ctx.textAlign = 'left';

    // Row separator
    if (i < maxRows - 1) {
      ctx.strokeStyle = '#1a2040';
      ctx.beginPath(); ctx.moveTo(15, y + 14); ctx.lineTo(W - 15, y + 14); ctx.stroke();
    }
  }
}

/** Update the activity board with recent events */
export function updateActivityBoard(events: Array<{ agent: string; text: string; color: string; time: string }>): void {
  boardEvents = events;
  renderBoard();
  if (boardTexture) boardTexture.needsUpdate = true;
}
