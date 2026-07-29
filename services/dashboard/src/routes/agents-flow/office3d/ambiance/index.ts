// office3d/ambiance/index.ts
// Barrel for the ambiance package: public surface identical to the old ambiance.ts.
import { setRuntime } from '../runtime.js';

export function initAmbiance(three: any, css2d: any) {
  setRuntime(three, css2d);
}

export { buildAmbiance } from './scenery.js';
export { buildWallClock, buildElevator, updateAmbiance } from './fixtures.js';
export { buildActivityBoard, updateActivityBoard } from './activity-board.js';
export { buildDoorLeds, updateDoorLeds } from './door-leds.js';
