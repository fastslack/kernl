/**
 * HTTP routes for email-analysis suggestions surfaced on the dashboard.
 * Listing + dismiss are the fallback of the `emailSuggestions.*` RPC actions
 * (same function on both roads; see dashboard-operations.ts). Approval stays
 * out of HTTP: it needs the WS path with the sibling services wired in, or
 * the MCP tool `kernel_email_approve`.
 */
import { HttpError, type KernelHttpServer } from "@kernl/extension-sdk";
import type { EmailAnalysisService } from "./email-analysis-service.js";
import { emailSuggestionOperations } from "./dashboard-operations.js";

export function registerEmailSuggestionsRoutes(
  server: KernelHttpServer,
  emailAnalysisService: EmailAnalysisService | null,
): void {
  const op = emailSuggestionOperations(emailAnalysisService);
  server.operation("GET", "/api/email-suggestions", op["emailSuggestions.list"]);

  server.route("POST", "/api/email-suggestions/approve", () => {
    throw new HttpError(
      400,
      "Use the MCP tool kernel_email_approve to approve suggestions. " +
      "This endpoint is read-only.",
    );
  });

  server.operation("POST", "/api/email-suggestions/dismiss", op["emailSuggestions.dismiss"]);
}
