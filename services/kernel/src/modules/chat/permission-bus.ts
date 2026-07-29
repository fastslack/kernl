/**
 * In-memory bus that bridges the Claude Code SDK's `canUseTool` hook to the
 * dashboard. The provider emits a `permission_request` event into the SSE
 * stream and parks an awaiter here; the dashboard answers via
 * `POST /api/chat/permission/respond`, which resolves the awaiter and the
 * SDK continues.
 *
 * Lifetime: a pending request lives in-memory until resolved or until
 * `cancelAllForEpisode()` is called when the SSE stream closes. There is no
 * persistence — if the kernel restarts mid-prompt, the SDK call dies with
 * the SSE connection.
 */

import { log } from "../../core/logger.js";

interface PendingRequest {
  episodeId: string;
  toolName: string;
  resolve: (decision: { behavior: "allow" | "deny"; reason?: string }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — user may step away

export class PermissionBus {
  private pending = new Map<string, PendingRequest>();

  /**
   * Park a permission request and return a promise the SDK awaits.
   * Times out after `timeoutMs` so a forgotten prompt doesn't hold the
   * subprocess open forever.
   */
  ask(input: {
    request_id: string;
    episode_id: string;
    tool_name: string;
    timeoutMs?: number;
  }): Promise<{ behavior: "allow" | "deny"; reason?: string }> {
    const { request_id, episode_id, tool_name } = input;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(request_id)) {
          log.warn(
            `permission-bus: request ${request_id} for tool "${tool_name}" timed out`,
          );
          resolve({ behavior: "deny", reason: "Permission request timed out." });
        }
      }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(request_id, {
        episodeId: episode_id,
        toolName: tool_name,
        resolve,
        reject,
        timer,
      });
    });
  }

  /** Called by the HTTP route when the user clicks allow/deny. */
  respond(
    request_id: string,
    decision: { behavior: "allow" | "deny"; reason?: string },
  ): boolean {
    const pending = this.pending.get(request_id);
    if (!pending) return false;
    this.pending.delete(request_id);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
  }

  /**
   * Cancel every parked request for an episode. Called when the dashboard
   * SSE stream closes — without this, the SDK subprocess hangs on a prompt
   * the user can never answer.
   */
  cancelAllForEpisode(episodeId: string, reason: string = "stream closed"): number {
    let cancelled = 0;
    for (const [id, p] of this.pending) {
      if (p.episodeId !== episodeId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({ behavior: "deny", reason });
      cancelled++;
    }
    return cancelled;
  }

  /** For ops + debugging. */
  size(): number {
    return this.pending.size;
  }
}
