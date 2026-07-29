# Kernl Vision 2026: AI Life Copilot

> De MCP Server a Top 10 GitHub Project

**Fecha**: Marzo 2026  
**Estado**: Planificación  
**Autor**: Conversación Claude + mtw

---

## Resumen Ejecutivo

Kernl comenzó como un MCP server para gestión personal. Con la implementación del Telegram Agent (Fases 1-6 completadas), evolucionó a un **agente personal persistente** accesible 24/7.

El siguiente paso es transformarlo en **el copiloto de vida con IA más completo y privado del mercado**, posicionándolo para adopción masiva.

### Visión
> "Un asistente personal de IA que observa, aprende, predice y actúa — manteniendo tus datos 100% privados."

### Target Audience
**Everyone (Consumer)** — No solo developers. Cualquier persona que quiera organizar su vida con ayuda de IA.

### Killer Feature
**AI Copilot Proactivo** — Una IA que no solo responde, sino que sugiere, predice y actúa sin que le pidas.

---

## Estado Actual (Marzo 2026)

### Stack Tecnológico
| Componente | Tecnología |
|------------|------------|
| Runtime | Node.js >=20, ESM, TypeScript strict |
| DB Principal | SQLite (better-sqlite3) |
| DB Grafos | Neo4j 5.x + GDS |
| Protocolo | MCP (stdio + Streamable HTTP) |
| Validación | Zod → JSON Schema |
| Embeddings | HuggingFace Transformers (local ONNX) |
| Notificaciones | Mattermost + Telegram |
| Testing | Vitest (559 tests) |

### Módulos Implementados (22 módulos, 70+ tools)
```
Core:        tasks, crm, reminders, shopping, home, comms
Intelligence: graph-intel, dashboard, web-intel, digest
Finance:     finance, subscriptions
Personal:    notes, goals, health, meals, vehicles, documents
Meta:        chat, agents, external-agents, google-sync, time-tracking
```

### Telegram Agent (Completado)
| Fase | Descripción | Estado |
|------|-------------|--------|
| 1 | Telegram Transport (grammy) | Done |
| 2 | Unified Notifier (Mattermost + Telegram) | Done |
| 3 | Orchestrator (slash commands + NLP) | Done |
| 4 | External Agents (API + monitoring) | Done |
| 5 | Proactive Behaviors (morning/evening) | Done |
| 6 | Polish (inline keyboards) | Done |

### Slash Commands Disponibles
```
/start    - Welcome + IDs
/help     - Lista de comandos
/status   - Estado del sistema
/tasks    - Listar tareas (filtros: today, overdue, status)
/task     - Crear tarea rápida
/remind   - Crear reminder con NLP ("in 2 hours", "tomorrow at 9am")
/contacts - Buscar contactos
/shopping - Listas de compras activas
/home     - Estado del hogar
/morning  - Briefing matutino
/evening  - Resumen nocturno
/agents   - Estado de agentes externos
/alerts   - Alertas sin acknowledger (con botones)
/done     - Completar tareas (con confirmación)
/reset    - Reiniciar conversación
```

---

## Gap Analysis: Actual vs Top 10 GitHub

| Aspecto | Kernl Hoy | Top 10 Projects | Gap |
|---------|---------------|-----------------|-----|
| **Onboarding** | Clone + config manual | One-click deploy | Alto |
| **UI** | Dashboard funcional | Pulido, dark mode, mobile-first | Alto |
| **Documentación** | CLAUDE.md técnico | Docs site, tutoriales, videos | Alto |
| **Mobile** | No hay | PWA o app nativa | Crítico |
| **AI Proactivo** | Morning/evening briefings | Predicción + acción autónoma | Medio |
| **Diferenciador** | MCP + Neo4j (técnico) | Claro y memorable para consumers | Alto |
| **Comunidad** | Solo desarrollo | Contributors, Discord, issues | Alto |
| **Marketing** | Ninguno | Landing, blog, ProductHunt | Crítico |

---

## Roadmap: 4 Fases

### Fase 1: Foundation for Consumers (4-6 semanas)

**Objetivo**: Que cualquier persona pueda usar Kernl en 5 minutos.

