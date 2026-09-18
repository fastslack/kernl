import { describe, it, expect } from "bun:test";
import en from "./llm-connect.en.js";
import es from "./llm-connect.es.js";
import { errorView } from "../llm-connect.js";

describe("llm-connect strings", () => {
  it("en and es define the same keys, none empty", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    const empty = [...Object.entries(en), ...Object.entries(es)].filter(([, v]) => v.trim() === "").map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("every key the error views and groups use exists", () => {
    const codes = ["auth", "quota", "model", "timeout", "no_tools", "unreachable", "no_session", "network", "unknown"] as const;
    const used = codes.flatMap((c) => { const v = errorView(c); return [v.messageKey, v.actionKey].filter(Boolean) as string[]; });
    for (const g of ["free", "local", "paid", "subscription"]) used.push(`llm.group.${g}`);
    expect(used.filter((k) => en[k] === undefined)).toEqual([]);
  });

  it("no string mentions an environment variable or API path", () => {
    for (const v of Object.values(en)) expect(v).not.toMatch(/_API_KEY|\/api\//);
  });
});
