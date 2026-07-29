// office3d/textures.ts
// Procedural texture pack — generated ONCE on offscreen canvases at build time.
// Zero per-frame cost: ~10 tiny 256² textures total. Every `map` is near-white
// grayscale so the existing material palette keeps tinting via material.color;
// the matching normalMap (Sobel over the same heightfield) adds micro-relief
// under the key light. All patterns are seamless (wrapped lattice noise +
// wrapped pixel plotting) so they tile without visible borders.
import { rt } from './runtime.js';

export type WorldTexKind = 'carpet' | 'asphalt' | 'concrete' | 'wall' | 'wood' | 'marble';

const SIZE = 256;

// Deterministic PRNG → the world renders identically every load (no texture
// "reshuffle" between sessions / HMR rebuilds).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seamless value noise: random lattice (wrapping indices) + smoothstep bilinear. */
function makeValueNoise(seed: number, cellsX: number, cellsY: number): (x: number, y: number) => number {
  const rand = mulberry32(seed);
  const lattice = new Float32Array(cellsX * cellsY);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  return (x: number, y: number) => {
    // x,y in 0..1 → lattice space with wraparound
    const fx = x * cellsX, fy = y * cellsY;
    const x0 = Math.floor(fx) % cellsX, y0 = Math.floor(fy) % cellsY;
    const x1 = (x0 + 1) % cellsX, y1 = (y0 + 1) % cellsY;
    let tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = lattice[y0 * cellsX + x0], b = lattice[y0 * cellsX + x1];
    const c = lattice[y1 * cellsX + x0], d = lattice[y1 * cellsX + x1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

type HeightField = Float32Array; // SIZE*SIZE, values ~0..1 (0.5 = flat)

function flatField(v = 0.5): HeightField {
  const f = new Float32Array(SIZE * SIZE);
  f.fill(v);
  return f;
}

function addNoise(field: HeightField, noise: (x: number, y: number) => number, amp: number): void {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      field[y * SIZE + x] += (noise(x / SIZE, y / SIZE) - 0.5) * amp;
    }
  }
}

/** Plot with wraparound so strokes crossing an edge stay seamless. */
function plot(field: HeightField, x: number, y: number, delta: number): void {
  const xi = ((Math.round(x) % SIZE) + SIZE) % SIZE;
  const yi = ((Math.round(y) % SIZE) + SIZE) % SIZE;
  field[yi * SIZE + xi] += delta;
}

/** Random-walk hairline cracks (seamless via wrapped plotting). */
function addCracks(field: HeightField, seed: number, count: number, length: number, depth: number): void {
  const rand = mulberry32(seed);
  for (let c = 0; c < count; c++) {
    let x = rand() * SIZE, y = rand() * SIZE;
    let ang = rand() * Math.PI * 2;
    for (let i = 0; i < length; i++) {
      ang += (rand() - 0.5) * 0.5;
      x += Math.cos(ang); y += Math.sin(ang);
      plot(field, x, y, -depth);
      // soft halo so the normal map picks a groove, not a 1px spike
      plot(field, x + 1, y, -depth * 0.4);
      plot(field, x, y + 1, -depth * 0.4);
    }
  }
}

/** Aggregate speckles (asphalt/concrete grain). */
function addSpeckles(field: HeightField, seed: number, count: number, amp: number): void {
  const rand = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const x = rand() * SIZE, y = rand() * SIZE;
    plot(field, x, y, (rand() - 0.4) * amp);
  }
}

