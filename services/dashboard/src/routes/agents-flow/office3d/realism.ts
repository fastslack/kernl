// office3d/realism.ts
// Photographic surface layer, switchable at runtime. When ON, every surface
// that goes through applyWorldTexture() swaps its procedural canvas textures
// for scanned CC0 PBR sets (albedo + normal + roughness, Poly Haven /
// ambientCG) and the baked studio env map is replaced by a real indoor HDRI.
// When OFF nothing here runs and the scene is exactly the procedural one.
//
// Toggle (persists per browser):
//   /agents-flow?realism=0   → procedural look
//   /agents-flow?realism=1   → photographic look (default)
// or from the console: kernlRealism(false) / kernlRealism(true) (reloads).
// Single parts: ?realismSkip=tex,env,lights,models (empty value clears it).
//
// Assets live in static/office3d/ (see static/office3d/CREDITS.md).
import { rt } from './runtime.js';
import type { WorldTexKind } from './textures.js';

const STORAGE_KEY = 'kernl.office3d.realism';
const ASSET_BASE = '/office3d';

let cached: boolean | null = null;

/** Whether the photographic layer is active. Reads ?realism= once and persists it. */
export function realismEnabled(): boolean {
  if (cached !== null) return cached;
  let on = true;
  try {
    const q = new URLSearchParams(window.location.search).get('realism');
    if (q === '0' || q === '1') localStorage.setItem(STORAGE_KEY, q);
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === '0') on = false;
  } catch { /* storage blocked → default */ }
  cached = on;
  return on;
}

/** Parts of the layer that can be switched off one by one. */
export type RealismPart = 'tex' | 'env' | 'lights' | 'models';
let skipped: Set<string> | null = null;

/**
 * Whether one part of the layer is active: the layer is ON and the part is
 * not listed in ?realismSkip=tex,env,lights,models (persisted like ?realism).
 */
export function realismPart(part: RealismPart): boolean {
  if (!realismEnabled()) return false;
  if (!skipped) {
    let raw = '';
    try {
      const q = new URLSearchParams(window.location.search).get('realismSkip');
      if (q !== null) localStorage.setItem(`${STORAGE_KEY}.skip`, q);
      raw = localStorage.getItem(`${STORAGE_KEY}.skip`) ?? '';
    } catch { /* storage blocked → nothing skipped */ }
    skipped = new Set(raw.split(',').map((x) => x.trim()).filter(Boolean));
  }
  return !skipped.has(part);
}

// Live switches, one list per part: every change the layer makes registers
// how to undo/redo itself, so a part can be flipped without a reload — for
// A/B comparisons and profiling: kernlRealismPart('lights', false).
// Entries hold their target weakly: the office is rebuilt on data changes,
// and a switch must not keep the old scene's materials alive. `apply` must be
// a module-level function (a closure would capture its creator's scope, and
// with it the very objects the WeakRef is meant to let go of); whatever it
// needs besides the target travels in `data`.
type LiveEntry = { ref: WeakRef<object>; data: unknown; apply: (target: any, data: any, on: boolean) => void };
const live: Record<RealismPart, LiveEntry[]> = { tex: [], env: [], lights: [], models: [] };

/** Register how to switch one applied change of `part` on and off. */
export function registerRealismSwitch<T extends object, D>(
  part: RealismPart, target: T, data: D, apply: (target: T, data: D, on: boolean) => void,
): void {
  live[part] = live[part].filter((e) => e.ref.deref() !== undefined);
  live[part].push({ ref: new WeakRef(target), data, apply });
}

/** Switch for anything that is simply shown or hidden. */
export function setVisible(obj: any, _data: unknown, on: boolean): void {
  obj.visible = on;
}

/** Switch for a glTF prop that replaces primitive stand-ins (shown when it is off). */
export function swapStandIn(obj: any, d: { stand: any[] }, on: boolean): void {
  obj.visible = on;
  for (const m of d.stand) m.visible = !on;
}

if (typeof window !== 'undefined') {
  (window as any).kernlRealismPart = (part: RealismPart, on: boolean) => {
    let n = 0;
    for (const e of live[part] ?? []) {
      const t = e.ref.deref();
      if (t) { e.apply(t, e.data, on); n++; }
    }
    return n;
  };
  (window as any).kernlRealism = (on: boolean) => {
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
    window.location.reload();
  };
}

