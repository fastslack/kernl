/**
 * agent-fields: typed readers for the agents table's JSON TEXT columns.
 * A bad value degrades to the column's "nothing set" value, never throws.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  agentAllowedTools,
  agentDeniedTools,
  agentVariables,
  agentModelChain,
  agentSkills,
  readHandlerVars,
} from "../src/modules/agents/agent-fields.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

describe("agentAllowedTools / agentDeniedTools", () => {
  it("reads a JSON array as stored", () => {
    expect(agentAllowedTools({ allowed_tools: '["a","b"]' })).toEqual(["a", "b"]);
    expect(agentDeniedTools({ denied_tools: "[]" })).toEqual([]);
  });

  it("decodes the double-encoded form once more", () => {
    expect(agentAllowedTools({ allowed_tools: JSON.stringify('["x"]') })).toEqual(["x"]);
  });

  it("does not filter elements (a non-string still counts as a restriction)", () => {
    expect(agentAllowedTools({ allowed_tools: "[1]" })).toEqual([1] as unknown as string[]);
  });

  it("is [] for empty, malformed or non-array values", () => {
    for (const raw of ["", "nope", "{}", "null", '"bad"', '""', undefined, null]) {
      expect(agentAllowedTools({ allowed_tools: raw })).toEqual([]);
    }
  });
});

describe("agentVariables", () => {
  it("reads an object and is {} otherwise", () => {
    expect(agentVariables({ variables: '{"k":"v"}' })).toEqual({ k: "v" });
    for (const raw of ["", "{", "[1]", "null", "3"]) {
      expect(agentVariables({ variables: raw })).toEqual({});
    }
  });
});

describe("agentModelChain", () => {
  it("keeps entries with a provider or a model, stringified", () => {
    const raw = JSON.stringify([
      { provider: "a", model: "m1" },
      { provider: "", model: "" },
      null,
      "junk",
      { model: 7 },
    ]);
    expect(agentModelChain({ model_chain: raw })).toEqual([
      { provider: "a", model: "m1" },
      { provider: "", model: "7" },
    ]);
  });

  it("is [] for the empty column and for garbage", () => {
    expect(agentModelChain({ model_chain: "" })).toEqual([]);
    expect(agentModelChain({ model_chain: "{" })).toEqual([]);
    expect(agentModelChain({ model_chain: "{}" })).toEqual([]);
  });
});

describe("agentSkills", () => {
  it("reads the slug list, [] otherwise", () => {
    expect(agentSkills({ skills_json: '["s1"]' })).toEqual(["s1"]);
    expect(agentSkills({})).toEqual([]);
    expect(agentSkills({ skills_json: '{"a":1}' })).toEqual([]);
  });
});

describe("readHandlerVars", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE agents (id TEXT, builtin_handler TEXT, variables TEXT)");
  db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run("1", "h:ok", '{"top_n":4}');
  db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run("2", "h:bad", "not json");
  db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run("3", "h:empty", "");
  const sdb = db as unknown as SqliteDb;

  it("returns the handler agent's variables", () => {
    expect(readHandlerVars(sdb, "h:ok")).toEqual({ top_n: 4 });
  });

  it("is {} for unreadable variables or no such agent", () => {
    expect(readHandlerVars(sdb, "h:bad")).toEqual({});
    expect(readHandlerVars(sdb, "h:empty")).toEqual({});
    expect(readHandlerVars(sdb, "h:missing")).toEqual({});
  });
});
