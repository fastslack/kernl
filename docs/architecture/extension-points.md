# Extension Points — El patrón Registry + Driver

Este documento describe **el template canónico** para convertir un área del kernel en un
*extension point* pluggable, inaugurado por `SandboxDriverRegistry`. Toda nueva
abstracción debería seguir exactamente este molde.

## Definición

Un **extension point** es un contract (interface) que el kernel expone, con:

- **0..N implementaciones built-in** que vienen con el kernel
- **0..N implementaciones custom** que se instalan como extensión
- **1 registry** que gestiona el ciclo de vida (start / stop / reload)
- **1 API HTTP** para que el dashboard configure drivers en runtime

El caso de referencia es `SandboxDriver`, que reemplazó el acoplamiento directo entre
`agents/claude-code-executor.ts` y la lógica Docker-in-Docker.

## Anatomía obligatoria

Para cada extension point nuevo, hay que crear exactamente esta estructura:

```
services/kernel/src/core/
├── <abstraction>.ts                    # Interface + tipos compartidos
├── <abstraction>-registry.ts           # Registry: factory map, lifecycle,
│                                         # config persistence, start/stop
├── <abstraction>-routes.ts             # HTTP: /api/<abstractions>
└── <abstraction>-drivers/
    ├── <name>-driver.ts                # Built-in: DockerSandboxDriver, etc.
    ├── <name>-driver.ts
    └── index.ts                        # Barrel export
```

Y dos cambios orbitales:

```
services/kernel/src/modules/extensions/
├── types.ts                            # Agrega "<abstraction>-driver" a ExtensionType
├── schema.ts                           # Valida backend.entry para custom drivers
└── installer.ts                        # Case dispatch: importa createDriver() del bundle

services/kernel/src/index.ts            # Bootstrap:
                                         #   1) new <Abstraction>Registry(sqlite)
                                         #   2) register factories built-in
                                         #   3) registry.seedBuiltinRows()
                                         #   4) registry.startAll()
                                         #   5) inject into consumers
                                         #   6) registerRoutes(server, registry)
                                         #   7) registry.stopAll() on shutdown
```

## Interfaces core obligatorias

Toda abstracción debe exponer estas interfaces. Los nombres pueden adaptarse, el shape no.

### 1. Driver base

```ts
export interface <Abstraction>Driver {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: <Abstraction>Capabilities;

  /** Llamado una vez al boot o al reload de config. */
  start(config: Record<string, unknown>): Promise<void>;

  /** Llamado al shutdown o al reload. Idempotente. */
  stop(): Promise<void>;

  /** JSON Schema del formulario que verá el admin en /api/<abstractions>/<slug>/schema. */
  getConfigSchema(): Record<string, unknown>;

  /** Healthcheck opcional que el registry expone via /status. */
  getStatus(): <Abstraction>DriverStatus;

  /** Operaciones específicas del dominio. */
  // ej. SandboxDriver: prepareRun(opts), cleanupRun(handle)
  // ej. LlmProvider: complete(prompt, opts), stream(prompt, opts)
  // ej. Transport: send(msg), onMessage(cb)
}
```

### 2. Registry

```ts
export class <Abstraction>Registry {
  constructor(private db: SqliteDb) {}

  registerFactory(slug: string, factory: () => Driver, source: "builtin" | "extension"): void;
  registerDriverFromExtension(slug: string, factory: () => Driver): void;
  getDriver(slug: string): Driver | undefined;
  listDrivers(): DriverStatus[];

  loadConfig(slug: string): Record<string, unknown>;
  saveConfig(slug: string, config: Record<string, unknown>): Promise<void>;

  async start(slug: string): Promise<void>;
  async stop(slug: string): Promise<void>;
  async startAll(): Promise<void>;
  async stopAll(): Promise<void>;

  /** Idempotente: crea row en installed_extensions por cada factory registrada. */
  async seedBuiltinRows(): Promise<void>;
}
```

### 3. HTTP routes

```
GET    /api/<abstractions>              → list con status de cada driver
GET    /api/<abstractions>/:slug        → detalle
GET    /api/<abstractions>/:slug/schema → JSON schema del form de config
PUT    /api/<abstractions>/:slug/config → guarda config y hot-reloads
POST   /api/<abstractions>/:slug/start  → start manual
POST   /api/<abstractions>/:slug/stop   → stop manual
```

