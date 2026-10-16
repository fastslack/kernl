import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { initAllSkins, resolveSkin } from './index.js';
import { animateSitting, animateWalk } from '../humanoid.js';

initAllSkins(THREE);
const skin=resolveSkin('life-sim');

test('Life Sim is selectable without replacing the existing default',()=>{
  expect(skin.manifest.name).toBe('Life Sim');
  expect(resolveSkin(undefined).manifest.id).toBe('office-worker');
  const h=skin.createHumanoid({flowColor:'#489c91',palette:skin.pickPalette('one')});
  const diamond=h.group.getObjectByName('status-diamond');
  expect(diamond.position.y).toBeGreaterThan(new THREE.Box3().setFromObject(h.head).max.y);
  const before=diamond.rotation.y;
  animateWalk({...h,timeSec:.4,age:.4} as any);
  expect(diamond.rotation.y).not.toBe(before);
});

test('seated legs bend at the knees so the shoes drop below the chair',()=>{
  const h=skin.createHumanoid({flowColor:'#489c91',palette:skin.pickPalette('one'),walker:false});
  h.leftLeg.rotation.x=h.rightLeg.rotation.x=-1.5;
  animateSitting(h,.4,0,true);
  h.group.updateMatrixWorld(true);
  const shoe=h.leftLeg.getObjectByName('sneaker').getWorldPosition(new THREE.Vector3());
  expect(shoe.y).toBeLessThan(.4);
  expect(shoe.y).toBeGreaterThan(-.1);
  expect(Number.isFinite(shoe.z)).toBe(true);
});
