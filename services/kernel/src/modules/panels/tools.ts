// src/modules/panels/tools.ts
import { z } from "zod";
import { defineTool } from "../../core/tool-builder.js";
import { textResult, errorResult } from "../../core/helpers.js";
import type { ToolDefinition } from "../../core/types.js";
import type { PanelStore } from "./store.js";

const COLLECTION = z.string().regex(/^[a-z][a-z0-9_.-]{0,47}$/).describe("Collection name declared in your office's panels (e.g. events)");

export function panelTools(store: PanelStore, ownerOfCaller: () => string | null): ToolDefinition[] {
  const owner = () => {
    const o = ownerOfCaller();
    if (!o) throw new Error("only an agent that belongs to an office can write panel records");
    return o;
  };
  return [
    defineTool({
      name: "kernel_panel_record_put",
      description: "Create or replace one record in a collection of YOUR office's panel (shown to the operator in the office panel). Use a stable key (e.g. the issue key).",
      schema: z.object({ collection: COLLECTION, key: z.string().min(1).max(200), data: z.record(z.unknown()) }),
      handler: async (input) => {
        try { store.putRecord(owner(), input.collection, input.key, input.data, "agent"); return textResult(`Saved ${input.collection}/${input.key}.`); }
        catch (e) { return errorResult(e instanceof Error ? e.message : String(e)); }
      },
    }),
    defineTool({
      name: "kernel_panel_record_append",
      description: "Append one event to a collection of YOUR office's panel (e.g. a state change for the office timeline). The key is generated.",
      schema: z.object({ collection: COLLECTION, data: z.record(z.unknown()) }),
      handler: async (input) => {
        try { const key = store.appendRecord(owner(), input.collection, input.data, "agent"); return textResult(`Appended ${input.collection}/${key}.`); }
        catch (e) { return errorResult(e instanceof Error ? e.message : String(e)); }
      },
    }),
  ];
}
