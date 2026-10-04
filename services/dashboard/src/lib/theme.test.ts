import { describe, it, expect } from 'bun:test';
import { themeVarsCss, withThemeClass } from './theme.js';
import type { ActiveTheme } from './stores.js';

const theme = (over: Partial<ActiveTheme> = {}): ActiveTheme => ({
  name: 'CRT', slug: 'crt-terminal', icon: '', variables: {}, fonts: [], customCss: '', previewColors: [],
  ...over,
});

describe('themeVarsCss', () => {
  it('is empty without a theme', () => {
    expect(themeVarsCss(null)).toBe('');
  });
  it('puts every variable on :root', () => {
    expect(themeVarsCss(theme({ variables: { '--bg': '#000', '--teal': '#0f0' } })))
      .toBe(':root{--bg:#000;--teal:#0f0}');
  });
});

describe('withThemeClass', () => {
  it('replaces a previous theme class and keeps the rest', () => {
    expect(withThemeClass('dark theme-old other', 'crt-terminal')).toBe('dark other theme-crt-terminal');
  });
  it('only removes theme classes when there is no slug', () => {
    expect(withThemeClass('dark theme-old', undefined)).toBe('dark');
  });
  it('handles an empty body class', () => {
    expect(withThemeClass('', 'x')).toBe('theme-x');
    expect(withThemeClass('', undefined)).toBe('');
  });
});
