// office3d/models.ts
// glTF props for the photographic layer (office3d/realism.ts). Files live in
// static/office3d/models/ — CC0, meshopt-compressed GLB with WebP textures
// (see static/office3d/CREDITS.md). Each file is fetched once; every
// placement gets its own clone.
import { rt } from './runtime.js';

const BASE = '/office3d/models';
const cache = new Map<string, Promise<any | null>>();
let loaderP: Promise<any> | null = null;

async function getLoader(): Promise<any> {
  if (!loaderP) {
    loaderP = (async () => {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      return loader;
    })();
  }
  return loaderP;
}

function loadScene(name: string): Promise<any | null> {
  let p = cache.get(name);
  if (!p) {
    p = getLoader()
      .then((l) => l.loadAsync(`${BASE}/${name}.glb`))
      .then((gltf: any) => gltf.scene)
      .catch((e: unknown) => { console.warn(`[models] ${name} unavailable:`, e); return null; });
    cache.set(name, p);
  }
  return p;
}

/**
 * Place a model with its base on `at`, uniformly scaled to `height` world
 * units and turned `ry` radians. Resolves to the placed object, or null when
 * the file could not be loaded (the caller keeps whatever it had).
 */
export async function placeModel(
  scene: any, name: string,
  at: { x: number; y: number; z: number },
  opts: { height: number; ry?: number; shadows?: boolean },
): Promise<any | null> {
  const src = await loadScene(name);
  if (!src) return null;
  const T = rt.THREE;
  const obj = src.clone(true);
  const box = new T.Box3().setFromObject(obj);
  const size = box.getSize(new T.Vector3());
  const s = size.y > 0 ? opts.height / size.y : 1;
  obj.scale.setScalar(s);
  // Centre on X/Z and sit the lowest point on `at.y`.
  const c = box.getCenter(new T.Vector3());
  obj.position.set(at.x - c.x * s, at.y - box.min.y * s, at.z - c.z * s);
  if (opts.ry) {
    // Rotate about the footprint centre, not the model origin.
    const pivot = new T.Group();
    pivot.position.set(at.x, 0, at.z);
    obj.position.x -= at.x; obj.position.z -= at.z;
    pivot.add(obj);
    pivot.rotation.y = opts.ry;
    scene.add(pivot);
    finish(obj, opts.shadows ?? true);
    return pivot;
  }
  scene.add(obj);
  finish(obj, opts.shadows ?? true);
  return obj;
}

function finish(obj: any, shadows: boolean): void {
  obj.traverse((n: any) => {
    if (n.isMesh) { n.castShadow = shadows; n.receiveShadow = shadows; }
  });
}
