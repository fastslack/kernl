/** Per-frame walker update + lifecycle (return / dismiss / seated-visibility sync).
 *  Extracted from walkers.ts (structural refactor). */

import type { Vec3, Walker } from '../types.js';
import { animateWalk, animateRun, animateTalking } from '../humanoid.js';
import { interpolatePath, pathDirection } from '../anim/path.js';
import type { SittingWorkers } from './types.js';

/** Update all walkers each frame.
 *  deltaSec is the real time elapsed since last frame (for constant world-space speed).
 *  sittingWorkers map is used to restore source seated worker visibility on return.
 */
export function updateWalkers(
  scene: any,
  walkers: Walker[],
  onArrival?: (targetId: string) => void,
  deltaSec: number = 1 / 60,
  sittingWorkers?: SittingWorkers,
): void {
  for (let i = walkers.length - 1; i >= 0; i--) {
    const w = walkers[i];
    w.age += deltaSec; // age is now in seconds
    w.timeSec = (w.timeSec ?? 0) + deltaSec;
    const activePath: Vec3[] = w.returning ? w.returnCurve : w.curve;
    const activeCumDist = w.returning ? w.retCumDist : w.fwdCumDist;

    // Fade in — iterate cached mats instead of traversing the subtree
    if (w.fadeState === 1) {
      w.fadeProgress = (w.fadeProgress ?? 0) + deltaSec * 5; // 200ms fade
      const op = Math.min(1, w.fadeProgress);
      const mats = w.fadeMats;
      if (mats) {
        for (let j = 0; j < mats.length; j++) mats[j].opacity = op;
      }
      if (op >= 1) {
        w.fadeState = 0;
        if (mats) {
          for (let j = 0; j < mats.length; j++) { mats[j].transparent = false; mats[j].opacity = 1; }
        }
      }
    }

    // Walking phase
    if (w.progress <= 1 && !w.arrived) {
      // Urgent walkers move 1.6x faster
      const speed = (w.unitsPerSec ?? 5) * (w.urgent ? 1.6 : 1);
      const pl = w.pathLength ?? 1;
      w.progress += speed * deltaSec / Math.max(pl, 1);
      const t = Math.min(w.progress, 1);
      const pos = interpolatePath(activePath, t, activeCumDist);

      // Apply lateral offset perpendicular to direction of travel.
      // The offset keeps parallel walkers from overlapping, but it pushes the
      // body PERPENDICULAR to travel with no collision check against the walls
      // the path so carefully routed around. The narrow bits — the desk exit,
      // the doorways, the target approach — all sit at the path's ends, so a
      // non-zero offset there shoves the walker straight through a wall (the
      // user-reported "atraviesan paredes"). Ramp the offset to zero over the
      // first/last 18% of the route: doors and desks stay dead-center while the
      // wide corridor middle still gets the anti-overlap spread.
      const angle = pathDirection(activePath, t, activeCumDist);
      const taper = Math.max(0, Math.min(1, t / 0.18, (1 - t) / 0.18));
      const off = (w.lateralOffset ?? 0) * taper;
      const px = pos.x + Math.cos(angle) * off;
      const pz = pos.z - Math.sin(angle) * off;
      // Use the interpolated Y from the path so commute walkers with an
      // outdoor prefix rise from street level (-streetDrop) up to the plinth
      // (Y=0) as they climb the staircase. For all-indoor paths this is a
      // no-op since every waypoint has y=0.
      w.group.position.set(px, pos.y ?? 0, pz);
      w.group.rotation.y = angle;

      // Urgent = running animation, normal = walking
      if (w.urgent) animateRun(w, deltaSec);
      else animateWalk(w, deltaSec);
    }

    // Arrived at target — start talking phase
    if (w.progress > 1 && !w.arrived && !w.returning) {
      w.arrived = true;
      w.arrivedSec = 0;
      // Snap to final position (no lateral offset)
      const finalPt = activePath[activePath.length - 1];
      w.group.position.set(finalPt.x, 0, finalPt.z);
      // Face the seated target worker (or, for meeting walkers, the table
      // centroid passed in via talkFacingPos).
      if (w.talkFacingPos) {
        const dx = w.talkFacingPos.x - finalPt.x;
        const dz = w.talkFacingPos.z - finalPt.z;
        w.group.rotation.y = Math.atan2(dx, dz);
      }
      // Reset walking limbs
      w.leftLeg.rotation.x = 0; w.rightLeg.rotation.x = 0;
      w.group.position.y = 0;

      // Meeting + My Office arrivals: drop into a seated pose so the room
      // actually looks like a meeting (not people standing/sitting on the
      // floor). Lower the group to chair height + bend the legs forward and
      // let the arms rest. The animation loop below leaves these alone for
      // `meeting`/`myoffice`, so the pose persists until the return is triggered.
      if (w.targetId === 'meeting' || w.targetId === 'myoffice') {
        w.group.position.y = -0.45;          // chair height drop
        w.leftLeg.rotation.x = -1.4;          // hips folded forward (~80°)
        w.rightLeg.rotation.x = -1.4;
        w.leftArm.rotation.x = -0.25;         // hands resting on the table
        w.rightArm.rotation.x = -0.25;
        w.torso.rotation.x = 0.05;            // slight forward lean
      }

      onArrival?.(w.targetId);

      // One-shot per-walker callback (e.g. "drop note on the top agent's desk").
      // The carried envelope is part of the right hand — dispose it now so the
      // walker visibly hands the note off to the desk stack at the same beat.
      if (!w.onArriveFired && w.onArriveCallback) {
        w.onArriveFired = true;
        try { w.onArriveCallback(); }
        catch { /* swallow — animation glue must never break the walk loop */ }
        if (w.envelope && w.envelope.parent) {
          w.envelope.parent.remove(w.envelope);
          w.envelope.geometry?.dispose();
          if (Array.isArray(w.envelope.material)) {
            for (const m of w.envelope.material) m.dispose?.();
          } else {
            w.envelope.material?.dispose();
          }
          w.envelope = { parent: null, geometry: { dispose() {} }, material: { dispose() {} } };
        }
      }

      if (w.bubble && w.bubble.parent) w.bubble.parent.remove(w.bubble);
    }

    // Talking/standing phase: most walkers auto-return after a short timeout.
    // Meeting walkers stay until manually dismissed via removeArrivedWalkers
    // (the kernel emits meeting_ended when the LLM-driven conversation wraps).
    if (w.arrived && !w.returning) {
      w.arrivedSec = (w.arrivedSec ?? 0) + deltaSec;

      // One-way commute walkers (LEAVE / ARRIVE): no talking, no return.
      // After a brief pause, ramp opacity to zero and despawn. ARRIVE walkers
      // also reveal the seated worker so the agent appears to "sit down".
      if (w.oneWay) {
        const mats = w.fadeMats;
        if (w.arrivedSec! >= 0.25 && w.fadeState !== 2) {
          w.fadeState = 2;
          w.fadeProgress = 0;
          if (mats) for (let j = 0; j < mats.length; j++) mats[j].transparent = true;
        }
        if (w.fadeState === 2) {
          w.fadeProgress = (w.fadeProgress ?? 0) + deltaSec * 3; // ~0.33s fade
          const op = Math.max(0, 1 - w.fadeProgress);
          if (mats) for (let j = 0; j < mats.length; j++) mats[j].opacity = op;
          if (op <= 0) {
            if (w.restoreSeatedOnArrive && sittingWorkers) {
              const seated = sittingWorkers.get(w.sourceId);
              if (seated) seated.setVisible(true);
            }
            scene.remove(w.group);
            w.group.traverse((c: any) => { c.geometry?.dispose(); c.material?.dispose(); });
            walkers.splice(i, 1);
          }
        }
        continue;
      }

      // Animate talking/idle while standing — but NOT for seated meeting /
      // My Office walkers; the arrival code above already locked them into a
      // seated pose and animateTalking would un-bend the legs every frame.
      if (w.targetId !== 'meeting' && w.targetId !== 'myoffice') {
        animateTalking(w as any, w.arrivedSec!, w.talkPhase ?? 0);
      }

      // Auto-return timers. Meetings get a generous safety window — the LLM-
      // backed real meetings can take 60–120s to play out and the kernel is
      // responsible for sending them home via the meeting_ended event. The
      // 30s cap that lived here used to evict walkers mid-conversation.
      // stayAtTarget walkers (real meeting attendees) NEVER auto-return:
      // they sit until removeArrivedWalkers() dismisses them (meeting_ended
      // event or the End Meeting button). The age>maxAge safety below still
      // walks them home if that signal never arrives.
      const autoReturnSec =
        w.targetId === 'meeting' ? 600.0
        : w.targetId === 'myoffice' ? 9.0   // sit, file the report, then leave
        : w.targetId === 'infra' ? 6.0      // operate the power console, then leave
        : 2.0;

      if (!w.stayAtTarget && w.arrivedSec! > autoReturnSec) {
        w.returning = true;
        w.progress = 0;
        w.arrived = false;
        w.arrivedSec = 0;
        // Stand up: clear the seated pose so the return walk starts clean
        // (otherwise the bent legs + chair-height drop carry into the walk).
        w.group.position.y = 0;
        w.leftLeg.rotation.x = 0; w.rightLeg.rotation.x = 0;
        w.leftArm.rotation.x = 0; w.rightArm.rotation.x = 0;
        w.torso.rotation.x = 0;
        // Drop the envelope
        if (w.envelope.parent) w.envelope.parent.remove(w.envelope);
        w.envelope.geometry?.dispose(); w.envelope.material?.dispose();
        if (w.bubble) {
          if (w.bubble.parent) w.bubble.parent.remove(w.bubble);
          if (w.bubble.element) w.bubble.element.remove();
        }
      }
    }

    // Returned home — fade out, restore seated worker, then remove
    if (w.returning && w.progress > 1) {
      w.leftLeg.rotation.x = 0; w.rightLeg.rotation.x = 0;
      w.leftArm.rotation.x = 0; w.rightArm.rotation.x = 0;
      w.torso.rotation.x = 0; w.torso.rotation.z = 0; // reset run lean
      w.head.rotation.x = 0;
      const mats = w.fadeMats;
      if (w.fadeState !== 2) {
        w.fadeState = 2;
        w.fadeProgress = 0;
        if (mats) for (let j = 0; j < mats.length; j++) mats[j].transparent = true;
      }
      w.fadeProgress = (w.fadeProgress ?? 0) + deltaSec * 5;
      const op = Math.max(0, 1 - w.fadeProgress);
      if (mats) for (let j = 0; j < mats.length; j++) mats[j].opacity = op;

      if (op <= 0) {
        // Restore seated source worker
        if (sittingWorkers) {
          const seatedSrc = sittingWorkers.get(w.sourceId);
          if (seatedSrc) seatedSrc.setVisible(true);
        }
        // Clean up bubble DOM element if still around
        if (w.bubble?.element) w.bubble.element.remove();
        scene.remove(w.group);
        w.group.traverse((c: any) => { c.geometry?.dispose(); c.material?.dispose(); });
        walkers.splice(i, 1);
      }
    }

    // Safety: walker has lived too long. There are two reasons this fires:
    //   1. The walker is genuinely stuck mid-walk (path glitch, race) — we
    //      have to dispose it to keep the office from filling with corpses.
    //   2. The walker arrived at a destination that waits for an external
    //      "go home" signal (e.g. urgent reports targetId='meeting' wait for
    //      a kernel `meeting_ended` event that never comes for non-meeting
    //      visits). In that case the walker just sat there until age hit
    //      maxAge, and we used to force-kill it — leaving the source desk
    //      "empty" visually until the seated worker was restored.
    //
    // The polite fix: if the walker has arrived but never returned, FLIP it
    // into the return-walk state (same path it would have taken on a normal
    // auto-return). The natural fade-out at progress > 1 cleans up properly,
    // and the user sees the agent walk back home like every other walker.
    // Only walkers that are actually stuck mid-walk (never arrived, or
    // already returning and still over budget) get the hard dispose.
    if (w.age > w.maxAge) {
      const canStillReturn = w.arrived && !w.returning && w.returnCurve && w.returnCurve.length >= 2;
      if (canStillReturn) {
        w.returning = true;
        w.progress = 0;
        w.arrived = false;
        w.arrivedSec = 0;
        // Reset seated pose so animateWalking starts clean — copied from
        // removeArrivedWalkers' meeting-dismiss logic.
        w.group.position.y = 0;
        w.leftLeg.rotation.x = 0;
        w.rightLeg.rotation.x = 0;
        w.leftArm.rotation.x = 0;
        w.rightArm.rotation.x = 0;
        w.torso.rotation.x = 0;
        // Give the return walk + fade a fresh 20s budget so this safety
        // path doesn't immediately re-fire on the next frame.
        w.age = 0;
        w.maxAge = 20;
        // Drop any envelope still attached.
        if (w.envelope?.parent) w.envelope.parent.remove(w.envelope);
        if (w.bubble?.element) w.bubble.element.remove();
      } else {
        if (sittingWorkers) {
          const seatedSrc = sittingWorkers.get(w.sourceId);
          if (seatedSrc) seatedSrc.setVisible(true);
        }
        if (w.bubble?.element) w.bubble.element.remove();
        scene.remove(w.group);
        w.group.traverse((c: any) => { c.geometry?.dispose(); c.material?.dispose(); });
        walkers.splice(i, 1);
      }
    }
  }
}

