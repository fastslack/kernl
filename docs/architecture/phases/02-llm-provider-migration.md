# Fase 2 — Migración al LlmProviderRegistry

## Estado actual

✅ Infra en su lugar (no toca código vivo todavía):

- `src/core/llm-provider.ts` — interface `LlmProvider` + tipos de mensaje/opts/result
- `src/core/llm-provider-registry.ts` — registry con lifecycle, config persist, exhaustion tracking
- `src/core/llm-provider-routes.ts` — `/api/llm-providers/*`
- `src/core/llm-providers/{claude,openai,grok,lmstudio}-provider.ts` — wrappers de las clases existentes en `chat/llm-adapter.ts`
- `src/core/llm-providers/index.ts` — `registerBuiltinLlmProviders(registry)` helper

Cero cambios al código consumidor. El `chat/llm-adapter.ts` sigue intacto.

## Lo que falta (no hecho porque hay trabajo paralelo en curso)

### A) Wire-up en bootstrap (`src/index.ts`)

Seguir el patrón exacto de `SandboxDriverRegistry`:

```ts
// 1. Construir
const llmRegistry = new LlmProviderRegistry();
llmRegistry.setDb(sqlite);
llmRegistry.setEncryptionKey(config.encryptionKey);

// 2. Registrar builtins
registerBuiltinLlmProviders(llmRegistry);

// 3. Pre-start hooks si algún provider necesita algo injected
// (por ahora ninguno lo pide)

// 4. Seed rows + start all
llmRegistry.seedBuiltinRows();
await llmRegistry.startAll();

// 5. Inyectar en consumers (ver sección B)
agentsModule.setLlmRegistry(llmRegistry);

// 6. Routes
registerLlmProviderRoutes(server, llmRegistry);

// 7. Extensions que aporten type:"llm-provider" pasan por InstallerDeps
//    (misma dispatch pattern que sandbox-driver)

// 8. Shutdown
// en el handler de shutdown:
await llmRegistry.stopAll();
```

### B) Consumidores a migrar

21 archivos importan de `chat/llm-adapter.ts` o `chat/llm-loop.ts`. La migración es
gradual porque el adapter viejo sigue operando; los nuevos callers pasan por el
registry:

| Grupo | Archivos | Estrategia |
|-------|----------|------------|
| **agents** | `agents/executor.ts`, `agents/meeting-executor.ts`, `agents/eval-service.ts`, `agents/reflection-optimizer.ts`, `agents/chain-service.ts` | Inyectar `LlmProviderRegistry` en vez de `Map<string, ChatLlmProvider>`. Reemplazar `resolveProvider(providers, name)` por `registry.resolve(name)`. El método `chatCompletion` del contract nuevo es compatible. |
| **chat** | `chat/service.ts`, `chat/api-routes.ts`, `chat/index.ts` | El adapter se vuelve un facade que lee del registry. |
| **web-intel** | `web-intel/*` usos | Pasarle el registry en vez del provider. |
| **comms** | `comms/triage-service.ts` | Idem. |
| **evolution/autogenesis** | `agents/reflection-optimizer.ts` | Idem. |

### C) Extension point para custom LLM providers

En `src/modules/extensions/types.ts`, agregar al ExtensionType:

```ts
export type ExtensionType =
  | "module"
  | ...
  | "sandbox-driver"
  | "llm-provider";  // ← nuevo
```

En `src/modules/extensions/installer.ts`, case dispatch:

```ts
case "llm-provider": {
  const mod = await import(bundle.entryPath);
  if (typeof mod.createProvider !== "function") {
    throw new Error("llm-provider extension must export createProvider()");
  }
  deps.llmProviderRegistry.registerDriverFromExtension(manifest.slug, mod.createProvider);
  await deps.llmProviderRegistry.startProvider(manifest.slug);
  break;
}
```

### D) Retirada del adapter viejo

Cuando los 21 callers migren, `chat/llm-adapter.ts` se reduce a un shim que reexporta
los tipos compartidos (`ChatMessage`, `ChatCompletionResult`, `ContentBlock`, etc).
Las clases (`ChatClaudeProvider`, etc.) se pueden mover físicamente a `src/core/llm-providers/*-provider.ts` — eliminando el wrapper trivial.

## Tipos que conviven durante la migración

Mientras coexistan los 2 caminos:

- **`chat/types.ts`** — `ChatMessage`, `ChatCompletionResult`, `ContentBlock`, `ToolUseBlock`
- **`core/llm-provider.ts`** — `ChatMessage`, `ChatCompletionResult`, `ChatToolCall`

Los wrappers hacen un `as unknown as` para cruzar contratos (visible en los archivos
de `core/llm-providers/`). No es ideal pero es temporal. Cuando se retira el
adapter viejo, los tipos quedan unificados en el de core.

## Riesgos

1. **Tool call shape difiere** entre el adapter viejo (`ToolUseBlock[]`) y el contract nuevo (`ChatToolCall[]`). Los consumers que parsean tool_calls deben adaptarse.
2. **`usage.input_tokens`** no lo expone el adapter viejo (consolida a `tokens_used`). Los callers que quieran breakdown real van a ver 0 en input hasta que reescribamos los wrappers para leer la API raw response.
3. **Quota tracking**: hay 2 sistemas paralelos ahora (`markProviderExhausted` en adapter viejo + `registry.markExhausted()`). Hay que unificar — mi sugerencia: el adapter viejo, cuando marca exhausted, notifica al registry via callback inyectado.

## Tests a agregar

- `tests/llm-provider-registry.test.ts` — register + startAll + stopAll + seedBuiltinRows
- `tests/llm-provider-integration.test.ts` — instalar una fake extensión y verificar dispatch
