# office3d assets

All files are CC0 (public domain). Used by `src/routes/agents-flow/office3d/realism.ts`.

| File | Source |
|---|---|
| `tex/marble_*` | Poly Haven — marble_01 — https://polyhaven.com/a/marble_01 |
| `tex/wood_*` | Poly Haven — dark_wood — https://polyhaven.com/a/dark_wood |
| `tex/wall_*` | Poly Haven — plastered_wall_04 — https://polyhaven.com/a/plastered_wall_04 |
| `tex/concrete_*` | Poly Haven — concrete_floor_02 — https://polyhaven.com/a/concrete_floor_02 |
| `tex/asphalt_*` | Poly Haven — asphalt_02 — https://polyhaven.com/a/asphalt_02 |
| `tex/carpet_*` | ambientCG — Carpet012 — https://ambientcg.com/view?id=Carpet012 |
| `tex/grass_*` | ambientCG — Grass001 — https://ambientcg.com/view?id=Grass001 |
| `hdri/studio_small_08_1k.hdr` | Poly Haven — studio_small_08 — https://polyhaven.com/a/studio_small_08 |
| `tex/window_city.jpg` | Poly Haven — shanghai_bund (tonemapped JPG, cropped to the skyline) — https://polyhaven.com/a/shanghai_bund |

Textures are the 1k JPG variants, re-encoded (albedo/roughness q80, normal q88; roughness as grayscale).

## Models

| File | Source |
|---|---|
| `models/potted_plant_02.glb` | Poly Haven — potted_plant_02 — https://polyhaven.com/a/potted_plant_02 |
| `models/marble_bust_01.glb` | Poly Haven — marble_bust_01 — https://polyhaven.com/a/marble_bust_01 |

Models are the 1k glTF variants, run through `gltf-transform optimize --compress meshopt --texture-compress webp --texture-size 512` (the plant also with `--simplify-ratio 0.2 --simplify-error 0.01`).
