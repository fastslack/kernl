// office3d/scene.ts
// The renderer-side setup of the 3D office, lifted out of AgentWorld3D's
// buildScene(): the WebGL renderer (with its fallback chain), the CSS2D label
// layer, the baked environment map, the initial camera distance and the
// post-processing pipeline. Everything here is pure THREE plumbing — it takes
// what it needs as arguments and returns what it built. The component still
// owns those objects and decides when each step runs; the office build, the
// camera controls and the pointer wiring stay there with the state they touch.
import { applyRendererGrading, applySceneGrading, GRADING } from './grading.js';
import { setTextureAnisotropy } from './textures.js';
import type { Vec3 } from './types.js';

/** First renderer config the GPU accepts, most capable first; null when none is usable. */
export function createRenderer(THREE: any): any | null {
  const opts = [
    { antialias: true, alpha: false, failIfMajorPerformanceCaveat: false, powerPreference: 'high-performance' as const, preserveDrawingBuffer: false },
    { antialias: false, alpha: false, failIfMajorPerformanceCaveat: false, powerPreference: 'default' as const },
    { antialias: false, alpha: false, failIfMajorPerformanceCaveat: false },
  ];
  let renderer: any = null;
  for (const o of opts) {
    try {
      renderer = new THREE.WebGLRenderer(o);
      // Verify the context is actually usable
      const gl = renderer.getContext();
      if (!gl || gl.isContextLost?.()) { renderer = null; continue; }
      break;
    } catch (e) {
      console.warn('[WebGL] renderer init failed:', e);
      renderer = null;
    }
  }
  return renderer;
}

/** Size, pixel ratio, shadows and grading for a freshly-created renderer; mounts its canvas. */
export function configureRenderer(THREE: any, renderer: any, canvasEl: HTMLElement): void {
  renderer.setSize(canvasEl.clientWidth, canvasEl.clientHeight);
  // Cap pixel ratio at 1.5 — HiDPI displays (dpr=2/3) quadruple shading cost
  // for marginal visual gain on a dense 3D scene. 1.5 still looks crisp.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  // Accumulate render stats across all passes (composer / post-process /
  // labelRenderer) within a single frame so the perf overlay sees the real
  // total — auto-reset would zero between sub-renders and only the last
  // pass (e.g. a fullscreen quad) would survive.
  renderer.info.autoReset = false;
  renderer.shadowMap.enabled = true;
  // PCFSoft is noticeably cheaper than VSM on dense scenes and visually
  // indistinguishable for our top-down office view.
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Shadow pass at half frame rate: the key light and the architecture are
  // static — only walkers/taxis move shadows, and 30Hz on those is
  // imperceptible. Saves a full 2048² depth render every other frame.
  // (needsUpdate=true is set on even frames in animate(); true here so the
  // very first frame bakes shadows.)
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  // ── Color grading global — ver office3d/grading.ts ──
  applyRendererGrading(renderer);
  // Procedural world textures sample at grazing angles on floors/streets —
  // real HW anisotropy keeps them sharp without supersampling.
  setTextureAnisotropy(renderer.capabilities?.getMaxAnisotropy?.() ?? 4);
  canvasEl.appendChild(renderer.domElement);
}

/** The CSS2D layer (nameplates, tags, banners) stacked over the WebGL canvas. */
export function createLabelRenderer(css2d: any, canvasEl: HTMLElement): any {
  const labelRenderer = new css2d.CSS2DRenderer();
  labelRenderer.setSize(canvasEl.clientWidth, canvasEl.clientHeight);
  labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:5;';
  canvasEl.appendChild(labelRenderer.domElement);
  return labelRenderer;
}

/** Bake the reflection environment into `scene` and apply the scene grading. */
export function applyEnvironment(THREE: any, renderer: any, scene: any): void {
  // ── Environment map for realistic reflections on glass/metal ──
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    // Richer studio-style environment → more believable reflections on metal
    // and glass. All meshes live in this throwaway scene and are baked once
    // by PMREM into a cubemap; zero per-frame cost.
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(
      new THREE.SphereGeometry(50, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0x0a1020, side: 1 }),
    ));
    // Warm ceiling glow (brighter so highlights on metal/glass read).
    const ceilGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 90),
      new THREE.MeshBasicMaterial({ color: 0x24304e }),
    );
    ceilGlow.position.y = 40; ceilGlow.rotation.x = Math.PI / 2;
    envScene.add(ceilGlow);
    // Cool floor reflection
    const floorGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 90),
      new THREE.MeshBasicMaterial({ color: 0x070c1a }),
    );
    floorGlow.position.y = -10; floorGlow.rotation.x = -Math.PI / 2;
    envScene.add(floorGlow);
    // Horizon haze band → soft gradient at eye level, the bit reflections
    // actually catch on near-vertical surfaces.
    const horizon = new THREE.Mesh(
      new THREE.CylinderGeometry(48, 48, 22, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x12203c, side: 1 }),
    );
    envScene.add(horizon);
    // Warm key bounce (upper-right, matching the sun) + cool fill (opposite)
    // → directional shine on metals instead of a flat ambient sheen.
    const keyPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(38, 26),
      new THREE.MeshBasicMaterial({ color: 0x4a4030, side: 2 }),
    );
    keyPanel.position.set(26, 16, 18); keyPanel.lookAt(0, 0, 0);
    envScene.add(keyPanel);
    const fillPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(34, 22),
      new THREE.MeshBasicMaterial({ color: 0x1c3258, side: 2 }),
    );
    fillPanel.position.set(-30, 12, -22); fillPanel.lookAt(0, 0, 0);
    envScene.add(fillPanel);
    // Higher blur sigma (0.035→0.18): the env is a few flat colored panels;
    // sharp, they reflected as hard ugly blotches on any glossy floor. Blurred
    // they read as a soft gradient, so reflections look like ambient sheen.
    const envMap = pmrem.fromScene(envScene, 0.18).texture;
    scene.environment = envMap;
    pmrem.dispose();
  } catch (e) { console.warn('[EnvMap] Failed:', e); }
  // Fog + environment intensity — unconditional (must apply even if PMREM
  // env generation above threw; environmentIntensity is `in`-guarded).
  applySceneGrading(scene);
}

