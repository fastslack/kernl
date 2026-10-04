/**
 * Twitter / X extension — frontend page bundle entry.
 *
 * Ships the "/x-manager" view (content pipeline: posts, queue, mentions,
 * accounts, metrics) declared by the people-suite nav.
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
 */
import Page from "./Page.svelte";
import { createMount } from "$shared/mount";

export const mount = createMount(Page);
