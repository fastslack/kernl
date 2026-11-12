const en = {
  "graph.title": "Graph",
  "graph.sub": "Explore what Kernl's graph holds: pick a label or search, click a node to read it, Expand to bring its neighbours in.",
  "graph.search.placeholder": "Search a name or title…",
  "graph.search.button": "Search",
  "graph.search.aria": "Search the graph",
  "graph.results": "Results",
  "graph.clear": "clear",
  "graph.labels": "Labels",
  "graph.labels.empty": "The graph is empty or off.",
  "graph.loading": "Loading…",
  "graph.depth": "Expand depth",
  "graph.depth.1": "1 hop",
  "graph.depth.2": "2 hops",
  "graph.clear_view": "Clear view",
  "graph.counts": "{nodes} nodes · {links} links",
  "graph.no_name": "(no name)",
  "graph.expand": "Expand",
  "graph.focus": "Focus here",
  "graph.loose": "These nodes have no relationships between them. Pick a node and Expand it, or try another label.",
  "graph.help": "Drag to rotate · wheel to zoom · right-click a node to expand it",
} as const;

export type GraphKey = keyof typeof en;
export default en;
