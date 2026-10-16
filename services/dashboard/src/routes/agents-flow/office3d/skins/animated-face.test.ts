import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { facialCel, facialPixels } from './animated-face.js';
import { initAllSkins, resolveSkin } from './index.js';
import { animateTalking } from '../humanoid.js';

test('facial expressions follow activity, with periodic blinks and changing speech shapes',()=>{
  expect(facialCel('idle',0)).toBe(0);
  expect(facialCel('typing',1)).toBe(2);
  expect(facialCel('idle',4.6)).toBe(1);
  expect(facialCel('idle',4.8)).toBe(0);
  expect(facialCel('talk',.01)).not.toBe(facialCel('talk',.26));
  expect(facialCel('stretch',1)).toBe(7);
  const atlas=facialPixels();
  expect(atlas.pixels.length).toBe(atlas.width*atlas.height*4);
  expect(atlas.pixels[3]).toBe(0);
});

test('the facial drawing belongs to the 3D head and receives the existing talking animation',()=>{
  initAllSkins(THREE);
  const skin=resolveSkin('toon-face-3d');
  const h=skin.createHumanoid({flowColor:'#447ba6',palette:skin.pickPalette('one')});
  const drawing=h.head.getObjectByName('animated-face-drawing');
  expect(drawing.parent).toBe(h.head);
  expect(drawing.geometry.type).toBe('SphereGeometry');
  expect(h.group.getObjectByName('status-diamond').visible).toBe(false);
  animateTalking(h,.26,0);
  expect(drawing.material.map.offset.x).toBe(facialCel('talk',.26)/8);
  expect(h.head.rotation.x).not.toBe(0);
  expect(resolveSkin('life-sim').manifest.name).toBe('Life Sim');
});
