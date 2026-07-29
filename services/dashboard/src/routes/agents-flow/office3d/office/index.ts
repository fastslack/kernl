// office3d/office/index.ts
// Barrel for the office package: public surface identical to the old office.ts.
import { setRuntime } from '../runtime.js';

export function initOffice(three: any, css2d: any) {
  setRuntime(three, css2d);
}

export { buildFloor } from './floor.js';
export { buildStreets, buildCorridorGrid, buildCorridor } from './streets.js';
export { buildRooms } from './rooms.js';
export { buildMeetingRooms } from './meeting-rooms.js';
export { buildMyOffice } from './my-office.js';
export { buildCentralHall, buildHallExtension } from './central-hall.js';
export { buildReception, type ReceptionAnchors } from './reception.js';
export { buildCommunicationsOffice } from './communications.js';
export { buildDataCenterOffice, type DataCenterHandles, type RepoBookmark } from './data-center.js';
export { setupLighting } from './lighting.js';