// ── Per-kind heightfield recipes ────────────────────────────────────────────
function buildHeight(kind: WorldTexKind): HeightField {
  const f = flatField();
  switch (kind) {
    case 'carpet': {
      // High-frequency only: fine grain mips away to flat at distance, so the
      // tile repeat is invisible. NO low-freq blotches — anything large-scale
      // repeats every tile and reads as a checkerboard from afar.
      addNoise(f, makeValueNoise(101, 96, 96), 0.30);  // fiber grain
      addNoise(f, makeValueNoise(102, 48, 48), 0.10);  // slightly coarser tooth
      // Tight orthogonal weave — high cycle count so it reads as fabric, not grid.
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const w = Math.sin((x / SIZE) * Math.PI * 2 * 64) * Math.sin((y / SIZE) * Math.PI * 2 * 64);
          f[y * SIZE + x] += w * 0.03;
        }
      }
      break;
    }
    case 'asphalt': {
      addNoise(f, makeValueNoise(201, 14, 14), 0.07);  // patch variation (kept faint — repeats per tile)
      addNoise(f, makeValueNoise(202, 110, 110), 0.22); // fine grain
      addSpeckles(f, 203, 1400, 0.55);                  // aggregate stones
      addCracks(f, 204, 2, 220, 0.10);
      break;
    }
    case 'concrete': {
      addNoise(f, makeValueNoise(301, 7, 7), 0.08);    // mottling (faint — repeats per tile)
      addNoise(f, makeValueNoise(302, 56, 56), 0.12);  // fine pores
      addSpeckles(f, 303, 500, 0.30);
      addCracks(f, 304, 3, 160, 0.14);
      break;
    }
    case 'wall': {
      // Vertical streaks: anisotropic lattice (many cells in X, few in Y).
      // Fine-grained only — no seams/panels: anything periodic at tile scale
      // turns walls into striped wallpaper from a distance.
      addNoise(f, makeValueNoise(401, 56, 7), 0.12);
      addNoise(f, makeValueNoise(402, 90, 90), 0.08);  // fine tooth
      break;
    }
    case 'marble': {
      addNoise(f, makeValueNoise(601, 5, 5), 0.06);    // soft tonal drift
      addNoise(f, makeValueNoise(602, 70, 70), 0.03);  // polish micrograin
      // Long meandering BRIGHT veins — light streaks through dark stone (the
      // slab colors in scene are dark, so positive tone is what actually reads).
      const rand = mulberry32(603);
      for (let c = 0; c < 9; c++) {
        let x = rand() * SIZE, y = rand() * SIZE;
        let ang = rand() * Math.PI * 2;
        const tone = 0.16 + rand() * 0.14;
        for (let i = 0; i < 480; i++) {
          ang += (rand() - 0.5) * 0.22;
          x += Math.cos(ang); y += Math.sin(ang);
          plot(f, x, y, tone);
          plot(f, x + 1, y, tone * 0.55);
          plot(f, x, y + 1, tone * 0.3);
        }
      }
      break;
    }
    case 'wood': {
      const warp = makeValueNoise(501, 8, 8);
      const streak = makeValueNoise(502, 6, 120);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const u = x / SIZE, v = y / SIZE;
          // Grain bands along Y, warped by low-freq noise — integer band count.
          const band = Math.sin((u + (warp(u, v) - 0.5) * 0.18) * Math.PI * 2 * 9);
          f[y * SIZE + x] += band * 0.07 + (streak(u, v) - 0.5) * 0.10;
        }
      }
      break;
    }
  }
  return f;
}

// Luminance shaping per kind — keep values high so material.color dominates.
const LUM: Record<WorldTexKind, { base: number; contrast: number }> = {
  carpet:   { base: 0.84, contrast: 0.45 },
  asphalt:  { base: 0.80, contrast: 0.55 },
  concrete: { base: 0.86, contrast: 0.42 },
  wall:     { base: 0.93, contrast: 0.28 },
  wood:     { base: 0.86, contrast: 0.40 },
  marble:   { base: 0.90, contrast: 0.55 },
};

const NORMAL_SCALE: Record<WorldTexKind, number> = {
  carpet: 0.28, asphalt: 0.50, concrete: 0.35, wall: 0.18, wood: 0.30, marble: 0.12,
};

