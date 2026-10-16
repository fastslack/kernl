import type { SkinDefinition, SkinCreateOpts } from './skin-types.js';
import type { HumanoidParts } from '../types.js';
import { attachAnimatedFace } from './animated-face.js';
import { pickHumanoidPalette } from '../humanoid-palette.js';

let THREE: any;

/** Everyday life-simulation figure with a faceted green status diamond. */
function createLifeSim(opts: SkinCreateOpts, faceStyle: 'mesh' | 'animated-2d' = 'mesh'): HumanoidParts {
  const group = new THREE.Group();
  group.scale.setScalar(opts.scale ?? 1);
  const material = (color: number | string, flatShading = false) =>
    new THREE.MeshLambertMaterial({ color, flatShading });
  const skin = material(opts.palette.skin);
  const hair = material(opts.palette.hair,true);
  const shirt = material(opts.flowColor,true);
  const shirtDark = material(new THREE.Color(opts.flowColor).multiplyScalar(.72).getHex(),true);
  const jeans = material(0x344a66,true), seam = material(0x64768b);
  const white = material(0xe7e5dc), sole = material(0xb8b9b6), dark = material(0x24272b);
  function mesh(parent: any, geo: any, mat: any, x=0,y=0,z=0,name='') {
    const m = new THREE.Mesh(geo,mat);
    m.position.set(x,y,z);
    m.name=name;
    m.castShadow=true;
    parent.add(m);
    return m;
  }
  function box(parent: any,w: number,h: number,d: number,mat: any,x: number,y: number,z: number,name='') {
    return mesh(parent,new THREE.BoxGeometry(w,h,d),mat,x,y,z,name);
  }
  const torso = new THREE.Group();
  torso.position.y=1.08;
  group.add(torso);
  const chest=mesh(torso,new THREE.CylinderGeometry(.215,.155,.5,10,2),shirt,0,0,0,'polo');
  chest.scale.z=.61;
  const shoulder=mesh(torso,new THREE.SphereGeometry(.208,10,6,0,Math.PI*2,0,Math.PI/2),shirt,0,.21,0);
  shoulder.scale.set(1,.3,.61);
  // Polo collar, placket and small embroidered chest patch.
  for (const side of [-1,1]) {
    const collar=box(torso,.077,.042,.02,shirtDark,side*.047,.223,.105);
    collar.rotation.z=side*.38;
  }
  box(torso,.024,.107,.012,shirtDark,0,.158,.13);
  for(const y of [.18,.144]) mesh(torso,new THREE.SphereGeometry(.007,5,4),white,0,y,.14);
  box(torso,.032,.034,.012,white,-.102,.12,.121);
  box(group,.305,.045,.202,dark,0,.809,0,'belt');
  box(group,.04,.038,.018,sole,0,.809,.111);
  const pelvis=mesh(group,new THREE.CylinderGeometry(.154,.172,.17,10),jeans,0,.728,0);
  pelvis.scale.z=.65;
  box(group,.009,.1,.012,seam,.025,.728,.107);
  mesh(group,new THREE.CylinderGeometry(.059,.068,.14,8),skin,0,1.409,0);
  const head = new THREE.Group();
  head.position.y=1.61;
  group.add(head);
  const face=mesh(head,new THREE.SphereGeometry(.135,12,10),skin,0,0,0,'face');
  face.scale.set(.86,1.16,.86);
  for(const side of [-1,1]) {
    const ear=mesh(head,new THREE.SphereGeometry(.025,6,5),skin,side*.113,-.012,0);
    ear.scale.set(.55,1,.7);
    if(faceStyle==='mesh') {
    box(head,.04,.018,.01,white,side*.043,.023,.105);
    box(head,.014,.017,.012,material(0x465b64),side*.039,.023,.112);
    box(head,.007,.013,.014,dark,side*.037,.023,.116);
    box(head,.046,.009,.012,hair,side*.044,.047,.103);
    }
  }
  const nose=mesh(head,new THREE.ConeGeometry(.018,.052,4),skin,0,-.014,.12);
  nose.rotation.x=Math.PI/2;
  if(faceStyle==='mesh') box(head,.042,.006,.011,material(0x855f51),0,-.071,.102);
  box(head,.03,.006,.009,skin,0,-.083,.097);
  const cap=mesh(head,new THREE.SphereGeometry(.141,10,7,0,Math.PI*2,0,Math.PI*(faceStyle==='animated-2d' ? .38 : .44)),hair,0,.025,-.005,'hair');
  cap.scale.set(.9,1.06,.91);
  const fringe=box(head,.13,.04,.045,hair,-.015,.114,.08);
  fringe.rotation.z=-.16;
  box(head,.022,.063,.036,hair,-.106,.051,.014);
  const arms: any[] = [], legs: any[] = [], elbows: any[] = [], knees: any[] = [];
  for(const side of [-1,1]) {
    const arm = new THREE.Group();
    arm.position.set(side*.232,1.31,0);
    group.add(arm);
    mesh(arm,new THREE.CylinderGeometry(.074,.067,.17,8),shirt,0,-.065,0);
    mesh(arm,new THREE.CylinderGeometry(.068,.068,.025,8),shirtDark,0,-.139,0);
    mesh(arm,new THREE.CylinderGeometry(.052,.045,.13,8),skin,0,-.2,0);
    const elbow=new THREE.Group();
    elbow.position.y=-.264;
    arm.add(elbow);
    const forearm=mesh(elbow,new THREE.CylinderGeometry(.047,.034,.217,8),skin,0,-.105,0);
    forearm.rotation.z=side*.025;
    const hand=mesh(elbow,new THREE.SphereGeometry(.042,8,6),skin,0,-.24,.011);
    hand.scale.set(.8,1.2,.68);
    if(side<0) {
      mesh(elbow,new THREE.CylinderGeometry(.039,.039,.027,8),dark,0,-.195,0);
      box(elbow,.041,.025,.013,sole,0,-.193,.033);
    }
    arms.push(arm);elbows.push(elbow);
    const leg=new THREE.Group();
    leg.position.set(side*.086,.72,0);
    group.add(leg);
    mesh(leg,new THREE.CylinderGeometry(.07,.058,.3,8),jeans,0,-.145,0);
    box(leg,.008,.22,.01,seam,side*.052,-.14,.038);
    const knee=new THREE.Group();
    knee.position.y=-.3;
    leg.add(knee);
    mesh(knee,new THREE.CylinderGeometry(.058,.042,.295,8),jeans,0,-.144,0);
    mesh(knee,new THREE.CylinderGeometry(.045,.045,.024,8),seam,0,-.281,0);
    const shoe=mesh(knee,new THREE.BoxGeometry(.114,.078,.199),white,0,-.31,.039,'sneaker');
    box(knee,.116,.021,.203,sole,0,-.352,.039);
    box(knee,.065,.01,.065,dark,0,-.27,.036);
    for(const z of [.025,.05,.075]) box(knee,.067,.007,.01,white,0,-.264,z);
    legs.push(leg);knees.push(knee);
  }
  const diamond = mesh(group,new THREE.OctahedronGeometry(.155,0),
    new THREE.MeshStandardMaterial({color:0x35ed62,emissive:0x0a7b29,emissiveIntensity:.45,roughness:.3,metalness:.08,flatShading:true}),0,2.08,0,'status-diamond');
  diamond.scale.set(.75,1.7,.75);
  diamond.castShadow=false;
  diamond.visible=faceStyle==='mesh';
  const animateFace=faceStyle==='animated-2d' ? attachAnimatedFace(THREE,head) : null;
  head.userData.animateAccessories=(seconds: number,action: string)=>{
    animateFace?.(seconds,action);
    diamond.position.y=2.08+Math.sin(seconds*2)*.025;
    diamond.rotation.y=seconds*.65;
    const seated=opts.walker===false || legs.some(leg=>leg.rotation.x < -1);
    knees.forEach((knee,i)=>{knee.rotation.x=seated ? -legs[i].rotation.x : Math.max(0,Math.sin(seconds*10+i*Math.PI))*(action==='walk' ? .26 : 0);});
    elbows.forEach((elbow,i)=>{elbow.rotation.x=seated ? -.5 : action==='talk' && i===1 ? -.28 : -.08;});
  };
  // Apply the seated bend immediately, before the first rendered animation tick.
  if(opts.walker===false) knees.forEach(knee=>{knee.rotation.x=1.5;});
  return {group,head,torso,leftArm:arms[0],rightArm:arms[1],leftLeg:legs[0],rightLeg:legs[1]};
}

export const lifeSimSkin: SkinDefinition = {
  manifest:{
    id:'life-sim',name:'Life Sim',
    description:'Classic life-simulation style: casual clothes, articulated limbs and a floating green diamond.',
    author:'core',version:'1.0.0',category:'humanoid',
  },
  init(three: any) {THREE=three;},
  createHumanoid:createLifeSim,
  pickPalette:pickHumanoidPalette,
};


export const toonFaceSkin: SkinDefinition = {
  manifest:{
    id:'toon-face-3d',name:'Toon Face 3D',
    description:'A fully 3D figure with hand-drawn 2D facial expressions: blinking, focus, smiles and speech.',
    author:'core',version:'1.0.0',category:'humanoid',
  },
  init(three: any) {THREE=three;},
  createHumanoid:(opts)=>createLifeSim(opts,'animated-2d'),
  pickPalette:pickHumanoidPalette,
};
