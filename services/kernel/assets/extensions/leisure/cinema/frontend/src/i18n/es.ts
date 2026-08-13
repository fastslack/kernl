/**
 * Spanish copy for the /cinema page chrome.
 *
 * Rioplatense, matching the rest of the dashboard: voseo ("buscá", "puntuá"),
 * angular quotes for titles, and no calques from the English — "watchlist" is
 * "mi lista", not "lista de seguimiento".
 *
 * Any key missing here falls back to en.ts rather than rendering the raw key.
 */
import type { Dict } from "$shared/i18n";

const es: Dict = {
  // ── Banda ① — identidad + acciones rápidas ─────────────────────
  "header.catalogue": "{n} títulos · catálogo local",
  "header.results": "{n} resultados para «{q}»",
  "header.watchlist": "tu lista · {n} guardadas",
  "header.loading": "cargando catálogo…",
  "nav.aria": "Secciones de cinema",
  "nav.watchlist": "mi lista",
  "nav.watchlist.hint": "Los títulos que guardaste con el botón de estrella",
  "nav.embeddings": "embeddings",
  "nav.embeddings.hint": "Estado del índice semántico — ver o lanzar el embedder",
  "nav.embeddings.running": "Indexando",
  "nav.directories": "directorios",
  "nav.directories.hint": "Directorios comunitarios federados vía Nostr",
  "nav.back": "volver al catálogo",

  // ── Banda ② — barra de comando ─────────────────────────────────
  "search.placeholder": "Buscá una película, o describí una — «cine mudo con vampiros»",
  "search.aria": "Buscar en el catálogo",
  "search.enter.hint": "Enter para buscar. Escribí #etiqueta para filtrar por etiqueta.",
  "search.clear": "Limpiar la búsqueda",
  "search.busy": "Buscando…",
  "filters.toggle": "Filtros",
  "filters.toggle.hint": "Año, idioma, tipo, duración, orden y contenido",
  "filters.toggle.count": "{n} filtros activos",
  "filters.open": "Mostrar los filtros",
  "filters.close": "Ocultar los filtros",

  // ── Panel de filtros ───────────────────────────────────────────
  "filters.aria": "Filtros del catálogo",
  "filters.year": "Año",
  "filters.year.from": "Desde",
  "filters.year.to": "Hasta",
  "filters.year.from.ph": "1888",
  "filters.year.to.ph": "2099",
  "filters.language": "Idioma",
  "filters.language.any": "Cualquier idioma",
  "filters.kind": "Tipo",
  "filters.kind.any": "Películas y series",
  "filters.kind.film": "Solo películas",
  "filters.kind.series": "Solo series",
  "filters.duration": "Duración mínima",
  "filters.duration.hint":
    "Duración real, leída de los archivos del ítem — saca clips, cartas de ajuste y audios mal etiquetados",
  "filters.duration.any": "Cualquier duración",
  "filters.duration.20": "20 min o más",
  "filters.duration.40": "40 min o más",
  "filters.duration.60": "60 min o más (largometrajes)",
  "filters.sort": "Ordenar por",
  "filters.sort.hint": "«Mejores» pondera la puntuación por cuánta gente votó",
  "filters.sort.best": "Mejores",
  "filters.sort.downloads": "Más vistas",
  "filters.sort.rating": "Mejor puntuadas",
  "filters.sort.year_desc": "Más nuevas primero",
  "filters.sort.year_asc": "Más viejas primero",
  "filters.sort.added_desc": "Agregadas recientemente",
  "filters.content": "Contenido",
  "filters.reset": "Restablecer los filtros",

  "toggle.collapse": "Agrupar copias",
  "toggle.collapse.hint":
    "Junta las varias subidas de una misma película en una fila, sumando vistas y votos",
  "toggle.playable": "Reproducibles",
  "toggle.playable.hint":
    "Solo ítems con un formato que el reproductor puede abrir — no es lo mismo que tener torrent",
  "toggle.subs": "Con subtítulos",
  "toggle.subs.hint": "Solo ítems que traen subtítulos",
  "toggle.identified": "Identificadas",
  "toggle.identified.hint":
    "Solo títulos identificados como obra catalogada — deja fuera el cine industrial y educativo que no está en Wikidata",

  // ── Fila de filtros activos ────────────────────────────────────
  "active.label": "Viendo",
  "active.aria": "Filtros activos",
  "active.clear": "limpiar todo",
  "active.remove": "Quitar el filtro: {x}",
  "active.query": "«{q}»",
  "active.year.between": "{a}–{b}",
  "active.year.from": "desde {a}",
  "active.year.to": "hasta {b}",
  "active.kind.film": "solo películas",
  "active.kind.series": "solo series",
  "active.duration": "{n} min o más",
  "active.playable": "reproducibles",
  "active.subs": "con subtítulos",
  "active.identified": "identificadas",
  "active.ungrouped": "copias sin agrupar",
  "active.rail": "lista: {x}",
  "active.match.all": "todas las etiquetas",
  "active.match.any": "cualquier etiqueta",
  "active.match.hint": "Cambiar entre exigir todas las etiquetas o cualquiera",

  // ── Banda ③ — descubrir ────────────────────────────────────────
  "discover.label": "Descubrir",
  "discover.aria": "Descubrimiento y listas curadas",
  "discover.forYou": "para vos",
  "discover.forYou.hint":
    "Rankea el catálogo contra el centroide de tu lista, tus vistas y tus puntuaciones",
  "discover.rail.hint": "{blurb} — el catálogo tiene {held} de {members}",
  "discover.clear": "Quitar el filtro de lista",
  "foryou.noProfile":
    "Guardá o puntuá algunas películas y este carril empieza a funcionar — van {n}, hacen falta al menos 3.",
  "foryou.noVectors":
    "El catálogo todavía no está indexado. Corré el indexador de embeddings y volvé a probar.",
  "foryou.noDirection":
    "Tus puntuaciones se cancelan entre sí — todavía no hay una dirección clara para buscar.",

  // ── Banda ④ — etiquetas ────────────────────────────────────────
  "transcode.note": "Convirtiendo {fmt} en vivo — podés mirar, pero no adelantar",
  "boot.connecting": "Conectando con la fuente",
  "boot.buffering": "Cargando",
  "boot.transcoding": "Convirtiendo para tu navegador",
  "boot.buffered": "en buffer",
  "boot.noSeek": "no se puede adelantar mientras convierte",
  "tags.label": "Etiquetas",
  "tags.aria": "Filtrar por etiqueta",
  "tags.hint": "{n} películas · clic para sumar al filtro",
  "tags.remove": "Quitar la etiqueta: {x}",
  "tags.all": "todas",
  "tags.all.hint": "Desplegar la lista completa de etiquetas, con buscador",
  "tags.less": "menos",
  "tags.less.hint": "Volver a las etiquetas principales",
  "tags.search.placeholder": "Buscar una etiqueta…",
  "tags.search.empty": "Sin coincidencias para «{q}»",
  "tags.search.busy": "Buscando…",
  "tags.scroll.more": "Más etiquetas",

  // ── Panel de embeddings ────────────────────────────────────────
  "embed.title": "Embeddings",
  "embed.indexed": "{done} / {total} indexadas",
  "embed.noModel": "sin modelo",
  "embed.close": "Cerrar el panel de embeddings",
};

export default es;
