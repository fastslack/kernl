/**
 * Stage: wire the mesh-dashboard extension and bridge MeshService methods to
 * the EventBus.
 *
 * Runs after extensions load (so `meshModule` may be present) AND after the
 * attestation identity has been loaded (so the dashboard knows the local
 * server's fingerprint).
 *
 * MeshService doesn't depend on the EventBus directly (keeps its unit tests
 * in-process), so we monkey-patch its pair/trust/revoke methods to also emit
 * the corresponding bus events. The mesh-dashboard extension subscribes to
 * those and repaints on every operator action.
 */

import type { EventBus } from "../event-bus.js";
import type { ModuleRegistry } from "../module-registry.js";
import type { Identity } from "../attestation.js";
import type { MeshModule, MeshDashboardModule } from "../types/extensions/index.js";

export function wireMesh(args: {
  registry: ModuleRegistry;
  events: EventBus;
  meshModule: MeshModule | null;
  attestIdentity: Identity | undefined;
}): void {
  const { registry, events, meshModule, attestIdentity } = args;

  const meshDashboardExt = registry.getModule("ext:mesh-dashboard") as MeshDashboardModule | null;
  meshDashboardExt?.bind({
    meshService: meshModule?.getService() ?? null,
    selfFingerprint: attestIdentity ? attestIdentity.serverId() : null,
  });

  // Bridge MeshService → EventBus so the dashboard repaints on every
  // operator action (pair / trust / revoke).
  const meshSvc = meshModule?.getService() ?? null;
  if (meshSvc) {
    const origPair = meshSvc.pairPeer.bind(meshSvc);
    meshSvc.pairPeer = async (opts) => {
      const result = await origPair(opts);
      events.emit("mesh:peer.added", {
        peer_id: result.record.peer_id,
        endpoint: result.record.endpoint,
        display_name: result.record.display_name,
        status: result.record.status,
      }).catch(() => {});
      return result;
    };
    const origTrust = meshSvc.trustPeer.bind(meshSvc);
    meshSvc.trustPeer = (peerId) => {
      const ok = origTrust(peerId);
      if (ok) events.emit("mesh:peer.trust", { peer_id: peerId, status: "trusted" }).catch(() => {});
      return ok;
    };
    const origRevoke = meshSvc.revokePeer.bind(meshSvc);
    meshSvc.revokePeer = (peerId) => {
      const ok = origRevoke(peerId);
      if (ok) events.emit("mesh:peer.trust", { peer_id: peerId, status: "revoked" }).catch(() => {});
      return ok;
    };
  }
}