function heightToMapCanvas(field: HeightField, kind: WorldTexKind): HTMLCanvasElement {
  const { base, contrast } = LUM[kind];
  const cv = document.createElement('canvas');
  cv.width = SIZE; cv.height = SIZE;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  for (let i = 0; i < field.length; i++) {
    const lum = Math.max(0, Math.min(1, base + (field[i] - 0.5) * contrast));
    const v = Math.round(lum * 255);
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function heightToNormalCanvas(field: HeightField): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = SIZE; cv.height = SIZE;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  const h = (x: number, y: number) => field[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)];
  const K = 2.2; // gradient gain; final strength comes from material.normalScale
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * K;
      const dy = (h(x, y + 1) - h(x, y - 1)) * K;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * SIZE + x) * 4;
      img.data[i]     = Math.round(((-dx * inv) * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round(((-dy * inv) * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// ── Cache + public API ──────────────────────────────────────────────────────
type TexPair = { map: any; normalMap: any; avgLin: number };
const cache = new Map<WorldTexKind, TexPair>();
let maxAnisotropy = 4;

/** Call once after renderer init so textures use real HW anisotropy. */
export function setTextureAnisotropy(value: number): void {
  maxAnisotropy = Math.max(1, Math.min(8, value || 1));
  for (const pair of cache.values()) {
    pair.map.anisotropy = maxAnisotropy;
    pair.normalMap.anisotropy = maxAnisotropy;
    pair.map.needsUpdate = true;
    pair.normalMap.needsUpdate = true;
  }
}

export function getWorldTexture(kind: WorldTexKind): TexPair {
  let pair = cache.get(kind);
  if (pair) return pair;
  const THREE = rt.THREE;
  const field = buildHeight(kind);
  const map = new THREE.CanvasTexture(heightToMapCanvas(field, kind));
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAnisotropy;
  const normalMap = new THREE.CanvasTexture(heightToNormalCanvas(field));
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.anisotropy = maxAnisotropy;
  // Average LINEAR luminance of the map — the map multiplies material.color in
  // linear space, so applyWorldTexture divides the color by this to keep each
  // surface's overall brightness identical to the untextured original.
  const { base, contrast } = LUM[kind];
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const lum = Math.max(0, Math.min(1, base + (field[i] - 0.5) * contrast));
    sum += Math.pow(lum, 2.2); // sRGB → linear approx
  }
  const avgLin = Math.max(0.2, sum / field.length);
  pair = { map, normalMap, avgLin };
  cache.set(kind, pair);
  return pair;
}

/**
 * Attach the kind's map + normalMap to an existing MeshStandardMaterial.
 * Color/roughness/metalness are untouched — the grayscale map multiplies the
 * existing tint, so the scene palette is preserved.
 */
export function applyWorldTexture(
  material: any,
  kind: WorldTexKind,
  opts: { normalScale?: number } = {},
): void {
  if (!material || !rt.THREE) return;
  const { map, normalMap, avgLin } = getWorldTexture(kind);
  material.map = map;
  material.normalMap = normalMap;
  // Brightness compensation: the grayscale map would darken the surface by its
  // average luminance; pre-boost the tint so the lit result matches the
  // original palette (components may exceed 1 — tone mapping handles it).
  if (material.color?.multiplyScalar && !material.__texCompensated) {
    material.color.multiplyScalar(1 / avgLin);
    material.__texCompensated = true;
  }
  const s = opts.normalScale ?? NORMAL_SCALE[kind];
  if (material.normalScale?.set) material.normalScale.set(s, s);
  material.needsUpdate = true;
}

/**
 * Rescale a geometry's UVs so one texture tile spans a fixed world size —
 * constant texel density across rooms/streets of any dimension. Mutates the
 * uv attribute in place (call right after creating the geometry).
 */
export function scaleUV(geometry: any, tilesU: number, tilesV: number): void {
  const uv = geometry?.attributes?.uv;
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * tilesU, uv.getY(i) * tilesV);
  }
  uv.needsUpdate = true;
}

// ── One-off UI textures (monitor screens, whiteboards) ─────────────────────
// Not tiling world materials: each is a single image generated once and
// shared across every mesh that uses it (no per-instance canvases).
const uiCache = new Map<string, any>();

/**
 * Grayscale "screen content" texture, used as emissiveMap on the monitors so
 * the per-state emissive color (blue idle / green running) tints it. The
 * panel background stays at ~35% so screens keep their soft glow from afar,
 * while text rows / charts pop bright up close.
 */
export function getScreenTexture(variant: number): any {
  const key = `screen:${variant % 3}`;
  if (uiCache.has(key)) return uiCache.get(key);
  const THREE = rt.THREE;
  const W = 128, H = 80;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = 'rgb(90,90,90)'; // base panel glow
  ctx.fillRect(0, 0, W, H);
  const rand = mulberry32(700 + (variant % 3));
  // Title bar
  ctx.fillStyle = 'rgb(160,160,160)';
  ctx.fillRect(0, 0, W, 7);
  ctx.fillStyle = 'rgb(40,40,40)';
  ctx.fillRect(3, 2, 26, 3);
  if (variant % 3 === 1) {
    // Dashboard: bar chart + sparkline
    const bars = 9;
    for (let i = 0; i < bars; i++) {
      const bh = 8 + rand() * 34;
      ctx.fillStyle = `rgb(${200 + Math.floor(rand() * 55)},${200 + Math.floor(rand() * 55)},${200 + Math.floor(rand() * 55)})`;
      ctx.fillRect(8 + i * 13, H - 10 - bh, 8, bh);
    }
    ctx.strokeStyle = 'rgb(255,255,255)';
    ctx.beginPath();
    ctx.moveTo(6, 22);
    for (let x = 6; x < W - 6; x += 6) ctx.lineTo(x, 14 + rand() * 14);
    ctx.stroke();
  } else {
    // Terminal / code: rows of dashes with jitter and indents
    let y = 12;
    while (y < H - 6) {
      let x = 6 + (variant % 3 === 2 ? Math.floor(rand() * 3) * 10 : 0);
      const segs = 1 + Math.floor(rand() * 3);
      for (let s = 0; s < segs && x < W - 10; s++) {
        const len = 10 + rand() * 36;
        const bright = rand() > 0.75 ? 255 : 190;
        ctx.fillStyle = `rgb(${bright},${bright},${bright})`;
        ctx.fillRect(x, y, Math.min(len, W - 8 - x), 3);
        x += len + 6;
      }
      y += 6;
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  uiCache.set(key, tex);
  return tex;
}

/** Whiteboard scribbles: handwriting strokes, a small chart, colored arrows. */
export function getWhiteboardTexture(variant: number): any {
  const key = `board:${variant % 2}`;
  if (uiCache.has(key)) return uiCache.get(key);
  const THREE = rt.THREE;
  const W = 256, H = 144;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = 'rgb(235,239,244)';
  ctx.fillRect(0, 0, W, H);
  const rand = mulberry32(800 + (variant % 2));
  const inks = ['rgba(36,52,120,0.85)', 'rgba(170,40,40,0.8)', 'rgba(30,110,60,0.8)'];
  // "Handwriting" lines: wobbly horizontal strokes of varying length
  let y = 18;
  for (let row = 0; row < 5; row++) {
    const ink = inks[Math.floor(rand() * inks.length)];
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    let x = 14 + rand() * 10;
    const end = x + 60 + rand() * (variant % 2 === 0 ? 90 : 50);
    ctx.beginPath();
    ctx.moveTo(x, y);
    while (x < end && x < W - 14) {
      x += 7;
      ctx.lineTo(x, y + (rand() - 0.5) * 5);
    }
    ctx.stroke();
    y += 16 + rand() * 6;
  }
  // Small chart in a corner: axes + rising polyline
  const cx0 = variant % 2 === 0 ? W - 92 : W - 100, cy0 = H - 18;
  ctx.strokeStyle = 'rgba(40,40,50,0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx0, cy0 - 52); ctx.lineTo(cx0, cy0); ctx.lineTo(cx0 + 74, cy0);
  ctx.stroke();
  ctx.strokeStyle = inks[2];
  ctx.beginPath();
  ctx.moveTo(cx0 + 4, cy0 - 6);
  for (let i = 1; i <= 6; i++) ctx.lineTo(cx0 + 4 + i * 11, cy0 - 6 - i * 6 + (rand() - 0.5) * 10);
  ctx.stroke();
  // Circled note + arrow
  ctx.strokeStyle = inks[1];
  ctx.beginPath();
  ctx.ellipse(50 + rand() * 30, H - 36, 24, 12, 0.1, 0, Math.PI * 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  uiCache.set(key, tex);
  return tex;
}
