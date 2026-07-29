// office3d/walkers/index.ts
// Barrel for the walkers package: public surface identical to the old walkers.ts.
import { setRuntime } from '../runtime.js';

export function initWalkers(three: any, css2d: any) {
  setRuntime(three, css2d);
}

export { sendWalker, sendWalkerToPoint, sendCommuteWalker } from './spawn.js';
export { updateWalkers, removeArrivedWalkers, syncSeatedVisibility } from './update.js';
export type { SittingWorkerEntry, SittingWorkers, WalkerToPointOpts, CommuteWalkerOpts } from './types.js';
