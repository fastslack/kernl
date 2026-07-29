/**
 * Desk-note stack — a persistent pile of paper "reports" that accumulates on
 * the top agent's desk as office leaders walk in to drop them off.
 *
 * Each `dropNote()` call adds a small paper sheet to the stack with a brief
 * fall + settle animation. Notes survive after the animation completes — they
 * stay parented to the scene as flat boxes on the desk surface — so the user
 * can see a literal paperwork backlog grow throughout the day. The stack is
 * capped at `maxNotes` (FIFO eviction) so it never overflows the desk.
 */

import type { Vec3 } from '../../types.js';
import type { AnimationRegistry, Ticker } from '../registry.js';
import { getThree } from './_init.js';

export interface NoteStack {
  /** Drop a single note with a tinted band identifying the sender's flow. */
  dropNote(opts?: { color?: string; tag?: string }): void;
  /** Remove every note + ticker (called when the scene is rebuilt). */
  clear(): void;
  /** Current resting count — handy for tests / perf overlays. */
  size(): number;
}

export interface NoteStackOpts {
  /** World-space center of the desk surface where notes pile up. */
  basePos: Vec3;
  /** Scene/parent the note meshes attach to. */
  scene: any;
  /** Animation registry — the drop tween parks itself here. */
  registry: AnimationRegistry;
  /** FIFO cap (oldest evicted). Default 8. */
  maxNotes?: number;
}

interface RestingNote {
  mesh: any;
  band: any;
  /** Slot index in the stack (0 = bottom). Used to recompute Y on eviction. */
  slot: number;
}

const NOTE_W = 0.28;
const NOTE_D = 0.36;
const NOTE_H = 0.012;            // very thin sheet
const STACK_GAP = 0.002;          // microscopic gap so adjacent sheets don't z-fight
const SLOT_DROP_HEIGHT = 1.2;     // how high above the desk the note spawns
const DROP_DURATION_SEC = 0.55;   // fall + settle
const PAPER_COLOR = 0xf2eeda;     // off-white — old-school report stock
const PAPER_EMISSIVE = 0x000000;

export function createNoteStack(opts: NoteStackOpts): NoteStack {
  const THREE = getThree();
  const maxNotes = opts.maxNotes ?? 8;
  const { basePos, scene, registry } = opts;

  const notes: RestingNote[] = [];
  let dropCounter = 0;

  function stackY(slot: number): number {
    return basePos.y + (NOTE_H / 2) + slot * (NOTE_H + STACK_GAP);
  }

  function disposeNote(n: RestingNote): void {
    if (n.mesh.parent) n.mesh.parent.remove(n.mesh);
    n.mesh.geometry?.dispose();
    if (Array.isArray(n.mesh.material)) {
      for (const m of n.mesh.material) m.dispose?.();
    } else {
      n.mesh.material?.dispose();
    }
    if (n.band) {
      if (n.band.parent) n.band.parent.remove(n.band);
      n.band.geometry?.dispose();
      n.band.material?.dispose();
    }
  }

  return {
    dropNote(o?: { color?: string; tag?: string }) {
      // Pre-evict the oldest if the stack would overflow. We do this BEFORE
      // spawning so the new note's resting slot is always free.
      while (notes.length >= maxNotes) {
        const old = notes.shift()!;
        registry.cancelByTag(`desk-note-drop:${old.slot}`);
        disposeNote(old);
      }
      // Re-slot any survivors so the bottom of the pile is always slot 0.
      for (let i = 0; i < notes.length; i++) {
        notes[i].slot = i;
        notes[i].mesh.position.y = stackY(i);
      }

      const slot = notes.length;
      const id = dropCounter++;
      const tag = o?.tag ?? `desk-note-drop:${slot}-${id}`;
      // Slight per-note jitter so the pile looks lived-in rather than CAD-aligned.
      const jitterX = (Math.random() - 0.5) * 0.04;
      const jitterZ = (Math.random() - 0.5) * 0.04;
      const jitterRot = (Math.random() - 0.5) * 0.18;
      const finalY = stackY(slot);
      const finalPos = {
        x: basePos.x + jitterX,
        y: finalY,
        z: basePos.z + jitterZ,
      };

      const paperMat = new THREE.MeshStandardMaterial({
        color: PAPER_COLOR,
        emissive: PAPER_EMISSIVE,
        roughness: 0.85,
        metalness: 0.02,
      });
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(NOTE_W, NOTE_H, NOTE_D),
        paperMat,
      );
      mesh.position.set(finalPos.x, finalY + SLOT_DROP_HEIGHT, finalPos.z);
      mesh.rotation.y = jitterRot;
      scene.add(mesh);

      // Coloured band along the top edge — sender's flow color, so the
      // top agent can eyeball who delivered which report.
      let band: any = null;
      if (o?.color) {
        const bandMat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(o.color),
          roughness: 0.6, metalness: 0.05,
        });
        band = new THREE.Mesh(
          new THREE.BoxGeometry(NOTE_W * 0.92, NOTE_H + 0.001, 0.05),
          bandMat,
        );
        band.position.set(0, NOTE_H * 0.4, -NOTE_D / 2 + 0.04);
        mesh.add(band);
      }

      const resting: RestingNote = { mesh, band, slot };
      notes.push(resting);

      const startY = mesh.position.y;
      const startRotZ = (Math.random() - 0.5) * 0.6; // wobble during the fall
      mesh.rotation.z = startRotZ;
      let elapsed = 0;

      const ticker: Ticker = {
        tag,
        update(deltaSec: number): boolean {
          elapsed += deltaSec;
          const t = Math.min(elapsed / DROP_DURATION_SEC, 1);
          // ease-in (gravity-ish) → ease-out (settle)
          const eased = t < 0.85
            ? Math.pow(t / 0.85, 2)              // accelerate as it falls
            : 1 - Math.pow(1 - (t - 0.85) / 0.15, 3) * 0.04; // tiny overshoot
          mesh.position.y = startY + (finalY - startY) * eased;
          // Wobble decays as the sheet approaches the desk.
          mesh.rotation.z = startRotZ * (1 - t);
          if (t >= 1) {
            mesh.position.y = finalY;
            mesh.rotation.z = 0;
            return true;
          }
          return false;
        },
      };
      registry.add(ticker);
    },

    clear() {
      for (const n of notes) {
        registry.cancelByTag(`desk-note-drop:${n.slot}`);
        disposeNote(n);
      }
      notes.length = 0;
    },

    size() {
      return notes.length;
    },
  };
}