| Feature | Descripción | Esfuerzo | Prioridad |
|---------|-------------|----------|-----------|
| Docker one-liner | `docker run kernl/kernel` con todo incluido | 2 días | P0 |
| Cloud hosted demo | Instancia pública para probar | 1 semana | P0 |
| Mobile PWA | Dashboard responsive + offline | 2 semanas | P0 |
| Onboarding wizard | Setup guiado, value en 5 min | 3 días | P0 |
| Import Todoist | Migrar tareas existentes | 3 días | P1 |
| Import Google Contacts | Sincronización completa | Ya existe | P1 |
| Import Notion | Migrar notas/tasks | 1 semana | P1 |
| Landing page | Explicar valor, screenshots, CTA | 3 días | P0 |

**Entregables**:
- [ ] Dockerfile multi-stage optimizado
- [ ] docker-compose.yml con Neo4j + Kernel
- [ ] PWA con service worker
- [ ] Wizard de 5 pasos (cuenta, import, preferencias, notificaciones, demo)
- [ ] Landing page en `/` con hero, features, screenshots

### Fase 2: AI Copilot Proactivo (6-8 semanas)

**Objetivo**: IA que observa, aprende, predice y actúa.

#### 2.1 Pattern Detector
Sistema que analiza datos históricos para detectar patrones.

```typescript
interface Pattern {
  type: 'habit' | 'purchase' | 'contact' | 'task' | 'finance';
  description: string;
  frequency: { value: number; unit: 'days' | 'weeks' | 'months' };
  confidence: number; // 0-1
  lastOccurrence: string;
  nextPredicted: string;
  metadata: Record<string, unknown>;
}

// Ejemplos de patrones detectables:
// - "Compras leche cada ~12 días"
// - "Llamas a mamá los domingos"
// - "Pagas Netflix el día 15"
// - "Haces ejercicio L-M-V"
// - "Gastas más en restaurantes los viernes"
```

#### 2.2 Prediction Engine
Usa patrones + contexto para predecir necesidades.

```typescript
interface Prediction {
  type: 'need' | 'reminder' | 'alert' | 'suggestion';
  title: string;
  reason: string; // Explicación para el usuario
  confidence: number;
  suggestedAction?: {
    tool: string;
    params: Record<string, unknown>;
  };
  expiresAt: string;
}

// Ejemplos:
// - "Mañana probablemente necesites comprar leche (última: hace 11 días)"
// - "No has hablado con Juan en 3 semanas (usualmente: cada 2 semanas)"
// - "Tu factura de luz llega en 3 días (promedio: €85)"
```

#### 2.3 Proactive Actions
Acciones que el sistema puede tomar automáticamente (con permiso).

| Nivel | Descripción | Ejemplo |
|-------|-------------|---------|
| **Observe** | Solo detecta, no actúa | "Detecté que compraste café" |
| **Suggest** | Sugiere acción, usuario confirma | "¿Agrego café a tu lista?" |
| **Auto-low** | Actúa en cosas menores | Auto-categoriza gasto |
| **Auto-high** | Actúa en cosas importantes (requiere opt-in) | Crea reminder automático |

```typescript
interface ProactiveAction {
  id: string;
  trigger: 'pattern' | 'prediction' | 'event' | 'schedule';
  level: 'observe' | 'suggest' | 'auto-low' | 'auto-high';
  condition: string; // SQL o expresión
  action: {
    tool: string;
    params: Record<string, unknown>;
  };
  enabled: boolean;
  lastTriggered: string | null;
}
```

#### 2.4 Context Memory
Memoria persistente del copilot sobre el usuario.

```typescript
interface UserContext {
  preferences: {
    workHours: { start: string; end: string };
    timezone: string;
    notificationStyle: 'minimal' | 'normal' | 'verbose';
    autoActionLevel: 'observe' | 'suggest' | 'auto-low' | 'auto-high';
  };
  entities: {
    // Entidades importantes extraídas de conversaciones
    people: Map<string, { role: string; notes: string }>;
    places: Map<string, { type: string; address: string }>;
    accounts: Map<string, { type: string; lastUsed: string }>;
  };
  patterns: Pattern[];
  recentContext: string[]; // Últimas N interacciones resumidas
}
```

#### 2.5 Smart Notifications
No spam — solo lo importante, en el momento correcto.

```typescript
interface SmartNotification {
  priority: 'low' | 'normal' | 'high' | 'urgent';
  category: 'insight' | 'reminder' | 'alert' | 'suggestion' | 'summary';
  
  // Reglas de delivery
  delivery: {
    channels: ('telegram' | 'mattermost' | 'push' | 'email')[];
    timing: 'immediate' | 'batch' | 'scheduled';
    quietHours: boolean; // Respetar horas de silencio
    dedupe: boolean; // No repetir si ya se envió similar
  };
  
  // Para batching
  batchKey?: string; // Agrupa notificaciones similares
  batchTemplate?: string; // "Tienes {count} sugerencias pendientes"
}
```

