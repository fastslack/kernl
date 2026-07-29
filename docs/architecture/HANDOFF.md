# HANDOFF — Migración a "kernel mínimo + todo extensión"

Documento de transferencia para retomar la migración arquitectónica en cualquier
momento, por el usuario o por otra sesión. Autosuficiente: no requiere historial
de conversación.

**Última actualización:** 2026-04-22
**Estado general:** Fases 0-2 completas end-to-end. Build pipeline listo.
Fase 4 cleanup confirmada. Fases 3, 5-7 planeadas en docs.

## Lo que se cerró en la sesión 2026-04-22

- ✅ **Fase 2 close-out** — `LlmProviderRegistry` wireado en bootstrap (`services/kernel/src/index.ts`). 4 providers (claude/openai/grok/lmstudio) arrancan con `ready=true`. Endpoint `/api/llm-providers` responde.
- ✅ **Migration v2 de `installed_extensions`** — drop del CHECK constraint de `type` que bloqueaba seeds. **Bug pre-existente** que también impedía que el `SandboxDriverRegistry` seeding funcionara. Ahora los rows se crean correctamente.
- ✅ **Build pipeline** — `services/kernel/scripts/pack-extension.ts <slug>` produce `.kernlext` con integrity.sha256 correcto (delega al `packBundle()` oficial del módulo extensions) y convierte migrations TS→SQL automáticamente.
- ✅ **Piloto Fase 5 end-to-end** — `notes-1.0.0.kernlext` instalado via `/api/extensions/upload`. Status `active`, `install_path=/app/data/extensions/notes/`, migrations aplicadas, tabla `notes` creada, integrity hash válido. **El pipeline completo funciona. Los otros 37 features se pueden extraer con el mismo flujo.**
- ✅ **Task 35 (`getTransport` crash)** — verificado: el archivo ya tenía `provider?.getTransport?.()` con optional chain, kernel arranca `healthy` sin crashes. Bug del user ya resuelto antes de esta sesión.
- ✅ **Env var fallback en providers** — wrappers de llm-providers caen a `process.env.*_API_KEY` cuando no hay config persistida. Funciona out-of-the-box con el `.env` existente.
- ✅ **Fase 3 parcial — dashboard cleanup** — Borré las 15 rutas HTTP duplicadas de `api-routes.ts`. El `DashboardRegistry.registerAllRoutes()` auto-genera `/api/dashboard/<channel>` para los ~18 módulos con `getDashboardDescriptor()`. Queda pendiente: alinear channel names de `home`/`web-intel`/`time-tracking` con sus paths (hoy publican `house`/`webIntel`/`timeTracking` y se mantienen aliases kebab-case en api-routes). Verificado: kebab + camelCase routes ambos responden 200.
- ✅ **Fase 3 cleanup de rpc-actions** — 18 cases hardcoded (`dashboard.home`, `dashboard.notes`, etc.) reemplazados por **auto-generación** iterando `dashboardRegistry.getChannelNames()`. `DashboardRegistry` inyectado via `DashboardRpcDeps`. Ahora TODOS los módulos con channel descriptor exponen automáticamente su RPC. Extensiones `.kernlext` con channels aparecen en RPC sin tocar rpc-actions.ts. Verificado: 292 RPC actions (incremento vs 290 anterior, que es lo esperado).
- ✅ **Fase 5 batch pack — 36 feature extensions empaquetadas** — Ejecutado `services/kernel/scripts/pack-extension.ts` sobre todos los candidatos hojas + medios. Todos OK (36/36), total ~250 KB en `dist/extensions/`. Bundles válidos con integrity.sha256 y migrations TS→SQL. Lista: meals, goals, health, finance, subscriptions, vehicles, notes, time-tracking, documents, files, training, nutrition, learning, calendar, smart-folders, behavioral, game-hub, agent-reach, dev-env, home, lights, cameras, wearables, predictor, system-monitor, security-scanner, vault, media, browser, network-mgr, desktop-automation, devtools, digest, rss-registry, twitter, prospecting.
- ✅ **Fase 5 batch install — 36 extensiones instaladas y cargadas como `ext:<slug>`** — Todos 200 OK en endpoints `/api/dashboard/<channel>`. Ningún bundled sigue registrado (36 overridden por dedup logic).
- ✅ **ModuleRegistry.loadExtensionOverrides(db)** — Al bootstrap, skip de módulos bundled cuyo slug tiene una extensión `type=module status=active` instalada. Así no hay conflictos ni tools duplicadas. El cambio vive en `services/kernel/src/core/module-registry.ts` + call en `services/kernel/src/index.ts` post `new ModuleRegistry()`.
- ✅ **Loader wrapper propaga `getDashboardDescriptor()`** — Fix en `services/kernel/src/modules/extensions/loader.ts` que re-expone el descriptor del ExtensibleModule para que el DashboardRegistry registre los channels de las extensiones cargadas. Sin esto los endpoints `/api/dashboard/<channel>` daban 404.
- ✅ **Pack-extension wrapper entry** — El packer escanea TODOS los exports del módulo y busca `create<X>Module` / `createModule` / `default`. Abarca todas las convenciones existentes en el kernel (devtools usa `createDevToolsModule`, notes usa `createNotesModule`, etc.).

