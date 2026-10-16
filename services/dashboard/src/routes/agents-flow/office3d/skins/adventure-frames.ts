/** Camera-relative sprite directions and time-based cel selection. */
export type AdventureAction = 'idle' | 'walk' | 'typing' | 'talk' | 'stretch';
export const ADVENTURE_ACTIONS: AdventureAction[] = ['idle', 'walk', 'typing', 'talk', 'stretch'];
export const SPRITE_W = 48;
export const SPRITE_H = 96;
export const SPRITE_FRAMES = 8;
export const SPRITE_DIRECTIONS = 3;

export function adventureFrame(action: AdventureAction, seconds: number, relativeAngle: number) {
  const angle = Math.atan2(Math.sin(relativeAngle), Math.cos(relativeAngle));
  const direction = Math.abs(angle) < Math.PI / 4 ? 0 : Math.abs(angle) > Math.PI * 3 / 4 ? 2 : 1;
  const fps = action === 'walk' ? 10 : action === 'typing' ? 8 : action === 'idle' ? 2 : 6;
  return {
    column: ((Math.floor(seconds * fps) % SPRITE_FRAMES) + SPRITE_FRAMES) % SPRITE_FRAMES,
    row: ADVENTURE_ACTIONS.indexOf(action) * SPRITE_DIRECTIONS + direction,
    mirrored: direction === 1 && angle > 0,
  };
}
