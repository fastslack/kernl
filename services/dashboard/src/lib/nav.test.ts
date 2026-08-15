import { describe, it, expect } from 'bun:test';
import { railParentOf, railViewsFor } from './nav.js';
import type { NavView } from './constants.js';

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
