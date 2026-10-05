import { describe, it, expect } from 'bun:test';
import { extractChoices, choicesAsText, MAX_CHOICES } from './chat-choices';

const reply = (json: string) => `Depende de tu objetivo.\n\n\`\`\`choices\n${json}\n\`\`\``;

describe('extractChoices', () => {
  it('cuts the block out and returns question and options', () => {
    const r = extractChoices(reply('{"question":"¿Qué querés?","options":["A","B","C"]}'));
    expect(r.body).toBe('Depende de tu objetivo.');
    expect(r.choices).toEqual({ question: '¿Qué querés?', options: ['A', 'B', 'C'] });
  });

  it('accepts a bare array and {label} objects', () => {
    expect(extractChoices(reply('["A","B"]')).choices).toEqual({ question: '', options: ['A', 'B'] });
    expect(extractChoices(reply('{"options":[{"label":"A"},{"label":"B"}]}')).choices?.options).toEqual(['A', 'B']);
  });

  it('leaves text without a block alone', () => {
    expect(extractChoices('hola')).toEqual({ body: 'hola', choices: null });
    expect(extractChoices(null)).toEqual({ body: '', choices: null });
  });

  it('keeps a malformed block in the text', () => {
    const src = reply('{"options":[A, B]}');
    expect(extractChoices(src)).toEqual({ body: src, choices: null });
  });

  it('needs at least two distinct options and caps the list', () => {
    expect(extractChoices(reply('["A","A"]')).choices).toBeNull();
    const many = JSON.stringify(Array.from({ length: 10 }, (_, i) => `O${i}`));
    expect(extractChoices(reply(many)).choices?.options.length).toBe(MAX_CHOICES);
  });
});

describe('choicesAsText', () => {
  it('renders the options as a numbered list', () => {
    expect(choicesAsText(reply('{"question":"¿Cuál?","options":["A","B"]}')))
      .toBe('Depende de tu objetivo.\n\n¿Cuál?\n\n1. A\n2. B');
  });
});
