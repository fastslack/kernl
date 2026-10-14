# Registro de cambios

Todos los cambios importantes de este proyecto se documentan en este archivo.

El formato se basa en [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
y el proyecto sigue [Versionado Semántico](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.4] - 2026-10-14

### Actualizar desde 0.4.3

- **La dirección onion ya no llega al kernel.** Antes reenviaba al puerto
  propio del kernel, lo que dejaba el dashboard, `/mcp`, `/api/health` y
  `/api/metrics` en una dirección pública protegidos solo por el token del
  dueño. Ahora llega a un gateway aparte que sirve la tarjeta de presencia y
  nada más, hasta que publicás un servicio desde la página de Amigos. Por Tor,
  tus amigos llegan solo a lo que publiques ahí.
- **Tor lo arranca el kernel, no el entrypoint del contenedor.** El switch de
  la página de Amigos lo prende y lo apaga sin tocar `.env` ni reiniciar;
  `KERNEL_TOR=1` solo define el valor por defecto hasta que usás el switch.
  La clave onion en `/app/data/tor/kernl` se conserva, así que la dirección no
  cambia.
- **Elegí una edición.** El setup suma un paso personal/empresa. En una
  instalación anterior a las ediciones (la marca la migración 4), elegir una
  solo prende extensiones, nunca las apaga.

### Agregado

- **Edición personal o empresa.** Define qué extensiones gratuitas arrancan
  activas, qué equipo inicial ofrece el setup y el contexto que recibe cada
  agente. La cambiás desde Configuración → General; la tienda de extensiones
  filtra por ella y marca las extensiones hechas para una sola.
- **Model Bench** (`/bench`) puntúa cada modelo conectado en los tipos de
  trabajo propios de Kernl: llamadas a herramientas, tareas de agente, JSON,
  números, idioma, contexto largo e inyección de prompts, con chequeos
  deterministas, costo e historial. La pastilla LIVE muestra un punto por
  cada modelo de la cadena y el puntaje de cada uno.
- **Vista general del sistema** (`/control`): cómo anda este Kernl de un
  vistazo, con acceso a cada una de sus partes.
- **"¿Qué respondería la IA?"** en una pregunta de oficina ahora la contesta
  un investigador de solo lectura que lee el issue, su merge request, el
  código y el historial de git antes de opinar, y va mostrando su avance.
- **Paneles de oficina.** Una oficina puede declarar paneles (fuentes, vistas
  y acciones, `panels.v1`) en el manifiesto del Office Kit o en el seed de
  oficina de una extensión. Aparecen como pestañas en el panel 3D de la
  oficina y se abren desde el pizarrón de su sala. Cada lectura y cada acción
  se valida, tiene límite de frecuencia y queda auditada.
- **Más proveedores de IA**: Cerebras, Mistral, Together, Fireworks, Kimi,
  Qwen, Z.ai, Xiaomi MiMo y cualquier servidor compatible con OpenAI. Vienen
  con los íconos de cada marca y un selector de dos columnas.
- **Tor en los paquetes nativos.** Los builds de Linux, macOS y Windows traen
  Tor, así que una instalación nativa también puede ser accesible desde
  cualquier lado.
- **Respondé las opciones de un reporte desde Mi Oficina**; lo que elijas va
  al chat del agente.
- **Un agente puede desactivar la autoevaluación** después de cada corrida, y
  los seeds de extensiones pueden desactivarla para uno.
- **`scripts/kernl.sh`** arranca, frena, sigue los logs y chequea el stack
  local.
- **Un visor de JSON compacto** para llamadas a herramientas, resultados y
  mensajes de agentes.

### Cambiado

- **Los agentes programados corren en paralelo**, así que una corrida larga
  ya no frena a todas las demás programaciones.
- **El modelo de un proveedor conectado se elige con el selector de
  modelos**, Claude Code incluido; el modelo se prueba antes de guardarlo.
- **El stream de mensajes muestra la hora y los tokens de cada post** en sus
  propias columnas a la izquierda: el reloj, cuánto tardó el post, los tokens
  que consumió y el total de la corrida hasta ahí. Los agentes `claude_code`
  ahora reportan sus tokens por cada turno del modelo en vez de solo al final
  de la corrida.
- **El panel de oficina es más ancho**, su tablero se colorea por estado, y
  Destruir oficina se mudó del pie a una zona de peligro.
- **Los caminantes 3D toman el camino más corto por los pasillos** esquivando
  escritorios, salas de reunión y la recepción, y llevan su mensaje adentro
  de su cartel con el nombre.
- **La redirección del login de Claude se captura en el host**, así que un
  stack Docker en Linux no necesita pegar nada.
- Las preguntas sin resolver del chief le llegan al operador apenas termina su
  corrida de triage, y las corridas desatendidas le llegan al operador a
  través del chief.

### Corregido

- Los modelos de razonamiento de OpenAI (GPT-5, serie o) rechazaban todos los
  pedidos: `max_tokens` ahora se manda como `max_completion_tokens`, el
  sampling no soportado se descarta y su tope de tokens deja lugar para el
  razonamiento.
- El selector de modelos del diálogo de proveedor se abría por debajo del
  diálogo.
- Las respuestas largas de los agentes `claude_code` se cortaban en el hilo
  del chat.
- La cámara no llegaba a la oficina que estaba enfocando con algunos frame
  rates.
- Un logo de proveedor redibujado quedaba escondido detrás de la caché del
  navegador.
- Una corrida `claude_code` en sandbox podía rotar la sesión de Claude de
  Kernl y dejar a todas las corridas siguientes con "OAuth expired". Ahora los
  sandboxes reciben el access token sin el refresh token, el kernel lo
  refresca antes si vencería a mitad de la corrida, y una sesión muerta cuenta
  como falla de autenticación.

## [0.4.3] - 2026-10-08

### Actualizar desde 0.4.2

- **Los agentes ya no publican en la red social ni llaman a otras instancias
  de Kernl por su cuenta.** Un post o una respuesta de una corrida de agente
  se convierte en un borrador `social_post` en Aprobaciones, que aprobás antes
  de que salga; los follows, reacciones, cambios de perfil y llamadas de mesh
  y federación se rechazan con un mensaje que le dice al agente que te
  pregunte. `AGENT_EGRESS_STRICT=1` va más allá y hace que toda herramienta
  que publica o envía quede en modo solo borrador para los agentes, tengan
  proyecto o no.
- **Aprobaciones acepta borradores sin proyecto.** La tabla de salida se
  reconstruye en el primer arranque (migración 8) para que `project_id` pueda
  quedar vacío; los borradores existentes se copian tal cual. Las referencias
  de cuenta se guardan en la forma canónica de cada canal, así que
  `comms:<id>`, el id pelado y la dirección nombran la misma cuenta de mail.
- **Los agentes Claude Code corren solo con la sesión propia de Kernl.** En
  Docker tomaban prestado el login `~/.claude` del host y los sandboxes
  montaban las credenciales del host, así que los agentes seguían corriendo
  mientras Conexiones de IA decía que Claude Code no estaba conectado. Iniciá
  sesión una vez desde el dashboard; hasta entonces el panel del agente lo
  avisa y te ofrece el login.
- **El fixer de Kernl necesita el repo montado para funcionar.** "Que lo
  arregle Claude Code" en la pestaña de bugs de Kernl necesita
  `KERNL_REPO_PATH`, `KERNL_REPO_GIT` y `KERNL_FIX_ROOT` en `.env` (mirá
  `docker-compose.host.yml`). Si no están, el botón explica qué falta y no
  cambia nada más.

### Agregado

- **El texto de terceros queda aislado para los agentes.** Mails, posts de
  Nostr, ítems de RSS y resultados de herramientas de pares le llegan al
  modelo dentro de un único elemento `<external>` que el texto no puede cerrar
  ni falsificar; los caracteres invisibles y bidi se descartan, y los patrones
  de inyección conocidos se marcan, nunca se borran.
- **Tarjetas para compartir firmadas.** Una película, serie, disco, libro,
  link o nota compartidos viajan como una tarjeta validada estrictamente y
  firmada con la clave Nostr de quien la manda. Tus amigos pueden saber qué
  persona de Social corre en qué Kernl a través de una prueba sellada que
  firman las dos claves; nadie más se puede enterar.
- **Arreglá un bug de Kernl desde su reporte.** La pestaña de bugs de Kernl
  muestra cada reporte en línea con filtros y estado, y puede pasarle uno a un
  agente programador que trabaja en su propio worktree de git y su propio
  sandbox, en su propia branch `fix/`. El kernel commitea ahí y nunca pushea
  ni mergea.
- **Buscá mail nuevo desde la página de mail**, que corre el fetch de IMAP en
  el momento y te dice cuántos mensajes entraron. El mail IMAP conserva sus
  adjuntos, y la vista de mail los lista y los abre.
- **Toasts, confirmaciones y estados de carga propios de Kernl** reemplazan
  todos los alert, confirm y prompt del navegador. Las acciones irreversibles
  dicen qué se pierde, y desinstalar o borrar un agente, una cuenta o un
  remoto te pide que escribas su nombre; archivar, mandar a la papelera y
  bloquear en Mail actúan al instante con Deshacer. Las pantallas de todos los
  días muestran un skeleton mientras cargan y dicen qué falló, con Reintentar.
- **Iniciá sesión en Claude Code desde el agente que perdió la sesión**,
  desde su banner o debajo de la respuesta fallida en su chat; retoma apenas
  vuelve la sesión.
- **Las skills escritas como `<name>-SKILL.md`** se importan, con los
  archivos que nombran; un agente abre esos archivos con
  `kernel_skill_load(slug, file)`.
- **Una programación puede trabajar para un proyecto.**
  `kernel_agents_add_trigger` acepta un `project`; sin él, las corridas
  heredan el proyecto de una oficina que atiende exactamente uno.

### Cambiado

- **Los selectores de modelos se ordenan por uso.** Los proveedores y modelos
  que más usás aparecen primero, con un contador de llamadas al lado de cada
  modelo usado, y el menú muestra un loader mientras llega la lista de modelos
  en vez de "no hay coincidencias".
- **Los selectores de modelos ofrecen solo modelos que pueden llamar
  herramientas** donde la corrida las necesita, y marcan los que todavía no
  están verificados. Claude Code lista sus modelos reales después de un login
  por navegador, Opus 5.5 incluido.
- **Aprobaciones le da toda la pantalla al borrador**, lista los mails por
  asunto y usa sus propios colores.
- **El chip de oficina en el panel del agente abre un menú con estilo** en
  vez de la lista pelada del navegador.
- **El panel del agente ya no enlaza al panel de DevOps**; el panel de oficina
  sí.
- **La sugerencia de actualización de Docker respeta tus overrides**: arma el
  comando con los archivos compose con los que se levantó el stack.

### Corregido

- Responder varias preguntas seguidas dejaba sin entregar todas menos la
  primera; ahora el agente se relanza con todas las respuestas pendientes
  cuando termina su corrida.
- La opinión de la IA sobre una pregunta escalada mostraba como error el
  razonamiento a medio terminar de un modelo de razonamiento. Ahora tiene
  lugar para responder, un reintento y un mensaje claro cuando no hay
  respuesta.
- `/mail` fallaba con un 500 cuando lo renderizaba el servidor de desarrollo.

## [0.4.2] - 2026-10-07

### Actualizar desde 0.4.1

- **La clave de la instancia ya no cambia cuando se instala Social.** La seed
  de la instancia ahora siempre le gana a la de la persona de Social; una
  seed que existe pero no se puede descifrar apaga el peering en vez de
  generar una identidad nueva. Las instalaciones cuyas amistades se hicieron
  con la clave de la persona la conservan.
- **El Chief y los agentes de sistema del núcleo están siempre prendidos.**
  Desactivar o borrar el Chief, Agent Offline Monitor, Agent Factory o Data
  Retention se rechaza con un 409, y el corte por fallas nunca los pausa.

### Agregado

- **Mandá texto y archivos a tus amigos de Kernl**, por la LAN, una URL
  pública o Tor: ofertas firmadas, partes reanudables de 8 MiB con hashes,
  vencimiento a las 24 h. Social → Compartir tiene el editor y la actividad;
  Commander suma "Mandar a un amigo" y permite recorrer los archivos
  recibidos. El peering anuncia las direcciones LAN reales (`KERNEL_LAN_URL`
  en Docker), un puerto 3088 que solo deja pasar rutas firmadas, y una
  dirección manual por amigo.
- **Pedile a la IA su opinión sobre una pregunta escalada.** Si está de
  acuerdo con una opción, esa opción queda marcada como recomendada; si no,
  propone su propia respuesta.
- **La pestaña Workspace separa los archivos propios del agente del repo** en
  el que trabaja.
- **Copiá la vista previa del issue de un bug de Kernl** tal cual se
  publicaría.

### Cambiado

- `/projects` tiene su propia paleta cálida, colores e iniciales por
  proyecto.
- El menú Herramientas queda oculto salvo que esté activado Configuración →
  General → "Mostrar el menú Herramientas".
- Los temas incluidos cumplen el contraste WCAG AA.
- El login de Claude Code por terminal se explica paso a paso, y en Windows
  nombra al Símbolo del sistema.

### Corregido

- Los agentes no podían correr en una instalación solo con Claude Code, como
  en un Windows recién instalado: el executor buscaba la sesión en
  `~/.claude`.
- Las herramientas de extensiones se publicaban con un esquema de entrada
  vacío, así que los agentes adivinaban los nombres de los parámetros.
- Una corrida de agente se pasaba de su presupuesto de tokens por un turno
  entero, y retomar una corrida que el presupuesto había frenado fallaba en
  su primer turno.
- Un agente despertado no podía encontrar ni dar por recibidas las cartas por
  las que lo habían despertado.

## [0.4.1] - 2026-10-06

### Actualizar desde 0.4.0

- **Los datos viejos ahora se borran todas las noches, con políticas de
  retención que vienen activadas.** Reemplazan al viejo agente
  `script:cleanup`, que se retira en el primer arranque. De entrada: las
  corridas completadas de agentes sin modelo (polls, chequeos programados) a
  los 14 días, las corridas fallidas o canceladas de cualquier agente a los
  60, el log de eventos de agentes, las versiones viejas de prompts y las
  propuestas de evolución rechazadas a los 30, las notificaciones leídas a
  los 7, y el uso diario de modelos a los 365. Las corridas completadas de
  agentes que usan un modelo alimentan su memoria y se conservan: esa
  política viene apagada. Revisá o cambiá cualquiera en Sistema →
  Almacenamiento antes de la primera noche si querés guardar más.
- **Se rechaza una carpeta de oficina o de agente que el kernel no puede
  ver.** Configurar el repo de una oficina o el `__cwd_path__` de un agente
  con una carpeta del host que está fuera de todos los montajes de un kernel
  en Docker ahora responde 400 (el repo de una oficina además tiene que tener
  permiso de escritura), en vez de guardarlo y dejar que el agente trabaje
  calladito en otro lado. El Office Kit igual registra ese repo en sus
  agentes, con una advertencia, para que la oficina empiece a trabajar en
  cuanto se monte. Las carpetas que ya estaban guardadas así se reportan una
  vez al arrancar. Para darles sus repos a las oficinas, definí
  `KERNL_PROJECTS_ROOT` en `.env` (lo monta en lectura-escritura
  `docker-compose.host.yml`); si no está, no cambia nada.
- **El modelo principal elige el motor de un agente Claude Code en los dos
  sentidos.** La 0.4.0 pasaba un agente al executor del kernel cuando su
  modelo no era Claude; ahora elegir un modelo Claude Code (SDK) también lo
  pasa al executor `claude_code`, y cualquier otro modelo, incluido un modelo
  Claude por la API, al del kernel. Los agentes conservan su motor hasta que
  se cambie su modelo principal.
- **`GET /api/agents/:id/cwd-files` lista un solo nivel.** Devuelve la raíz,
  o la carpeta indicada por `?dir=`, con la cantidad de entradas de cada
  subcarpeta; las carpetas de más de 500 entradas se cortan, y `truncated` y
  `total` lo indican. Antes devolvía el árbol entero en una sola respuesta.

### Agregado

- **Conectá Claude Code con un botón.** "Conectar con mi suscripción" abre la
  página de aprobación de Claude en tu navegador; la aprobás y Kernl toma la
  sesión solo — sin terminal, sin comandos para pegar. Corre el login propio
  del CLI oficial, así que Kernl sigue sin ver nunca el token. En Docker,
  donde la aprobación no encuentra sola el camino de vuelta al contenedor,
  Kernl abre la página y vos pegás la dirección en la que quedó tu navegador
  — igual sin terminal.
- **Claude Opus 5.5 en los agentes Claude Code.** El SDK de agentes de Claude
  pasa a la 0.3.290, que trae Claude Code 2.1.290; la 2.1.114 que reemplaza
  era rechazada por la API para Opus 5.5 ("version 2.1.280 or newer is
  required").
- **Documentos, fotos y videos cortos en los chats.** Adjuntá hasta diez
  archivos a un mensaje, en el chat, el chat de la oficina 3D y el creador de
  oficinas. Las imágenes se achican, los PDF y documentos de Word se leen
  como texto, y los videos de hasta tres minutos se muestrean en frames, y se
  transcriben cuando ya hay un modelo whisper en disco, así el modelo ve lo
  que se mandó.
- **Sistema → Almacenamiento.** Muestra qué ocupa lugar en la base de datos,
  tabla por tabla, cuánto liberaría cada política de retención, y te deja
  prender o apagar políticas, cambiar sus días y correrlas en el momento, con
  progreso. Las extensiones traen sus propias políticas; Cinema y Music suman
  un tope al tamaño de su catálogo.
- **Apagá una oficina.** Una oficina apagada conserva sus agentes,
  programaciones y lote, pero no corre nada adentro: las programaciones y los
  disparadores de eventos la saltean y sus corridas en curso se cancelan. El
  agente principal nunca se frena. Hay un botón de encendido en las tarjetas
  de oficina y en el panel de oficina, y las oficinas apagadas se ven
  atenuadas en 3D.
- **Los agentes creados sin prompt reciben un mandato completo**, que escribe
  el modelo a partir de su título, rol, oficina y equipo.
- **Una oficina compartida puede trabajar para cualquier proyecto.** El
  proyecto de quien llama define de quién es el trabajo de una corrida, así
  que la memoria, la bandeja y los archivos quedan separados por proyecto; a
  una corrida sin proyecto se le pide que lo defina primero. El chat del
  agente lleva un proyecto, que se elige en la pestaña cuando la oficina
  atiende varios, con su propio hilo cada uno. Las extensiones leen el
  proyecto de la corrida con `projects.current()`.
- **Los chats se agrupan según dónde arrancaron** (oficina 3D, dashboard,
  MCP, mensajería, setup) y se titulan por tema después del primer
  intercambio (`CHAT_TITLE_MODEL` elige el modelo). Reabrir el chat 3D de un
  agente retoma su última conversación.

### Cambiado

- **El menú de modelos lista solo lo que funciona**: los proveedores que no
  están configurados, o que no encontraron modelos, quedan afuera, y Claude
  Code (SDK) aparece primero. Los modelos de Claude Code se pueden elegir como
  modelo principal de cualquier agente, ya que elegir uno pasa al agente al
  motor que lo corre. La sección Modelo del agente ahora es solo la lista de
  modelos; el switch de motor y sus notas ya no están.
- **La pestaña Workspace abre las carpetas a demanda.** Carga la carpeta del
  agente de a un nivel en vez del árbol entero: un repo real montado desde el
  host respondía con 224.741 entradas y 35 MB, y la pestaña se colgaba. Ahora
  la raíz llega en unos pocos kilobytes.
- **La pestaña Workspace muestra dónde trabaja de verdad un agente** cuando
  su `__cwd_path__` no está montado en el contenedor, en vez de una carpeta
  vacía.
- **LIVE se lee mejor.** Cada paso es una línea con su resultado y su tiempo
  como etiquetas; los nombres de herramientas son legibles, con el servidor
  MCP en su propia etiqueta; un paso que abriste queda abierto mientras
  llegan eventos nuevos; y se muestra la corrida entera, no sus primeros 60
  pasos.
- **Borrar una oficina ahora es "Destruir oficina"**, con una confirmación más
  clara y una demolición en el mundo 3D.
- **El escritorio del chief queda más lejos de la pared del fondo.**
- **Chatear con un agente ya no pasa su respuesta por sus cadenas**, y el
  tráfico de las cadenas queda fuera del chat. Las respuestas guardadas en
  memoria ya no se cortan a los 2.000 caracteres, y los chips de sugerencias
  debajo del chat ya no están.

### Corregido

- Pegar la redirección de un login de Claude Code en Docker siempre se
  rechazaba: el CLI escuchaba en `::1` mientras el kernel llamaba a
  `127.0.0.1`. Ahora se prueban los dos.
- `services/kernel/package-lock.json` se había quedado atrás de
  `package.json` (le faltaba `mammoth`), lo que habría roto el `npm ci` del
  build de release.
## [0.4.0] - 2026-10-04

### Actualizar desde 0.3.2

- **Sin `TIMEZONE`, el kernel ahora usa la zona horaria de esta máquina**, no
  UTC. En una Mac es tu propia zona; en un contenedor sigue siendo UTC. Esto
  mueve más que el "hoy": **los agentes programados corren a esa hora local**
  (un agente configurado en `0 8 * * *` corría a las 08:00 UTC y ahora corre a
  las 08:00 tuyas). Poné `TIMEZONE=UTC` si querés el comportamiento anterior.
- **Las horas de recordatorios y eventos sin zona son hora local.**
  `2026-03-01T09:00` antes no significaba nada concreto (los recordatorios lo
  comparaban como si fuera UTC); ahora es las 09:00 en `TIMEZONE`. Los
  recordatorios y eventos existentes guardados así se reescriben como
  instantes UTC en el primer arranque, interpretados de la misma manera. Las
  horas con `Z` o con offset no cambian.
- **Configurá `KERNEL_ENCRYPTION_KEY` antes de actualizar si usás conexiones
  de GitHub, GitLab o Gitea, y no la pierdas.** Sus tokens y las claves
  privadas de las GitHub Apps se guardaban en texto plano; con una clave
  configurada se cifran en el primer arranque. Si después cambiás o perdés la
  clave, quedan ilegibles: tenés que volver a agregar la conexión. Sin clave
  quedan como estaban.
- **Crear un contacto con un teléfono o email que ya existe lo fusiona con
  ese contacto** en vez de agregar un duplicado, por cualquier camino (tool,
  RPC, HTTP): ahora pasa por el mismo servicio que la tool MCP.
- **Borrar una tarea por HTTP ahora es un borrado lógico**, igual que en todos
  lados; una tarea borrada ya no aparece en la lista del dashboard.
- **El email entrante (`POST /api/comms/inbound`) necesita
  `COMMS_INBOUND_TOKEN`**, enviado en el header `X-Inbound-Token`. Un relay
  que mandaba `?token=` o que dependía de que el token no estuviera
  configurado deja de entregar hasta que lo actualices.
- **Un body de request vacío o mal formado da 400** (413 si pasa los 10 MB) en
  la API HTTP, donde la mayoría de las rutas respondían 500. Algunos mensajes
  de 500 ahora dicen `Error: …`.
- **Issues ya no existe.** La página de Issues, su pestaña en el menú Work, su
  extensión y las tools `kernel_issues_*` se sacaron del core. Los agentes o
  scripts que llamaban a esas tools dejan de encontrarlas. Los issues
  sincronizados quedan en la base, intactos, pero ya nada los lee.
- **El stack de Docker ahora levanta por defecto el motor de tiempo real
  (`mtw-request`) y el bridge de WhatsApp.** Ya no necesitan
  `--profile torrents`, y `BRIDGE_ENABLED` y `RUST_BRIDGE_ENABLED` vienen en
  `true` por defecto. Un `docker compose up` pelado baja dos imágenes más y
  crea los volúmenes `mtw-torrents`, `mtw-whatsapp-sock` y
  `mtw-whatsapp-data`. Las descargas de torrents ahora viven en un volumen,
  así que recrear el contenedor las conserva. Poné las dos variables en
  `false` para quedarte con el stack anterior, solo con el kernel.
- **Las carpetas del host pasaron a un overlay opcional,
  `docker-compose.host.yml`.** El `docker-compose.yml` por defecto ya no monta
  carpetas del host en el kernel (antes montaba una ruta fija). Si navegás una
  carpeta del host con el Filesystem Commander, o corrés agentes
  `claude_code` con tu login de Claude Code (ahora montado en
  lectura-escritura para que el CLI pueda renovar su sesión), configurá
  `KERNL_FS_ROOT` en `.env` y agregá `-f docker-compose.host.yml` a cada
  comando `docker compose` del stack. `HOST_HOME` ahora toma por defecto tu
  `$HOME`.
- **La voz está activada salvo que pongas `VOICE_ENABLED=false`.** Los motores
  por defecto son locales y gratis (whisper.cpp para escuchar, Piper para
  hablar). Las variables viejas siguen andando:
  `VOICE_STT_PROVIDER=local-whisper` significa whisper.cpp, y
  `VOICE_TTS_PROVIDER=system` pasa a ser `auto`. La voz de Piper en español
  (unos 110 MB) se descarga en el volumen de datos la primera vez que se usa.
- **Si elegís para un agente de Claude Code un modelo que no es de Claude, el
  agente pasa al executor propio del kernel.** Antes la elección se guardaba
  pero nunca se usaba, y cada corrida fallaba en su primer turno.

### Agregado

- **ECC como fuente de skills por defecto.** El catálogo del marketplace
  ahora se suscribe a [affaan-m/ECC](https://github.com/affaan-m/ECC) (MIT,
  ~290 skills), fijado en `v2.2.1`. Solo se agrega la suscripción: no se
  instala ninguna skill. Se agrega una vez por base de datos, así que si te
  desuscribís, queda así. El catálogo se llena en la próxima sincronización
  de repos (cada 6 horas, o con "Sync" en el marketplace).
- **El canal del agente principal corre con cualquier modelo conectado**, con
  un selector de modelo en su encabezado; los proveedores sin sesión siguen
  en el menú, atenuados, con el motivo.
- **El progreso de la actualización se ve en el banner**, no solo en
  Settings → About.
- **La búsqueda de trabajo es una extensión** (`automation/job-hunter`),
  instalada y activa por defecto; sus handlers conservan los nombres, así que
  los agentes existentes siguen andando.
- **El dashboard abre en el mundo 3D**, que aparece antes que Offices. Una
  nueva pestaña Offices al lado lista todas las oficinas con su estado. Pasar
  de una a otra no recarga el mundo.
- **Las extensiones pueden sumar sus propios edificios al mundo 3D.** Una
  extensión que declara un world plugin (incluidas las pagas) recibe un lote
  en el terreno y dibuja ahí su edificio.
- **Las oficinas nuevas se construyen en lotes fijos.** Crear, agrandar o
  borrar una oficina nunca mueve otra. Los lotes libres muestran un cartel de
  "Lote disponible", y al hacer clic en uno se abre el asistente de nueva
  oficina. Una oficina creada con el mundo abierto se construye en pantalla:
  una cuadrilla levanta las paredes y después los agentes llegan a sus
  escritorios. Podés saltear la animación.
- **Proyectos.** Una oficina puede atender varios productos o negocios. Las
  corridas, la memoria, los aprendizajes, las cartas y las programaciones
  pertenecen a un proyecto. En una corrida de proyecto, las tools que publican
  o envían algo escriben en cambio un borrador en una bandeja de salida, y no
  sale nada hasta que lo aprobás. Los borradores aprobados salen por email,
  newsletter, WhatsApp o LinkedIn. Se respetan las marcas de no contactar y
  los links de desuscripción. Un proyecto puede conectar sus propios datos
  con un pull de snapshot y webhooks firmados
  (`docs/project-connector-v1.md`). Las aprobaciones pendientes se ven en el
  resumen de Work.
- **Los agentes pueden buscar negocios en Google Maps** una vez que guardás
  una API key de Google Places en Settings → Integrations.
- **Hablale al Chief.** Un botón de micrófono en el chat y en el canal del
  Chief, con respuestas habladas que podés activar, más notas de voz en
  Telegram. El reconocimiento de voz y la voz se configuran en Settings → AI
  → Voice, con una prueba de micrófono. El reconocimiento puede usar
  whisper.cpp, Groq u OpenAI; la voz puede ser Piper, OpenAI o ElevenLabs.
- **Conectá un buzón desde Settings o desde el asistente de configuración.**
  El proveedor se detecta a partir de la dirección, IMAP y SMTP se prueban
  antes de guardar, y la tarjeta te guía con las contraseñas de aplicación
  cuando el proveedor las pide. Las cuentas conectadas se listan con el
  estado de sincronización y la cantidad de no leídos, y cada una enlaza a su
  buzón.
- **Correo IMAP en la vista de mail.** Los mensajes se decodifican, los
  cuerpos HTML se muestran con las imágenes remotas bloqueadas, y cada cuenta
  muestra su estado de sincronización. Las cuentas de Gmail se dividen en las
  pestañas Principal, Notificaciones, Promociones, Social y Foros.
- **La clasificación y el análisis de mail pueden correr en un proveedor
  elegido** (`comms.llm.provider`, opcionalmente `comms.llm.model`). Si ese
  proveedor falla o está desconectado, toma la posta la cadena por defecto.
- **Vinculá WhatsApp desde Settings o desde el asistente de configuración**
  con un código QR o un código de teléfono. La sesión sobrevive a las
  actualizaciones, así que no te va a pedir que escanees el QR de nuevo.
- **Los paquetes nativos traen el motor de tiempo real y el bridge de
  WhatsApp.** Las instalaciones de Linux, macOS y Windows (MSI y zip) los
  supervisan como sidecars; en Windows se comunican por named pipes.
- **Uso de tokens por modelo, por llamador y por día** en Settings → AI →
  Token usage. Se cuenta cada llamada a un modelo, incluidas las de la
  suscripción de Claude Code y las corridas de agentes, que antes no se
  contaban. Los modelos cuyo proveedor no informa costo se valúan con la
  tabla de precios de LiteLLM.
- **Las corridas de agentes interrumpidas se retoman.** Una corrida cortada
  por un reinicio sigue desde donde quedó. Las llamadas a tools cuyo
  resultado se perdió nunca se repiten; al agente se le avisa que su
  resultado es desconocido. Las corridas más viejas se pueden retomar a mano
  (`kernel_agents_resume`). Los reintentos automáticos tienen tope
  (`KERNEL_AGENT_RESUME_WINDOW_MS`, `KERNEL_AGENT_MAX_AUTO_RESUMES`), así que
  una corrida que tira el kernel no puede tirarlo en cada arranque. Las
  corridas también registran condiciones (modelo listo, interrumpida,
  retomada, abortada) con un motivo.
- **Workspaces de oficina declarativos.** Una oficina puede declarar qué
  tiene que haber en su carpeta: repos de git para clonar, archivos para
  sembrar, y los servidores MCP y las skills que comparten sus agentes de
  Claude Code (`kernel_agents_workspace_apply`). Antes de cada corrida la
  carpeta se pone al día con esa especificación. Los checkouts existentes
  nunca se resetean, y una corrida cuya carpeta no se puede preparar falla
  con el motivo.
- **Los agentes de una oficina pueden consultarle al Chief.** El Chief
  responde lo que puede y te pasa el resto en My Office. Los agentes que no
  responden cuando un colega les escribe se vuelven a despertar hasta que
  acusan recibo de la carta.
- **La oficina del Chief muestra lo que te necesita.** Las fallas se agrupan
  y se explican, y las resueltas quedan marcadas. Cada una se puede arreglar
  con un clic o pasársela al Chief. Lo que descartás queda recordado.
- **El Chief puede reportar bugs del propio Kernl.** Los bugs aparecen en una
  pestaña de My Office con el contexto de la corrida censurado. Un bug se
  convierte en issue de GitHub solo después de que lo aprobás.
- **Los pedidos de permiso de tools se muestran en línea** en el canal del
  Chief y en el chat, con "Permitir todo" para el resto de la sesión.
- **Un panel de agente rediseñado.** Las pestañas Overview y Settings quedan
  bajo un encabezado de una línea. El modelo se cambia desde un chip en el
  encabezado. Correr y frenar usan el mismo botón, y la programación es un
  switch de encendido/apagado. El mandato se abre por defecto, renderizado
  como markdown. Al pasar el mouse sobre una skill se explica qué hace,
  traducido por el modelo externo más barato.
- **Pestañas LIVE e HISTORY legibles.** Cada paso muestra la llamada al lado
  de su resultado, y cada fila se abre con el detalle completo. Las llamadas
  idénticas repetidas se agrupan en una sola entrada "×N", y las fallidas
  quedan marcadas. Cuando un agente actúa sobre otro agente, el paso se
  muestra como una tarjeta con el destinatario y el resultado.
- **El mundo 3D cobra vida.** Las cartas entre colegas vuelan de escritorio
  en escritorio. Los comandos del Chief nombran al agente al que apuntan.
  Al hacer clic en una mesa de reunión se ve en qué están trabajando los dos
  agentes que están ahí.
- **Cambios visuales en el mundo 3D.** Hay una capa opcional de realismo
  fotográfico. Se rediseñaron la recepción, la sede central y la oficina de
  DevOps, el lobby tiene alfombra mate, y los agentes entran por la puerta.
  Las placas de los racks de DevOps abren el repo.
- **El resumen de Social muestra lo que necesita atención** en mail,
  contactos e IRC. Su menú queda solo con Overview, Mail, Contacts e IRC.
- **La configuración de las extensiones puede ofrecer las cuentas de mail de
  Kernl** como opciones.
- **Una compra pendiente en la tienda se puede retomar o cancelar.** Antes,
  cerrar la pestaña de Stripe dejaba la tarjeta en "Esperando el pago" hasta
  24 horas.
- **La licencia va primero en Settings.** Una licencia pegada se guarda en un
  solo paso, y se acepta una licencia copiada de un email en el que los
  saltos de línea se convirtieron en espacios.
- **Los chats nuevos arrancan con el último modelo que elegiste en un chat.**

### Corregido

- **Un proveedor sin cuota podía cortar el fallback al siguiente.** Cuando no
  se podía escribir la tabla que recuerda los proveedores agotados, el error
  se escapaba y la corrida fallaba en vez de seguir; ahora esa escritura es
  best effort y el fallback continúa.
- **No se podía conectar Claude Code desde la app de macOS.** El .dmg no
  traía el CLI `claude`, así que el paso de inicio de sesión mostraba un
  `claude` pelado que respondía "command not found", y no había forma de usar
  una suscripción Pro o Max. Ahora el CLI viene dentro de la app, como ya
  pasaba en Windows, y el comando de inicio de sesión, el proveedor del chat
  y los agentes corren todos el mismo binario.
- **Se perdían las respuestas largas en Discord y Telegram.** Las plataformas
  rechazan un mensaje de más de 2000 / 4096 caracteres y nada lo partía;
  ahora las respuestas se dividen en límites de párrafo, línea o palabra,
  dejando intactos los bloques de código.
- **Las páginas de extensiones perdían el texto del contenido sanitizado**
  (ítems de RSS, noticias, cuerpos e hilos de email): el sanitizador
  compartido eliminaba los nodos de texto.
- **Una escritura lenta del dashboard podía ejecutarse dos veces.** Cuando el
  WebSocket andaba lento, el dashboard también mandaba el request por HTTP,
  así que un "Run", "Create" o "Publish" lento podía ejecutarse dos veces.
  Ahora las escrituras van por un solo camino, y un error que respondió el
  kernel no se reintenta.
- **Los dos caminos del dashboard respondían distinto.** Cada acción
  accesible por RPC sobre WebSocket y por HTTP ahora corre una sola función.
  Entre lo que eso arregló: "Run now" por WebSocket dejaba `{{event.*}}` en
  el objetivo y se salteaba el circuit breaker; las actualizaciones de
  agentes por WebSocket perdían campos como wake-on-inbox; el chat por
  WebSocket perdía los adjuntos; los feeds de las columnas de noticias y el
  mapa de arquitectura nunca anduvieron por WebSocket; las fallas se
  mostraban como éxito.
- **La búsqueda de alimentos fallaba siempre** (nutrición, incluida la tool
  MCP).
- **Otros arreglos encontrados durante la unificación:** un feed RSS no se
  podía desactivar por WebSocket; las acciones de la página de entrenamiento
  nunca llegaban al kernel por WebSocket; quitar un ítem de la lista de
  compras por HTTP respondía 404; borrar un contacto con interacciones
  fallaba; crear un recurso de aprendizaje sin todos los campos fallaba; un
  `#tag` en la búsqueda de notas era un error de sintaxis; una transacción de
  finanzas guardaba un monto con signo pero movía el saldo por su valor
  absoluto; `GET /api/agents/:id/memory` ignoraba `?limit=`; revocar el
  inicio de sesión de un servidor MCP nunca hacía nada; el fallback del
  estado de Google consultaba el endpoint equivocado.
- **Un borrador de oficina que no pasa la validación tiene un intento de
  reparación**, y el error nombra al modelo que falló.
- **"Hoy" era el día UTC.** En UTC-3 pasaba a ser mañana a las 21:00: el
  briefing de la mañana, las tareas que vencen hoy y las vencidas, el
  calendario, la agenda, los conteos de "completadas hoy" y la fecha que se
  les informa a los agentes cambiaban antes de tiempo, y un evento o
  recordatorio de la noche aparecía en el día siguiente. Ahora cada límite de
  día sigue a `TIMEZONE`, y las horas en briefings y notificaciones se
  muestran en esa zona.
- **Un recordatorio diario o semanal se corría una hora en cada cambio de
  horario de verano**; ahora mantiene su hora local. `/remind … at 9am`
  significaba las 09:00 en la zona del servidor (UTC en un contenedor); ahora
  significa en la tuya.
- **Un recordatorio que vencía más temprano hoy no contaba como vencido** en
  `/status` ni en los briefings hasta el día siguiente (su hora se comparaba
  como texto contra un "ahora" con otro formato).
- **Listar eventos hasta una fecha dejaba afuera los eventos de ese día.**
- **Una migración que fallaba a la mitad quedaba aplicada a medias**, sin
  registrarse, y volvía a correr en el próximo arranque sobre el esquema
  parcial. Ahora cada migración se aplica entera o no se aplica.
- **Las tools aceptaban cualquier `limit`.** 37 tools pasaban un `limit` sin
  tope directo a SQL; ahora tiene un tope por tool (un valor mayor se
  recorta, no se rechaza). Los argumentos de tools con valor por defecto ya
  no figuran como obligatorios, y los argumentos `.optional().default()` se
  publican con su tipo real.
- **System → Processes decía siempre "System registry not available".** La
  página nunca se suscribía al canal que lee, y el canal no incluía el flag
  `available` que la página espera.
- **La página de una campaña no mostraba destinatarios**; ahora lista cada uno
  con su estado y error, y cuenta enviados, fallidos y pendientes.
- **La configuración de los canales se abría vacía.** Los formularios de
  WhatsApp y de canal genérico leían un campo que nadie mandaba; ahora
  muestran la configuración guardada, con los campos de contraseña
  enmascarados.
- **Crear, pausar o cancelar una suscripción podía no hacer nada sin
  avisar** cuando la conexión en vivo estaba caída; ahora cae a HTTP.
- **Una corrida que fallaba antes de arrancar quedaba "activa" para siempre**
  (sin tools, sin proveedor utilizable): ahora siempre se saca de las
  corridas activas.
- **El reset de rate limit de `750ms` de un proveedor se leía como 750
  minutos**, y por eso esperaba el tope de 15 segundos. Ahora se entienden
  milisegundos y horas.
- **Las credenciales de Google guardadas desde el dashboard nunca se leían**,
  así que vincular Gmail siempre decía "credentials not configured". Ahora la
  configuración guardada se aplica al arrancar, antes de que inicie cualquier
  módulo, y guardar tiene efecto sin reiniciar. Las variables de entorno
  reales siguen teniendo prioridad.
- **La clasificación de emails fallaba en cada lote con modelos de
  razonamiento.** Se quedaban sin tokens a mitad del razonamiento, o un
  corchete en su razonamiento rompía el parseo.
- **La bandeja de mail se quedaba en "Loading"** después de elegir una
  cuenta. Una acción que la conexión en vivo no conoce ahora cae a HTTP.
- **Una licencia rechazada reemplazaba a la que funcionaba.** Ahora la
  licencia actual sigue activa cuando se rechaza una pegada.
- **El resultado de una tool podía quedar etiquetado con la tool
  equivocada** cuando un turno hacía dos llamadas (por ejemplo, una
  actualización de agente mostrada como salida de ToolSearch).
- **El lanzador portable de Linux fallaba cuando se iniciaba a través de un
  symlink en el `PATH`.**
- **Un agente abierto en la pestaña History desde un link no mostraba
  corridas.**
- **El Chief se reportaba a sí mismo**, entrando a My Office para entregar su
  propio reporte.
- **Los eventos en vivo de los agentes se mostraban dos veces**, y en el
  mundo 3D se podían dejar dos paquetes en el mismo lugar.

### Seguridad

- **Una tool de workspace ya no toma la oficina del llamador de un
  argumento.** Un `flow_id` explícito pisaba la identidad del llamador, así
  que cualquier agente podía llegar a los workspaces privados de otra
  oficina. Los agentes CLI, cuya identidad llega con el request, ahora
  también reciben su propia oficina.
- **Los adjuntos y los streams de chat respondían
  `Access-Control-Allow-Origin: *`.** Ahora siguen la allow-list de CORS
  opcional del servidor. Los adjuntos HTML y SVG se descargan en vez de
  renderizarse en línea desde el origen del kernel.
- **Las credenciales de las forjas se cifran en reposo** (ver Actualizar).
  Una conexión cuyas credenciales no puede abrir la clave actual se marca
  como ilegible, lo indica en su prueba y en el listado, y nunca se envía a
  la forja.
- **`POST /api/comms/inbound` fallaba abierto.** Sin `COMMS_INBOUND_TOKEN`
  aceptaba cualquier email; ahora responde 503 hasta que se configura el
  token, lo acepta solo en el header `X-Inbound-Token` (ya no en `?token=`),
  y lo compara en tiempo constante.
- **Las API keys, tokens y cookies de Twitter/X se mandaban al dashboard** en
  cada listado de cuentas. Ahora van enmascarados; si dejás una credencial en
  blanco al editar, se conserva la guardada. La configuración de los canales
  enmascara sus secretos de la misma forma.
- **Las actualizaciones de comms escribían cualquier columna que nombrara el
  llamador.** Ahora el servicio aplica su propia allow-list de columnas.
- **El sandbox de Docker falla cerrado.** Se rechaza una allowlist de salida o
  un nombre de red inválido; antes, dejaba la red abierta sin avisar. Los
  procesos de agentes en sandbox ya no heredan el entorno ni los secretos
  del kernel.
- **Las especificaciones de workspace rechazan entradas inseguras.** Se
  rechazan las rutas fuera del workspace, y las URLs de repos o branches que
  git podría interpretar como opciones.
- **`/api/comms/unsubscribe/` es accesible sin el token de la API**, porque la
  gente que hace clic en los links de desuscripción no lo tiene.

### Cambiado

- Una gran reestructuración interna sin cambios de comportamiento buscados
  más allá de lo anterior: un único helper de rutas HTTP, una operación por
  acción del dashboard, tools tipadas y factories de módulos en el SDK de
  extensiones, plomería compartida de canales y forjas, el executor de
  agentes dividido en fases, un único loop de reintento y fallback en la capa
  de LLM, una única librería de frontend compartida por el dashboard y las
  páginas de extensiones, fuentes de calendario aportadas por los módulos
  dueños de cada una, y entry points de extensiones generados.

### Eliminado

- **Issues** (página, extensión, tools) y la página de analytics de contactos
  que no se usaba. Ver Actualizar.

## [0.3.2] - 2026-09-18

### Agregado

- **Conectá cualquier proveedor de LLM desde una sola pantalla.**
- **Las extensiones importan el kernel desde un SDK versionado**, y leen las
  credenciales a través de él.

### Corregido

- Un nombre de modelo inválido ya no tira abajo a todo un proveedor.
- Los assets del catálogo de proveedores vienen con la instalación.
- El pie del asistente de configuración ya no queda debajo de los estilos de
  la barra lateral.
- Una actualización solo se entrega a un helper que realmente arrancó.
- Los procesos huérfanos del contenedor del kernel se recolectan.
- Las corridas viejas de agentes vuelven a podarse (se siembra el agente Data
  Cleanup), y el dashboard de agentes deja de escanear `agent_runs`.
- archive.org: las corridas de ingesta se cierran cuando su cursor deja de
  avanzar, a la API de scrape se le piden al menos 100 filas, y los índices
  del catálogo se reconstruyen solo cuando llegan títulos nuevos, como mucho
  una vez por hora durante un backfill.
- El visor de emails enviados se cierra con Escape.
- Los errores se loguean con su mensaje y su stack en vez de `{}`.

## [0.3.1] - 2026-09-13

### Actualizar desde 0.3.0 o anterior

- **Instalá esta versión a mano una vez.** Los arreglos de abajo están en el
  actualizador, y una copia instalada se actualiza con el actualizador que ya
  tiene, que es justamente el que no puede. En Windows corré el MSI nuevo (o
  descomprimilo encima de la copia portable), en macOS abrí el dmg nuevo, en
  Linux volvé a correr `install.sh`. Todas las actualizaciones siguientes se
  hacen desde el botón "Update now".

### Agregado

- **Reiniciá Kernl desde el dashboard** (Settings → About). Lo relanza de la
  misma forma en que se inició la instalación (start.bat, la .app, la unidad
  de systemd, la política de reinicio del contenedor), así que una extensión
  actualizada toma efecto sin cerrar una ventana de consola ni andar buscando
  un acceso directo. `POST /api/update/restart` hace lo mismo.

### Corregido

- **Todas las páginas de extensiones salían en blanco en Windows.**
  `/ext-assets` verificaba la contención con `startsWith(dir + "/")`, que
  nunca coincide con una ruta con barras invertidas, así que Cinema y todas
  las demás páginas de extensiones respondían 404. Ahora todas las jaulas de
  rutas del kernel, las extensiones y el dashboard comparan a través de
  `relative()`, sin distinguir mayúsculas en Windows, y el smoke test del
  release de Windows pide una página de extensión.
- **Los subtítulos offline fallaban en una PC sin el runtime de Visual C++.**
  whisper-cli y onnxruntime importan MSVCP140, VCRUNTIME140 y VCOMP140; los
  paquetes de Windows los llevan al lado de los binarios, y el release falla
  si faltan.
- **Cinema en Windows:** los videos convertidos se reproducían en negro
  (`/api/cinema/media/convert/file` respondía 401), whisper abortaba con un
  nombre de perfil con tildes, una descarga de modelo interrumpida dejaba un
  modelo truncado al que se le confiaba para siempre, y una extracción
  fallida dejaba su WAV en la carpeta temporal.
- **Los paquetes de extensiones no se resolvían para usuarios comunes de
  Windows.** El link del payload era un symlink de directorio, que necesita
  permisos de administrador; ahora es una junction.
- **Claude Code en Windows.** El CLI se encuentra sin `which`; las tools del
  kernel llegan al chat y a los agentes por HTTP con el token de la API en
  vez de un socket Unix bajo `/tmp`; las reglas de permisos de los agentes
  usan la forma absoluta `//path` (una sola barra inicial ancla en el origen
  de la configuración y nunca coincidía en ninguna plataforma), y los
  agentes Docker usan el bridge stdio que realmente se distribuye.
- **Tools y rutas solo POSIX en Windows:** exec y búsqueda de repos,
  instalaciones de plugins desde zip, el workspace evolver, las copias
  remotas del filesystem-commander y su guarda que impide borrar una raíz,
  los escaneos de seguridad fuera de la carpeta de datos, el mensaje del
  certificado de IRC, el bloqueo de `data/` de `kernel_code_read`, `HOME`,
  el frontmatter con CRLF, `tar` tomado del PATH, y una ventana de consola
  cerrada que se salteaba el apagado limpio.
- **El dashboard rechazaba rutas de Windows** en Filesystem, Workspace, el
  registro de repos, Files y la página de licencia, y mostraba ⌘K en
  teclados sin tecla ⌘.
- **Las actualizaciones de extensiones** toman un lock por extensión,
  actualizan las extensiones incluidas en la carpeta de datos en vez de la
  carpeta de instalación, sobreviven a una carpeta que Windows mantiene
  bloqueada, y ya no borran la copia distribuida al desinstalar.
- **Los agentes en sandbox sobre un stack con volúmenes con nombre escribían
  en un `/workspace` vacío** y perdían sus archivos con el contenedor. El
  workspace se monta desde el volumen de datos, y el panel del agente
  muestra la carpeta de oficina en la que el agente corre de verdad.
- **macOS nunca podía actualizarse desde la app.** El bundle se buscaba dos
  carpetas arriba de `Contents/Resources` y después se exigía que terminara
  en `.app/Contents`, cosa que nunca pasa, así que cada intento se rechazaba
  con "could not work out which directory to replace". El chequeo siguiente
  verificaba la firma de la app ya instalada en vez de la descargada, y
  rechazaba porque los releases todavía no están firmados. Ahora se verifica
  el bundle descargado: una firma rota se rechaza, y un build sin firmar se
  instala sacándole el atributo de cuarentena. Una app que corre
  traslocada desde Descargas, desde la imagen de disco o desde una carpeta en
  la que la cuenta no puede escribir lo avisa antes de descargar nada.
- **Las instalaciones por paquete se actualizan desde la app.** El .deb o
  .rpm se descarga, se verifica y se instala con el pedido de administrador
  del escritorio (pkexec), y después Kernl se reinicia por systemd, o se
  relanza si se había iniciado a mano. Sin pkexec, el mensaje es el comando
  de instalación exacto para el archivo ya descargado. Antes sugería
  `apt upgrade kernl`, que no hace nada: ningún repositorio publica Kernl.
- **Una actualización fallida dejaba Kernl sin correr.** El kernel sale antes
  de que el helper cambie nada, y cada falla en el helper (una carpeta que no
  podía mover, msiexec fallando, un aviso de UAC rechazado) simplemente
  terminaba. Ahora cualquier salida vuelve a iniciar Kernl, y registra lo
  que pasó para el próximo arranque.
- **Una actualización que instalaba una versión que no arranca era
  definitiva.** El helper conserva la copia anterior hasta que la versión
  nueva responde en `/api/health`, y la vuelve a poner si no lo hace en
  cinco minutos.
- **El dashboard nunca decía si una actualización había funcionado.**
  Mostraba "restarting, this page will reconnect" y dejaba de escuchar;
  perder contacto a mitad de la descarga también se leía como éxito. Ahora
  espera a que Kernl vuelva y dice "now on vX", o qué salió mal.
- **Otras cuentas de Windows no podían actualizar una instalación MSI.** La
  marca del MSI vivía en el HKCU del usuario que instaló, así que cualquier
  otra cuenta veía una copia descomprimida e intentaba mover Program Files.
  El instalador escribe una marca en HKLM con la carpeta de instalación, y
  una copia bajo Program Files nunca se intercambia.
- **El "éxito, requiere reinicio" (3010) de msiexec contaba como falla.**
- **Instalar un rc y después su build final dejaba dos entradas en Agregar o
  quitar programas**, porque las dos tienen la misma versión de MSI.
- **El helper de Windows confiaba en el `find` y el `tar` que aparecieran
  primero en el PATH.** El find de GNU de Git for Windows terminaba el loop
  de espera de inmediato, así que el intercambio corría con el kernel todavía
  vivo. Las herramientas del sistema se llaman desde System32 con la ruta
  completa, y los movimientos se reintentan mientras Windows mantiene
  bloqueado un archivo recién cerrado.
- **Salir para actualizar se salteaba el apagado propio del kernel** y dejaba
  whisper, ffmpeg y otros procesos hijos reteniendo archivos en la carpeta de
  instalación. Ahora se frenan primero, y el kernel cierra con su apagado
  normal.
- **Una copia portable de Linux podía borrar su propia base de datos al
  actualizarse.** Si se iniciaba desde adentro de la carpeta extraída, Kernl
  guardaba `data/` ahí, y la actualización reemplaza esa carpeta. El tarball
  trae un lanzador `kernl` que guarda los datos en `~/.local/share/kernl`, y
  el actualizador se niega mientras haya datos dentro de la instalación.
- **Cada actualización exitosa dejaba su descarga tirada**, al lado de la
  instalación o en la carpeta temporal. El próximo arranque la borra.
- **Docker ofrecía un botón "Update now" que solo podía negarse.** Ahora
  muestra el comando de rebuild.
- **Una copia portable podía informar la versión de un package.json que no
  tenía nada que ver.** La búsqueda arrancaba tres carpetas arriba, que para
  un tarball bajo `~/apps` es la carpeta home.
- **install.sh en macOS instalaba una segunda copia versionada en cada
  re-ejecución.** Ahora instala `Kernl.app`, igual que el dmg.

- **La actualización desde la app no podía funcionar en Windows, y lo decía
  recién después de negarse.** Una instalación se reconocía porque el código
  en ejecución estaba en un directorio `bin/`, la forma que produce
  `stage-payload.sh` y que traen el bundle de macOS y el tarball de Linux.
  Pero `build-zip.sh` y `build-msi.sh` copian los dos el kernel empaquetado a
  la RAÍZ del paquete, así que una instalación de Windows corre desde
  `C:\Program Files\Kernl` y se clasificaba como "not an installed copy". La
  única plataforma sin un gestor de paquetes detrás era la que nunca podía
  actualizarse.
- **Una instalación MSI ahora la actualiza el instalador de Windows, no
  moviendo su directorio.** Un intercambio bajo Program Files necesita
  permisos que este proceso no tiene, y aun donde funciona deja a Agregar o
  quitar programas anunciando una versión que ya no está en disco. La app
  descarga el MSI nuevo, lo verifica y se lo pasa a `msiexec /i /qb`: un solo
  aviso de UAC, el progreso del propio instalador, y el registro y el
  desinstalador sincronizados. Una copia portable se sigue intercambiando,
  que es lo correcto para un directorio que no es de nadie más.
- **El actualizador pedía nombres de assets que el release no publica.** Los
  armaba a mano: `Kernl-…-windows-x64.zip` contra un
  `kernl-…-windows-x64.zip` publicado. GitHub resuelve los nombres de assets
  sin distinguir mayúsculas, así que la descarga sobrevivía; la búsqueda del
  checksum, una comparación exacta de strings contra SHA256SUMS, no, y la
  actualización fallaba después de transferir 311 MB. Ahora el nombre sale
  de la API de releases, así que lo que se verifica y lo que se descarga son
  el mismo string por construcción.
- **El helper de Windows no podía dormir, así que nunca intercambiaba nada.**
  Usaba `timeout`, que sale de inmediato con "Input redirection is not
  supported" cuando stdin está redirigido, y el helper se lanza con su stdio
  ignorado. El loop de espera quemaba sus sesenta intentos en milisegundos y
  se rendía, y para ese momento el kernel ya había salido: app cerrada, sin
  actualización y sin relanzar.
- **Un primer movimiento fallido podía anidar la instalación nueva dentro de
  la vieja.** El movimiento que aparta la copia anterior no se verificaba, y
  `move` hacia un directorio existente mueve *adentro* de él, así que un
  movimiento denegado dejaba el árbol nuevo dentro de la instalación activa,
  informaba éxito, y borraba un backup que nunca se había hecho.
- **El relanzamiento apuntaba a un directorio.** Correcto para `open` sobre un
  bundle de macOS; en Windows corría `start "" "C:\Program Files\Kernl"`, que
  abre el Explorador, y en Linux intentaba ejecutar una carpeta. Windows
  relanza `start.bat`, el punto de entrada documentado que ya usa el acceso
  directo del menú Inicio, y la copia portable de Linux corre su runtime
  empaquetado contra su kernel empaquetado.
- **La actualización desde la app en Linux devolvía 404.** El tarball
  portable se construía y se subía como artefacto de CI, pero el release solo
  adjuntaba `Kernl-*-macos.tar.gz`, así que el archivo que descarga el
  actualizador nunca se publicaba.

- **Dos clics arrancaban dos actualizaciones.** Nada protegía el camino de
  aplicación, así que un segundo clic (o una segunda pestaña, o un reintento
  después de un timeout) empezaba otra descarga, escribía otro helper y
  armaba otro timer de salida, con los dos helpers compitiendo por mover el
  mismo directorio. El segundo encontraba la instalación ya desaparecida.
- **Una copia portable en otra unidad nunca se podía actualizar.** La
  descarga se preparaba en el directorio temporal del sistema, y `move` en
  Windows no puede mover un *directorio* entre volúmenes: con la app en D: y
  TEMP en C:, el helper esperaba a que el kernel saliera y después fallaba en
  el único paso que importa. Ahora la preparación se hace al lado de la
  instalación, lo que en Linux y macOS además convierte una copia entre
  dispositivos de varios cientos de megas en un rename.
- **Un MSI instalado fuera de Program Files se intercambiaba en vez de
  actualizarse.** `INSTALLDIR` lo puede cambiar el usuario, así que la
  pregunta "¿esta es una instalación de un instalador?" no se puede responder
  por la ruta. Ahora lee el valor del registro que `product.wxs` ya escribe,
  y solo cae a la ruta cuando no se puede leer para nada.
- **Cada intento fallido dejaba la descarga tirada.** Hasta trescientos megas
  por clic, en el directorio temporal, sin nada que alguna vez lo limpiara.
- **Verificar el checksum cargaba todo el archivo en memoria.** El archivo se
  leía de una sola vez para hashearlo: un pico de 311 MB encima de la copia
  que ya estaba en disco. Ahora se hashea por partes.
- **Nada tenía timeout.** Una conexión que se abría y después se quedaba
  callada dejaba la barra de progreso en "downloading" para siempre, sin
  botón de cancelar en ningún lado. Ahora una descarga que no recibe nada
  durante sesenta segundos se abandona y lo avisa, y las llamadas al host de
  releases se rinden a los quince.
- **Un momento sin conexión escondía un release durante seis horas.** El
  chequeo cacheaba las fallas con la misma vida de seis horas que las
  respuestas, así que un solo fetch inestable dejaba la UI callada el resto
  del día, y una UI callada es justo cuando a nadie se le ocurre apretar
  "Check for updates". Ahora una falla se guarda un minuto, y un rate limit
  de GitHub cinco, y se informa como lo que es en vez de como "offline".
- El chequeo de actualizaciones se identifica ante GitHub, que les pide eso a
  los llamadores y permite sesenta requests anónimos por hora por IP.

### Agregado

- Un test que compara los nombres de assets que pide el actualizador contra
  los nombres que publicó un release real. El test anterior comparaba el
  nombre armado a mano contra sí mismo, lo que pasa por más mal que esté ese
  nombre, y es la razón por la que todo lo anterior salió publicado.
- Tests para el chequeo de actualizaciones en sí, que no tenía ninguno a
  pesar de aceptar un fetch inyectable justamente para eso: el orden de
  versiones incluida la regla de prereleases, y qué le puede hacer una falla
  a la caché.

### Cambiado

- **`docs/ARCHITECTURE-MAP.md` ya no existe.** Su contenido ahora abre
  `docs/ARCHITECTURE.md`, que es adonde siempre iba a ir: los dos archivos
  describían el mismo sistema a dos profundidades y cada uno empezaba
  remitiendo al otro. Un link a la ruta vieja ya no va a resolver.
- Los manifiestos del dashboard y del escritorio llevan la versión del kernel
  en vez de quedarse en 0.1.0 mientras el kernel llegaba a 0.3.0, y
  `scripts/release.sh` los sube junto con él, así que un checkout ya no
  parece tres proyectos de tres edades distintas.
## [0.3.0] - 2026-09-08

Todo lo que define a un agente —su prompt, su runtime, sus herramientas, sus
skills, lo que lo despierta— estaba repartido entre un panel soldado al mundo
3D y un segundo panel, medio duplicado, en la página de agentes. Esta versión
lo junta todo en un solo cajón que montan las dos páginas, y después dedica la
mayoría de sus commits a completarlo.

### Agregado

- **El cajón del agente.** Un único panel, sacado del mundo 3D a su propio
  contenedor con su propio store, que también se monta en la página de
  agentes. Su árbol incluye el mandato, el objetivo por defecto, las
  herramientas permitidas, las variables, la apariencia y el runtime, que ahora
  se edita desde el mismo panel en vez de desde una página de configuración a
  tres clics de distancia.
- **Una pestaña de skills por agente** que recomienda, instala y asigna en un
  solo lugar. Las sugerencias se sirven por HTTP desde un núcleo de puntuación
  que se sacó del cron del sugeridor, y las skills del catálogo se puntúan junto
  con las que ya están instaladas, así que el ranking responde "qué debería
  aprender este agente ahora" y no "qué tiene ya".
- **Skills desde la URL de un repo**, que agregás sin salir de la pestaña.
- **Conexiones MCP desde el dashboard**: agregás un servidor, iniciás sesión y
  queda funcionando, sin editar un archivo de configuración ni reiniciar.
- **Actualización desde la app en Linux y Windows**, con progreso. macOS ya la
  tenía.
- **Un diagnóstico de las ejecuciones fallidas del agente**, arriba de todo en
  el panel, con cada falla asociada al control que realmente la arregla.
- **Las cadenas de modelos** se convierten entre la lista del panel y las
  columnas del agente.
- **La capacidad de tool loop** aparece en el estado del proveedor de LLM, así
  un proveedor que no puede manejar un tool loop lo avisa antes de que le
  apuntes un agente.
- **Mirá cómo dibuja la oficina creativa**, desde el cajón del agente.
- **Los builds de macOS salen firmados y notarizados, en el orden correcto.**
  Cada Mach-O anidado se firma antes que el bundle que lo sella, el `.app` se
  notariza y se le hace staple *antes* de entrar en la imagen de disco —así
  abre sin red— y el tarball portable se vuelve a armar a partir del bundle
  firmado en lugar del sin firmar que se había escrito minutos antes. Ahora el
  job falla cuando los seis secretos de Apple están cargados a medias, en vez
  de publicar una app firmada pero sin notarizar que Gatekeeper rechaza igual
  que a una sin firmar. Un release armado sin los secretos sale sin firmar,
  como antes, y lo dice.
- **Soporte del host para renderizado headless**, para el puente con Blender
  que viene como extensión. La imagen del kernel trae las bibliotecas que un
  render necesita sin pantalla —sobre todo libEGL, cuya ausencia mataba un job
  *después* de encolarlo y de armar la escena— y un frame renderizado se puede
  mostrar con `<img src>` a través de `?auth=`, que no puede mandar un header.
  La lista de permitidos sigue abarcando una sola ruta: el listado de jobs de
  al lado sigue rechazando un token en la URL.

### Cambiado

- **El dashboard abre con la sesión iniciada en todas las plataformas.** El
  traspaso del token andaba en una y en las demás te dejaba en una pantalla de
  login para una instancia que acababas de instalar vos mismo.
- **Conexiones, programación y disparadores por evento son una sola sección
  "disparo".** Eran tres lugares para responder una sola pregunta: qué arranca
  a este agente.
- El instalador de Windows incluye los SDK de agentes y de MCP, así que una
  instalación nueva de Windows puede correr un agente sin un toolchain aparte.
- La pestaña de skills se oculta para los agentes de script, que no pueden
  usar skills, y el cajón está traducido.
- El README arranca con la oficina de agentes y un contador de instancias en
  vivo.
- Se fue el panel duplicado de skills del agente.
- **El indicador de "pensando" vive en la etiqueta del propio agente.** Era un
  glifo ⚙️ girando sobre la cabeza del agente: a la distancia de la cámara de
  la oficina, un glifo que rota se ve como una mancha que vibra. Ahora son
  tres puntos que respiran en secuencia dentro de la placa con el nombre, en
  el color de flujo del agente.

### Corregido

- **El botón de actualizar de la tienda no actualizaba.** Informaba éxito.
- **Faltaban todas las herramientas `mcp__kernel__*` en una ejecución de
  `claude_code`.** La API HTTP del kernel es fail-closed y el servidor MCP le
  pegaba sin header Authorization, así que `/mcp` respondía 401 y el servidor
  nunca terminaba de inicializarse, en silencio. El agente arrancaba igual,
  encontraba solo sus herramientas integradas e improvisaba. Ahora presenta el
  token que el proceso ya tiene.
- **Una ejecución fallida dejaba el hilo del chat en silencio.** El panel
  recurría a la fila de la ejecución solo cuando el hilo no tenía ningún
  mensaje del agente, así que a partir de la segunda falla el error
  desaparecía por completo: el operador veía su propio mensaje, ninguna
  respuesta y ningún error. Ahora el motivo se persiste como lo hace el
  ejecutor nativo, y se muestra como una línea que nombra el control que
  realmente lo arregla: si se agotó el presupuesto de pasos, te dice qué
  ajuste lo mueve, en vez de "Reached maximum number of turns (15)".
- **Ninguna etiqueta de evento animada funcionaba.** El ícono nunca llevaba la
  clase de la que cuelgan sus keyframes, y los keyframes se referenciaban con
  un nombre que Svelte ya había reescrito, así que pulse, spin, shake, wobble,
  bounce, sparkle y pop no se habían reproducido ni una vez.
- Los argumentos de tipo array y objeto que un ejecutor había serializado como
  strings se recuperan, en vez de llegarle a la herramienta como
  `"[object Object]"`.
- La detección de re-autenticación de Google matcheaba errores del SDK de
  Claude Code y pedía volver a iniciar sesión sin arreglar nada; ahora matchea
  las firmas de error del propio kernel.
- La coerción de las cadenas de modelos convertía los valores que no eran
  string en `undefined` en lugar de strings, y ahora usa un centinela explícito
  de string vacío.
- El store del cajón: `seed()` desactualizado, rollback de patch por campo,
  campos en vuelo pisados cuando se volvía a sembrar el cajón, escrituras que
  no se conciliaban contra la fila guardada, y un listener de menú que se
  perdía en cada apertura.
- La clasificación del estado de las skills, cómo se muestra el costo
  desconocido y la tokenización de texto con acentos.
- Los controles de la cadena quedan deshabilitados mientras se escribe la
  cadena.

## [0.2.6] - 2026-08-23

### Agregado

- Los repos se asignan a agentes y se muestran en la UI; los entornos de
  oficina pasaron a DevOps.
- Montajes del sandbox de agentes, empaquetado de extensiones y listas en
  markdown.

### Corregido

- El proveedor de OpenAI, el selector de modelos y una compuerta de
  disponibilidad que era demasiado amplia.
- La traducción de subtítulos de Cinema reutiliza las transcripciones en caché
  y llega a nuestro propio puerto.

### Cambiado

- Dejamos de publicar imágenes de contenedor que nadie bajaba.

## [0.2.5] - 2026-08-22

### Agregado

- LM Studio se detecta solo, junto con el modelo que tiene cargado y la
  ventana de contexto real de ese modelo.
- Discover tiene un estante para extensiones y otro para skills.
- Una sección Acerca de en la configuración, con búsqueda de actualizaciones.

### Cambiado

- Los agentes pasan por las puertas, y cada uno lleva una sola etiqueta en la
  oficina.
- Los archivos `SKILL.md` de la comunidad se leen como los escribieron sus
  autores.
- Se prefieren los originales de Archive.org antes que el derivado Theora.

### Corregido

- Un comportamiento de diseño de un proveedor se informaba como una falla.
- El reproductor de música se llama por el nombre del producto.

## [0.2.4] - 2026-08-17

### Corregido

- El build de ffmpeg linkeaba las bibliotecas de Homebrew del runner, no podía
  linkear iconv y tomaba TLS del openssl de Homebrew en vez de SecureTransport,
  lo que generaba binarios que no corrían en una máquina limpia.
- La generación de subtítulos funciona en los paquetes nativos.
- Un módulo puede retirar un driver de agente cuyo upstream ya no existe.

### Cambiado

- Un bundle de whisper recompilado para macOS 13 y 14.
- Se fueron las páginas sueltas de Modelos y Proveedores de IA.

## [0.2.3] - 2026-08-15

### Agregado

- `scripts/release.sh`: la secuencia de release, que hasta ahora vivía en el
  historial del shell.
- Un script `reload:local` para el stack de docker-compose.yml.

### Corregido

- Los originales de Archive.org se reproducen, y ya no se inventan subtítulos
  para películas mudas.
- La ruta de push de Apple Health queda exenta de la compuerta del token
  maestro.
- En macOS, la PTY se toma prestada como la quiere el `script` de BSD.

### Cambiado

- La franja de "más como esto" en el reproductor de Cinema, rediseñada.
- El aviso de actualización salió de la columna de la barra lateral.

## [0.2.2] - 2026-08-14

### Corregido

- `ConfigService` se construía con argumentos que no recibe.
- Los binarios de sharp quedan fijados para cada plataforma en la que
  compilamos.

### Agregado

- El whisper con CUDA se compila cuando se aplica el overlay de GPU.
- El actualizador verifica lo que descarga y ofrece brew como alternativa.

## [0.2.1] - 2026-08-14

### Agregado

- La navegación está traducida en vez de mostrar el inglés del manifiesto, y
  las etiquetas de configuración y de navegación llevan un idioma.
- El kernel avisa cuando pausó un agente y cuando uno está esperando una
  respuesta.
- Cobertura E2E para el grupo de Torrents y los textos en español de TV.

### Corregido

- Una actualización que macOS rechazaría se rechaza primero acá, y se avisa
  antes del primer arranque.
- Todo resultado de una ejecución de agente se informa al circuit breaker;
  algunos no se informaban, así que el breaker nunca se abría.
- La descarga se resuelve a partir del release en vez de a partir de una
  plantilla.
- El binario de plataforma de sharp va en el payload, y los paquetes del
  payload siguen siendo resolubles desde una extensión materializada.
- El pipeline de subtítulos de Cinema apunta a las rutas propias de Cinema.
- El servidor de desarrollo se queda en loopback, igual que el dashboard al
  que reemplaza.

### Cambiado

- El scratchpad de razonamiento se muestra plegado en vez de impreso.
- "Configurar un proveedor" es un botón, no un párrafo.
- Una llamada a herramienta en el chat se puede leer y su resultado está a
  mano.

## [0.2.0] - 2026-08-14

### Seguridad

- **El stack de Docker por defecto ya no corre sin autenticación.**
  `docker-compose.yml` seteaba `KERNEL_ALLOW_UNAUTH=1`, con la justificación de
  que el dashboard se publicaba en 127.0.0.1. Loopback no es una frontera de
  confianza frente a un navegador: sumado a un `Access-Control-Allow-Origin`
  comodín en cada respuesta, cualquier página que el usuario tuviera abierta
  podía leer —y escribir— todo el kernel cross-origin, incluida la superficie
  de herramientas MCP. El inicio rápido ahora corre con el token que el kernel
  genera en el primer arranque.
- **CORS deniega por defecto.** `Access-Control-Allow-Origin` se manda solo
  para un origen listado explícitamente en `CORS_ALLOWED_ORIGINS`; una lista
  vacía significa solo mismo origen, que es lo que necesita el dashboard
  incluido. Antes, una lista vacía significaba `*`, y a un origen que no
  coincidía se le respondía con el primer origen configurado en vez de un
  rechazo.
- **La recuperación de licencias ya no reparte claves de licencia.**
  `GET /api/license/lookup` devolvía el JWT completo de la licencia —la
  credencial de descarga de cada extensión que tiene un cliente— a cualquiera
  que supiera su dirección de email, y su 404 confirmaba qué direcciones eran
  de clientes. Ahora manda la licencia por mail a la dirección registrada y
  responde 202 igual en los dos casos.
- **Torrents se valida en tiempo de ejecución.** La extensión paga salía sin
  ningún chequeo de licencia ni en sus herramientas MCP ni en sus rutas
  `/api/torrents/*`; lo único protegido era la descarga del bundle.
- El token de autenticación que se genera en el primer arranque se le pasa al
  navegador por el fragmento de la URL, que nunca se manda al servidor, en vez
  de por un query string.

### Corregido

- **Los backups copiaban la base equivocada, y lo decían muy contentos.**
  `backup.sh` copiaba el `./data/kernel.db` del repo —casi siempre un resto
  viejo— en vez de la base que está dentro del volumen de Docker, usaba `cp`
  sobre una base en modo WAL abierta por el kernel, y salía con 0 cuando no
  encontraba nada. Ahora hace el snapshot a través de SQLite (`VACUUM INTO`),
  verifica el resultado antes de llamarlo backup y falla con ruido. También
  copia `.kernel-encryption-key`, sin la cual los secretos cifrados de una base
  restaurada no se pueden recuperar.
- **Las restauraciones escribían donde nadie lee.** `restore.sh` copiaba la
  base al `./data` del repo incluso en despliegues con Docker, se salteaba la
  clave de cifrado e informaba "starting fresh" cuando el archivo no tenía
  base. Ahora exige un destino explícito `--docker` / `--native` y rechaza un
  archivo vacío.
- **Las licencias pagas se rechazaban en toda instalación que no fuera
  Docker.** El kernel esperaba un emisor `issuer.mtwkernel.com` mientras que
  las licencias las emite `issuer.lifekernl.com`, y solo `docker-compose.yml`
  seteaba el override, así que las instalaciones rpm, deb, dmg y msi no
  podían activar una clave válida.
- **La firma de código nunca corría, con o sin certificados.** Los pasos de
  firma del workflow de release estaban condicionados con `if: env.X != ''`,
  con `X` definida en el bloque `env:` del mismo paso, que no está al alcance
  de la condición de ese paso. Cada release publicaba artefactos sin firmar e
  informaba éxito.
- El kernel escuchaba en loopback aun con la autenticación activada:
  `loadConfig()` resolvía el bind antes de que el bootstrap generara el token
  de autenticación, y pisaba para siempre un `0.0.0.0` explícito. Ahora la
  decisión se toma donde ya se conoce el token final.
- El primer arranque de una instalación nativa terminaba en un callejón sin
  salida: una pantalla de login que pedía un token que al usuario nunca se le
  había mostrado. Ahora los lanzadores de macOS y Windows lo pasan; el de
  Linux imprime dónde encontrarlo.
- `docs/DEPLOYMENT.md` documentaba el backup de Neo4j contra un nombre de
  volumen que no existe, lo que hace que `docker run -v` cree uno vacío y no
  archive nada, con éxito.

## [0.1.1] - 2026-08-03

### Corregido

- Los paquetes nativos vuelven a servir el dashboard: la SPA preparada vive en
  `dashboard/`, que no coincidía con ninguno de los directorios estáticos
  candidatos, así que cada .deb, .rpm, .dmg y .msi devolvía 500 en `/`
  mientras la API respondía normalmente.
- RPM ya no genera dependencias contra el árbol vendorizado, y saca la
  dependencia de sqlite que bloqueaba los rebuilds en RHEL.
- Publicación de releases: mayúsculas en los artefactos, metadatos de
  licencia, guarda de tags, runner de macOS fijado y un chequeo de CI que
  mantiene los lockfiles de npm sincronizados con `package.json`; un desfasaje
  ahí fue lo que hizo que un release taggeado saliera sin ningún asset.

## [0.1.0] - 2026-07-29

Primera versión pública.

### Agregado

- ~290 herramientas MCP repartidas en más de 60 módulos autocontenidos (tareas,
  CRM, recordatorios, compras, hogar, eventos, finanzas, salud, entrenamiento,
  nutrición, agentes, chat y más)
- Dashboard web (SPA en SvelteKit) con más de 20 vistas
- Notificaciones multicanal (Telegram, Slack, Discord, WhatsApp, Mattermost,
  WebChat)
- Analítica de grafos con Neo4j (opcional) y algoritmos GDS
- Panel Life Intelligence (clima, AQI, luna, monedas, sismos)
- Agentes de IA con programación, disparadores y ciclos de feedback
- Chat cognitivo con memoria episódica y recuperación de contexto
- Sincronización con Google Contacts/Gmail
- Secretos cifrados (AES-256-GCM), autogenerados y persistidos en el primer
  arranque
- Filtro de PII para las llamadas a LLM
- Despliegue con Docker Compose (contenedores separados de frontend/backend)
- Paquetes multiplataforma: rpm, deb, dmg, msi y zip portable
- Pipeline de CI con GitHub Actions

### Seguridad

- Autenticación de la API con `KERNEL_AUTH_TOKEN`, generado y persistido si no
  está seteado
- CORS configurable con `CORS_ALLOWED_ORIGINS`
- Headers de seguridad (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- Rate limiting HTTP para llamadas no locales
- Protección contra SSRF en los fetch salientes controlados por el usuario
- Verificación de firma (RS256) de los bundles de extensiones pagas antes de
  instalarlos
