import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { clearDeskObjects } from './furniture.js';
import { resolveSkin, initAllSkins } from './skins/index.js';

initAllSkins(THREE);

test('a desk rebuild removes an orphaned avatar and furniture while preserving walkers', () => {
  const scene = new THREE.Scene();
  const skin = resolveSkin('adventure-3d');
  const oldDesk = new THREE.Group();
  oldDesk.userData._deskOwned = true;
  oldDesk.add(skin.createHumanoid({ flowColor: '#bd8247', palette: skin.pickPalette('one') }).group);
  scene.add(oldDesk);
  const furniture = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
  furniture.userData._deskOwned = true;
  scene.add(furniture);
  const walker = skin.createHumanoid({ flowColor: '#bd8247', palette: skin.pickPalette('one') }).group;
  scene.add(walker);
  let disposed = 0;
  furniture.geometry.addEventListener('dispose', () => disposed++);
  clearDeskObjects(scene);
  expect(scene.getObjectById(oldDesk.id)).toBeUndefined();
  expect(scene.getObjectById(furniture.id)).toBeUndefined();
  expect(scene.getObjectById(walker.id)).toBe(walker);
  expect(disposed).toBe(1);
  clearDeskObjects(scene);
  expect(scene.children).toEqual([walker]);
});