**Entregables Fase 2**:
- [ ] `src/modules/patterns/` — Detección de patrones
- [ ] `src/modules/predictions/` — Motor de predicción
- [ ] `src/core/proactive-actions.ts` — Sistema de acciones automáticas
- [ ] `src/core/context-memory.ts` — Memoria del copilot
- [ ] `src/core/smart-notifications.ts` — Notificaciones inteligentes
- [ ] Tabla `user_preferences` para configuración
- [ ] Tabla `detected_patterns` para patrones
- [ ] Tabla `predictions` para predicciones activas
- [ ] Tabla `proactive_actions` para acciones configuradas

### Fase 3: Diferenciadores Visuales (4 semanas)

**Objetivo**: Visualizaciones únicas que hagan viral al proyecto.

#### 3.1 Life Graph 3D
Visualización interactiva de tu red de vida usando Neo4j + D3/Three.js.

```
Nodos: Contactos, Tareas, Proyectos, Lugares, Cuentas
Edges: Interacciones, Dependencias, Ubicaciones, Transacciones

Features:
- Zoom semántico (más detalle al acercar)
- Filtros por tipo, fecha, relación
- Click para ver detalles
- Clusters automáticos (comunidades)
- Timeline slider (ver evolución)
```

#### 3.2 Life Timeline
Tu vida como una timeline privada (estilo Facebook pero tuyo).

```
| Mar 2026                                    |
|---------------------------------------------|
| [Task] Completaste "Renovar pasaporte"      |
| [Finance] Pagaste electricidad (€92)        |
| [Contact] Llamada con Juan (45 min)         |
| [Health] Caminaste 8,432 pasos              |
| [Shopping] Compraste en Mercadona (€67)     |
```

#### 3.3 Insights Dashboard
Métricas de tu vida con comparaciones temporales.

```
┌─────────────────┬─────────────────┬─────────────────┐
│ PRODUCTIVIDAD   │ RELACIONES      │ FINANZAS        │
│ ━━━━━━━━━━━━━━  │ ━━━━━━━━━━━━━━  │ ━━━━━━━━━━━━━━  │
│ Tasks: 23 done  │ Contacts: 12    │ Spent: €1,240   │
│ vs last week:+5 │ vs last week:-3 │ vs budget: -8%  │
│ Focus: 4.2h/day │ Top: María (5x) │ Top: Groceries  │
└─────────────────┴─────────────────┴─────────────────┘
```

#### 3.4 Weekly AI Report
Email/Telegram semanal con insights personalizados.

```markdown
# Tu Semana (Feb 24 - Mar 2)

## Logros
- Completaste 23 tareas (mejor semana del mes)
- Mantuviste racha de ejercicio: 12 días

## Insights
- Gastaste 40% más en delivery que la semana pasada
- No has hablado con tu hermano en 3 semanas
- Tu proyecto "Renovación cocina" lleva 2 meses estancado

## Sugerencias
- Considera cocinar más (ahorro estimado: €80/mes)
- ¿Llamar a tu hermano este fin de semana?
- ¿Revisar el proyecto de cocina o archivarlo?

## Próxima Semana
- 3 tareas con deadline
- Cumpleaños de María (viernes)
- Vence seguro del auto (renovar antes del 10)
```

**Entregables Fase 3**:
- [ ] `/dashboard/graph` — Life Graph 3D
- [ ] `/dashboard/timeline` — Life Timeline
- [ ] `/dashboard/insights` — Insights Dashboard
- [ ] `kernel_report_weekly` tool — Genera reporte
- [ ] Scheduled job para enviar reporte semanal

### Fase 4: Community & Growth (Ongoing)

**Objetivo**: Construir comunidad y adopción.

| Acción | Plataforma | Impacto Esperado |
|--------|------------|------------------|
| Docs site | Docusaurus/VitePress | SEO, credibilidad |
| Discord server | Discord | Comunidad, feedback |
| Video demo (2 min) | YouTube | Viralidad |
| Blog técnico | Dev.to/Medium | SEO, autoridad |
| ProductHunt launch | ProductHunt | Early adopters |
| HackerNews post | HN | Developer reach |
| Comparisons page | Website | SEO, conversión |
| Plugin system | GitHub | Contributors |
| Templates gallery | Website | Onboarding |
| Testimonials | Website | Social proof |

