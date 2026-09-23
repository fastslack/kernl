/**
 * CRM extension — frontend page bundle entry.
 *
 * Ships TWO views from one bundle: "/crm" (contact manager + /crm/leads
 * pipeline via the Root sub-router) and "/people" (contacts analytics
 * overview). Both are anchored on the crm module's data, so the pages live
 * here — mount() switches on ctx.view.
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
 */
import Root from "./Root.svelte";
import PeoplePage from "./PeoplePage.svelte";
import { createMount } from "$shared/mount";

export const mount = createMount(Root, { people: PeoplePage });
