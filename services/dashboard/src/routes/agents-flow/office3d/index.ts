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
export { resolveFlowColor, agentType, modelChainFallbacks, CLAUDE_CODE_DEFAULT_MODEL, FLOW_COLORS } from './types.js';
export type { AgentData, ChainData, FlowData, StatsData, Vec3, Walker, RoomInfo, CorridorInfo, FloorPlan, SpeechBubble, HumanoidParts, Aabb2D } from './types.js';

// Animation system — pose math, easing, path navigation, effects, registry.
// See office3d/anim/index.ts for the full surface.
export {
  createAnimationRegistry, initAnimEffects,
  cameraTween, haloPulse, risingParticles, bubbleFade, materialPulse,
  floatingGlyph, shake, convergingParticles, fallingGlyph, spinningGear,
  curvedArrow, paperPlane, pillarOfLight,
  tickerCard, candlestick, coinTrail, priceLine, chyronLabel,
  createNoteStack,
  runTradeExecution,
  computeWalkPose, computeRunPose, computeCarrierPose, computeSittingPose, computeTalkingPose,
  pathLength, interpolatePath, pathDirection, buildCumDist,
  easeOutCubic, easeInOutQuad, easeOutQuad, smoothstep, lerp, damp, clamp01,
  type AnimationRegistry, type Ticker, type TradeExecutionOpts,
  type WalkPose, type SittingPose, type SittingMode, type TalkingPose,
  type NoteStack, type NoteStackOpts,
} from './anim/index.js';