**Comparisons a crear**:
- "Kernel vs Notion" — Privacy, AI, offline
- "Kernel vs Todoist" — Graph, proactivity, integrations
- "Kernel vs Obsidian" — Life management vs notes
- "Kernel vs Home Assistant" — Complementario, no competidor

---

## Arquitectura Propuesta: AI Copilot

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER INTERFACES                          │
│  Telegram │ Web Dashboard │ PWA │ API │ Voice (future)          │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         ORCHESTRATOR                             │
│  Message Router │ Command Parser │ NLP Handler │ Callback Handler│
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PROACTIVE ENGINE                            │
├─────────────────┬─────────────────┬─────────────────────────────┤
│ Pattern Detector│ Prediction Engine│ Action Engine              │
│ ───────────────│ ────────────────│ ─────────────────────────── │
│ • Habit mining │ • Need forecast │ • Auto-categorize           │
│ • Spending     │ • Anomaly detect│ • Auto-remind               │
│ • Relationships│ • Time estimates│ • Suggestions               │
│ • Schedules    │ • Risk alerts   │ • Batch actions             │
└─────────────────┴─────────────────┴─────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      CONTEXT MEMORY                              │
│  User Preferences │ Entity Graph │ Conversation History         │
│  Detected Patterns │ Active Predictions │ Action History        │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      INTELLIGENCE LAYER                          │
│  ChatService (LLM) │ Embeddings │ Graph Analytics (Neo4j GDS)   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         DATA LAYER                               │
│  SQLite (primary) │ Neo4j (graph) │ Vector Index (embeddings)   │
├─────────────────────────────────────────────────────────────────┤
│                        MODULE TOOLS                              │
│ Tasks│CRM│Finance│Shopping│Home│Health│Comms│Calendar│...      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Nuevas Tablas Propuestas

### user_preferences
```sql
CREATE TABLE user_preferences (
  id TEXT PRIMARY KEY DEFAULT 'default',
  work_hours_start TEXT NOT NULL DEFAULT '09:00',
  work_hours_end TEXT NOT NULL DEFAULT '18:00',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  notification_style TEXT NOT NULL DEFAULT 'normal'
    CHECK(notification_style IN ('minimal','normal','verbose')),
  auto_action_level TEXT NOT NULL DEFAULT 'suggest'
    CHECK(auto_action_level IN ('observe','suggest','auto-low','auto-high')),
  quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
  quiet_hours_end TEXT NOT NULL DEFAULT '08:00',
  weekly_report_day INTEGER NOT NULL DEFAULT 0, -- 0=Sunday
  weekly_report_time TEXT NOT NULL DEFAULT '09:00',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### detected_patterns
```sql
CREATE TABLE detected_patterns (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('habit','purchase','contact','task','finance','health')),
  description TEXT NOT NULL,
  frequency_value INTEGER NOT NULL,
  frequency_unit TEXT NOT NULL CHECK(frequency_unit IN ('days','weeks','months')),
  confidence REAL NOT NULL DEFAULT 0.5,
  last_occurrence TEXT,
  next_predicted TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### predictions
```sql
CREATE TABLE predictions (
  id TEXT PRIMARY KEY,
  pattern_id TEXT REFERENCES detected_patterns(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK(type IN ('need','reminder','alert','suggestion')),
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  suggested_tool TEXT,
  suggested_params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','shown','accepted','dismissed','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### proactive_actions
```sql
CREATE TABLE proactive_actions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('pattern','prediction','event','schedule')),
  trigger_config TEXT NOT NULL DEFAULT '{}',
  level TEXT NOT NULL DEFAULT 'suggest'
    CHECK(level IN ('observe','suggest','auto-low','auto-high')),
  action_tool TEXT NOT NULL,
  action_params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_triggered_at TEXT,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### action_history
```sql
CREATE TABLE action_history (
  id TEXT PRIMARY KEY,
  action_id TEXT REFERENCES proactive_actions(id) ON DELETE SET NULL,
  prediction_id TEXT REFERENCES predictions(id) ON DELETE SET NULL,
  tool_called TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT '',
  user_feedback TEXT CHECK(user_feedback IN ('helpful','neutral','annoying')),
  created_at TEXT NOT NULL
);
```

