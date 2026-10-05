import { describe, it, expect } from 'bun:test';
import { chatProjectChoices, defaultChatProject } from './chat-project';

const heural = { slug: 'heural', name: 'Heural', status: 'active' };
const mini = { slug: 'miniatura', name: 'Miniatura', status: 'active' };
const old = { slug: 'old', name: 'Old', status: 'paused' };

describe('chatProjectChoices', () => {
  it('offers the active projects assigned to the office', () => {
    const office = { projects: [{ active: true, project: heural }, { active: false, project: mini }, { active: true, project: old }] };
    expect(chatProjectChoices(office, null)).toEqual([{ slug: 'heural', name: 'Heural' }]);
  });

  it('offers every active project when the office is shared', () => {
    const office = { serves_any: true, projects: [{ active: true, project: mini }] };
    expect(chatProjectChoices(office, { projects: [heural, mini, old] }).map((p) => p.slug)).toEqual(['heural', 'miniatura']);
  });

  it('is empty without data', () => {
    expect(chatProjectChoices(null, null)).toEqual([]);
  });
});

describe('defaultChatProject', () => {
  const two = [{ slug: 'heural', name: 'Heural' }, { slug: 'miniatura', name: 'Miniatura' }];
  it('takes the only project', () => {
    expect(defaultChatProject([two[0]], null)).toBe('heural');
  });
  it('restores the last pick only when still offered', () => {
    expect(defaultChatProject(two, 'miniatura')).toBe('miniatura');
    expect(defaultChatProject(two, 'gone')).toBe('');
    expect(defaultChatProject(two, null)).toBe('');
  });
});
