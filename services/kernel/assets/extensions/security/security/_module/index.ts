import { defineModule } from "@kernl/extension-sdk";
import { securityMigrations } from "./migrations/001_security.js";
import { SecurityService } from "./service.js";
import { securityTools } from "./tools.js";

export function createSecurityModule() {
  return defineModule({
    name: "security",
    migrations: securityMigrations,
    init: (ctx) => new SecurityService(ctx.sqlite),
    tools: securityTools,
  });
}
