/**
 * Finance extension — frontend page bundle entry (view "finance").
 * The finance-suite only contributes nav; the page itself lives here, with
 * the extension that owns the finance module data.
 */
import Page from "./Page.svelte";
import { createMount } from "$shared/mount";

export const mount = createMount(Page);
