import type {
  DashboardDescriptor,
  ExtensibleModule,
  ModuleContext,
} from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { booksMigrations } from "./migrations/001_books.js";
import { BooksService } from "./service.js";
import { registerBooksRoutes } from "./api-routes.js";

export interface BooksModule extends ExtensibleModule {
  getService(): BooksService;
}

export function createBooksModule(): BooksModule {
  let service: BooksService | null = null;
  return {
    name: "books",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "books", booksMigrations);
      service = new BooksService(ctx.sqlite);
    },
    getTools() { return []; },
    async shutdown() {},
    getService() {
      if (!service) throw new Error("BooksService not initialized");
      return service;
    },
    getDashboardDescriptor(): DashboardDescriptor | null {
      if (!service) return null;
      const svc = service;
      return {
        registerRoutes: (server) => registerBooksRoutes(server, svc),
      };
    },
  };
}
