import { describe, it, expect } from 'bun:test';
import { railParentOf, railViewsFor, buildNav } from './nav.js';
import type { NavGroup, NavView } from './constants.js';

const VIEWS: NavView[] = [
  { id: 'settings', label: 'Settings', icon: '⚙️', order: 10 },
  { id: 'system', label: 'System', icon: '🖥️', order: 20 },
  { id: 'extensions', label: 'Extensions', icon: '🧩', order: 30 },
  { id: 'friends', label: 'Friends', icon: '🤝', parent: 'system', order: 30 },
  { id: 'architecture', label: 'Arch 3D', icon: '🧊', parent: 'system', order: 20 },
];

describe('railParentOf', () => {
  it('devuelve la vista misma cuando no tiene padre', () => {
    expect(railParentOf(VIEWS, 'system')).toBe('system');
  });

  it('devuelve el padre cuando la vista es hija', () => {
    expect(railParentOf(VIEWS, 'architecture')).toBe('system');
  });

  it('devuelve la vista misma cuando no está en la lista', () => {
    expect(railParentOf(VIEWS, 'desconocida')).toBe('desconocida');
  });
});

describe('railViewsFor', () => {
  it('pone al padre primero y ordena los hijos por order', () => {
    expect(railViewsFor(VIEWS, 'system').map((v) => v.id))
      .toEqual(['system', 'architecture', 'friends']);
  });

  it('parado en un hijo muestra los mismos hermanos', () => {
    expect(railViewsFor(VIEWS, 'architecture').map((v) => v.id))
      .toEqual(['system', 'architecture', 'friends']);
  });

  it('devuelve vacío cuando la vista no tiene hijos', () => {
    expect(railViewsFor(VIEWS, 'extensions')).toEqual([]);
  });

  it('no muta el array recibido', () => {
    const copia = [...VIEWS];
    railViewsFor(VIEWS, 'system');
    expect(VIEWS).toEqual(copia);
  });

  it('omite al padre cuando no está declarado pero sus hijos sí', () => {
    const huerfanos: NavView[] = [
      { id: 'a', label: 'A', icon: '', parent: 'fantasma' },
    ];
    expect(railViewsFor(huerfanos, 'a').map((v) => v.id)).toEqual(['a']);
  });
});

describe('buildNav', () => {
  const base = (): NavGroup[] => [
    { id: 'people', label: 'Social', icon: '🌐', views: [{ id: 'irc', label: 'IRC', icon: '📡', order: 60 }] },
    { id: 'system', label: 'System', icon: '⚙️', views: [{ id: 'settings', label: 'Settings', icon: '⚙️' }] },
  ];

  it('sin manifest devuelve la base y su índice vista → grupo', () => {
    const nav = buildNav({}, base());
    expect(nav.navGroups.map((g) => g.id)).toEqual(['people', 'system']);
    expect(nav.allViews.map((v) => v.id)).toEqual(['irc', 'settings']);
    expect(nav.viewToGroup).toEqual({ irc: 'people', settings: 'system' });
    expect(nav.viewPaths).toEqual({});
  });

  it('no muta la base', () => {
    const b = base();
    const copia = JSON.parse(JSON.stringify(b));
    buildNav({
      navGroups: [{ id: 'work', label: 'Work', icon: '💼' }],
      navItems: [{ id: 'tasks', label: 'Tasks', icon: '☑', group: 'people' }],
    }, b);
    expect(b).toEqual(copia);
  });

  it('ordena los grupos nuevos: people en 250, sin order en 500, system al final', () => {
    const nav = buildNav({
      navGroups: [
        { id: 'work', label: 'Work', icon: '💼', order: 100 },
        { id: 'tools', label: 'Tools', icon: '🔧' },
        { id: 'people', label: 'Ignorado', icon: '?' },
      ],
      navItems: [
        { id: 'tasks', label: 'Tasks', icon: '☑', group: 'work' },
        { id: 'files', label: 'Files', icon: '📁', group: 'tools' },
      ],
    }, base());
    expect(nav.navGroups.map((g) => g.id)).toEqual(['work', 'people', 'tools', 'system']);
    // Un grupo que ya existe en la base no se pisa.
    expect(nav.navGroups.find((g) => g.id === 'people')?.label).toBe('Social');
  });

  it('descarta items cuyo módulo `requires` no está instalado', () => {
    const nav = buildNav({
      modules: ['crm'],
      navItems: [
        { id: 'leads', label: 'Leads', icon: '🎯', group: 'people', requires: 'crm' },
        { id: 'paid', label: 'Paid', icon: '💰', group: 'people', requires: 'pro' },
      ],
    }, base());
    expect(nav.allViews.map((v) => v.id)).toContain('leads');
    expect(nav.allViews.map((v) => v.id)).not.toContain('paid');
  });

  it('crea el grupo que un item nombra y no existe, al final y con label legible', () => {
    const nav = buildNav({
      navItems: [{ id: 'gym', label: 'Gym', icon: '🏋️', group: 'wellness' }],
    }, base());
    const g = nav.navGroups.at(-1)!;
    expect(g).toMatchObject({ id: 'wellness', label: 'Wellness', icon: '⚙️', order: 500 });
    expect(nav.viewToGroup.gym).toBe('wellness');
  });

  it('ordena las vistas por order, conserva parent, ignora duplicados y junta los path', () => {
    const nav = buildNav({
      navItems: [
        { id: 'feed', label: 'Feed', icon: '📰', group: 'people', order: 10, path: '/feed?tab=all' },
        { id: 'irc', label: 'Otro IRC', icon: '?', group: 'people' },
        { id: 'dm', label: 'DM', icon: '✉', group: 'people', parent: 'feed' },
      ],
    }, base());
    const people = nav.navGroups.find((g) => g.id === 'people')!;
    expect(people.views.map((v) => v.id)).toEqual(['feed', 'irc', 'dm']);
    expect(people.views.find((v) => v.id === 'irc')?.label).toBe('IRC');
    expect(people.views.find((v) => v.id === 'dm')?.parent).toBe('feed');
    expect(nav.viewPaths).toEqual({ feed: '/feed?tab=all' });
  });

  it('quita los grupos vacíos salvo system', () => {
    const nav = buildNav({ navGroups: [{ id: 'empty', label: 'Empty', icon: '∅' }] }, [
      { id: 'people', label: 'Social', icon: '🌐', views: [] },
      { id: 'system', label: 'System', icon: '⚙️', views: [] },
    ]);
    expect(nav.navGroups.map((g) => g.id)).toEqual(['system']);
  });
});
