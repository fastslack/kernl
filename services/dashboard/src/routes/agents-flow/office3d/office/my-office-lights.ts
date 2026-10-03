// office3d/office/my-office-lights.ts
// Photographic-layer lighting for the executive office: the desk lamp, the
// floor lamp and the window stop being glowing props and actually light the
// room. Only runs with the realism layer ON (office3d/realism.ts), so
// ?realism=0 brings back the original single-light office.
//
// Cost: three PointLights, no shadows. Every light is evaluated for every lit
// fragment in the whole scene, so keep this list short.
import { rt } from '../runtime.js';
import { realismPart, registerRealismSwitch, setVisible, swapStandIn } from '../realism.js';
import { placeModel } from '../models.js';

type P = { x: number; y: number; z: number };

const WINDOW_VIEW_URL = '/office3d/tex/window_city.jpg';

export function addMyOfficeLights(scene: any, opts: {
  /** Bulb position inside the desk lamp shade. */
  deskLamp: P;
  /** Bulb position inside the floor lamp shade. */
  floorLamp: P;
  /** The back-wall window pane; gets a night-city view. */
  windowMesh: any;
}): void {
  if (!realismPart('lights')) return;
  const T = rt.THREE;

  // Desk lamp: warm, short reach — a pool of light on the writing surface.
  const desk = new T.PointLight(0xffc27a, 2.2, 3.2, 2);
  desk.position.set(opts.deskLamp.x, opts.deskLamp.y - 0.05, opts.deskLamp.z);
  desk.matrixAutoUpdate = false; desk.updateMatrix();
  scene.add(desk);
  registerRealismSwitch('lights', desk, null, setVisible);

  // Floor lamp in the lounge: warm, wider, lights the sofa and the painting.
  const floor = new T.PointLight(0xffb36b, 4.4, 6, 2);
  floor.position.set(opts.floorLamp.x, opts.floorLamp.y, opts.floorLamp.z);
  floor.matrixAutoUpdate = false; floor.updateMatrix();
  scene.add(floor);
  registerRealismSwitch('lights', floor, null, setVisible);

  // Cool city light spilling in through the window, onto the back of the
  // desk and the occupant — the counterpoint to the warm lamps.
  const pane = opts.windowMesh?.position;
  if (pane) {
    const spill = new T.PointLight(0x7f98ff, 3.2, 5, 2);
    spill.position.set(pane.x, pane.y - 0.2, pane.z + 0.8);
    spill.matrixAutoUpdate = false; spill.updateMatrix();
    scene.add(spill);
    registerRealismSwitch('lights', spill, null, setVisible);
  }

  // Window: a night skyline instead of a flat blue panel. Emissive, so the
  // city glows on its own and bloom picks up the neon.
  const mat = opts.windowMesh?.material;
  if (!mat) return;
  new T.TextureLoader().load(WINDOW_VIEW_URL, (tex: any) => {
    tex.colorSpace = T.SRGBColorSpace;
    const before = {
      color: mat.color.clone(), emissive: mat.emissive.clone(), emissiveMap: mat.emissiveMap,
      emissiveIntensity: mat.emissiveIntensity, roughness: mat.roughness, metalness: mat.metalness,
      transparent: mat.transparent, opacity: mat.opacity,
    };
    mat.color.set(0x000000);
    mat.emissive.set(0xffffff);
    mat.emissiveMap = tex;
    mat.emissiveIntensity = 0.85;
    mat.roughness = 0.05;
    mat.metalness = 0;
    mat.transparent = false;
    mat.opacity = 1;
    mat.needsUpdate = true;
    const after = {
      color: mat.color.clone(), emissive: mat.emissive.clone(), emissiveMap: tex,
      emissiveIntensity: mat.emissiveIntensity, roughness: mat.roughness, metalness: mat.metalness,
      transparent: false, opacity: 1,
    };
    registerRealismSwitch('lights', mat, { before, after }, applyWindowState);
  });
}

/**
 * Real glTF props (office3d/models.ts) in place of the primitive ones:
 * potted plants instead of the green spheres, and a marble bust on top of
 * the bookcase. The primitive stand-ins are hidden only once each model has
 * loaded, so a failed download leaves the old look in place.
 */
export function addMyOfficeProps(scene: any, opts: {
  /** Each pot's floor position and the primitive meshes it replaces. */
  plants: Array<{ x: number; z: number; stand: any[] }>;
  /** Top of the bookcase, where the bust sits. */
  bust: P;
}): void {
  if (!realismPart('models')) return;
  opts.plants.forEach((p, i) => {
    void placeModel(scene, 'potted_plant_02', { x: p.x, y: 0, z: p.z }, { height: 1.45, ry: i * 2.1 })
      .then((obj) => {
        if (!obj) return;
        const data = { stand: p.stand };
        swapStandIn(obj, data, true);
        registerRealismSwitch('models', obj, data, swapStandIn);
      });
  });
  void placeModel(scene, 'marble_bust_01', opts.bust, { height: 0.5, ry: Math.PI / 2 })
    .then((obj) => { if (obj) registerRealismSwitch('models', obj, null, setVisible); });
}

type WindowState = {
  color: any; emissive: any; emissiveMap: any; emissiveIntensity: number;
  roughness: number; metalness: number; transparent: boolean; opacity: number;
};

function applyWindowState(mat: any, d: { before: WindowState; after: WindowState }, on: boolean): void {
  const v = on ? d.after : d.before;
  mat.color.copy(v.color); mat.emissive.copy(v.emissive); mat.emissiveMap = v.emissiveMap;
  mat.emissiveIntensity = v.emissiveIntensity; mat.roughness = v.roughness; mat.metalness = v.metalness;
  mat.transparent = v.transparent; mat.opacity = v.opacity;
  mat.needsUpdate = true;
}
