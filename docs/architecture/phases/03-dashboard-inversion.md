# Fase 3 — Inversión del dashboard (static imports → runtime registration)

## Estado actual

`src/modules/dashboard/api.ts` tiene **~30 imports estáticos** desde otros módulos:

```ts
export { queryTasks } from "../tasks/dashboard-queries.js";
export { queryCrm } from "../crm/dashboard-queries.js";
// ... 28 más
```

Esto significa que:

- Agregar un módulo nuevo requiere editar dashboard/api.ts (violación DIP).
- Eliminar un módulo rompe el build del dashboard.
- Extensiones externas (`.kernlext`) no pueden aportar paneles al dashboard.

## Lo que ya existe (punto de palanca)

El tipo `DashboardDescriptor` ya está definido en `src/core/types.ts`:

```ts
export interface DashboardDescriptor {
  nav?: NavItem[];
  channels?: ChannelDescriptor[];        // name + query(db)
  channelMappings?: ChannelMapping[];
  stores?: string[];
  fetchEndpoints?: FetchEndpointDescriptor[];
}
```

Y `ExtensibleModule.getDashboardDescriptor()` es el hook.

Los módulos **ya implementan este interface** (confirmo con el caso de `agents/index.ts`
que devuelve nav + channels + stores + fetchEndpoints).

## Objetivo

Convertir `dashboard/api.ts` en un **collector dinámico**:

```ts
// Antes (hoy)
import { queryTasks } from "../tasks/dashboard-queries.js";
import { queryCrm } from "../crm/dashboard-queries.js";
// … 28 imports estáticos

export function queryFullDashboard(db, ...) {
  return {
    tasks: queryTasks(db),
    crm: queryCrm(db),
    // … 28 llamadas hardcodeadas
  };
}

// Después (objetivo)
// dashboard no importa ningún módulo. El registry de módulos le entrega los descriptors.
import { DashboardRegistry } from "../../core/dashboard-registry.js";

export function queryFullDashboard(db, registry) {
  const out: Record<string, unknown> = {};
  for (const ch of registry.getChannels()) {
    try { out[ch.name] = ch.query(db); }
    catch (err) { log.warn(`channel "${ch.name}" failed: ${err}`); }
  }
  return out;
}
```

## Lo que ya existe (`dashboard-registry.ts`)

Descubro que `src/core/dashboard-registry.ts` ya existe. Hay que:
1. Leer qué hace
2. Extender/usar lo que ya está
3. No duplicar

## Plan paso a paso

### Paso 1 — Inventariar descriptores actuales (1h)

Recorrer `src/modules/*/index.ts` y confirmar cuántos implementan
`getDashboardDescriptor()`. Los que no lo hacen pero SÍ aportan queries al dashboard
necesitan que se les agregue el descriptor.

Auditoría rápida:

```bash
grep -l "getDashboardDescriptor" src/modules/*/index.ts | wc -l
# vs
grep -rl "dashboard-queries.ts" src/modules/ | wc -l
```

El delta son módulos que hay que upgrade-ar.

### Paso 2 — Cablear el collector (0.5 día)

Modificar `dashboard/api.ts`:
- Quitar los 30 imports estáticos
- Recibir el `moduleRegistry` (que ya existe en `core/module-registry.ts`) como parámetro
- Iterar: `for (const mod of moduleRegistry.getAll()) { const desc = mod.getDashboardDescriptor?.(); if (desc) registerChannels(desc.channels); }`
- Callsite en `src/index.ts` pasa el registry

### Paso 3 — Tipos DashboardDescriptor para channels con shape

Hoy `DashboardChannel.query(db)` devuelve `unknown`. Hay que tipearlo para que el
consumer final (la UI) sepa qué shape recibir. Dos opciones:

1. **Generic por-channel** — `ChannelDescriptor<T>` con T como shape. Complicaos los
   collectors.
2. **Schema opcional** — cada channel incluye un JSON Schema de su shape. El dashboard
   lo usa sólo para documentación. La UI parsea a su criterio.

Recomendado: opción 2. Menos refactor.

### Paso 4 — Nav dinámico

Hoy el sidebar del dashboard está parcialmente hardcodeado y parcialmente por manifest.
Consolidar: **todos los nav items vienen de extensiones**.

El kernel aporta sólo el wireframe (header, grupos, áreas).

### Paso 5 — fetchEndpoints del manifest

Ya existe `DashboardDescriptor.fetchEndpoints`. El dashboard genera automáticamente
las rutas HTTP basándose en eso. Confirmar que está wireado — si no, cablearlo.

### Paso 6 — UI dinámica por extensión (Fase 6+, NO ahora)

Las extensiones traen sus propias Svelte pages. Hoy el dashboard monolítico las tiene
todas en `dashboard/src/routes/*/`. Plan tardío:
- Extensión declara `frontend.pages: [{ path, file }]`
- Al instalar, se copian/symlinkean los `.svelte` al build tree
- Rebuild del dashboard incluye las nuevas pages

Complejidad alta. Requiere build pipeline separado. Se difiere.

## Archivos tocados en Fase 3

**Modificar:**
- `src/modules/dashboard/api.ts` — quitar imports estáticos + usar registry
- `src/modules/dashboard/index.ts` — pasar registry al api
- `src/index.ts` — wire-up

**Leer (no modificar):**
- `src/core/dashboard-registry.ts` — ya existe, entender y extender
- `src/core/module-registry.ts` — listar módulos activos

**No crear archivos nuevos** salvo que el registry actual no alcance.

## Riesgos

1. **Compat runtime**: cualquier módulo que hoy no implementa `getDashboardDescriptor()`
   pero SÍ exporta `queryXxx` desde su `dashboard-queries.ts` quedará fuera hasta que lo
   upgraden. Lista pre-migración necesaria.
2. **`queryFullDashboard` en el bootstrap** — varios lugares del código lo llaman.
   Todos reciben el registry inyectado. Cambio invasivo.
3. **Tests**: probablemente hay tests que importan queryXxx del dashboard. Van a romper.
   Actualizar para construir un registry fake con el channel necesario.

## No hacer todavía (bloqueado por trabajo paralelo)

Esta fase toca `dashboard/api.ts`, `dashboard/index.ts`, `src/index.ts` — archivos
calientes. Si hay otra instancia modificando dashboard, espera. Coordinación humana
necesaria antes de ejecutar.
