# Conector de proyectos — contrato v1

Un **proyecto** de Kernl (un producto o negocio) le cuenta a Kernl
quiénes se registraron, cuánto usa cada cliente y quién está en lista de espera. Con eso
las oficinas de Ventas y Marketing trabajan para ese proyecto.

Hay dos caminos, y conviene implementar los dos:

- **Pull:** Kernl le pide un snapshot al proyecto cada 6 horas (y cuando el operador toca
  "Probar ahora").
- **Push:** el proyecto le avisa a Kernl cada evento en el momento, con un webhook firmado.

El pull reconcilia lo que se haya perdido por webhook (por ejemplo, si Kernl estuvo apagado).

## Alcance: solo datos comerciales

El contrato transporta **datos de la institución cliente, conteos agregados y el contacto
del administrador de la cuenta**. Nunca datos clínicos ni personales de terceros: ni
pacientes, ni encuentros con contenido, ni diagnósticos.

Kernl valida cada respuesta contra el schema y **descarta todo campo que no esté en este
documento**. Si el proyecto manda de más, ese dato no se guarda. Un snapshot que no cumple el
schema (un campo obligatorio ausente o de otro tipo) se rechaza entero y el error queda
visible en la pantalla Proyectos.

## Configuración en Kernl

En **Proyectos → (proyecto) → Conector**:

| Campo | Qué es |
|---|---|
| URL del snapshot | Base del endpoint del proyecto, por ejemplo `https://api.tu-producto.com/kernl/v1` |
| Token | Bearer token que el proyecto acepta en el pull. Kernl lo guarda cifrado |
| Webhook | URL y secreto que Kernl genera para el push (botón "Mostrar secreto") |

La URL pública del webhook se arma con `KERNEL_PUBLIC_URL`. Si Kernl corre detrás de un
túnel, esa variable tiene que apuntar al túnel.

## Pull: `GET {url}/snapshot?since=<iso8601>`

Headers que manda Kernl:

```
Authorization: Bearer <token>
Accept: application/json
```

`since` es el momento del último pull exitoso (`1970-01-01T00:00:00Z` la primera vez). El
proyecto puede devolver solo lo que cambió desde entonces o todo: Kernl hace upsert.

Respuesta `200`:

```json
{
  "version": "v1",
  "generated_at": "2026-10-04T12:00:00Z",
  "institutions": [
    {
      "id": "inst_123",
      "name": "Clínica Sur",
      "country": "AR",
      "plan": "free",
      "created_at": "2026-09-01T10:00:00Z",
      "last_active_at": "2026-10-03T18:20:00Z",
      "usage": { "users": 3, "practitioners": 2, "encounters_30d": 120, "appointments_30d": 300 },
      "admin": { "name": "Ana Pérez", "email": "ana@clinicasur.com.ar", "phone": "+54 11 5555 0000" }
    }
  ],
  "waitlist": [
    { "name": "Beto Gómez", "email": "beto@consultorio.ar", "institution": "Consultorio X", "created_at": "2026-10-01T09:00:00Z" }
  ]
}
```

### `institutions[]`

| Campo | Tipo | Obligatorio |
|---|---|---|
| `id` | string | sí — id estable del cliente en el proyecto |
| `name` | string | sí |
| `country` | string (ISO 3166-1 alpha-2) | sí |
| `plan` | string | sí — por ejemplo `free`, `pro` |
| `created_at` | string ISO 8601 | sí |
| `last_active_at` | string ISO 8601 o `null` | no |
| `usage.users` | entero ≥ 0 | sí |
| `usage.practitioners` | entero ≥ 0 | sí |
| `usage.encounters_30d` | entero ≥ 0 | sí — cantidad, no contenido |
| `usage.appointments_30d` | entero ≥ 0 | sí |
| `admin.name` | string | sí |
| `admin.email` | string | sí |
| `admin.phone` | string | no |

### `waitlist[]`

| Campo | Tipo | Obligatorio |
|---|---|---|
| `name` | string | sí |
| `email` | string | sí — identifica la entrada |
| `institution` | string | no |
| `created_at` | string ISO 8601 | sí |

Con cada pull, el administrador de cada institución y cada entrada de la waitlist quedan
como **leads del proyecto** en el CRM de Kernl (`lead_source` `signup` o `waitlist`), una
sola vez por email.

Errores: cualquier respuesta que no sea `2xx`, o que tarde más de 30 segundos, se registra
como error del conector y se reintenta en el próximo ciclo.

## Push: webhooks

```
POST {KERNEL_PUBLIC_URL}/api/projects/webhook/{slug}
Content-Type: application/json
X-Kernl-Signature: sha256=<hex>
```

La firma es el HMAC-SHA256 del **body crudo, tal cual se envía**, con el secreto del
webhook. No se firma un objeto re-serializado: cualquier diferencia de espacios u orden
invalida la firma.

Ejemplo en Node:

```js
import { createHmac } from "node:crypto";

const body = JSON.stringify(event);
const signature = "sha256=" + createHmac("sha256", process.env.KERNL_WEBHOOK_SECRET).update(body).digest("hex");
await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Kernl-Signature": signature }, body });
```

Forma del evento:

```json
{ "event_id": "evt_01H…", "type": "waitlist.joined", "occurred_at": "2026-10-04T12:00:00Z", "data": { … } }
```

| `type` | `data` |
|---|---|
| `institution.created` | una institución, con la misma forma que en el snapshot |
| `waitlist.joined` | una entrada de waitlist, con la misma forma que en el snapshot |
| `usage.threshold` | `{ "institution_id": string, "metric": string, "value": number }` — el proyecto decide qué umbral cuenta |
| `plan.changed` | `{ "institution_id": string, "from": string, "to": string }` |

`event_id` tiene que ser único por evento. Kernl procesa cada `event_id` una sola vez y
responde `200` a los repetidos, así que reintentar es seguro.

Respuestas:

| Código | Significado |
|---|---|
| `200` | Recibido (o repetido) |
| `400` | JSON inválido, `type` desconocido o `data` fuera de schema — no reintentar sin corregir |
| `401` | Firma ausente o incorrecta |
| `404` | No existe un proyecto con ese slug |

Cada evento aceptado dispara `project:<type>` dentro de Kernl, con el proyecto
identificado. Las oficinas que atienden ese proyecto pueden reaccionar: por ejemplo,
Ventas califica al nuevo inscripto de la waitlist y deja un borrador de seguimiento para
que el operador lo apruebe.