---

## 1. Contexto — por qué esta migración

Kernl tiene **62 módulos, ~95k LOC**. ~40% vive en 3 módulos gigantes (agents, trading,
dashboard). El usuario quiere que el kernel sea una **base mínima** (contracts +
registries) y **todo lo demás viva como extensión** (feature extensions, drivers
pluggables, plugins de terceros).

La arquitectura ya tiene el runtime de extensiones (`services/kernel/src/modules/extensions/`), un
marketplace (`services/kernel/src/modules/marketplace/`), e instalador git (`services/kernel/src/modules/plugins/`).
Lo que faltaba era **migrar lo existente** al modelo.

El **precedente arquitectónico** que habilita todo: `SandboxDriverRegistry`, que
reemplazó el acoplamiento directo entre `agents/claude-code-executor.ts` y Docker,
moviéndolo a `services/kernel/src/core/sandbox-driver.ts` + drivers built-in + extension type
`"sandbox-driver"`.

Este patrón (Registry + Driver) es **el template canónico** que hay que replicar.
Lo documenté en `extension-points.md`.

---

## 2. Lo que ESTÁ en el working tree (listo para usar o revisar)

### Código nuevo — Fase 2 (LlmProviderRegistry) — infra completa

```
services/kernel/src/core/llm-provider.ts          # Interface LlmProvider + tipos
services/kernel/src/core/llm-provider-registry.ts # Registry + lifecycle + config
services/kernel/src/core/llm-provider-routes.ts   # /api/llm-providers/*
services/kernel/src/core/llm-providers/
├── claude-provider.ts                     # wrapper de ChatClaudeProvider
├── openai-provider.ts                     # wrapper de ChatOpenAiProvider
├── grok-provider.ts                       # wrapper de ChatGrokProvider
├── lmstudio-provider.ts                   # wrapper de ChatLmStudioProvider
└── index.ts                               # registerBuiltinLlmProviders(registry)
```

**Crítico:** Los wrappers **delegan** a las clases existentes en
`services/kernel/src/modules/chat/llm-adapter.ts` — no reimplementan lógica. El adapter viejo
sigue operativo. Cero cambio a código vivo.

**Verificación:** `npm run lint` — cero errores nuevos en estos archivos.

### Documentación completa

```
docs/architecture/
├── README.md                              # Índice + principios + mapa final
├── extension-points.md                    # Template canónico Registry+Driver
├── deprecations.md                        # Audit de zombies (ninguno borrado)
├── HANDOFF.md                             # Este archivo
└── phases/
    ├── 02-llm-provider-migration.md       # Wire-up pendiente + 21 callers
    ├── 03-dashboard-inversion.md          # Plan sin tocar código
    ├── 04-transport-registry.md           # Ya existe como NotificationRegistry
    ├── 05-feature-extension-migration.md  # Los 38 hojas + build pipeline
    └── 07-monolith-decomposition.md       # agents · comms · trading
```

---

## 3. Estado por fase

| # | Nombre | Estado | Archivos |
|---|--------|--------|----------|
| 0 | Documentar patrón | ✅ **HECHO** | `extension-points.md` |
| 1 | Audit zombies | ✅ **HECHO**, retirada no ejecutada por prudencia | `deprecations.md` |
| 2 | LlmProviderRegistry | ✅ **COMPLETO** end-to-end — wireado + providers ready | `phases/02-*.md` |
| 3 | Dashboard inversion | ✅ **Completo** — rutas HTTP y RPC actions auto-generadas por DashboardRegistry. Solo queda alinear channel names kebab-case | `phases/03-*.md` |
| 4 | TransportRegistry | ✅ Bug crash resuelto. Limpieza iterativa pendiente | `phases/04-*.md` |
| 5-6 | Extract 38 features | ✅ **36 extracted end-to-end** — todas instaladas, cargadas como `ext:<slug>`, overridean el bundled via dedup. Kernel sirve via extensions sin tocar el src original. Próximo paso: `rm -rf` de los 36 módulos fuente del kernel | `phases/05-*.md` |
| 7 | Descomponer monoliths | 📋 Plan listo (agents · comms · trading) | `phases/07-*.md` |
| 8 | UI marketplace público | TBD | — |