/** How far out the initial isometric camera sits so the whole block (streets included) is framed. */
export function initialCameraDistance(
  deskPos: Map<string, Vec3>,
  buildingBounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): number {
  let ext = 0;
  for (const [, p] of deskPos) ext = Math.max(ext, Math.sqrt(p.x ** 2 + p.z ** 2));
  const b = buildingBounds;
  const buildingRadius = Math.max(Math.abs(b.maxX), Math.abs(b.minX), Math.abs(b.maxZ), Math.abs(b.minZ));
  const STREET_MARGIN = 23; // ≈ PLINTH_W (5) + PED_W (3.5) + STREET_W (12) + portal in office.ts
  const cd = Math.max(60, Math.max(ext, buildingRadius + STREET_MARGIN) * 1.15);
  return cd;
}

/** Post-processing pipeline; `composer` is null when it is skipped or unavailable. */
export async function createPostProcessing(
  THREE: any, renderer: any, scene: any, camera: any, canvasEl: HTMLElement,
): Promise<{ composer: any; gtaoPass: any; bloomPass: any }> {
  // ── Post-processing: selective bloom for emissive surfaces (monitors, envelopes) ──
  // Bloom adds 3 fullscreen passes per frame. On HiDPI displays that's very
  // expensive; skip it entirely on retina / >1.5x dpr and fall back to direct
  // render. Loss of bloom is barely noticeable with tonemapping active.
  let composer: any = null;
  let gtaoPass: any = null;
  let bloomPass: any = null;
  if (window.devicePixelRatio <= 1.5) {
    try {
      const { EffectComposer } = await import('three/examples/jsm/postprocessing/EffectComposer.js');
      const { RenderPass } = await import('three/examples/jsm/postprocessing/RenderPass.js');
      const { UnrealBloomPass } = await import('three/examples/jsm/postprocessing/UnrealBloomPass.js');
      const { OutputPass } = await import('three/examples/jsm/postprocessing/OutputPass.js');
      composer = new EffectComposer(renderer);
      // ── Anti-aliasing through the composer (fixes the "pixelado") ──
      // The renderer's `antialias:true` ONLY anti-aliases the default
      // framebuffer — which the EffectComposer bypasses entirely. So every
      // edge in the post-processed scene (i.e. always, on dpr≤1.5 monitors)
      // was rendered with zero MSAA → jagged/aliased = the pixelation the
      // user saw. Enable 4× MSAA on the composer's ping-pong render targets.
      // We let the default constructor size them correctly (CSS px × dpr) and
      // only flip `samples` + dispose so the GL framebuffers reinit as
      // multisampled (setSize alone ignores a samples change). samples is
      // preserved across resize, so this survives the ResizeObserver path.
      const AA_SAMPLES = 4;
      for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
        rt.samples = AA_SAMPLES;
        rt.dispose();
      }
      composer.addPass(new RenderPass(scene, camera));

      // GTAO — screen-space ambient occlusion. DISABLED by default: at our
      // sample budget it produced view-dependent noise/blotches on flat
      // surfaces (desks, carpet) that read as "manchas". The scene already
      // has zero-cost baked vertex AO (bakeVertexAO) + real shadow maps for
      // depth, so dropping GTAO removes the artifact AND saves the most
      // expensive post pass. Flip GTAO_ENABLED back to true to restore it.
      const GTAO_ENABLED = false;
      const aoCores = navigator.hardwareConcurrency ?? 8;
      if (GTAO_ENABLED && aoCores >= 4) {
        try {
          const { GTAOPass } = await import('three/examples/jsm/postprocessing/GTAOPass.js');
          const gtao = new GTAOPass(scene, camera, canvasEl.clientWidth, canvasEl.clientHeight);
          gtao.output = (GTAOPass as any).OUTPUT.Default;
          // AO tuned to stop the blotchy "reflejo feo" on flat surfaces
          // (keyboards, carpet): smaller radius keeps it as tight contact
          // shadows instead of large smears; distanceExponent 1→2 makes AO
          // fall off faster so it stops bleeding across flat planes; samples
          // back up to 16 to kill the noise the 8-sample pass introduced. The
          // adaptive controller still disables the whole pass under load.
          gtao.updateGtaoMaterial({
            radius: 0.5, distanceExponent: 2, thickness: 1,
            scale: 1.0, samples: 16, screenSpaceRadius: false,
          });
          composer.addPass(gtao);
          gtaoPass = gtao;
        } catch (e) { console.warn('[GTAO] unavailable, skipping AO pass:', e); }
      }

      // Bloom — subtle glow on emissive surfaces. Strength + radius dialed
      // down (0.3→0.15, 0.5→0.3) to roughly halve the post-process cost.
      // Visually still picks up on monitor glow / running emissives.
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(canvasEl.clientWidth, canvasEl.clientHeight),
        GRADING.bloom.strength,
        GRADING.bloom.radius,
        GRADING.bloom.threshold,
      );
      composer.addPass(bloom);
      bloomPass = bloom;
      composer.addPass(new OutputPass());
    } catch (e) {
      console.warn('[PostProcess] Not available, falling back to direct render:', e);
      composer = null;
    }
  } else {
    composer = null;
  }
  return { composer, gtaoPass, bloomPass };
}
