/**
 * Cinema extension — frontend page bundle entry.
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
 * The dashboard ext-host imports it and calls mount() when the user
 * navigates to /cinema.
 */
import Root from "./Root.svelte";
import { createMount } from "$shared/mount";

// Root switches between the catalog (Page) and Directories based on the
// pathname — /cinema/directories shares this view (host routes by first
// URL segment).
export const mount = createMount(Root);
