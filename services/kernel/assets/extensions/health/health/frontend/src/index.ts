/**
 * Health extension — frontend page bundle entry.
 *
 * Ships TWO views from one bundle: "/health" (vitals & tracking) and
 * "/wellness" (the cross-module overview formerly owned by the
 * wellness-suite). The suite has no backend, so the page lives here —
 * health owns the healthData store the overview is anchored on — and
 * mount() switches on ctx.view.
 */
import HealthPage from "./HealthPage.svelte";
import WellnessPage from "./WellnessPage.svelte";
import { createMount } from "$shared/mount";

export const mount = createMount(HealthPage, { wellness: WellnessPage });
