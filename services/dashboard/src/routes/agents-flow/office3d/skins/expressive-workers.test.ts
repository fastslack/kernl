import {expect,test} from 'bun:test';
import {characterExpression} from './expressive-atlas.js';
import {resolveSkin,listSkins} from './index.js';

test('2D expressions include readable focus, blinking, surprise and multiple speech shapes',()=>{
  expect(characterExpression('typing',0)).toBe('focused');
  expect(characterExpression('idle',7)).toBe('blink');
  expect(characterExpression('stretch',0)).toBe('surprised');
  expect(new Set([0,1,2,3].map(f=>characterExpression('talk',f))).size).toBe(4);
});
test('the three new characters coexist with the original skins',()=>{
  for(const id of ['inventor-2d','detective-2d','robot-2d'])expect(resolveSkin(id).manifest.id).toBe(id);
  expect(resolveSkin(undefined).manifest.id).toBe('office-worker');
  expect(listSkins().filter(s=>['Inventor 2D','Detective 2D','Cyborg 94 2D'].includes(s.manifest.name))).toHaveLength(3);
});

test('saved robot selections now resolve to the redesigned 1990s cyborg',()=>{
  expect(resolveSkin('robot-2d').manifest.name).toBe('Cyborg 94 2D');
});