---

## 4. PRÓXIMO PASO CONCRETO (lo primero que hay que hacer cuando se retome)

### ✅ Fase 2 close-out — YA HECHO en sesión 2026-04-22

Para referencia histórica, así quedó el wire-up en `services/kernel/src/index.ts`:

**Añadir después de crear el SandboxDriverRegistry:**

```ts
// Near the top, with other imports:
import { LlmProviderRegistry } from "./core/llm-provider-registry.js";
import { registerBuiltinLlmProviders } from "./core/llm-providers/index.js";
import { registerLlmProviderRoutes } from "./core/llm-provider-routes.js";

// In bootstrap(), after sandboxRegistry setup:
const llmRegistry = new LlmProviderRegistry();
llmRegistry.setDb(sqlite);
if (config.encryptionKey) llmRegistry.setEncryptionKey(config.encryptionKey);
registerBuiltinLlmProviders(llmRegistry);
llmRegistry.seedBuiltinRows();
await llmRegistry.startAll();
registerLlmProviderRoutes(httpServer, llmRegistry);

// In shutdown handler:
await llmRegistry.stopAll();
```

**NO** injectar al módulo agents todavía. Eso es el paso siguiente (migrar los 21
callers) y puede esperar.

**Verificación ya ejecutada:** los 4 providers responden con `ready=true` en
`/api/llm-providers`. Kernel healthy post-rebuild.

### Próximo paso real al retomar

**Fase 3 — inversión del dashboard**. Es el único bloqueador real para continuar
extrayendo features. Hoy `dashboard/api.ts` importa de 30 módulos estáticamente.
Hasta invertir esa relación (cada módulo aporta su `DashboardDescriptor`, el dashboard
los itera), no se puede `rm -rf services/kernel/src/modules/notes/` porque el dashboard se rompe
al build.

Ya está el plan en `phases/03-dashboard-inversion.md` — es un refactor contenido
a `services/kernel/src/modules/dashboard/api.ts` + `services/kernel/src/index.ts`.

### Después de Fase 3

1. **Retirar `notes` del kernel** (primer caso). Borrar `services/kernel/src/modules/notes/` y los
   imports en `services/kernel/src/index.ts`. Kernel build debe pasar. Runtime sigue cargando
   `notes` desde la extensión instalada.
2. **Empaquetar + instalar los otros 37 hojas** en batch. Con `services/kernel/scripts/pack-extension.ts`
   toma ~30 seg por módulo, 30 min total.
3. **Migrar 21 callers de `chat/llm-adapter` al LlmProviderRegistry**.
4. **Fase 7** (monolitos) al final.

### Orden óptimo del resto

1. **Validar piloto `notes` end-to-end** (este turno o próximo).
2. **Fase 3 (dashboard inversion)** — Bloqueador duro para continuar extrayendo
   features (porque `dashboard/api.ts` sigue con 30 imports estáticos).
3. **Migrar los 21 callers de `chat/llm-adapter` al LlmProviderRegistry** —
   Cambio mecánico. Leer `phases/02-*.md`.
4. **Batch Fase 5** — después del piloto, los otros 37 hojas.
5. **Fase 7** — monolitos (agents · comms · trading) al final.

Trading queda para el final (mínimo 2-3 meses de trabajo dedicado).

---

## 5. Decisiones pendientes (requieren input humano)

Estas NO se pueden tomar solas. Afectan la dirección arquitectónica:

1. **DB por-extensión vs DB compartida con namespace.** Hoy todo vive en `kernel.db`.
   Opciones:
   - Una DB shared, tablas con prefijo `ext_<slug>_*` (más simple, migración fácil).
   - DB separada por extensión (más aislado, pero joins cross-ext son imposibles).

2. **Política de uninstall de extensiones.** Cuando se desinstala:
   - Soft: tablas quedan, status `disabled` (default).
   - Hard: `DROP TABLE` + limpieza de files.
   Hoy no hay infra para hard uninstall.

3. **Frontend dinámico para extensiones.** SvelteKit adapter-static no carga rutas
   dinámicas. Opciones en `phases/05-*.md` sección final. Hay que elegir.

