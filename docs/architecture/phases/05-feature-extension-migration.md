# Fases 5 y 6 — Extracción de feature extensions (38 módulos hoja)

## Alcance

Los 38 módulos con 0-1 consumers detectados en el inventario. Son features verticales
con DB propia, UI propia (en algunos casos), tools, schedulers. Zero-risk de colisión
con otros módulos.

Target: cada uno sale del kernel como `.kernlext`, se instala via el runtime de
`extensions`, y el kernel deja de referenciarlo.

## Lista (reclasificada por complejidad de extracción)

### Trivial (0 incoming, 0 UI dinámica) — 18 módulos

Estos salen copy-paste del patrón. LOC promedio ~700.

| Módulo | LOC | Nota |
|--------|-----|------|
| `notes` | 633 | Ya tiene `getDashboardDescriptor` |
| `meals` | 575 | Ya tiene dashboard |
| `game-hub` | 533 | Standalone |
| `agent-reach` | 514 | Standalone |
| `dev-env` | 442 | Dev util |
| `documents` | 374 | Ya tiene dashboard |
| `finance` | 932 | Ya tiene dashboard |
| `health` | 680 | Ya tiene dashboard |
| `goals` | 645 | Ya tiene dashboard |
| `time-tracking` | 566 | Ya tiene dashboard |
| `subscriptions` | 824 | Ya tiene dashboard |
| `vehicles` | 829 | Ya tiene dashboard |
| `training` | 1292 | Ya tiene dashboard |
| `nutrition` | 1237 | Ya tiene dashboard |
| `behavioral` | 584 | Standalone |
| `learning` | 910 | Standalone |
| `calendar` | 845 | Standalone |
| `smart-folders` | 694 | Standalone |

### Medio (alguna integración externa) — 14 módulos

Requieren bind a un driver/registry o tienen side-effects cross-module:

| Módulo | LOC | Complicación |
|--------|-----|--------------|
| `predictor` | 789 | Usa Neo4j, valida dependencia |
| `system-monitor` | 717 | Lee métricas del host |
| `security-scanner` | 623 | Ejecuta binarios del host |
| `vault` | 584 | Secret storage — decide si es feature o core |
| `media` | 601 | Expone archivos, necesita transport |
| `home` | 2024 | Hub para otros life-modules |
| `lights` | 1957 | Bind a transport IoT |
| `cameras` | 2112 | Stream + storage |
| `wearables` | 1514 | Device ingestion |
| `browser` | 741 | Ejecuta chromium |
| `network-mgr` | 529 | Host-level |
| `desktop-automation` | 530 | Host-level |
| `devtools` | 1792 | Drift detection + scaffolding |
| `digest` | 192 | Consume tasks + reminders |

### Alto (cross-module) — 6 módulos

Requieren contratos intermedios antes de extraer:

| Módulo | LOC | Requiere |
|--------|-----|----------|
| `web-intel` | 3757 | LLM registry (Fase 2) + storage |
| `rss-registry` | 1039 | Transport registry + scheduler |
| `twitter` | 2133 | Transport registry |
| `prospecting` | 1178 | CRM + LLM |
| `graph-intel` | 1278 | Neo4j shared |
| `issues` | 2229 | GitLab/GitHub auth — externos |

## Template de extracción

Para cada módulo, el proceso es:

### Paso 1 — Preparación (sin cambiar código)

1. Confirmar `getDashboardDescriptor()` existe en `index.ts`. Si no, agregarlo
   basándose en lo que exponen sus `dashboard-queries.ts`.
2. Confirmar migrations tienen prefix consistente (`ext_<slug>_*` o al menos
   namespace claro) para que al desinstalar las tablas se puedan borrar sin
   pisar otras.
3. Verificar que NO usa `../../core/` imports que no estén en el SDK públicado
   (próxima sección).

### Paso 2 — Crear bundle

Estructura del `.kernlext`:

```
mi-extension.kernlext (tar.gz)
├── manifest.json                    # ExtensionManifest: type: "module"
├── backend/
│   └── entry.js                     # createModule() → KernelModule (bundled)
├── frontend/                        # opcional — páginas Svelte precompiladas
│   ├── pages/
│   │   └── <slug>.html
│   └── assets/
├── migrations/
│   └── 001.sql
└── README.md
```

El `manifest.json`:

```json
{
  "$schema": "kernl://extension/v1",
  "id": "io.kernl.notes",
  "slug": "notes",
  "name": "Notes",
  "version": "1.0.0",
  "type": "module",
  "description": "Quick notes with tags and search",
  "author": "Kernl",
  "license": "MIT",
  "backend": {
    "entry": "backend/entry.js",
    "migrations": "migrations"
  },
  "frontend": {
    "nav": { "group": "personal", "label": "Notes", "icon": "📝", "order": 10 },
    "pages": [{ "path": "/notes", "file": "frontend/pages/notes.html" }]
  },
  "permissions": ["module:notes"]
}
```

### Paso 3 — Build tooling

Un script `scripts/pack-extension.sh <slug>`:
1. Lee manifest
2. `bun build src/modules/<slug>/index.ts --outdir <out>/backend --target bun`
3. Copia migrations
4. Si tiene UI: build de las Svelte pages a HTML estático
5. Empaqueta en `.kernlext`

Este script NO existe todavía — hay que escribirlo. Es el **primer bloqueador real**
de la migración.

### Paso 4 — Instalar via runtime

Con el `.kernlext` listo:

```bash
curl -X POST http://localhost:3086/api/extensions/upload \
  -F "file=@notes.kernlext"
```

El runtime (que YA existe en `src/modules/extensions/`) lo valida, corre migrations,
y registra el módulo.

### Paso 5 — Remover del kernel

Cuando el runtime lo carga OK:
1. Borrar `src/modules/notes/`
2. Borrar `import { createNotesModule } from "./modules/notes/..."` en `src/index.ts`
3. Borrar referencias en `dashboard/api.ts` (bloqueado por Fase 3)
4. Borrar tests específicos

### Paso 6 — Verificar

- Arrancar kernel sin el módulo en source
- Confirmar que al arrancar, runtime carga la extensión
- Smoke test de `/api/notes/*` endpoints
- Verificar UI en dashboard

## Bloqueadores previos

Antes de empezar a migrar features, necesitás:

1. **✅ Fase 0** — docs del patrón (listo)
2. **⏳ Fase 3** — inversión del dashboard. Sin esto, el kernel SIGUE importando
   `queryNotes` de `notes/dashboard-queries.ts` y no podés borrar el módulo.
3. **⏳ Build pipeline** — script que empaqueta un módulo en `.kernlext`. No existe.
4. **⏳ Frontend dynamic loading** — hoy el dashboard es un bundle único en
   `dashboard/build/`. Las pages de una extensión no se cargan sin rebuild. Opciones:
   - Rebuild del dashboard cada instalación (lento pero simple)
   - Pages servidas como iframes desde `/ext/<slug>/pages/...` (más complejo)

## Plan de batch

Asumiendo que Fase 3 + build pipeline están listos:

**Semana 1** — Primer piloto: `notes` (más simple y ya tiene dashboard). Todo el
pipeline end-to-end. Ida y vuelta de bugs.

**Semana 2** — 5 más: `meals`, `goals`, `health`, `finance`, `documents`. Copy-paste.

**Semana 3** — 10 más de los triviales.

**Semana 4+** — los medios. Los altos esperan Fase 7 (contracts intermedios).

## Riesgo de datos

Cuando se desinstala una extension, las tablas quedan. La política debe ser explícita:

- **Soft uninstall** (default): tablas quedan, extensión marcada `disabled`. Data intact.
- **Hard uninstall**: `DROP TABLE` + limpieza de files. Requiere confirmación doble.

Esto requiere que las migrations DECLAREN qué tablas son suyas, lo cual no está hoy.
Decisión arquitectónica antes de la primera extracción.

## Frontend Svelte con SvelteKit — limitación

El dashboard usa SvelteKit adapter-static. No carga rutas dinámicas en runtime. Para
que una extensión traiga sus Svelte pages, hay que elegir uno de:

1. **Rebuild on install** — el kernel triggera un `bun run build` del dashboard cuando
   una extensión nueva aporta pages. Latencia de 20-30s post-install.
2. **Pages pre-compiladas a HTML+JS** — la extensión trae `.html` ya buildeados que el
   dashboard sirve en iframes o routes dinámicas. Los Svelte components de la extensión
   no hablan con los stores del dashboard.
3. **Extension pages en otro subdominio/puerto** — cada extensión sirve su propia UI.
   Simple pero feo UX.

Recomendación: arrancar con opción 2 (iframes + pre-compiled) para MVP, migrar a 1
cuando el pipeline de rebuild esté automatizado.

## Métricas de éxito

- Kernel `src/modules/` baja de 62 módulos a ≤30 (core + hubs + drivers-host + registries).
- `src/index.ts` no importa ningún feature module específico (solo el extensions runtime).
- `npm run build` del kernel es ~30% más rápido.
- Instalar una nueva feature no requiere compilar el kernel.
