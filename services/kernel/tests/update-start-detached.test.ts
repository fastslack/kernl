import { describe, it, expect } from "bun:test";
import { startDetached } from "../src/core/update/install.js";

// The update and restart paths spawn a helper that has to outlive the kernel,
// then exit. They used to exit as soon as spawn() returned. When the helper
// could not start at all (no /bin/sh, a broken ComSpec), the kernel still
// exited, with nothing left to relaunch it. Only a started helper may be
// handed off to.

describe("startDetached", () => {
  it("resolves with the pid once the helper has started", async () => {
    const pid = await startDetached("/bin/sh", ["-c", "exit 0"]);
    expect(typeof pid).toBe("number");
    expect(pid).toBeGreaterThan(0);
  });

  it("rejects when the helper cannot start", async () => {
    await expect(startDetached("/nonexistent/kernl-helper", [])).rejects.toThrow(/ENOENT/);
  });
});
