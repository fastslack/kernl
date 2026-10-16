import type { HumanoidParts } from '../types.js';
import type { SkinDefinition, SkinCreateOpts } from './skin-types.js';
import { pickHumanoidPalette } from '../humanoid-palette.js';

let THREE: any;

/** Small painted value maps, sampled as pixels rather than filtered fabric. */
function paintedMap(kind: 'cloth' | 'hair' | 'leather') {
  const w = 16, h = 32;
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const noise = ((x * 17 + y * 31 + x * y * 3) % 13) - 6;
    const fold = kind === 'hair' ? ((x + Math.floor(y / 7)) % 5 === 0 ? -48 : 0)
      : kind === 'cloth' ? (x % 7 === 0 ? -28 : x % 7 === 1 ? 8 : 0)
      : (y % 8 === 0 ? -28 : 0);
    const value = Math.max(100, Math.min(255, 235 + fold + noise));
    const i = (y * w + x) * 4;
    pixels.set([value, value, value, 255], i);
  }
  const map = new THREE.DataTexture(pixels, w, h);
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.NearestFilter;
  map.generateMipmaps = false;
  map.needsUpdate = true;
  return map;
}

/** Octagonal cross sections make tailored, tapered volumes instead of blocks. */
function loft(rings: number[][], sides = 8) {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  rings.forEach(([y, rx, rz, cz = 0], r) => {
    for (let j = 0; j <= sides; j++) {
      const a = j / sides * Math.PI * 2;
      positions.push(Math.cos(a) * rx, y, Math.sin(a) * rz + cz);
      uvs.push(j / sides, r / (rings.length - 1));
      if (r < rings.length - 1 && j < sides) {
        const i = r * (sides + 1) + j;
        indices.push(i, i + sides + 1, i + 1, i + 1, i + sides + 1, i + sides + 2);
      }
    }
  });
  // Each ring's first/last vertex shares a position, closing the UV seam.
  for (let j = 1; j < sides - 1; j++) {
    indices.push(0, j, j + 1);
    const last = (rings.length - 1) * (sides + 1);
    indices.push(last, last + j + 1, last + j);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createAdventure3D(opts: SkinCreateOpts): HumanoidParts {
  const group = new THREE.Group();
  group.scale.setScalar(opts.scale ?? 1);
  const clothMap = paintedMap('cloth'), hairMap = paintedMap('hair'), leatherMap = paintedMap('leather');
  function material(color: number | string, map?: any) {
    const mat = new THREE.MeshLambertMaterial({ color, map: map ?? null, flatShading: true });
    if (map) mat.addEventListener('dispose', () => map.dispose());
    return mat;
  }
  const coat = material(0x244c79, clothMap), coatLight = material(0x3e6a92, clothMap);
  const coatShade = material(0x17334e, clothMap), lining = material(0x5b352e, clothMap);
  const shirt = material(0xeee1bc, clothMap), shirtShade = material(0xb8af94);
  const skin = material(opts.palette.skin), skinShade = material(new THREE.Color(opts.palette.skin).multiplyScalar(.78).getHex());
  const hair = material(opts.palette.hair, hairMap), hairLight = material(new THREE.Color(opts.palette.hair).lerp(new THREE.Color(0xffe1a0),.3).getHex(), hairMap);
  const pants = material(0x72654d, clothMap), boots = material(0x48372b, leatherMap);
  const bootLight = material(0x72533a, leatherMap), sole = material(0x27272b);
  const gold = material(0xbda16a), dark = material(0x3b302d);
  const flow = material(opts.flowColor, clothMap);
  function mesh(parent: any, geo: any, mat: any, x = 0, y = 0, z = 0, name = '') {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x,y,z);
    m.name = name;
    m.castShadow = true;
    parent.add(m);
    return m;
  }
  function box(parent: any, w: number,h: number,d: number, mat: any,x: number,y: number,z: number,name = '') {
    return mesh(parent,new THREE.BoxGeometry(w,h,d),mat,x,y,z,name);
  }
  function panel(parent: any, points: number[][], depth: number, mat: any,x: number,y: number,z: number) {
    const shape = new THREE.Shape();
    points.forEach(([px,py],i)=>i ? shape.lineTo(px,py) : shape.moveTo(px,py));
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:false,steps:1});
    return mesh(parent,geo,mat,x,y,z);
  }
  const torso = new THREE.Group();
  torso.position.y = 1.08;
  group.add(torso);
  mesh(torso,loft([[-.34,.15,.105],[-.19,.155,.11],[.1,.205,.12],[.27,.22,.115],[.31,.145,.09]]),coat,0,0,0,'blue-coat');
  // Shirt front sits inside an open coat, framed by asymmetric lapels.
  panel(torso,[[-.105,-.22],[.1,-.22],[.13,.23],[.055,.3],[-.07,.29],[-.13,.2]],.018,shirt,0,0,.113);
  panel(torso,[[-.13,.27],[-.075,.23],[-.08,-.23],[-.155,-.28],[-.18,.13]],.025,coatShade,0,0,.128);
  panel(torso,[[.09,.27],[.17,.15],[.145,-.28],[.09,-.22],[.07,.2]],.025,coatLight,0,0,.128);
  panel(torso,[[-.11,.29],[-.035,.22],[-.075,.12],[-.145,.22]],.018,shirt,0,0,.15);
  panel(torso,[[.065,.29],[.13,.22],[.075,.14],[.03,.22]],.018,shirt,0,0,.15);
  box(torso,.018,.13,.008,shirtShade,-.015,.02,.139);
  box(torso,.06,.009,.009,shirtShade,.035,-.13,.141);
  box(torso,.012,.08,.009,shirtShade,.052,.12,.141);
  for (const side of [-1,1]) for (const y of [-.19,-.05,.09]) {
    mesh(torso,new THREE.SphereGeometry(.013,5,4),gold,side*.133,y,.16);
  }
  // Back tailoring: center seam, shoulder yoke and belt keep all angles readable.
  box(torso,.009,.42,.01,coatShade,0,-.015,-.122);
  box(torso,.32,.035,.012,coatLight,0,.19,-.106);
  box(group,.33,.055,.24,boots,0,.81,.008,'belt');
  box(group,.065,.057,.025,gold,.015,.81,.143);
  box(group,.038,.032,.029,dark,.015,.81,.148);
  box(group,.045,.09,.03,flow,-.13,.76,.126,'team-ribbon');
  mesh(group,loft([[-.09,.145,.09],[.09,.16,.105]]),pants,0,.72,0);
  mesh(group,new THREE.CylinderGeometry(.062,.073,.15,8),skin,0,1.44,0);

  const head = new THREE.Group();
  head.position.set(0,1.64,0);
  group.add(head);
  mesh(head,loft([[-.18,.057,.058,.015],[-.14,.087,.077,.01],[-.06,.112,.09],[.055,.108,.087],[.13,.09,.075],[.15,.055,.05]]),skin,0,0,0,'face');
  mesh(head,loft([[-.166,.05,.033],[-.14,.076,.053]]),skinShade,0,0,.034);
  for (const side of [-1,1]) {
    mesh(head,new THREE.SphereGeometry(.029,6,5),skin,side*.11,-.035,0);
    box(head,.025,.028,.012,skinShade,side*.112,-.034,.018);
    box(head,.047,.023,.014,shirt,side*.046,.008,.083);
    box(head,.014,.019,.017,material(0x36516b),side*.039,.008,.089);
    box(head,.007,.014,.019,dark,side*.037,.007,.091);
    box(head,.054,.012,.016,hair,side*.047,.038,.086);
  }
  // A narrow wedge nose projects from the face in profile.
  const nose = new THREE.ConeGeometry(.026,.088,4);
  const noseMesh=mesh(head,nose,skin,0,-.035,.106);
  noseMesh.rotation.x=Math.PI/2;
  noseMesh.rotation.z=Math.PI/4;
  box(head,.045,.008,.012,dark,.008,-.104,.093);
  box(head,.03,.009,.014,skinShade,.013,-.117,.087);
  box(head,.037,.012,.008,skin,.008,-.143,.079);
  // The swept fringe, crown and tied queue all move with the head.
  mesh(head,loft([[.035,.113,.09,-.015],[.115,.116,.097,-.012],[.18,.085,.077,-.01],[.195,.036,.034]]),hair,0,0,0,'hair-crown');
  panel(head,[[-.112,.12],[-.06,.17],[.08,.15],[.108,.11],[.025,.116],[-.033,.069],[-.09,.025],[-.111,.04]],.025,hairLight,0,0,.076);
  panel(head,[[-.108,.09],[-.075,.13],[-.05,.125],[-.083,.044],[-.112,-.008]],.017,hair,0,0,.091);
  const ponytail = new THREE.Group();
  ponytail.position.set(0,-.015,-.097);
  head.add(ponytail);
  mesh(ponytail,new THREE.SphereGeometry(.044,6,5),hair,0,0,-.028);
  mesh(ponytail,loft([[-.275,.018,.025,-.035],[-.2,.034,.034,-.045],[-.095,.03,.026,-.025],[-.03,.025,.025]]),hair,0,0,0,'ponytail');
  box(ponytail,.063,.026,.063,flow,0,-.055,-.017);
  for (const x of [-.045,.015,.064]) {
    const strand=box(head,.01,.061,.008,hairLight,x,.143,.078);
    strand.rotation.z=-.25;
  }
  const arms: any[] = [], legs: any[] = [], tails: any[] = [];
  for (const side of [-1,1]) {
    const arm = new THREE.Group();
    arm.position.set(side*.245,1.34,0);
    group.add(arm);
    mesh(arm,loft([[-.27,.055,.055],[-.17,.064,.064],[-.04,.076,.072],[.025,.063,.059]]),coat,0,0,0);
    mesh(arm,loft([[-.48,.043,.044],[-.27,.055,.055]]),coatLight,0,0,.014);
    mesh(arm,new THREE.CylinderGeometry(.05,.05,.045,8),shirt,0,-.478,.015);
    mesh(arm,new THREE.CylinderGeometry(.058,.055,.055,8),coatShade,0,-.439,.014);
    mesh(arm,new THREE.SphereGeometry(.011,5,4),gold,side*.044,-.44,.045);
    mesh(arm,loft([[-.565,.025,.027],[-.53,.04,.035],[-.49,.037,.032]]),skin,0,0,.022);
    box(arm,.018,.045,.022,skinShade,-side*.034,-.522,.047);
    arms.push(arm);
    const leg = new THREE.Group();
    leg.position.set(side*.085,.73,0);
    group.add(leg);
    mesh(leg,loft([[-.45,.043,.046],[-.32,.054,.06],[-.16,.061,.067],[.015,.067,.074]]),pants,0,0,0);
    mesh(leg,loft([[-.65,.048,.057,.012],[-.54,.052,.057],[-.37,.057,.065]]),boots,0,0,0);
    mesh(leg,new THREE.CylinderGeometry(.069,.066,.055,8),bootLight,0,-.37,0);
    const foot=box(leg,.113,.077,.205,boots,0,-.659,.046);
    foot.rotation.x=-.04;
    box(leg,.118,.025,.212,sole,0,-.7,.045);
    box(leg,.085,.014,.07,bootLight,0,-.61,.078);
    box(leg,.013,.2,.008,bootLight,side*.035,-.5,.054);
    // Split coat skirts follow the thighs when walking or sitting.
    const tail = new THREE.Group();
    tail.position.set(0,.065,-.056);
    leg.add(tail);
    const skirt=mesh(tail,loft([[-.43,.112,.055,-.045],[-.18,.101,.06,-.027],[.02,.088,.052]]),coat,side*.026,0,0,'coat-tail');
    skirt.rotation.z=side*.045;
    panel(tail,[[-.08,.0],[.065,.0],[.087,-.39],[-.085,-.42]],.007,lining,side*.026,0,.012);
    box(tail,.009,.31,.008,coatLight,side*.096,-.18,-.02);
    tails.push(tail);
    legs.push(leg);
  }
  head.userData.animateAccessories = (seconds: number, action: string) => {
    const moving = action === 'walk';
    ponytail.rotation.x = Math.sin(seconds * (moving ? 10 : 2)) * (moving ? .12 : .025);
    ponytail.rotation.z = Math.sin(seconds * (moving ? 5 : 1.3)) * (moving ? .1 : .025);
    tails.forEach((tail,i)=>{tail.rotation.z=Math.sin(seconds*(moving ? 10 : 1.4)+i*Math.PI)*(moving ? .055 : .009);});
  };
  return { group,head,torso,leftArm:arms[0],rightArm:arms[1],leftLeg:legs[0],rightLeg:legs[1] };
}

export const adventure3DSkin: SkinDefinition = {
  manifest: {
    id:'adventure-3d', name:'Adventure 3D',
    description:'A tall blond adventurer with a long blue coat, painted pixel textures and animated coat tails.',
    author:'core',version:'1.0.0',category:'humanoid',
  },
  init(three: any) { THREE=three; },
  createHumanoid:createAdventure3D,
  pickPalette(seed: string) { return {...pickHumanoidPalette(seed),hair:0xc49b4e,pants:0x72654d}; },
};
