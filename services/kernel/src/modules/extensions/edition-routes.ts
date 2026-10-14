/** HTTP surface for the personal/business edition. Mounted with the extensions routes. */
import { HttpError, type KernelHttpServer } from "../../core/http-server.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { applyEdition, editionStatus, type ExtensionsPort } from "./edition-apply.js";

export function registerEditionRoutes(server: KernelHttpServer, db: SqliteDb, ext: ExtensionsPort): void {
  server.route("GET", "/api/edition", () => editionStatus(db));

  server.route<{ mode?: unknown; addOnly?: unknown }>("POST", "/api/edition", async ({ body }) => {
    const mode = body?.mode;
    if (mode !== "personal" && mode !== "business") {
      throw new HttpError(400, 'mode must be "personal" or "business"');
    }
    return applyEdition(db, ext, mode, { addOnly: body?.addOnly === true });
  });
}
