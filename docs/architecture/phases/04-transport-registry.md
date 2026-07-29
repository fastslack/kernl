# Fase 4 — TransportRegistry (spoiler: ya existe como NotificationRegistry)

## Estado real al descubrirlo

El `NotificationRegistry` existente YA ES el TransportRegistry que había propuesto.
Capabilities incluyen `"notify"`, **`"receive"`**, `"buttons"`, `"media"`, `"typing"`,
`"reactions"`, `"voice"` — o sea, soporta 2-way.

Y los providers built-in ya están implementados:

```
src/core/providers/
├── dashboard-provider.ts
├── discord-provider.ts
├── mattermost-provider.ts
├── slack-provider.ts
├── telegram-provider.ts
├── webchat-provider.ts
├── whatsapp-provider.ts
└── index.ts
```

## Lo que falta (mucho menos de lo que pensé)

### A) Retirar el legacy `src/core/telegram.ts`

Hay un `src/core/telegram.ts` — ¿es legacy dup o es distinto de `telegram-provider.ts`?
Auditar y retirar si es duplicado.

### B) Completar capability `receive` en todos los providers

Los 7 providers exponen `sendNotification()`. Verificar cuáles tienen el hook
`onMessage(callback)` o equivalente para recibir mensajes. Si falta, agregarlo.

Con esto, el `message-routing.ts` deja de preguntar `provider.getTransport()` (el error
pre-existente que salió en Fase inicial) y pasa por el registry directo.

### C) Fix del `getTransport is not a function`

Hay un bug pre-existente en `src/core/message-routing.ts:64` que el user reportó:

```
TypeError: provider?.getTransport is not a function
```

Eso se resuelve haciendo que los providers expongan `onMessage(cb)` en el contract
(ya en capabilities como `"receive"`), y el routing itera:

```ts
for (const p of registry.getProviders()) {
  if (p.capabilities.includes("receive") && "onMessage" in p) {
    (p as unknown as { onMessage: (cb: Fn) => void }).onMessage(handleIncoming);
  }
}
```

Sin imports estáticos de `WhatsAppProvider`, `SlackProvider`, etc.

### D) ExtensionType `"transport"` o reusar `"channel"`

Ya existe `ExtensionType: "channel"` — probablemente eso es lo mismo que yo llamaba
"transport". Usar el que ya está. Agregar en `installer.ts` el dispatch de
`"channel"` que llame `registry.registerProviderFromExtension(slug, factory)`.

## Plan reducido

Con todo lo que YA existe, la Fase 4 es:

1. **Audit** (1-2h) — confirmar si `src/core/telegram.ts` es legacy vs activo
2. **Fix del routing** (~0.5 día) — reemplazar imports estáticos en `message-routing.ts` por iteración del registry
3. **Extension dispatch** — agregar case `"channel"` en `installer.ts` si no está
4. **Doc user-facing** — documentar cómo agregar un transport custom (un ejemplo: SMS via Twilio como `.kernlext`)

## Archivos tocados

**Leer:**
- `src/core/notification-registry.ts`
- `src/core/message-routing.ts`
- `src/core/providers/*.ts`
- `src/core/telegram.ts` (posible legacy)

**Modificar** (pequeño scope):
- `src/core/message-routing.ts` — reemplazar `provider.getTransport()` por iteración
- `src/modules/extensions/installer.ts` — caso `"channel"` si no está

## No hay "crear registry desde cero" — ya está

Este trabajo es casi todo limpieza + bug fix. El resultado real es desbloquear que
una extension `.kernlext` aporte un nuevo transport sin tocar el kernel.
