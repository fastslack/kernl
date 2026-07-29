# Deprecations y candidatos a reemplazo

Módulos del kernel marcados como deprecated o legacy. **No se borran activamente** — tests los referencian y el user puede tener integraciones custom. El camino es: migrar al reemplazo, luego remover en un commit dedicado cuando el uso caiga a 0.

## `services/kernel/src/modules/sandbox-agents/` — deprecated

- **Estado:** Legacy. Todos los consumidores migraron a `SandboxDriverRegistry`.
- **Reemplazo:** `services/kernel/src/core/sandbox-driver-registry.ts` + drivers en `services/kernel/src/core/sandbox-drivers/`.
- **Uso vivo:**
  - `services/kernel/tests/sandbox-agents.test.ts` — test histórico de `AgentLoader`, `AgentSandbox`, `SandboxAgentService`. No aporta cobertura sobre código que hoy se use en runtime.
  - `services/kernel/src/index.ts:72` — se sigue registrando como `KernelModule` por back-compat (no causa daño).
- **Dependencias inversas:** `modules→0`, `core→0`. Huérfano excepto por el bootstrap register.
- **Plan de retirada:**
  1. Confirmar con user que ninguna extensión externa depende de este módulo
  2. Remover import de `services/kernel/src/index.ts`
  3. Borrar `services/kernel/src/modules/sandbox-agents/` y `services/kernel/tests/sandbox-agents.test.ts` en un commit único con mensaje `chore: remove legacy sandbox-agents (superseded by SandboxDriverRegistry)`

## `services/kernel/src/modules/agents/claude-sandbox.ts` — ya eliminado ✅

- **Estado:** eliminado en el cambio que introdujo `SandboxDriverRegistry`.
- **Reemplazo:** `services/kernel/src/core/sandbox-drivers/docker-driver.ts` con lógica equivalente.

## Candidatos a revisar (no deprecated todavía)

Estos tienen bajo uso pero no son obviamente zombies — el user debería confirmar si los usa:

- **`services/kernel/src/modules/mcp-bridge/`** — 277 líneas, 0 migrations, 0 dashboard, 0 reverse deps. Solo se registra en bootstrap. No tiene tests. Preguntar al user antes de tocar.
- **`services/kernel/src/modules/digest/`** — 192 líneas, tests activos que leen tasks/reminders. Bajo uso pero funcional.
- **`services/kernel/src/modules/devtools/`** — 1792 líneas con tests de drift-detection funcionales. Feature activa aunque sin dashboard.

## Criterio para marcar "deprecated"

Se marca un módulo como deprecated sólo si:

1. Existe un reemplazo **ya en runtime** (no futuro)
2. Los consumidores runtime del módulo son **0** (tests pueden quedar, pero no imports de otros modules/core)
3. El plan de retirada está escrito

Si alguna condición falla, el módulo queda como "low-usage candidate" hasta que cumplan.
