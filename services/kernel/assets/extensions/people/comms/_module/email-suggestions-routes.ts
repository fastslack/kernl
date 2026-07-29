/**
 * HTTP routes for email-analysis suggestions surfaced on the dashboard.
 * Read-only listing + dismiss; approval is handled via the MCP tool
 * `kernel_email_approve` to keep all side effects in one path.
 */
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { EmailAnalysisService } from "./email-analysis-service.js";

export function registerEmailSuggestionsRoutes(
  server: KernelHttpServer,
  emailAnalysisService: EmailAnalysisService | null,
): void {
  server.get("/api/email-suggestions", (_req, res) => {
    if (!emailAnalysisService) {
      server.json(res, 200, { available: false, suggestions: [] });
      return;
    }
    const suggestions = emailAnalysisService.getPendingSuggestions(50);
    server.json(res, 200, {
      available: true,
      suggestions,
      count: suggestions.length,
    });
  });

  server.post("/api/email-suggestions/approve", async (_req, res) => {
    server.json(res, 400, {
      error:
        "Use the MCP tool kernel_email_approve to approve suggestions. " +
        "This endpoint is read-only.",
    });
  });

  server.post("/api/email-suggestions/dismiss", async (req, res) => {
    if (!emailAnalysisService) {
      server.json(res, 404, { error: "Email analysis not available" });
      return;
    }
    try {
      const body = await server.parseBody<{ suggestion_id: string }>(req);
      emailAnalysisService.dismissSuggestion(body.suggestion_id);
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
}
