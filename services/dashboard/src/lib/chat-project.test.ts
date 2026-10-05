import { describe, it, expect } from 'bun:test';
import { chatProjectChoices, defaultChatProject } from './chat-project';

const acme = { slug: 'acme', name: 'Acme', status: 'active' };
const mini = { slug: 'miniatura', name: 'Miniatura', status: 'active' };
const old = { slug: 'old', name: 'Old', status: 'paused' };

describe('chatProjectChoices', () => {
  it('offers the active projects assigned to the office', () => {
    const office = { projects: [{ active: true, project: acme }, { active: false, project: mini }, { active: true, project: old }] };
    expect(chatProjectChoices(office, null)).toEqual([{ slug: 'acme', name: 'Acme' }]);
  });

  it('offers every active project when the office is shared', () => {
    const office = { serves_any: true, projects: [{ active: true, project: mini }] };
    expect(chatProjectChoices(office, { projects: [acme, mini, old] }).map((p) => p.slug)).toEqual(['acme', 'miniatura']);
  });

  it('is empty without data', () => {
    expect(chatProjectChoices(null, null)).toEqual([]);
  });
});

describe('defaultChatProject', () => {
  const two = [{ slug: 'acme', name: 'Acme' }, { slug: 'miniatura', name: 'Miniatura' }];
  it('takes the only project', () => {
    expect(defaultChatProject([two[0]], null)).toBe('acme');
  });
  it('restores the last pick only when still offered', () => {
    expect(defaultChatProject(two, 'miniatura')).toBe('miniatura');
    expect(defaultChatProject(two, 'gone')).toBe('');
    expect(defaultChatProject(two, null)).toBe('');
  });
});
