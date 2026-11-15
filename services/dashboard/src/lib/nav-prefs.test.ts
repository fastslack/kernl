import { describe, it, expect } from 'bun:test';
import { parseNavPrefs, serializeNavPrefs, orderNavGroups, applyNavPrefs } from './nav-prefs.js';

const g = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (gs: Array<{ id: string }>) => gs.map((x) => x.id);

describe('parseNavPrefs', () => {
  it('vacío, roto o con basura vuelve al menú por defecto', () => {
    expect(parseNavPrefs('')).toEqual({ order: [], hidden: [], shown: [] });
    expect(parseNavPrefs(undefined)).toEqual({ order: [], hidden: [], shown: [] });
    expect(parseNavPrefs('{"order":')).toEqual({ order: [], hidden: [], shown: [] });
    expect(parseNavPrefs('{"order":["a",3,null],"hidden":"x"}')).toEqual({ order: ['a'], hidden: [], shown: [] });
  });

  it('ida y vuelta con serializeNavPrefs; sin cambios se guarda vacío', () => {
    const p = { order: ['work', 'ai'], hidden: ['finance'], shown: ['leisure'] };
    expect(parseNavPrefs(serializeNavPrefs(p))).toEqual(p);
    expect(serializeNavPrefs({ order: [], hidden: [], shown: [] })).toBe('');
  });
});

describe('orderNavGroups', () => {
  it('pone primero los que el usuario ordenó y deja los nuevos después, en su orden', () => {
    expect(ids(orderNavGroups(g('work', 'people', 'finance', 'ai'), ['ai', 'work']))).toEqual(['ai', 'work', 'people', 'finance']);
  });

  it('ignora ids que ya no existen', () => {
    expect(ids(orderNavGroups(g('work', 'ai'), ['gone', 'ai']))).toEqual(['ai', 'work']);
  });
});

describe('applyNavPrefs', () => {
  it('ordena y saca los ocultos', () => {
    const out = applyNavPrefs(g('dashboard', 'work', 'people', 'ai'), { order: ['ai', 'dashboard'], hidden: ['people'], shown: [] });
    expect(ids(out)).toEqual(['ai', 'dashboard', 'work']);
  });

  it('sin preferencias deja el orden del manifest', () => {
    expect(ids(applyNavPrefs(g('work', 'ai'), { order: [], hidden: [], shown: [] }))).toEqual(['work', 'ai']);
  });

  it('la edición oculta sus menús salvo que el usuario los muestre; lo del usuario gana', () => {
    const groups = g('dashboard', 'work', 'leisure', 'ai');
    const edition = ['dashboard', 'leisure'];
    expect(ids(applyNavPrefs(groups, { order: [], hidden: [], shown: [] }, edition))).toEqual(['work', 'ai']);
    expect(ids(applyNavPrefs(groups, { order: [], hidden: ['ai'], shown: ['leisure'] }, edition))).toEqual(['work', 'leisure']);
  });
});
