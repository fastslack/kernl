/**
 * English copy for the /cinema page chrome.
 *
 * English is the fallback locale (see $shared/i18n), so this file must stay
 * complete: a key missing here renders as the raw key in every language.
 *
 * Keys are namespaced by the band they appear in, which is also the order they
 * appear on screen — header, search, filters, active, discover, tags, embed.
 * Tooltips carry the `.hint` suffix, accessible names `.aria`.
 */
import type { Dict } from "$shared/i18n";

const en: Dict = {
  // ── Band ① — identity + quick actions ──────────────────────────
  "header.catalogue": "{n} titles · local catalogue",
  "header.results": "{n} results for “{q}”",
  "header.watchlist": "your list · {n} saved",
  "header.loading": "loading catalogue…",
  "nav.aria": "Cinema sections",
  "nav.watchlist": "my list",
  "nav.watchlist.hint": "Titles you saved with the star button",
  "nav.embeddings": "embeddings",
  "nav.embeddings.hint": "Semantic index status — view or run the embedder",
  "nav.embeddings.running": "Indexing in progress",
  "nav.directories": "directories",
  "nav.directories.hint": "Federated community directories over Nostr",
  "nav.back": "back to the catalogue",

  // ── Band ② — command bar ───────────────────────────────────────
  "search.placeholder": "Search a film, or describe one — “silent films with vampires”",
  "search.aria": "Search the catalogue",
  "search.enter.hint": "Press Enter to search. Type #tag to filter by tag.",
  "search.clear": "Clear the search",
  "search.busy": "Searching…",
  "filters.toggle": "Filters",
  "filters.toggle.hint": "Year, language, type, duration, sort order and content",
  "filters.toggle.count": "{n} active filters",
  "filters.open": "Show filters",
  "filters.close": "Hide filters",

  // ── Filters panel ──────────────────────────────────────────────
  "filters.aria": "Catalogue filters",
  "filters.year": "Year",
  "filters.year.from": "From",
  "filters.year.to": "To",
  "filters.year.from.ph": "1888",
  "filters.year.to.ph": "2099",
  "filters.language": "Language",
  "filters.language.any": "Any language",
  "filters.kind": "Type",
  "filters.kind.any": "Films and series",
  "filters.kind.film": "Films only",
  "filters.kind.series": "Series only",
  "filters.duration": "Minimum duration",
  "filters.duration.hint":
    "Real duration read from the item's own files — drops clips, test cards and mislabelled audio",
  "filters.duration.any": "Any duration",
  "filters.duration.20": "20 min or more",
  "filters.duration.40": "40 min or more",
  "filters.duration.60": "60 min or more (features)",
  "filters.sort": "Sort by",
  "filters.sort.hint": "“Best” weights the rating by how many people voted",
  "filters.sort.best": "Best rated",
  "filters.sort.downloads": "Most viewed",
  "filters.sort.rating": "Highest rating",
  "filters.sort.year_desc": "Newest first",
  "filters.sort.year_asc": "Oldest first",
  "filters.sort.added_desc": "Recently added",
  "filters.content": "Content",
  "filters.reset": "Reset filters",

  "toggle.collapse": "Group copies",
  "toggle.collapse.hint":
    "Merge the several uploads of one film into a single row, summing views and votes",
  "toggle.playable": "Playable",
  "toggle.playable.hint":
    "Only items in a format the player can open — not the same as having a torrent",
  "toggle.subs": "With subtitles",
  "toggle.subs.hint": "Only items that ship subtitles",
  "toggle.identified": "Identified",
  "toggle.identified.hint":
    "Only titles matched to a catalogued work — leaves out industrial and educational cinema Wikidata does not list",

  // ── Active-filter row ──────────────────────────────────────────
  "active.label": "Showing",
  "active.aria": "Active filters",
  "active.clear": "clear all",
  "active.remove": "Remove filter: {x}",
  "active.query": "“{q}”",
  "active.year.between": "{a}–{b}",
  "active.year.from": "from {a}",
  "active.year.to": "until {b}",
  "active.kind.film": "films only",
  "active.kind.series": "series only",
  "active.duration": "{n} min or more",
  "active.playable": "playable",
  "active.subs": "with subtitles",
  "active.identified": "identified",
  "active.ungrouped": "copies not grouped",
  "active.rail": "list: {x}",
  "active.match.all": "all tags",
  "active.match.any": "any tag",
  "active.match.hint": "Switch between matching all tags and any tag",

  // ── Band ③ — discover ──────────────────────────────────────────
  "discover.label": "Discover",
  "discover.aria": "Discovery and curated lists",
  "discover.forYou": "for you",
  "discover.forYou.hint":
    "Ranks the catalogue against the centroid of your list, your views and your ratings",
  "discover.rail.hint": "{blurb} — the catalogue holds {held} of {members}",
  "discover.clear": "Clear the list filter",
  "foryou.noProfile":
    "Save or rate a few films and this rail starts working — {n} so far, at least 3 are needed.",
  "foryou.noVectors":
    "The catalogue is not indexed yet. Run the embedding indexer and try again.",
  "foryou.noDirection":
    "Your ratings cancel each other out — there is no clear direction to search in yet.",

  // ── Band ④ — tags ──────────────────────────────────────────────
  "transcode.note": "Transcoding {fmt} live — you can watch, but you can't skip ahead",
  "boot.connecting": "Connecting to source",
  "boot.buffering": "Buffering",
  "boot.transcoding": "Transcoding for your browser",
  "boot.buffered": "buffered",
  "boot.noSeek": "seek unavailable while transcoding",
  "tags.label": "Tags",
  "tags.aria": "Filter by tag",
  "tags.hint": "{n} films · click to add to the filter",
  "tags.remove": "Remove tag: {x}",
  "tags.all": "all tags",
  "tags.all.hint": "Expand the full tag list, searchable",
  "tags.less": "less",
  "tags.less.hint": "Collapse back to the top tags",
  "tags.search.placeholder": "Search a tag…",
  "tags.search.empty": "No matches for “{q}”",
  "tags.search.busy": "Searching…",
  "tags.scroll.more": "More tags",

  // ── Embeddings panel ───────────────────────────────────────────
  "embed.title": "Embeddings",
  "embed.indexed": "{done} / {total} indexed",
  "embed.noModel": "no model",
  "embed.close": "Close the embeddings panel",
};

export default en;
