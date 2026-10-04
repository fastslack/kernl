import { describe, it, expect } from 'bun:test';
import { listPartAt, listHeight, propOf, tagProp, type ListLayout } from './wall-screen.js';

const base = { pad: 10, headerH: 40, rowH: 30, rows: 3, footerH: 30 };
const layout: ListLayout = { ...base, height: listHeight(base) }; // 10+40+90+30+10 = 180

/** UV y for a canvas pixel row (UV runs bottom→top, the canvas top→bottom). */
const uvAt = (px: number) => 1 - px / layout.height;

describe('listPartAt', () => {
  it('sizes the canvas to the layout', () => {
    expect(layout.height).toBe(180);
  });

  it('finds the header', () => {
    expect(listPartAt(layout, uvAt(15))).toEqual({ kind: 'header' });
    expect(listPartAt(layout, uvAt(49))).toEqual({ kind: 'header' });
  });

  it('finds each row by its band', () => {
    expect(listPartAt(layout, uvAt(51))).toEqual({ kind: 'row', index: 0 });
    expect(listPartAt(layout, uvAt(85))).toEqual({ kind: 'row', index: 1 });
    expect(listPartAt(layout, uvAt(139))).toEqual({ kind: 'row', index: 2 });
  });

  it('finds the footer under the rows', () => {
    expect(listPartAt(layout, uvAt(145))).toEqual({ kind: 'footer' });
  });

  it('the padding is nothing — a click on the frame does nothing', () => {
    expect(listPartAt(layout, uvAt(4))).toBeNull();
    expect(listPartAt(layout, uvAt(175))).toBeNull();
  });

  it('without a footer the band under the rows is nothing', () => {
    const noFooter = { ...base, footerH: 0 };
    const l: ListLayout = { ...noFooter, height: listHeight(noFooter) };
    expect(listPartAt(l, 1 - 145 / l.height)).toBeNull();
  });
});

describe('propOf', () => {
  it('finds the prop on the hit mesh or an ancestor, and nothing elsewhere', () => {
    const prop = { tip: () => 'x' };
    const parent = tagProp({ userData: {}, parent: null } as any, prop);
    const child = { userData: {}, parent };
    expect(propOf(child)).toBe(prop);
    expect(propOf({ userData: {}, parent: null })).toBeNull();
  });
});