/** Send all walkers that are sitting at `targetId` back to their desks with a
 *  proper return-walk animation. Used for ending meetings.
 *
 *  Subtle but important: long meetings (60–120s of LLM chatter) push the
 *  walker's `age` well past any reasonable return-walk budget, so we MUST
 *  reset `age` to 0 here. Without that reset, the safety cleanup at line
 *  ~594 (`if (w.age > w.maxAge)`) fires on the first frame after this call
 *  and force-removes the walker before `updateWalkers` can animate it along
 *  `returnCurve` — the visible symptom is "walkers teleport to desks
 *  instead of walking back". We also reset the seated-pose offsets (chair
 *  drop on Y, folded legs/arms) so the walking animation starts from a
 *  natural standing pose. */
export function removeArrivedWalkers(
  scene: any,
  walkers: Walker[],
  targetId: string,
  // Optional predicate — when set, only walkers passing it are sent home.
  // Used by ad-hoc cross-office coordinations so the dismiss fires for the
  // two coord participants without disturbing real LLM meeting walkers that
  // share the same targetId='meeting'.
  filter?: (w: Walker) => boolean,
): void {
  for (let i = walkers.length - 1; i >= 0; i--) {
    const w = walkers[i];
    if (w.targetId === targetId && w.arrived && (!filter || filter(w))) {
      w.returning = true;
      w.progress = 0;
      w.arrived = false;
      // Reset the seated pose so walkAnimation starts from a clean standing
      // posture; otherwise the walker tries to walk while folded into a chair.
      w.group.position.y = 0;
      w.leftLeg.rotation.x = 0;
      w.rightLeg.rotation.x = 0;
      w.leftArm.rotation.x = 0;
      w.rightArm.rotation.x = 0;
      w.torso.rotation.x = 0;
      // Fresh 20s budget for the return walk + fade. The previous code only
      // changed maxAge, leaving age at its accumulated value (often >60s for
      // long meetings) → instant force-cleanup.
      w.age = 0;
      w.maxAge = 20;
      if (w.bubble && w.bubble.parent) w.bubble.parent.remove(w.bubble);
    }
  }
}

/**
 * Sync seated worker visibility with active walkers.
 * Call this after rebuildScene creates fresh sittingWorkers —
 * any agent that has an active walker (not yet returned) must have
 * its seated worker hidden to prevent the duplicate-humanoid bug.
 */
export function syncSeatedVisibility(walkers: Walker[], sittingWorkers: SittingWorkers): void {
  for (const w of walkers) {
    const seated = sittingWorkers.get(w.sourceId);
    if (seated) seated.setVisible(false);
  }
}
