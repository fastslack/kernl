# Kernl — Architecture docs

Documentos de arquitectura del proyecto. Rige la migración "kernel mínimo + todo
como extensión" iniciada tras el SandboxDriverRegistry.

## Inicio rápido

1. **Entender el patrón:** [`extension-points.md`](extension-points.md) — el
   template Registry+Driver que toda abstracción debe seguir (inaugurado por
   `SandboxDriverRegistry`).
2. **Ver módulos deprecados / legacy:** [`deprecations.md`](deprecations.md).
3. **Seguir las fases:** [`phases/`](phases/) — plan de migración en 7 fases.

## Fases de migración

| Fase | Doc | Estado |
|------|-----|--------|
| 0 — Documentar patrón | [`extension-points.md`](extension-points.md) | ✅ hecho |
| 1 — Audit zombies | [`deprecations.md`](deprecations.md) | ✅ auditoría completa, retirada no ejecutada |
| 2 — LlmProviderRegistry | [`phases/02-llm-provider-migration.md`](phases/02-llm-provider-migration.md) | 🟡 infra lista, wire-up pendiente |
| 3 — Dashboard inversion | [`phases/03-dashboard-inversion.md`](phases/03-dashboard-inversion.md) | 📋 plan listo |
| 4 — TransportRegistry | [`phases/04-transport-registry.md`](phases/04-transport-registry.md) | 📋 plan listo (ya existe como NotificationRegistry, solo falta limpieza) |
| 5-6 — Extract 38 features | [`phases/05-feature-extension-migration.md`](phases/05-feature-extension-migration.md) | 📋 plan listo, bloqueado por Fase 3 + build pipeline |
| 7 — Decompose monoliths | [`phases/07-monolith-decomposition.md`](phases/07-monolith-decomposition.md) | 📋 plan listo (agents · comms · trading) |
| 8 — UI marketplace público | (TBD) | — |

## Principios

1. **Todo contract vive en `services/kernel/src/core/`**. Interfaces, registries, routes.
2. **Todo driver built-in vive en `services/kernel/src/core/<abstraction>-drivers/`**. Son parte
   del kernel pero consumen el contract.
3. **Toda feature vertical es extensión**. Empaquetable como `.kernlext`, instalable
   via marketplace o upload.
4. **Zero static imports entre features**. Los módulos se comunican por eventos
   (`event-bus`) o por registries.
5. **Incremental, nunca big-bang**. Cada fase debe completarse y validarse antes
   de la siguiente. El kernel sigue funcionando durante toda la migración.

## Extension points actuales

| Point | Status | Drivers built-in |
|-------|--------|------------------|
| `NotificationRegistry` | ✅ producción | dashboard, discord, mattermost, slack, telegram, webchat, whatsapp |
| `SandboxDriverRegistry` | ✅ producción | docker, cubesandbox |
| `LlmProviderRegistry` | 🟡 infra en tree, sin wire-up | claude, openai, grok, lmstudio |

## Estructura del código tras completar la migración

```
Kernl (base mínima ~30k LOC)
├── services/kernel/src/core/         # Infra + contratos + registries + builtins
│   ├── <abstraction>.ts              # ← una interface por extension point
│   ├── <abstraction>-registry.ts
│   ├── <abstraction>-routes.ts
│   └── <abstraction>-drivers/        # ← drivers built-in
├── services/kernel/src/modules/      # Solo core modules que aún no se extraen:
│   ├── config/
│   ├── dashboard/                    # Host dinámico, sin imports de features
│   ├── extensions/                   # Runtime de instalación
│   ├── marketplace/                  # Catálogo
│   ├── plugins/                      # Git installer
│   ├── api-registry/
│   └── agents-core/                  # Tras Fase 7
└── extensions/                       # (fuera del árbol del kernel)
    ├── notes.kernlext
    ├── trading-binance.kernlext
    └── ...
```

## Cómo contribuir

1. Leer [`extension-points.md`](extension-points.md) antes de tocar nada.
2. Si agregás un nuevo extension point, seguí el template exacto.
3. Si migrás un feature, seguí el template en la fase 5.
4. Docs van antes que código — escribir el `.md` primero forzando claridad.

## Metadatos

- **Fecha de esta iteración:** 2026-04-21
- **LOC del kernel al momento del plan:** ~95k
- **Objetivo de LOC post-migración:** ~30k core + extensiones as needed
- **Patrón inaugurador:** SandboxDriverRegistry
