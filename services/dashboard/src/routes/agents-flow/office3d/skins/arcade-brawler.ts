import type { SkinDefinition, SkinCreateOpts } from './skin-types.js';
import type { HumanoidParts } from '../types.js';

let THREE: any;

/** Blue-clad, blond street brawler inspired by classic beat-'em-up heroes. */
function createBrawler(opts: SkinCreateOpts): HumanoidParts {
  const group=new THREE.Group();
  group.scale.setScalar(opts.scale ?? 1);
  const mat=(color: number | string,flatShading=true)=>new THREE.MeshLambertMaterial({color,flatShading});
  const skin=mat(opts.palette.skin), shade=mat(0xb47d52), blue=mat(0x2461b1), blueLight=mat(0x4283cc);
  const blueDark=mat(0x1b3b70), hair=mat(0xd4a542), hairLight=mat(0xf0c666);
  const boots=mat(0x29292e), bootLight=mat(0x4e4b4a), white=mat(0xe7d9b7);
  const ink=mat(0x352a28), gold=mat(0xba9560), team=mat(opts.flowColor);
  function mesh(parent: any,geo: any,material: any,x=0,y=0,z=0,name='') {
    const m=new THREE.Mesh(geo,material);
    m.position.set(x,y,z);m.name=name;m.castShadow=true;parent.add(m);return m;
  }
  function box(parent: any,w: number,h: number,d: number,material: any,x: number,y: number,z: number,name='') {
    return mesh(parent,new THREE.BoxGeometry(w,h,d),material,x,y,z,name);
  }
  function oval(parent: any,rx: number,ry: number,rz: number,material: any,x: number,y: number,z: number) {
    const m=mesh(parent,new THREE.SphereGeometry(1,8,6),material,x,y,z);m.scale.set(rx,ry,rz);return m;
  }
  const torso=new THREE.Group();torso.position.y=1.085;group.add(torso);
  const chest=mesh(torso,new THREE.CylinderGeometry(.24,.165,.49,10,2),skin,0,0,0,'bare-chest');chest.scale.z=.58;
  // Sculpted chest and open vest leave a clear sleeveless arcade silhouette.
  for(const side of [-1,1]) {
    oval(torso,.104,.067,.022,skin,side*.087,.12,.121);
    const vest=box(torso,.094,.43,.061,blue,side*.178,.007,.096,'vest-panel');vest.rotation.z=-side*.095;
    box(torso,.017,.31,.012,blueLight,side*.135,.005,.137);
    box(torso,.066,.028,.014,blueDark,side*.18,-.12,.134);
    const lapel=box(torso,.067,.125,.033,blueLight,side*.145,.192,.101);lapel.rotation.z=side*.28;
  }
  box(torso,.014,.14,.008,shade,0,-.105,.1);
  box(torso,.105,.011,.01,shade,0,-.11,.109);
  const back=mesh(torso,new THREE.CylinderGeometry(.246,.17,.47,10,1, false, Math.PI,Math.PI),blue,0,0,0,'vest-back');back.geometry.rotateY(-Math.PI/2);back.scale.z=.6;
  box(torso,.009,.36,.012,blueDark,0,.005,-.147);
  box(torso,.18,.035,.015,blueLight,0,.174,-.127);
  box(torso,.045,.05,.016,team,-.175,.11,.139);
  mesh(group,new THREE.CylinderGeometry(.07,.085,.14,8),skin,0,1.407,0);
  box(group,.35,.065,.223,boots,0,.803,0,'belt');
  box(group,.062,.057,.021,gold,0,.803,.123);
  box(group,.035,.032,.025,boots,0,.803,.128);
  const hips=mesh(group,new THREE.CylinderGeometry(.174,.187,.17,10),blue,0,.727,0);hips.scale.z=.65;
  box(group,.01,.085,.012,blueDark,.025,.722,.119);
  const head=new THREE.Group();head.position.y=1.61;group.add(head);
  oval(head,.12,.151,.113,skin,0,0,0);
  box(head,.12,.035,.101,skin,0,-.105,.014);
  for(const side of [-1,1]) {
    oval(head,.019,.028,.018,skin,side*.119,-.015,0);
    box(head,.043,.017,.012,white,side*.045,.02,.105);
    box(head,.015,.016,.014,blueDark,side*.04,.02,.112);
    const brow=box(head,.054,.013,.014,ink,side*.047,.045,.103);brow.rotation.z=side*.16;
  }
  const nose=mesh(head,new THREE.ConeGeometry(.023,.062,4),skin,0,-.018,.122);nose.rotation.x=Math.PI/2;
  box(head,.049,.008,.013,ink,.004,-.078,.106);
  box(head,.034,.009,.01,shade,.004,-.092,.097);
  const cap=mesh(head,new THREE.SphereGeometry(.146,10,6,0,Math.PI*2,0,Math.PI*.41),hair,0,.021,-.006,'blond-hair');cap.scale.set(.93,1.06,.94);
  for(const [x,y,z,tilt] of [[-.091,.125,.027,-.3],[-.047,.157,.052,-.2],[.005,.166,.043,.08],[.057,.147,.022,.25],[.091,.121,-.004,.38]]) {
    const tuft=mesh(head,new THREE.ConeGeometry(.045,.08,4),x<0 ? hairLight : hair,x,y,z);
    tuft.rotation.z=tilt;tuft.scale.z=.8;
  }
  const fringe=box(head,.14,.032,.04,hairLight,-.017,.099,.083);fringe.rotation.z=-.16;
  const arms: any[]=[],legs: any[]=[],elbows: any[]=[],knees: any[]=[];
  for(const side of [-1,1]) {
    const arm=new THREE.Group();arm.position.set(side*.267,1.31,0);group.add(arm);
    oval(arm,.093,.11,.084,skin,0,-.025,0);
    mesh(arm,new THREE.CylinderGeometry(.076,.063,.19,8),skin,0,-.157,0);
    oval(arm,.077,.102,.065,skin,0,-.133,.025);
    const elbow=new THREE.Group();elbow.position.y=-.255;arm.add(elbow);
    mesh(elbow,new THREE.CylinderGeometry(.066,.046,.21,8),skin,0,-.1,0);
    mesh(elbow,new THREE.CylinderGeometry(.05,.05,.045,8),white,0,-.189,0,'wrist-wrap');
    mesh(elbow,new THREE.CylinderGeometry(.052,.052,.014,8),team,0,-.18,0);
    box(elbow,.086,.083,.078,skin,0,-.253,.018,'fist');
    box(elbow,.083,.018,.018,shade,0,-.256,.062);
    box(elbow,.026,.045,.034,skin,-side*.045,-.232,.03);
    arms.push(arm);elbows.push(elbow);
    const leg=new THREE.Group();leg.position.set(side*.096,.72,0);group.add(leg);
    mesh(leg,new THREE.CylinderGeometry(.082,.068,.3,8),blue,0,-.144,0);
    box(leg,.012,.215,.014,blueLight,side*.064,-.13,.041);
    const knee=new THREE.Group();knee.position.y=-.3;leg.add(knee);
    mesh(knee,new THREE.CylinderGeometry(.068,.052,.23,8),blue,0,-.105,0);
    box(knee,.082,.055,.021,blueDark,0,-.025,.058);
    mesh(knee,new THREE.CylinderGeometry(.057,.061,.16,8),boots,0,-.237,0);
    mesh(knee,new THREE.CylinderGeometry(.065,.065,.03,8),bootLight,0,-.17,0);
    box(knee,.13,.081,.213,boots,0,-.312,.047,'boot');
    box(knee,.135,.025,.218,ink,0,-.357,.047);
    for(const y of [-.2,-.23,-.26]) box(knee,.051,.009,.014,bootLight,0,y,.061);
    legs.push(leg);knees.push(knee);
  }
  head.userData.animateAccessories=(seconds: number,action: string)=>{
    const seated=opts.walker===false || legs.some(leg=>leg.rotation.x < -1);
    knees.forEach((knee,i)=>{knee.rotation.x=seated ? -legs[i].rotation.x : Math.max(0,Math.sin(seconds*10+i*Math.PI))*(action==='walk' ? .24 : 0);});
    elbows.forEach((elbow,i)=>{elbow.rotation.x=seated ? -.5 : action==='talk' && i===1 ? -.35 : -.15;});
  };
  if(opts.walker===false) knees.forEach(knee=>{knee.rotation.x=1.5;});
  return {group,head,torso,leftArm:arms[0],rightArm:arms[1],leftLeg:legs[0],rightLeg:legs[1]};
}

export const arcadeBrawlerSkin: SkinDefinition={
  manifest:{id:'arcade-brawler',name:'Arcade Brawler',description:'Double Dragon–inspired blond brawler with an open blue vest, muscular arms, wrist wraps and combat boots.',author:'core',version:'1.0.0',category:'humanoid'},
  init(three: any){THREE=three;},
  createHumanoid:createBrawler,
  pickPalette(){return {skin:0xe0b187,hair:0xd4a542,pants:0x2461b1};},
};
