/**
 * Tasks extension — frontend page bundle entry.
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
 * The dashboard ext-host imports it and calls mount() when the user
 * navigates to /tasks.
 */
import Page from "./Page.svelte";
import { createMount } from "$shared/mount";

export const mount = createMount(Page);