/**
 * Per-kind tuning.
 *  realColor: 0 keeps the scene palette exactly (the photo only adds detail),
 *             1 shows the photo's own colours; brightness is preserved either way.
 *  lift:      brightness multiplier over the original surface.
 *  repeat:    extra tiling on top of the UVs the call site already set.
 *  roughness / metalness: replace the material's values (the roughness map
 *             multiplies `roughness`); undefined keeps what the site set.
 *  roughnessMap: false = ignore the photo's roughness map. A map averaging ~0.5
 *             halves the roughness, and a surface that should be dead matte
 *             (a lawn) then throws a sheen back at every light.
 */
const SETS: Record<WorldTexKind, {
  realColor: number; lift: number; repeat: number;
  normalScale: number; roughness?: number; metalness?: number; roughnessMap?: boolean;
}> = {
  // Honed, not polished: lifted 2.6× with the photo's roughness map it read as a white glare.
  marble:   { realColor: 0.8,  lift: 1.7, repeat: 3,   normalScale: 0.8, roughness: 0.85, metalness: 0, roughnessMap: false },
  wood:     { realColor: 0.7,  lift: 1.3, repeat: 1,   normalScale: 0.6, roughness: 0.85, metalness: 0 },
  carpet:   { realColor: 0.0,  lift: 1.1, repeat: 3,   normalScale: 1.0, roughness: 1.0, metalness: 0 },
  wall:     { realColor: 0.15, lift: 1.1, repeat: 1.5, normalScale: 0.7, roughness: 1.0, metalness: 0 },
  concrete: { realColor: 0.2,  lift: 1.0, repeat: 1,   normalScale: 0.8, roughness: 1.0 },
  grass:    { realColor: 0.9,  lift: 1.25, repeat: 2.5, normalScale: 1.6, roughness: 1.0, metalness: 0, roughnessMap: false },
  asphalt:  { realColor: 0.35, lift: 1.0, repeat: 1,   normalScale: 0.8, roughness: 1.0 },
};

/** Environment: HDRI file + intensity (replaces GRADING.environmentIntensity while ON). */
export const REALISM_ENV = {
  url: `${ASSET_BASE}/hdri/studio_small_08_1k.hdr`,
  intensity: 0.55,
};

type PhotoSet = { map: any; normalMap: any; roughnessMap: any; avg: [number, number, number] };
const sets = new Map<WorldTexKind, Promise<PhotoSet | null>>();
let anisotropy = 4;

export function setRealismAnisotropy(v: number): void { anisotropy = v; }

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/** Mean LINEAR colour of an sRGB image (sampled at 32²). */
function meanLinear(img: HTMLImageElement): [number, number, number] {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, 32, 32);
  const px = ctx.getImageData(0, 0, 32, 32).data;
  const acc = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) {
    for (let k = 0; k < 3; k++) acc[k] += Math.pow(px[i + k] / 255, 2.2);
  }
  const n = px.length / 4;
  return [acc[0] / n, acc[1] / n, acc[2] / n];
}

function loadSet(kind: WorldTexKind): Promise<PhotoSet | null> {
  let p = sets.get(kind);
  if (p) return p;
  const THREE = rt.THREE;
  const base = `${ASSET_BASE}/tex/${kind}`;
  p = Promise.all([
    loadImage(`${base}_albedo.jpg`),
    loadImage(`${base}_normal.jpg`),
    loadImage(`${base}_rough.jpg`),
  ]).then(([a, n, r]) => {
    const mk = (img: HTMLImageElement, srgb: boolean) => {
      const t = new THREE.Texture(img);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = anisotropy;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.repeat.set(SETS[kind].repeat, SETS[kind].repeat);
      t.needsUpdate = true;
      return t;
    };
    return { map: mk(a, true), normalMap: mk(n, false), roughnessMap: mk(r, false), avg: meanLinear(a) };
  }).catch((e) => {
    console.warn(`[realism] ${kind} set unavailable, keeping procedural:`, e);
    return null;
  });
  sets.set(kind, p);
  return p;
}

