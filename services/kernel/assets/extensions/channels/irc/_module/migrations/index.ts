import type { Migration } from "../../../../../../src/core/db/migrations.js";
import { ircMigrations } from "./001_irc.js";
import { upstreamMigrations } from "./002_upstream.js";

/** Every migration for the "irc" module, in version order. */
export const allIrcMigrations: Migration[] = [...ircMigrations, ...upstreamMigrations];

export { ircMigrations, upstreamMigrations };
