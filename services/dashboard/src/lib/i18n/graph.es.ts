import type { GraphKey } from "./graph.en.js";

// Exactly the keys of graph.en.ts: a missing or extra key is a compile error.
const es: Record<GraphKey, string> = {
  "graph.title": "Grafo",
  "graph.sub": "Explorá lo que guarda el grafo de Kernl: elegí una etiqueta o buscá, tocá un nodo para leerlo y usá Expandir para traer a sus vecinos.",
  "graph.search.placeholder": "Buscá un nombre o un título…",
  "graph.search.button": "Buscar",
  "graph.search.aria": "Buscar en el grafo",
  "graph.results": "Resultados",
  "graph.clear": "limpiar",
  "graph.labels": "Etiquetas",
  "graph.labels.empty": "El grafo está vacío o apagado.",
  "graph.loading": "Cargando…",
  "graph.depth": "Profundidad al expandir",
  "graph.depth.1": "1 salto",
  "graph.depth.2": "2 saltos",
  "graph.clear_view": "Limpiar vista",
  "graph.counts": "{nodes} nodos · {links} relaciones",
  "graph.no_name": "(sin nombre)",
  "graph.expand": "Expandir",
  "graph.focus": "Centrar acá",
  "graph.loose": "Estos nodos no tienen relaciones entre sí. Elegí uno y expandilo, o probá otra etiqueta.",
  "graph.help": "Arrastrá para girar · rueda para acercar · clic derecho en un nodo para expandirlo",
};

export default es;
