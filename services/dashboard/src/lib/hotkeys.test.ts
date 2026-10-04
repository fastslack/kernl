import { describe, it, expect } from 'bun:test';
import { musicHotkeyFor, musicHotkeyPreventsDefault, altDigitIndex, isTypingTarget } from './hotkeys.js';

describe('musicHotkeyFor', () => {
  it('maps the arrows, with Shift turning skip into seek', () => {
    expect(musicHotkeyFor('ArrowRight', false)).toEqual({ kind: 'next' });
    expect(musicHotkeyFor('ArrowRight', true)).toEqual({ kind: 'seek', by: 10 });
    expect(musicHotkeyFor('ArrowLeft', false)).toEqual({ kind: 'prev' });
    expect(musicHotkeyFor('ArrowLeft', true)).toEqual({ kind: 'seek', by: -10 });
    expect(musicHotkeyFor('ArrowUp', false)).toEqual({ kind: 'volume', by: 0.05 });
    expect(musicHotkeyFor('ArrowDown', false)).toEqual({ kind: 'volume', by: -0.05 });
  });

  it('maps the letters in either case', () => {
    for (const [k, kind] of [['m', 'mute'], ['n', 'next'], ['p', 'prev'], ['f', 'fullscreen']] as const) {
      expect(musicHotkeyFor(k, false)).toEqual({ kind });
      expect(musicHotkeyFor(k.toUpperCase(), true)).toEqual({ kind });
    }
    expect(musicHotkeyFor(' ', false)).toEqual({ kind: 'toggle' });
  });

  it('ignores anything else', () => {
    expect(musicHotkeyFor('x', false)).toBeNull();
    expect(musicHotkeyFor('Enter', false)).toBeNull();
  });
});

describe('musicHotkeyPreventsDefault', () => {
  it('swallows only the keys that would scroll the page', () => {
    expect(musicHotkeyPreventsDefault(' ')).toBe(true);
    expect(musicHotkeyPreventsDefault('ArrowUp')).toBe(true);
    expect(musicHotkeyPreventsDefault('ArrowDown')).toBe(true);
    expect(musicHotkeyPreventsDefault('ArrowRight')).toBe(false);
    expect(musicHotkeyPreventsDefault('m')).toBe(false);
  });
});

describe('altDigitIndex', () => {
  const k = (key: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey', boolean>> = {}) =>
    ({ key, altKey: false, ctrlKey: false, metaKey: false, ...mods });

  it('turns Alt+1…9 into a zero-based index', () => {
    expect(altDigitIndex(k('1', { altKey: true }))).toBe(0);
    expect(altDigitIndex(k('9', { altKey: true }))).toBe(8);
  });
  it('needs Alt alone', () => {
    expect(altDigitIndex(k('1'))).toBeNull();
    expect(altDigitIndex(k('1', { altKey: true, ctrlKey: true }))).toBeNull();
    expect(altDigitIndex(k('1', { altKey: true, metaKey: true }))).toBeNull();
  });
  it('ignores 0 and non-digits', () => {
    expect(altDigitIndex(k('0', { altKey: true }))).toBeNull();
    expect(altDigitIndex(k('a', { altKey: true }))).toBeNull();
  });
});

describe('isTypingTarget', () => {
  const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as HTMLElement;
  it('is true for inputs, textareas and contenteditable', () => {
    expect(isTypingTarget(el('INPUT'))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('DIV', true))).toBe(true);
  });
  it('is false for anything else, or no target', () => {
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
