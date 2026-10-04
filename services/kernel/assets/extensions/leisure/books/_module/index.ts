import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { booksMigrations } from "./migrations/001_books.js";
import { BooksService } from "./service.js";
import { registerBooksRoutes } from "./api-routes.js";

export interface BooksModule extends ExtensibleModule {
  getService(): BooksService;
}

export function createBooksModule(): BooksModule {
  let service: BooksService | null = null;

  const mod = defineModule({
    name: "books",
    migrations: booksMigrations,
    init: (ctx) => (service = new BooksService(ctx.sqlite)),
    dashboard: (svc) => (svc ? { registerRoutes: (server) => registerBooksRoutes(server, svc) } : null),
  });

  return Object.assign(mod, {
    getService() {
      if (!service) throw new Error("BooksService not initialized");
      return service;
    },
  });
}
