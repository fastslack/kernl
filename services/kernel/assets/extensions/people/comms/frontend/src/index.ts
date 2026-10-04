/**
 * Comms extension — frontend page bundle entry.
 *
 * Ships the "/comms" view plus its sub-routes (/comms/compose,
 * /comms/campaign/:id, /comms/edit/:id, /comms/thread/:id) via the Root
 * sub-router — the host routes by first URL segment only.
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
 */
import Root from "./Root.svelte";
import { createMount } from "$shared/mount";

export const mount = createMount(Root);
