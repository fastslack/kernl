/**
 * Office creation helpers for the dashboard wizard:
 *   GET  /api/offices/templates  — gallery cards + whether host isolation is allowed
 *   POST /api/offices/draft      — "Armar con IA": describe a team, get a draft OfficeDefinition
 */
import type { KernelHttpServer } from "../../../core/http-server.js";
import type { KernelLanguage } from "../../../core/config.js";
import { log } from "../../../core/logger.js";
import { buildOfficeTemplates, type ExtensionOfficeSource } from "../office-templates.js";
import { hostIsolationAllowed } from "../repo-isolation.js";
import { draftOfficeDefinition, DraftError } from "../office-draft.js";

export interface OfficeRoutesDeps {
  defaultLanguage: KernelLanguage;
  /** Offices shipped by extensions. Injected so the agents module does not import extensions or marketplace. */
  officeSources?: () => Promise<ExtensionOfficeSource[]>;
}

function languageFrom(value: unknown, fallback: KernelLanguage): KernelLanguage {
  return value === "es" || value === "en" ? value : fallback;
}

export function registerOfficeRoutes(server: KernelHttpServer, deps: OfficeRoutesDeps): void {
  server.get("/api/offices/templates", async (req, res) => {
    try {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const language = languageFrom(params.get("language"), deps.defaultLanguage);
      let sources: ExtensionOfficeSource[] = [];
      try {
        sources = (await deps.officeSources?.()) ?? [];
      } catch (err) {
        log.warn(`offices/templates: extension offices unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      server.json(res, 200, buildOfficeTemplates(language, sources, hostIsolationAllowed()));
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/offices/draft", async (req, res) => {
    try {
      const body = await server.parseBody<{ description?: string; language?: string }>(req);
      const language = languageFrom(body.language, deps.defaultLanguage);
      const { llm } = await import("../../../core/llm/client.js");
      const definition = await draftOfficeDefinition(
        { description: body.description ?? "", language },
        (opts) => llm().chatJson(opts),
      );
      server.json(res, 200, { definition });
    } catch (err) {
      if (err instanceof DraftError) {
        server.json(res, err.kind === "input" ? 400 : 422, {
          error: err.kind === "input" ? err.message : "invalid_draft",
          detail: err.detail,
        });
        return;
      }
      log.error("offices/draft failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });
}
