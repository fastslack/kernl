/**
 * Door LEDs — status indicators above each office door, driven by running /
 * failed agent state.
 */

import { rt } from '../runtime.js';

let doorLeds: Map<string, any> = new Map();

/** Build LED status indicators above each office door */
export function buildDoorLeds(
  scene: any,
  rooms: Map<string, { cx: number; cz: number; w: number; d: number; doorDir?: string }>,
): void {
  if (!rt.THREE) return;
  doorLeds.clear();

  for (const [flowId, room] of rooms) {
    const dd = (room as any).doorDir || 'bottom';
    // LED position: above the door wall, centered
    let lx = room.cx, lz = room.cz;
    if (dd === 'top') lz = room.cz + room.d / 2;
    else if (dd === 'bottom') lz = room.cz - room.d / 2;
    else if (dd === 'left') lx = room.cx - room.w / 2;
    else if (dd === 'right') lx = room.cx + room.w / 2;

    // LED housing
    const housing = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(0.3, 0.12, 0.1),
      new rt.THREE.MeshStandardMaterial({ color: 0x1a1d2a, roughness: 0.4, metalness: 0.3 }),
    );
    housing.position.set(lx, 3.6, lz);
    scene.add(housing);

    // LED bulb (starts grey = idle)
    const led = new rt.THREE.Mesh(
      new rt.THREE.SphereGeometry(0.06, 8, 8),
      new rt.THREE.MeshStandardMaterial({ color: 0x4a4f6a, emissive: new rt.THREE.Color(0x4a4f6a), emissiveIntensity: 0.3 }),
    );
    led.position.set(lx, 3.6, lz - 0.06);
    scene.add(led);
    doorLeds.set(flowId, led);
  }
}

/** Update door LEDs based on running agents.
 *  Runs every frame — flows with running agents are collected ONCE (O(agents))
 *  instead of per-room agents.some(), and material writes only happen on a
 *  state transition (LEDs change a few times a minute, not per frame). */
const _runningFlows = new Set<string>();
export function updateDoorLeds(
  runningAgentIds: Set<string>,
  agents: Array<{ id: string; flow_id: string }>,
  failedFlows?: Set<string>,
): void {
  _runningFlows.clear();
  if (runningAgentIds.size > 0) {
    for (const a of agents) {
      if (runningAgentIds.has(a.id)) _runningFlows.add(a.flow_id);
    }
  }
  for (const [flowId, led] of doorLeds) {
    const state = failedFlows?.has(flowId) ? 'failed' : _runningFlows.has(flowId) ? 'running' : 'idle';
    if (led.userData._ledState === state) continue;
    led.userData._ledState = state;
    if (state === 'failed') {
      led.material.color.setHex(0xef4444);
      led.material.emissive.setHex(0xef4444);
      led.material.emissiveIntensity = 0.8;
    } else if (state === 'running') {
      led.material.color.setHex(0x3dd68c);
      led.material.emissive.setHex(0x3dd68c);
      led.material.emissiveIntensity = 0.8;
    } else {
      led.material.color.setHex(0x4a4f6a);
      led.material.emissive.setHex(0x4a4f6a);
      led.material.emissiveIntensity = 0.2;
    }
  }
}
