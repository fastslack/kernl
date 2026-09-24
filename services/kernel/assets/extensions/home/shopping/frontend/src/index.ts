/**
 * Shopping extension — frontend page bundle entry (view "shopping").
 * The shopping-nav suite only contributes the nav item; the page itself lives
 * here, with the extension that owns the shopping module data.
 */
import Page from "./Page.svelte";
import { createMount } from "$shared/mount";

export const mount = createMount(Page);
