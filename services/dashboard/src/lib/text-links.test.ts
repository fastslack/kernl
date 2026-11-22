import { describe, expect, it } from 'bun:test';
import { textLinks } from './text-links.js';

describe('textLinks', () => {
  it('turns the URL a refusal ends at into a link', () => {
    expect(textLinks('elegí ese repo y probá de nuevo: https://github.com/settings/personal-access-tokens')).toEqual([
      { text: 'elegí ese repo y probá de nuevo: ' },
      { text: 'https://github.com/settings/personal-access-tokens', href: 'https://github.com/settings/personal-access-tokens' },
    ]);
  });

  it('leaves the punctuation that closes the sentence out of the link', () => {
    expect(textLinks('mirá https://gitlab.com/a/b/-/project_members.')).toEqual([
      { text: 'mirá ' },
      { text: 'https://gitlab.com/a/b/-/project_members', href: 'https://gitlab.com/a/b/-/project_members' },
      { text: '.' },
    ]);
  });

  it('finds several, and leaves text without one alone', () => {
    expect(textLinks('https://x.io/1 y https://x.io/2').filter((p) => p.href).map((p) => p.href)).toEqual(['https://x.io/1', 'https://x.io/2']);
    expect(textLinks('sin links')).toEqual([{ text: 'sin links' }]);
    expect(textLinks('')).toEqual([]);
  });

  it('only links http(s)', () => {
    expect(textLinks('javascript:alert(1)')).toEqual([{ text: 'javascript:alert(1)' }]);
  });
});
