# Fase 7 — Descomposición de los 3 monstruos: agents · comms · trading

40% del LOC del kernel vive en 3 módulos. No son candidatos a "extraer como está" —
hay que partirlos. Este doc es el plan de ataque.

## 1. `agents/` — 21,298 líneas

### Situación actual

Todo en un módulo: service, executor nativo, executor claude_code, scheduler,
reactive engine, meeting executor, debate orchestrator, eval service, reflection
optimizer, workspace service, dashboard endpoints, 3D office UI (parcialmente).

Core del AI-layer. 5 módulos del kernel lo usan (`chat`, `dashboard`, algunos otros).

### Target: partir en agents-core + 5 extensiones

```
src/core/agents-api.ts             ← contrato público: AgentService + AgentExecutor + types
src/modules/agents-core/           ← service + executor nativo + scheduler + workspace-service
extensions/
├── agents-claude-sdk/             ← ClaudeCodeExecutor + sandbox adapter
├── agents-autoeval/               ← AgentEvalService + feedback-loop
├── agents-reflection/             ← ReflectionOptimizer + autogenesis
├── agents-debates/                ← DebateOrchestrator + MeetingExecutor
└── agents-office3d/               ← UI 3D del dashboard
```

### Orden de split (incremental)

1. **Extraer `agents-office3d` primero**. Es el más grande y el más UI-puro. Sale
   limpio porque el 3D consume eventos (`agent:flow:*`), no importa nada del
   backend de agents.
2. **Extraer `agents-claude-sdk`**. Ya depende del SandboxDriverRegistry (core). El
   ClaudeCodeExecutor se puede empaquetar como extension que extiende
   AgentExecutor via un hook.
3. **Extraer `agents-debates`** (DebateOrchestrator + MeetingExecutor). Son
   agregados sobre el service, no parte del hot path.
4. **Extraer `agents-autoeval` + `agents-reflection`**. Side features.
5. **Lo que queda** es `agents-core`: service + executor nativo + scheduler +
   workspace. Este queda como core.

### Contrato público `src/core/agents-api.ts`

Para que las extensiones puedan extender AgentExecutor sin depender del paquete
completo, definimos:

```ts
export interface AgentExecutorHook {
  /** Llamado antes de cada run. Devolver false cancela. */
  preRun?(ctx: RunContext): Promise<boolean | void>;
  /** Llamado después de cada run. */
  postRun?(ctx: RunContext, result: ExecutionResult): Promise<void>;
  /** Si el agent.executor_type coincide, este hook toma el run entero. */
  altExecutor?: {
    matches(agent: Agent): boolean;
    execute(params: ExecuteParams): Promise<ExecutionResult>;
  };
}

export interface AgentsApi {
  getService(): AgentService;
  registerHook(hook: AgentExecutorHook): void;
}
```

La extensión `agents-claude-sdk` se instala, en su entry hace:

```ts
export function createModule(ctx: ModuleContext): KernelModule {
  const agentsApi = ctx.get("agents");  // resolved via DI
  agentsApi.registerHook({
    altExecutor: {
      matches: a => a.executor_type === "claude_code",
      execute: params => new ClaudeCodeExecutor(...).execute(params),
    },
  });
  // ...
}
```

### Bloqueadores

- El 3D import chain (`dashboard/src/routes/agents-flow/*`) carga muchos módulos.
  Separar el código del UI del dashboard antes es prerequisito.
- Event types (`agent:flow:*`) deben estar en core para que extensiones puedan
  consumirlos sin depender de `agents/`.

---

## 2. `comms/` — 6,273 líneas

### Situación actual

Email triage + IMAP + SMTP + Gmail + Resend + mime building + conversation
routing. 5 reverse deps (tasks, reminders, crm, shopping, google-sync).

### Target: core-contract + drivers + feature

```
src/core/email-provider.ts          ← interface EmailProvider + EmailMessage types
src/core/email-provider-registry.ts ← registry (mismo patrón que sandbox-driver)
src/core/email-providers/           ← builtin drivers: gmail, imap-smtp, resend
extensions/
└── comms-triage/                   ← feature: LLM-based classification, rules engine
```

`chat/llm-adapter` se convierte en LlmProviderRegistry (Fase 2). comms-triage usa
el LlmProviderRegistry para llamar al LLM, en vez de tener acoplamiento directo.

### Orden

1. Crear el registry de email providers (siguiendo el patrón sandbox).
2. Migrar los 3 backends (gmail, imap-smtp, resend) a drivers.
3. Triage service queda como extensión porque es opinionado + usa LLM.

---

## 3. `trading/` — 26,442 líneas

### Situación actual

Es literalmente un producto completo: exchange adapters, strategies, formulas
(Rust-delegated), order management, portfolio tracking, charting, auto-trader,
paper trading, IBKR gateway.

3 imports desde `src/core/` (formula-rust-adapter, rust-delegates). Eso significa
que core DEPENDE de trading (invertido) — hay que romper eso primero.

### Target

```
src/core/exchange-adapter.ts         ← interface ExchangeAdapter
src/core/exchange-adapter-registry.ts
src/core/exchange-adapters/          ← builtin: binance (si se empaqueta), paper
extensions/
├── trading-core/                    ← order book, portfolio, positions, risk
├── trading-strategies/              ← strategy engine (llama formulas via Rust)
├── trading-ibkr/                    ← adapter IBKR
├── trading-binance/                 ← adapter Binance
├── trading-ccxt/                    ← adapter multi-exchange via ccxt
└── trading-ui/                      ← dashboard pages
```

### Bloqueadores inevitables

- **Rust bridge dependencies** — formulas y stop-loss cálculo viven en Rust
  (performance). Core importa esos helpers. Hay que invertir: el Rust bridge
  queda genérico (`callRustFormula(name, args)`), y cada adapter/strategy lo usa.
- **Paper trading vs live** — hay lógica doble que conviene refactorizar antes
  de extraer.
- **Tests** — probablemente muchos y frágiles. Auditar antes.

### Orden

Trading es el último. No atacar hasta que todo lo demás esté estable. El paso 1
es invertir los 3 imports desde core, el resto son proyectos en sí mismos.

---

## Complejidad total

| Monstruo | LOC | Estimación | Pre-req |
|----------|-----|-----------|---------|
| agents   | 21k | 3-4 semanas | Fase 3 (dashboard), event types en core, API pública |
| comms    | 6k  | 1-2 semanas | Fase 2 (LLM registry) |
| trading  | 26k | 2-3 meses   | Invertir rust imports, refactor paper/live, luego extract |

## Principio guía

**No partir un monstruo hasta que los huecos que deja estén llenos.** Extraer
`agents-office3d` antes de cablear event types en core genera un momento de
trabajo duplicado.

Hay un orden físico real: **hubs-primero (tasks/reminders/crm) → comms → agents
→ trading**. Saltar ese orden causa regresiones.

## No ejecutar sin coordinación

Estas extracciones tocan archivos muy usados. Si hay otra instancia trabajando
en cualquiera de los 3, coordinación humana previa es obligatoria. Este doc es
el plan, no la ejecución.
