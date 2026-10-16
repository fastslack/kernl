import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { resolveSkin, initAllSkins } from './index.js';
import { animateSitting, animateWalk } from '../humanoid.js';

initAllSkins(THREE);
function worker() {
  const skin = resolveSkin('adventure-3d');
  return skin.createHumanoid({flowColor:'#d08145',palette:skin.pickPalette('test'),walker:true});
}

describe('adventure 3D',()=>{
  test('keeps saved 2D selections and exposes the new model separately',()=>{
    expect(resolveSkin('adventure-worker').manifest.name).toBe('Adventure 2D');
    expect(resolveSkin('adventure-3d').manifest.name).toBe('Adventure 3D');
    expect(resolveSkin(undefined).manifest.id).toBe('office-worker');
  });
  test('has real depth and geometry attached to the animated head and legs',()=>{
    const h=worker();
    let sprites=0;
    h.group.traverse((o:any)=>{if(o.isSprite)sprites++;});
    expect(sprites).toBe(0);
    const box=new THREE.Box3().setFromObject(h.group);
    const size=box.getSize(new THREE.Vector3());
    expect(size.y).toBeGreaterThan(1.8);
    expect(size.z).toBeGreaterThan(.3);
    expect(h.head.getObjectByName('ponytail')).toBeDefined();
    expect(h.leftLeg.getObjectByName('coat-tail')).toBeDefined();
    expect(h.rightLeg.getObjectByName('coat-tail')).toBeDefined();
  });
  test('supports the existing walk and seated animation surface',()=>{
    const h=worker();
    animateWalk({...h,timeSec:.2,age:.2} as any);
    expect(h.leftLeg.rotation.x).not.toBe(0);
    h.leftLeg.rotation.x=h.rightLeg.rotation.x=-1.5;
    animateSitting(h,.4,0,true);
    expect(h.leftArm.rotation.x).toBeLessThan(-.6);
    expect(h.leftLeg.rotation.x).toBe(-1.5);
    expect(h.leftLeg.getObjectByName('coat-tail').parent.parent).toBe(h.leftLeg);
  });
});