### 4. ExtensionType

En `services/kernel/src/modules/extensions/types.ts`, agregar el slug al union:

```ts
export type ExtensionType =
  | "module"
  | "skill"
  | "agent-bundle"
  | "flow"
  | "theme"
  | "template"
  | "channel"
  | "sandbox-driver"
  | "<abstraction>-driver"   // ← nuevo
  ;
```

El manifest de la extensión debe exportar `createDriver(): <Abstraction>Driver` desde
`backend.entry`. El installer lo detecta via case-dispatch.

## Persistencia de config

Los drivers built-in tienen una row en `installed_extensions` con
`type = '<abstraction>-driver'`, `status = 'active'`, y `settings_json` contiene la
config del driver (editable desde el dashboard).

El registry usa esa tabla como fuente de verdad — no inventa storage nuevo.

## Lifecycle

```
bootstrap
  ├── new SandboxDriverRegistry(db)
  ├── registry.registerFactory("docker", createDockerDriver, "builtin")
  ├── registry.registerFactory("cubesandbox", createCubeDriver, "builtin")
  ├── await installerLoop() ──► detects custom drivers, calls registerDriverFromExtension()
  ├── await registry.seedBuiltinRows()
  ├── await registry.startAll()
  ├── inject registry into consumers (agents, etc.)
  └── registerSandboxDriverRoutes(server, registry)

shutdown
  └── await registry.stopAll()
```

## Cómo los consumidores lo usan

El código que USA drivers **nunca importa** un driver específico. Pide al registry:

```ts
const handle = await sandboxRegistry.prepareRun(agent.driver_slug, opts);
// ...
await sandboxRegistry.cleanup(handle);
```

Si `agent.driver_slug` refiere a un built-in, un custom instalado, o uno que todavía no
existe, el registry resuelve o devuelve undefined. El consumidor no cambia su código
cuando llega un nuevo driver.

## Tests obligatorios por extension point

Mínimo:

- `registry.test.ts` — registerFactory + loadConfig + start + stop + seedBuiltinRows
- `<builtin-driver>.test.ts` por cada built-in — unit tests del driver
- `integration.test.ts` — instalar una fake extensión via installer, verificar que aparece
  en `listDrivers()` con source `"extension"`, y que el consumer la puede invocar

## Cuándo NO hacer un extension point

Crear un registry es caro arquitectónicamente. Hacelo sólo si:

1. Hay **≥2 implementaciones reales** que necesitás soportar (ej. Docker + CubeSandbox)
2. El cliente code **hoy se ramifica con if/else** en base al provider
3. Esperás que **terceros agreguen impls** sin hacer fork del kernel

Si sólo vas a tener una implementación por años, un módulo normal alcanza.

## Extension points actuales y futuros

Inauguradores del patrón:

- ✅ `NotificationProviderRegistry` — ya existente (precede SandboxDriver)
- ✅ `SandboxDriverRegistry` — canónico (docker + cubesandbox)

Candidatos prioritarios (ver `docs/architecture/phases/`):

- ⏭️ `LlmProviderRegistry` — 4 impls (claude/openai/grok/lmstudio) + 21 reverse deps
- ⏭️ `TransportRegistry` — 5 impls (telegram/whatsapp/slack/discord/webchat)
- ⏭️ `EmailProviderRegistry` — 3 impls (gmail/imap-smtp/resend)
- ⏭️ `ExchangeAdapterRegistry` — para trading (binance/ibkr/ccxt)
- ⏭️ `CalendarProviderRegistry`, `StorageDriverRegistry`, `AuthProviderRegistry`

## Checklist para abrir un nuevo extension point

- [ ] Verificar criterios del "cuándo NO hacer"
- [ ] Crear 4-5 archivos en `services/kernel/src/core/<abstraction>*`
- [ ] Crear built-in drivers en `services/kernel/src/core/<abstraction>-drivers/`
- [ ] Agregar ExtensionType y case en installer
- [ ] Wire bootstrap en `services/kernel/src/index.ts`
- [ ] Registrar HTTP routes
- [ ] Refactorizar consumidores para usar `registry.getDriver(slug)` en vez de importar directo
- [ ] Tests (registry, driver, integration)
- [ ] Documentar en `docs/architecture/phases/<name>.md` si es parte de migración
