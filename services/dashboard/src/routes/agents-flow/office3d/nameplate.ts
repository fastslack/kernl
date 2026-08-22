/**
 * The chip floating over an agent's head.
 *
 * One builder, because there used to be none: the desk renderer wrote this
 * markup inline and the top agent — placed by a different code path — got no
 * chip at all, so the highest-ranked agent in the building was the one figure
 * on the floor you could not identify.
 *
 * Design notes, since "make the labels consistent" is the whole point of the
 * file existing:
 *
 *   · ONE line. Rank insignia, status dot and name sit inline instead of the
 *     old stacked block whose insignia row grew from 7px to 18px with rank —
 *     that alone made two agents at the same table look like different UI.
 *   · The rank colour is a hairline border and the insignia's own colour, not
 *     a 2px underline. At a distance the underline was the loudest thing on
 *     screen and it read as an error state.
 *   · Fixed type size. Distance is expressed by scaling the whole chip from
 *     the host's render loop, so the internal proportions never change.
 *   · Badges (PENDING / REVISION) stay, compacted, and only when they apply.
 */

export interface NameplateRank {
  name: string;
  color: string;
  insignia: string;
  level: number;
}

export interface NameplateOpts {
  agentId: string;
  name: string;
  /** Flow colour, used when the agent has no rank. */
  color: string;
  active: boolean;
  rank?: NameplateRank;
  underRevision?: boolean;
  /** Render the ⏻ activate/deactivate button (hidden until hover). */
  powerChip?: boolean;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

/** Height above the floor the chip should float at. */
export const NAMEPLATE_HEIGHT = 2.6;

/**
 * Build the chip element. The caller wraps it in a CSS2DObject; the returned
 * node's FIRST CHILD is the scalable inner wrapper the render loop transforms,
 * so keep that structure if you touch this.
 */
export function buildNameplate(opts: NameplateOpts): HTMLDivElement {
  const { name, color, active, rank, underRevision, powerChip } = opts;
  const accent = rank?.color ?? color;

  const insignia = rank
    ? `<span style="font:800 10px/1 'Manrope',sans-serif;color:${accent};` +
      `letter-spacing:-0.5px;flex:none" title="${esc(rank.name)}">${esc(rank.insignia)}</span>`
    : "";

  const dot =
    `<span style="width:6px;height:6px;border-radius:50%;flex:none;` +
    `background:${active ? "#3dd68c" : "#6b7088"};` +
    `${active ? "box-shadow:0 0 4px #3dd68c" : ""}"></span>`;

  const badge = (text: string, bg: string) =>
    `<span style="flex:none;background:${bg};color:#12161f;font:700 7px/1 'Manrope',sans-serif;` +
    `letter-spacing:0.3px;padding:2px 4px;border-radius:2px">${text}</span>`;

  const badges =
    (!active ? badge("PEND", "#facc15") : "") +
    (underRevision ? badge("REV", "#fb923c") : "");

  const power = powerChip
    ? `<button class="dl-power" data-agent="${esc(opts.agentId)}" data-active="${active ? 1 : 0}" ` +
      `title="${active ? "Deactivate agent" : "Activate agent"}" ` +
      `style="pointer-events:auto;cursor:pointer;display:none;flex:none;` +
      `border:none;border-radius:3px;padding:0 4px;font:700 9px 'Manrope',sans-serif;` +
      `background:${active ? "rgba(239,68,68,0.18)" : "rgba(61,214,140,0.20)"};` +
      `color:${active ? "#ff6b6b" : "#3dd68c"};">⏻</button>`
    : "";

  const el = document.createElement("div");
  el.className = "agent-nameplate";
  el.innerHTML =
    `<div style="display:inline-flex;align-items:center;gap:5px;` +
    `background:rgba(13,16,25,${active ? 0.82 : 0.6});` +
    `border:1px solid ${accent}${active ? "66" : "33"};` +
    `border-radius:5px;padding:2px 7px;white-space:nowrap;` +
    `box-shadow:0 1px 4px rgba(0,0,0,0.45);` +
    `font:600 10px/1.35 'Manrope',sans-serif;` +
    `color:${active ? "#e6e9f2" : "#98a0b3"};opacity:${active ? 1 : 0.75}">` +
    `${badges}${insignia}${dot}<span>${esc(name)}</span>${power}</div>`;
  return el;
}
