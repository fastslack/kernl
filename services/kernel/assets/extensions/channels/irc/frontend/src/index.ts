/**
 * IRC extension — frontend page bundle entry.
 *
 * Ships the "/irc" view: a thin IRCv3 web client that connects straight to
 * the extension's /ws/irc WebSocket endpoint.
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
 */
import Page from "./Page.svelte";
import { createMount } from "$shared/mount";

export const mount = createMount(Page);
