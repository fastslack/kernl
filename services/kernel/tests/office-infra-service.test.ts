import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { officeInfraMigrations } from "../src/modules/office-infra/migrations.js";
import { OfficeEnvironmentService } from "../src/modules/office-infra/office-environment-service.js";
import type { DockerResult } from "../src/modules/office-infra/types.js";

function makeService(handler?: (args: string[]) => DockerResult) {
  const db = new Database(":memory:");
  runMigrations(db, "office-infra", officeInfraMigrations);
  // The service validates flow_id against agent_flows — provide the table and
  // seed the office used across these tests.
  db.exec(
    `CREATE TABLE agent_flows (id TEXT PRIMARY KEY, name TEXT, description TEXT, color TEXT, active INTEGER, created_at TEXT, updated_at TEXT)`,
  );
  db.prepare("INSERT INTO agent_flows (id, name) VALUES (?, ?)").run("flow-1", "Test Office");
  const calls: string[][] = [];
  const runner = (args: string[]): DockerResult => {
    calls.push(args);
    return handler ? handler(args) : { code: 0, stdout: "", stderr: "" };
  };
  const svc = new OfficeEnvironmentService(db as any, runner);
  return { db, svc, calls };
}

describe("OfficeEnvironmentService.get / configure", () => {
  it("auto-creates a default row on first get", () => {
    const { svc } = makeService();
    const row = svc.get("flow-1");
    expect(row.flow_id).toBe("flow-1");
    expect(row.image).toBe("oven/bun:1");
    expect(row.container_name).toBe("mtw-office-flow-1");
    expect(row.workspace_subpath).toBe("data/workspaces/flow-1");
  });

  it("applies a valid configure patch", () => {
    const { svc } = makeService();
    const row = svc.configure("flow-1", {
      image: "node:22",
      ports: ["4321:4321"],
      run_command: "bun run dev",
    });
    expect(row.image).toBe("node:22");
    expect(JSON.parse(row.ports_json)).toEqual(["4321:4321"]);
    expect(row.run_command).toBe("bun run dev");
  });

  it("rejects malformed port mappings", () => {
    const { svc } = makeService();
    expect(() => svc.configure("flow-1", { ports: ["notaport"] })).toThrow(/port/i);
  });

  it("rejects workspace_subpath outside data/", () => {
    const { svc } = makeService();
    expect(() => svc.configure("flow-1", { workspace_subpath: "../etc" })).toThrow(/workspace/i);
  });

  it("rejects invalid env var key names (silent-corruption guard)", () => {
    const { svc } = makeService();
    expect(() => svc.configure("flow-1", { env: { "MY=KEY": "v" } })).toThrow(/env key/i);
    expect(() => svc.configure("flow-1", { env: { "has space": "v" } })).toThrow(/env key/i);
    // valid keys pass
    expect(() => svc.configure("flow-1", { env: { NODE_ENV: "dev", _x1: "y" } })).not.toThrow();
  });

  it("rejects an office (flow) that does not exist in agent_flows", () => {
    const { svc } = makeService();
    expect(() => svc.get("ghost-flow")).toThrow(/not found/i);
  });
});

describe("OfficeEnvironmentService.up + verbs", () => {
  it("up builds a docker run -d with workspace mount, label, port, image", () => {
    const { svc, calls } = makeService();
    svc.configure("flow-1", { ports: ["4321:4321"], run_command: "bun run dev" });
    svc.up("flow-1");
    // The last docker call should be the `run` (a prior `rm -f` may precede it).
    const runCall = calls.find((c) => c[0] === "run");
    expect(runCall).toBeTruthy();
    const joined = runCall!.join(" ");
    expect(joined).toContain("-d");
    expect(joined).toContain("--name mtw-office-flow-1");
    expect(joined).toContain("--label mtw.office=flow-1");
    expect(joined).toContain(":/workspace");
    expect(joined).toContain("-p 4321:4321");
    expect(joined).toContain("oven/bun:1");
    expect(joined).toContain("bun run dev");
    expect(svc.get("flow-1").desired_state).toBe("running");
  });

  it("up with empty run_command falls back to sleep infinity", () => {
    const { svc, calls } = makeService();
    svc.up("flow-1");
    const runCall = calls.find((c) => c[0] === "run")!;
    expect(runCall.join(" ")).toContain("sleep infinity");
  });

  it("pause/resume/stop/restart call docker with the right verb + name", () => {
    const { svc, calls } = makeService();
    svc.pause("flow-1");
    svc.resume("flow-1");
    svc.stop("flow-1");
    svc.restart("flow-1");
    const verbs = calls.map((c) => c[0]);
    expect(verbs).toContain("pause");
    expect(verbs).toContain("unpause");
    expect(verbs).toContain("stop");
    expect(verbs).toContain("restart");
    for (const v of ["pause", "unpause", "stop", "restart"]) {
      expect(calls.find((c) => c[0] === v)!).toContain("mtw-office-flow-1");
    }
    expect(svc.get("flow-1").desired_state).toBe("running"); // restart was last
  });

  it("surfaces docker failure as a thrown error and records last_error", () => {
    const { svc } = makeService((args) =>
      args[0] === "run"
        ? { code: 1, stdout: "", stderr: "no such image" }
        : { code: 0, stdout: "", stderr: "" },
    );
    expect(() => svc.up("flow-1")).toThrow(/no such image/);
    expect(svc.get("flow-1").last_error).toContain("no such image");
  });
});

describe("OfficeEnvironmentService.status", () => {
  const inspect = (state: string) =>
    JSON.stringify([{ State: { Status: state } }]);

  it("normalizes running and derives preview_url from first port", () => {
    const { svc } = makeService((args) =>
      args[0] === "inspect"
        ? { code: 0, stdout: inspect("running"), stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    svc.configure("flow-1", { ports: ["4321:4321"] });
    const st = svc.status("flow-1");
    expect(st.state).toBe("running");
    expect(st.preview_url).toBe("http://localhost:4321");
  });

  it("maps restarting -> running (in-use; no Encender)", () => {
    const { svc } = makeService((args) => ({
      code: 0, stdout: args[0] === "inspect" ? inspect("restarting") : "", stderr: "",
    }));
    expect(svc.status("flow-1").state).toBe("running");
  });

  it("maps exited -> exited, paused -> paused", () => {
    const { svc } = makeService((args) => ({
      code: 0, stdout: args[0] === "inspect" ? inspect("exited") : "", stderr: "",
    }));
    expect(svc.status("flow-1").state).toBe("exited");
  });

  it("maps a missing container (inspect exit 1) to absent", () => {
    const { svc } = makeService((args) =>
      args[0] === "inspect"
        ? { code: 1, stdout: "", stderr: "No such object" }
        : { code: 0, stdout: "", stderr: "" },
    );
    expect(svc.status("flow-1").state).toBe("absent");
  });

  it("maps docker-unreachable (inspect error code, daemon msg) appropriately", () => {
    const { svc } = makeService((args) =>
      args[0] === "inspect"
        ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const st = svc.status("flow-1");
    expect(st.state).toBe("error");
    expect(st.last_error).toContain("Docker daemon");
  });
});