/**
 * Upgrade a material that applyWorldTexture() just set up. `orig` is its
 * colour BEFORE the procedural brightness compensation. Async: the procedural
 * look shows until the photos arrive.
 */
export function upgradeMaterial(material: any, kind: WorldTexKind, orig: any): void {
  void loadSet(kind).then((set) => {
    if (!set) return;
    const cfg = SETS[kind];
    const [ar, ag, ab] = set.avg;
    const avgLum = Math.max(1e-3, 0.2126 * ar + 0.7152 * ag + 0.0722 * ab);
    const origLum = 0.2126 * orig.r + 0.7152 * orig.g + 0.0722 * orig.b;
    // Palette-preserving colour: cancel the photo's mean hue per channel
    // (floored so a strongly tinted photo doesn't blow up its weak channels).
    const floor = avgLum * 0.5;
    const pal = [orig.r / Math.max(ar, floor), orig.g / Math.max(ag, floor), orig.b / Math.max(ab, floor)];
    // Photo-colour variant at the same overall brightness.
    const k = origLum / avgLum;
    const t = cfg.realColor;
    const before = {
      color: material.color.clone(), map: material.map, normalMap: material.normalMap,
      roughnessMap: material.roughnessMap, normalScale: material.normalScale?.x,
      roughness: material.roughness, metalness: material.metalness,
    };
    material.color.setRGB(
      ((1 - t) * pal[0] + t * k) * cfg.lift,
      ((1 - t) * pal[1] + t * k) * cfg.lift,
      ((1 - t) * pal[2] + t * k) * cfg.lift,
    );
    material.map = set.map;
    material.normalMap = set.normalMap;
    material.roughnessMap = cfg.roughnessMap === false ? null : set.roughnessMap;
    if (material.normalScale?.set) material.normalScale.set(cfg.normalScale, cfg.normalScale);
    if (cfg.roughness !== undefined) material.roughness = cfg.roughness;
    if (cfg.metalness !== undefined) material.metalness = cfg.metalness;
    material.needsUpdate = true;
    const after = {
      color: material.color.clone(), map: set.map, normalMap: set.normalMap, roughnessMap: material.roughnessMap,
      normalScale: cfg.normalScale, roughness: material.roughness, metalness: material.metalness,
    };
    registerRealismSwitch('tex', material, { before, after }, applyTexState);
  });
}

type TexState = {
  color: any; map: any; normalMap: any; roughnessMap: any;
  normalScale: number | undefined; roughness: number; metalness: number;
};

function applyTexState(material: any, d: { before: TexState; after: TexState }, on: boolean): void {
  const v = on ? d.after : d.before;
  material.color.copy(v.color);
  material.map = v.map; material.normalMap = v.normalMap; material.roughnessMap = v.roughnessMap;
  if (v.normalScale !== undefined && material.normalScale?.set) material.normalScale.set(v.normalScale, v.normalScale);
  material.roughness = v.roughness; material.metalness = v.metalness;
  material.needsUpdate = true;
}

function applyEnvState(scene: any, d: { env: any; baked: any; bakedIntensity: number }, on: boolean): void {
  scene.environment = on ? d.env : d.baked;
  if ('environmentIntensity' in scene) scene.environmentIntensity = on ? REALISM_ENV.intensity : d.bakedIntensity;
}

/** Load the HDRI and make it the scene environment; keeps the baked one on failure. */
export async function applyRealismEnvironment(renderer: any, scene: any): Promise<void> {
  const THREE = rt.THREE;
  try {
    const { HDRLoader } = await import('three/examples/jsm/loaders/HDRLoader.js');
    const hdr = await new HDRLoader().loadAsync(REALISM_ENV.url);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(hdr).texture;
    hdr.dispose();
    pmrem.dispose();
    // The baked map is kept (it is small) so the switch can go back to it.
    const data = { env, baked: scene.environment, bakedIntensity: scene.environmentIntensity };
    applyEnvState(scene, data, true);
    registerRealismSwitch('env', scene, data, applyEnvState);
  } catch (e) {
    console.warn('[realism] HDRI unavailable, keeping baked environment:', e);
  }
}