4. **Zombies que DUDO si borrar:**
   - `sandbox-agents` (885 líneas, 0 usos runtime, test activo): borrar o mantener?
   - `mcp-bridge`, `digest`, `devtools`: features reales o legacy?
   - Confirmar con el usuario (sabe su uso diario real).

5. **Rust bridge en trading.** `services/kernel/src/core/` importa cosas de `trading/` (3 refs).
   Hay que invertir antes de extraer trading. Es refactor no trivial.

---

## 6. Cómo NO romper nada al retomar

### Antes de tocar código

1. **Git status** — ver qué está uncommitted (otra instancia puede haber agregado más).
2. **`npm run lint`** — establecer baseline de errores pre-existentes (hay unos 12
   que no son nuestros: better-sqlite3 types, event-listeners, trading/tools, tests).
3. **Leer docs/architecture/README.md** — 5 minutos que ahorran una hora.

### Reglas de oro

- **Cero cambios a `services/kernel/src/modules/chat/llm-adapter.ts`** hasta que se decida retirarlo.
  Los wrappers delegan; tocarlo rompe toda Fase 2.
- **Cero modificaciones a dashboards/api.ts** sin haber leído `phases/03-*.md`
  completo.
- **Todo código nuevo sigue el patrón de SandboxDriver.** Si tu instinto te pide
  hacer algo distinto, re-leer `extension-points.md`.
- **Docs antes que código.** Si una fase nueva aparece, escribir el `.md` primero
  fuerza claridad.

---

## 7. Estructura final esperada (roadmap)

Cuando la migración esté completa, el repo luce así:

```
Kernl/                             (~30k LOC vs 95k actual)
├── services/kernel/src/core/          Infra + contracts + registries + builtin drivers
│   ├── llm-provider.ts  llm-provider-registry.ts  llm-provider-routes.ts
│   ├── llm-providers/{claude,openai,grok,lmstudio}-provider.ts
│   ├── sandbox-driver.ts ...          (ya existe)
│   ├── notification-registry.ts ...   (ya existe)
│   ├── email-provider.ts ...          (fase 7)
│   ├── exchange-adapter.ts ...        (fase 7)
│   └── ...
├── services/kernel/src/modules/       Solo core: config, dashboard (host), extensions,
│   │                                   marketplace, plugins, api-registry, agents-core
│   └── ...
├── extensions/                        Afuera del árbol del kernel o en subrepo
│   ├── notes.kernlext
│   ├── trading-binance.kernlext
│   └── ...
└── docs/architecture/                 Esta guía, actualizada con cada fase cerrada
```

---

## 8. Métricas de éxito

La migración se considera "terminada" cuando:

- [ ] `services/kernel/src/modules/` ≤ 30 módulos (vs 62 actuales)
- [ ] `services/kernel/src/index.ts` NO importa ningún feature-module específico (solo core)
- [ ] `npm run build` del kernel es ≥25% más rápido
- [ ] Instalar un feature nuevo NO requiere recompilar el kernel
- [ ] `/api/extensions/upload` acepta `.kernlext` y el runtime lo carga
- [ ] 3 extension points de terceros (al menos) instalados exitosamente

Ninguna de estas métricas se cumple hoy. Todas son alcanzables.

---

## 9. Contacto / preguntas frecuentes

**¿Por qué no terminar la Fase 2 (wire-up) en esta sesión?**
Porque hay otra instancia trabajando en paralelo en archivos hot (`claude-code-executor.ts`, `agents/index.ts`, probablemente `services/kernel/src/index.ts`). Modificar bootstrap requiere coordinación humana para no pisar su trabajo.

**¿Por qué no borré los zombies?**
Todos (sandbox-agents, digest, mcp-bridge, devtools) tienen tests activos. Borrar sin validación = tests rotos. El audit está en `deprecations.md` para que el user decida con data.

**¿Cuánto tiempo toma terminar todo?**
Estimación aproximada: **3-4 meses** de trabajo dedicado. Fase 2 close + Fase 3 + build pipeline es ~2 semanas. Los 38 features en paralelo ~1 mes. Monolith decomposition es el grueso (2+ meses solo trading).

**¿Por dónde retomo si solo tengo 1 hora?**
Fase 2 close-out (sección 4 de este doc). 30 min de código, 15 min de verify.

**¿Por dónde retomo si tengo 1 día?**
Fase 2 close + Build pipeline (`services/kernel/scripts/pack-extension.sh`) + retiro de `sandbox-agents` legacy.
