export { paintMeetingScreen, clearMeetingScreen, type MeetingScreenHandle, type MeetingScreenContent } from './office/meeting-rooms.js';
export { buildNameplate, NAMEPLATE_HEIGHT, type NameplateOpts, type NameplateRank } from './nameplate.js';
export { computeFloorPlan, nearestCorridorNode, type CorridorGrid, type CorridorSegment } from './floor-plan.js';
export { initHumanoid, createHumanoid, animateWalk, animateRun, animateSitting } from './humanoid.js';
export { initHumanoidPool, createSittingHumanoidPool, type SittingHumanoidPool } from './humanoid-pool.js';
export { initOffice, buildFloor, buildStreets, buildCorridor, buildCorridorGrid, buildRooms, buildMeetingRooms, buildMyOffice, buildCentralHall, buildHallExtension, buildReception, buildCommunicationsOffice, buildDataCenterOffice, setupLighting, type ReceptionAnchors, type DataCenterHandles, type RepoBookmark } from './office/index.js';
export { applyRendererGrading, applySceneGrading, GRADING } from './grading.js';
export { initDelivery, initDeliveryScene, enqueueDelivery, resetDelivery, markPackagePickedUp, updateDelivery, type DeliveryInfo, type DeliveryContext } from './delivery.js';
export { initTaxi, initTaxiScene, enqueueTaxi, updateTaxis, resetTaxis, type TaxiContext, type TaxiArrivalOpts } from './taxi.js';
export { initFurniture, buildDesks, buildHallways, type HallwayLine } from './furniture.js';
export { initWalkers, sendWalker, sendWalkerToPoint, sendCommuteWalker, updateWalkers, removeArrivedWalkers, syncSeatedVisibility } from './walkers/index.js';
export { initAmbiance, buildAmbiance, buildWallClock, buildActivityBoard, updateActivityBoard, buildDoorLeds, updateDoorLeds, buildElevator, updateAmbiance } from './ambiance/index.js';
export { initRedAlertDecor, buildRadarDish, buildSandbagBarrier, buildCrates, type RadarDishHandle } from './red-alert-decor.js';
export {
  buildPowerConsole, setInfraBreaker, getInfraBreakerState, setInfraReadout,
  flipInfraLever, updateInfraConsole, getInfraOperatorPos, getInfraFacePos,
  resetInfraConsole, toggleInfraBoard, INFRA_VIS, type InfraState, type InfraOffice,
} from './infra-power.js';

// Skin system — installable per-agent visual themes (office-worker, ra-soldier…).
export {
  registerSkin, resolveSkin, listSkins, setDefaultSkin, initAllSkins, clearSkins,
  type SkinDefinition, type SkinManifest, type SkinPalette, type SkinCreateOpts,
} from './skins/index.js';
export { resolveFlowColor, agentType, agentUsesSkills, modelChainFallbacks, CLAUDE_CODE_DEFAULT_MODEL, FLOW_COLORS } from './types.js';
export type { AgentData, ChainData, FlowData, StatsData, Vec3, Walker, RoomInfo, CorridorInfo, FloorPlan, SpeechBubble, HumanoidParts, Aabb2D } from './types.js';

// Animation system — pose math, easing, path navigation, effects, registry.
//
// Re-exported wholesale rather than re-listed. This block used to name every
// symbol by hand, which made anim/ the only subsystem where adding or removing
// one effect meant editing three barrels plus the consumer — and removing the
// spinning gear proved it, because a name left behind in any of them is a
// build error at the far end. anim/index.ts already does `export *` over its
// own parts, so the single enumeration that remains is effects/index.ts, where
// each file is named exactly once.
export * from './anim/index.js';
