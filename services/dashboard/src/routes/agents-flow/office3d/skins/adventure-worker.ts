import type { SkinDefinition, SkinCreateOpts } from './skin-types.js';
import type { HumanoidParts } from '../types.js';
import { pickHumanoidPalette } from '../humanoid-palette.js';
import { drawAdventureAtlas } from './adventure-atlas.js';
import { adventureFrame, ADVENTURE_ACTIONS, SPRITE_DIRECTIONS, SPRITE_FRAMES, type AdventureAction } from './adventure-frames.js';

let THREE: any;

export function initAdventureWorker(three: any) { THREE = three; }

export function createAdventureWorker(opts: SkinCreateOpts, atlasFactory = drawAdventureAtlas, sleeveColor = 0xe1d9b9): HumanoidParts {
  const group = new THREE.Group();
  group.scale.setScalar(opts.scale ?? 1);
  // Keep the pose/attachment surface used by office chairs and couriers.
  const head = new THREE.Group(), torso = new THREE.Group();
  const leftArm = new THREE.Group(), rightArm = new THREE.Group();
  const leftLeg = new THREE.Group(), rightLeg = new THREE.Group();
  head.position.y = 1.55;
  torso.position.y = 1.05;
  leftArm.position.set(-0.32, 1.28, 0);
  rightArm.position.set(0.32, 1.28, 0);
  leftLeg.position.set(-0.12, 0.62, 0);
  rightLeg.position.set(0.12, 0.62, 0);
  group.add(head, torso, leftArm, rightArm, leftLeg, rightLeg);
  const state = { action: 'idle' as AdventureAction, seconds: 0 };
  head.userData.spriteAnimation = state;
  // Draw a distinct seated atlas. Meeting walkers can change posture later.
  const maps = new Map<boolean, any>();
  function postureMap(seated: boolean) {
    if (!maps.has(seated)) {
      const texture = new THREE.CanvasTexture(atlasFactory({ ...opts, walker: !seated }, seated));
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.repeat.set(1 / SPRITE_FRAMES, 1 / (ADVENTURE_ACTIONS.length * SPRITE_DIRECTIONS));
      maps.set(seated, texture);
    }
    return maps.get(seated);
  }
  const rows = ADVENTURE_ACTIONS.length * SPRITE_DIRECTIONS;
  const material = new THREE.MeshLambertMaterial({
    map: postureMap(opts.walker === false), transparent: true, alphaTest: 0.5,
    depthWrite: true, side: THREE.DoubleSide,
  });
  material.addEventListener('dispose', () => { for (const map of maps.values()) map.dispose(); });
  // A vertical cutout rotates only around world Y, retaining the room's up axis.
  // A spherical billboard tilts toward overhead cameras and floats across chairs.
  const geometry = new THREE.PlaneGeometry(0.96, 1.92);
  geometry.translate(0, 0.96, 0);
  const sprite = new THREE.Mesh(geometry, material);
  sprite.name = 'adventure-cutout';
  group.add(sprite);
  // Seated arms are small flat cutouts placed in room depth: the body stays
  // pixel art, while the hands can actually reach the keyboard in front of it.
  const armArt = new THREE.Group();
  armArt.name = 'seated-arm-cutouts';
  group.add(armArt);
  const armMaterials = [0x686754, sleeveColor, opts.palette.skin].map(color =>
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  const fabricPixels = new Uint8Array(8 * 16 * 4);
  for (let y=0;y<16;y++) for (let x=0;x<8;x++) {
    const shade = x===0 || x===7 ? 180 : (y===3 || y===11) && x>2 ? 204 : x<3 ? 248 : 231;
    fabricPixels.set([shade,shade,shade,255],(y*8+x)*4);
  }
  const fabric = new THREE.DataTexture(fabricPixels,8,16);
  fabric.magFilter = fabric.minFilter = THREE.NearestFilter;
  fabric.needsUpdate = true;
  armMaterials[1].map = fabric;
  armMaterials[1].addEventListener('dispose',()=>fabric.dispose());
  function strip(material: any) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0,0,1,0,0,1,1,1],2));
    geo.setIndex([0,1,2,2,1,3]);
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    armArt.add(mesh);
    return mesh;
  }
  const armStrips = [-1,1].map(() => [strip(armMaterials[0]),strip(armMaterials[1]),strip(armMaterials[0]),strip(armMaterials[2]),strip(armMaterials[0]),strip(armMaterials[2])]);
  function poseStrip(mesh: any, a: any, b: any, width: number, cameraLocal: any, offset = 0) {
    const view = cameraLocal.clone().sub(a.clone().add(b).multiplyScalar(.5)).normalize();
    const side = new THREE.Vector3().subVectors(b,a).cross(view).normalize().multiplyScalar(width / 2);
    const vertices = mesh.geometry.attributes.position;
    const shift = view.clone().multiplyScalar(offset);
    for (let i=0;i<4;i++) {
      const point = (i < 2 ? a : b).clone().addScaledVector(side, i % 2 ? 1 : -1).add(shift);
      vertices.setXYZ(i,point.x,point.y,point.z);
    }
    vertices.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }
  const position = new THREE.Vector3(), cameraPosition = new THREE.Vector3();
  const forward = new THREE.Vector3(), rotation = new THREE.Quaternion();
  let lastRenderFrame = -1;
  let lastCamera: any = null;
  const updateAppearance = (_renderer: any, _scene: any, camera: any) => {
    if (lastRenderFrame === _renderer.info.render.frame && lastCamera === camera) return;
    lastRenderFrame = _renderer.info.render.frame;
    lastCamera = camera;
    group.getWorldPosition(position);
    camera.getWorldPosition(cameraPosition);
    group.getWorldQuaternion(rotation);
    forward.set(0, 0, 1).applyQuaternion(rotation);
    const cameraYaw = Math.atan2(cameraPosition.x - position.x, cameraPosition.z - position.z);
    const worldYaw = Math.atan2(forward.x, forward.z);
    const angle = cameraYaw - worldYaw;
    sprite.rotation.y = angle;
    const seated = opts.walker === false || leftLeg.rotation.x < -1 || rightLeg.rotation.x < -1;
    const seatOffset = group.parent?.userData?._deskTop ? Math.max(0, group.position.z - .73) : 0;
    sprite.position.z = seated ? seatOffset : 0;
    sprite.updateMatrixWorld(true);
    const map = postureMap(seated);
    material.map = map;
    armArt.visible = seated;
    if (seated) {
      const view = group.worldToLocal(cameraPosition.clone());
      const right = new THREE.Vector3(Math.cos(angle),0,-Math.sin(angle));
      const tick = Math.floor(state.seconds * 8) % 8;
      const reach = group.parent?.userData?._deskTop ? group.position.z + .05 : .58;
      armStrips.forEach((strips,index)=>{
        const side = index ? 1 : -1;
        const shoulderWidth = Math.abs(Math.sin(angle)) > .707 ? .105 : .155;
        const shoulder = right.clone().multiplyScalar(side * shoulderWidth).add(new THREE.Vector3(.035,1.06,seatOffset));
        const elbow = new THREE.Vector3(index ? .29 : -.035,.905,seatOffset + (reach-seatOffset)*.5);
        const tap = state.action === 'typing' ? [0,0,.014,0,0,.014,.014,0][(tick+index*3)%8] : 0;
        const hand = new THREE.Vector3(index ? .39 : .15,.885 + tap,reach);
        if (state.action === 'talk' && index) hand.set(.36,1.03,.39);
        if (state.action === 'stretch') { elbow.set(side*.23,1.25,.02);hand.set(side*.18,1.5,0); }
        poseStrip(strips[0],shoulder,elbow,.105,view);
        poseStrip(strips[1],shoulder,elbow,.09,view,.004);
        poseStrip(strips[2],elbow,hand,.08,view);
        poseStrip(strips[3],elbow,hand,.065,view,.004);
        const handTop = hand.clone().add(new THREE.Vector3(0,.027,0));
        const handBottom = hand.clone().add(new THREE.Vector3(0,-.027,0));
        poseStrip(strips[4],handTop,handBottom,.095,view,.006);
        poseStrip(strips[5],handTop,handBottom,.073,view,.008);
      });
    }
    const frame = adventureFrame(state.action, state.seconds, angle);
    map.repeat.x = (frame.mirrored ? -1 : 1) / SPRITE_FRAMES;
    map.offset.set((frame.column + (frame.mirrored ? 1 : 0)) / SPRITE_FRAMES, 1 - (frame.row + 1) / rows);
  };
  sprite.onBeforeRender = updateAppearance;
  for (const strips of armStrips) for (const strip of strips) strip.onBeforeRender = updateAppearance;
  return { group, head, torso, leftArm, rightArm, leftLeg, rightLeg };
}

export const adventureWorkerSkin: SkinDefinition = {
  manifest: {
    id: 'adventure-worker', name: 'Adventure 2D',
    description: 'Monkey Island–inspired pixel characters, directional sprites and hand-drawn animation cels.',
    author: 'core', version: '1.0.0', category: 'humanoid',
  },
  init: initAdventureWorker,
  createHumanoid: createAdventureWorker,
  pickPalette: pickHumanoidPalette,
};
