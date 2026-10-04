import { defineModule, dashboardChannel } from "@kernl/extension-sdk";
import { nutritionMigrations } from "./migrations/001_nutrition.js";
import { NutritionService } from "./service.js";
import { nutritionTools } from "./tools.js";
import { queryNutrition } from "./dashboard-queries.js";
import { nutritionRpcActions } from "./rpc-actions.js";

export function createNutritionModule() {
  return defineModule({
    name: "nutrition",
    migrations: nutritionMigrations,
    init: (ctx) => new NutritionService(ctx.sqlite),
    tools: nutritionTools,
    rpc: nutritionRpcActions,
    dashboard: dashboardChannel("nutrition", (db) => queryNutrition(db), {
      nav: [
        { id: "nutrition", label: "Food", icon: "🥗", group: "wellness", order: 40 },
      ],
    }),
  });
}
