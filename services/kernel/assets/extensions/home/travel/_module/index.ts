import { defineModule } from "@kernl/extension-sdk";
import { travelMigrations } from "./migrations/001_travel.js";
import { TravelService } from "./service.js";
import { travelTools } from "./tools.js";

export function createTravelModule() {
  return defineModule({
    name: "travel",
    migrations: travelMigrations,
    init: (ctx) => new TravelService(ctx.sqlite),
    tools: travelTools,
  });
}
