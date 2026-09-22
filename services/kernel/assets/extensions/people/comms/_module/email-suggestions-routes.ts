/**
 * HTTP routes for email-analysis suggestions surfaced on the dashboard.
 * Read-only listing + dismiss; approval is handled via the MCP tool
 * `kernel_email_approve` to keep all side effects in one path.
 */
import { HttpError, type KernelHttpServer } from "@kernl/extension-sdk";
import type { EmailAnalysisService } from "./email-analysis-service.js";

export function registerEmailSuggestionsRoutes(
  server: KernelHttpServer,
  emailAnalysisService: EmailAnalysisService | null,
): void {
  server.route("GET", "/api/email-suggestions", () => {
    if (!emailAnalysisService) return { available: false, suggestions: [] };
    const suggestions = emailAnalysisService.getPendingSuggestions(50);
    return {
      available: true,
      suggestions,
      count: suggestions.length,
    };
  });

  server.route("POST", "/api/email-suggestions/approve", () => {
    throw new HttpError(
      400,
      "Use the MCP tool kernel_email_approve to approve suggestions. " +
      "This endpoint is read-only.",
    );
  });

  server.route<{ suggestion_id: string }>("POST", "/api/email-suggestions/dismiss", ({ body }) => {
    if (!emailAnalysisService) throw new HttpError(404, "Email analysis not available");
    emailAnalysisService.dismissSuggestion(body.suggestion_id);
    return { success: true };
  });
}
