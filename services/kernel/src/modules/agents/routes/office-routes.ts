/**
 * Office creation helpers for the dashboard wizard:
 *   GET  /api/offices/templates  — gallery cards + whether host isolation is allowed
 *   POST /api/offices/draft      — "Armar con IA": describe a team, get a draft OfficeDefinition
 */
import { HttpError, type KernelHttpServer } from "../../../core/http-server.js";
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
  server.route("GET", "/api/offices/templates", async ({ query }) => {
    const language = languageFrom(query.get("language"), deps.defaultLanguage);
    let sources: ExtensionOfficeSource[] = [];
    try {
      sources = (await deps.officeSources?.()) ?? [];
    } catch (err) {
      log.warn(`offices/templates: extension offices unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return buildOfficeTemplates(language, sources, hostIsolationAllowed());
  });

  server.route<{ description?: string; language?: string }>("POST", "/api/offices/draft", async ({ body }) => {
    const language = languageFrom(body.language, deps.defaultLanguage);
    const { llm } = await import("../../../core/llm/client.js");
    try {
      const definition = await draftOfficeDefinition(
        { description: body.description ?? "", language },
        (opts) => llm().chatJson(opts),
      );
      return { definition };
    } catch (err) {
      if (!(err instanceof DraftError)) throw err;
      // Name the model on a draft failure. The operator's next move differs
      // completely depending on whether their description was thin or the
      // model cannot hold a schema, and only the server knows which model
      // actually ran — the chain resolves it, nobody picked it here.
      let model: string | undefined;
      if (err.kind === "draft") {
        try {
          const { primary } = llm().describeChain();
          model = [primary.slug, primary.model].filter(Boolean).join("/") || undefined;
        } catch { /* unresolvable — the message still works without it */ }
      }
      throw new HttpError(err.kind === "input" ? 400 : 422, err.message, {
        error: err.kind === "input" ? err.message : "invalid_draft",
        detail: err.detail,
        ...(model ? { model } : {}),
      });
    }
  });
}
