import { describe, it, expect } from 'bun:test';
import { parseVtt, phaseLabel, relativeAge } from '../assets/extensions/_shared/media/subs-client.js';
import {
  loadCaptionStyle,
  captionInlineStyle,
  DEFAULT_CAPTION_STYLE,
  CAPTION_FAMILIES,
} from '../assets/extensions/_shared/media/caption-style.js';

/**
 * The shared media module is what /cinema, /tv and /torrents all render their
 * subtitles through, so a regression here is a regression in three players at
 * once. These cover the pure surface — parsing and formatting; the controller
 * itself needs a DOM and is exercised by the players' own suites.
 */

describe('parseVtt', () => {
  const VTT = [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:03.500',
    'Hello there',
    '',
    '00:00:04.000 --> 00:00:06.000',
    'Second line',
    '',
  ].join('\n');

  it('reads a plain WebVTT file', () => {
    const cues = parseVtt(VTT);
    expect(cues.length).toBe(2);
    expect(cues[0]).toEqual({ start: 1, end: 3.5, text: 'Hello there' });
    expect(cues[1].text).toBe('Second line');
  });

  it('tolerates CRLF — subtitle files travel across platforms', () => {
    expect(parseVtt(VTT.replace(/\n/g, '\r\n')).length).toBe(2);
  });

  it('accepts SRT comma decimals and numeric index lines', () => {
    const srt = '1\n00:00:02,250 --> 00:00:05,000\nComma decimals\n\n';
    const cues = parseVtt(srt);
    expect(cues.length).toBe(1);
    expect(cues[0].start).toBeCloseTo(2.25, 3);
    expect(cues[0].end).toBe(5);
    expect(cues[0].text).toBe('Comma decimals');
  });

  it('accepts MM:SS timestamps without an hours field', () => {
    const cues = parseVtt('WEBVTT\n\n01:05.000 --> 01:08.000\nShort form\n');
    expect(cues[0].start).toBe(65);
    expect(cues[0].end).toBe(68);
  });

  it('keeps multi-line cues as one cue with the break intact', () => {
    const cues = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfirst\nsecond\n');
    expect(cues.length).toBe(1);
    expect(cues[0].text).toBe('first\nsecond');
  });

  it('returns nothing for junk instead of throwing', () => {
    expect(parseVtt('')).toEqual([]);
    expect(parseVtt('not a subtitle file at all')).toEqual([]);
    // A header with no cues is valid but empty.
    expect(parseVtt('WEBVTT\n\n')).toEqual([]);
  });

  it('skips a malformed timing block and keeps the rest', () => {
    const mixed = 'WEBVTT\n\nnot-a-timing\norphan text\n\n00:00:09.000 --> 00:00:10.000\nsurvivor\n';
    const cues = parseVtt(mixed);
    expect(cues.length).toBe(1);
    expect(cues[0].text).toBe('survivor');
  });
});

describe('phaseLabel', () => {
  it('names the pipeline phases a viewer sees', () => {
    expect(phaseLabel('extract')).toBe('Pulling audio');
    expect(phaseLabel('transcribe')).toBe('Transcribing');
    expect(phaseLabel('translate')).toBe('Translating');
  });

  it('humanises an unknown phase rather than showing a raw slug', () => {
    expect(phaseLabel('mastering')).toBe('Mastering');
  });

  it('never renders an empty label', () => {
    expect(phaseLabel('')).toBe('Working');
  });
});

describe('relativeAge', () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  it('describes cached-track ages in the units a human uses', () => {
    expect(relativeAge(now - 5_000, now)).toBe('just now');
    expect(relativeAge(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeAge(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  it('says nothing when the timestamp is unknown', () => {
    expect(relativeAge(undefined, now)).toBe('');
  });
});

describe('caption style', () => {
  it('falls back to the defaults when nothing is stored', () => {
    // No `window` in this runtime, so this exercises the SSR-safe path.
    expect(loadCaptionStyle()).toEqual(DEFAULT_CAPTION_STYLE);
  });

  it('renders the font, size, colour and backdrop the viewer chose', () => {
    const css = captionInlineStyle({
      ...DEFAULT_CAPTION_STYLE,
      fontSize: 40,
      fontFamily: 'serif',
      textColor: '#ffcc00',
      bgOpacity: 0.5,
    });
    expect(css).toContain('font-size:40px');
    expect(css).toContain('color:#ffcc00');
    expect(css).toContain(CAPTION_FAMILIES.serif);
    expect(css).toContain('rgba(0,0,0,0.50)');
  });

  it('drops the backdrop entirely at zero opacity — not a 0-alpha rectangle', () => {
    const css = captionInlineStyle({ ...DEFAULT_CAPTION_STYLE, bgOpacity: 0 });
    expect(css).toContain('background:transparent');
  });

  it('gives each edge style its own shadow, and none means none', () => {
    expect(captionInlineStyle({ ...DEFAULT_CAPTION_STYLE, edge: 'none' })).toContain('text-shadow:none');
    expect(captionInlineStyle({ ...DEFAULT_CAPTION_STYLE, edge: 'outline' })).toContain('-1px -1px 0 #000');
    expect(captionInlineStyle({ ...DEFAULT_CAPTION_STYLE, edge: 'shadow' })).toContain('0 2px 6px');
  });
});