---

## Métricas de Éxito

### Fase 1 (Foundation)
- [ ] Time to first value < 5 minutos
- [ ] Docker pulls > 1,000/mes
- [ ] PWA Lighthouse score > 90

### Fase 2 (AI Copilot)
- [ ] Patrones detectados por usuario > 10
- [ ] Predicciones aceptadas > 50%
- [ ] Acciones automáticas/semana > 20
- [ ] User feedback "helpful" > 70%

### Fase 3 (Visuales)
- [ ] Time on Life Graph > 2 min/sesión
- [ ] Weekly report open rate > 60%
- [ ] Shares de screenshots > 100/mes

### Fase 4 (Community)
- [ ] GitHub stars > 10,000
- [ ] Discord members > 1,000
- [ ] Contributors > 20
- [ ] ProductHunt #1 of day

---

## Competencia y Posicionamiento

### Competidores Directos
| Producto | Fortaleza | Debilidad vs Kernel |
|----------|-----------|---------------------|
| Notion | UI, colaboración | No es AI-first, cloud-only |
| Todoist | Simplicidad | No tiene CRM, finanzas, home |
| Obsidian | Local-first, plugins | No es proactivo, no tiene graph |
| YNAB | Finanzas | Solo finanzas, no integra vida |
| Home Assistant | IoT, automación | No es personal assistant |

### Posicionamiento
> "Kernel es el único asistente de vida que combina gestión de tareas, CRM, finanzas, hogar y salud en un sistema local con IA proactiva que aprende de ti y actúa por ti."

### Taglines Candidatos
- "Your AI Life Copilot"
- "Life Management, Automated"
- "The Private AI That Knows You"
- "Your Life, Organized by AI"

---

## Riesgos y Mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|--------------|---------|------------|
| Complejidad abruma usuarios | Alta | Alto | Onboarding progresivo, defaults inteligentes |
| IA da sugerencias molestas | Media | Alto | Feedback loop, niveles de proactividad |
| Neo4j es barrera de entrada | Alta | Medio | Modo SQLite-only funcional |
| Sin comunidad no escala | Alta | Alto | Discord activo, responder issues <24h |
| Competidor grande copia | Baja | Medio | Velocidad de innovación, comunidad leal |

---

## Próximos Pasos Inmediatos

### Esta Semana
1. [ ] Crear `docs/design/PATTERNS.md` — Spec del Pattern Detector
2. [ ] Crear `src/modules/patterns/` — Estructura inicial
3. [ ] Mejorar Dockerfile para one-liner
4. [ ] Landing page básica en `/`

### Este Mes
1. [ ] Pattern Detector MVP (purchases, contacts)
2. [ ] Prediction Engine MVP
3. [ ] Weekly Report via Telegram
4. [ ] PWA básica del dashboard

### Q2 2026
1. [ ] Fase 2 completa (AI Copilot)
2. [ ] Life Graph 3D
3. [ ] ProductHunt launch
4. [ ] Primeros 1,000 stars

---

## Apéndice: Lecciones Aprendidas

### Del Desarrollo del Telegram Agent
1. **Arquitectura modular funciona** — Agregar Telegram sin tocar módulos existentes
2. **Unified Notifier pattern** — Abstraer canales de notificación
3. **Orchestrator centralizado** — Un punto de entrada para todos los mensajes
4. **Callback data format** — `action:id:extra` es simple y extensible
5. **Proactive Engine separado** — No mezclar con business logic

### De Proyectos Exitosos en GitHub
1. **README es marketing** — Screenshots, GIFs, valor claro en 10 segundos
2. **Docs site es credibilidad** — Sin docs parece proyecto abandonado
3. **Discord > Issues** — Comunidad en tiempo real genera momentum
4. **Video > Text** — 2 min demo vale más que 10 páginas de docs
5. **Comparisons son SEO** — "X vs Y" atrae tráfico de búsqueda

### De AI Products
1. **Explicar el "por qué"** — Usuarios confían más si entienden el razonamiento
2. **Feedback loop es crítico** — Sin feedback, IA no mejora
3. **Defaults conservadores** — Mejor pedir permiso que molestar
4. **Personalización gradual** — Aprender con el tiempo, no pedir todo upfront
5. **Privacidad es feature** — En 2026, "local-first" es diferenciador

---

*Documento vivo. Actualizar conforme avanza el desarrollo.*
