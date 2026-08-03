import { describe, it, expect } from "bun:test";
import {
  isCompleteLoginUrl,
  claudeConfigDir,
  claudeAuthEnv,
  parseAuthStatus,
  stripAnsi,
  extractLoginUrl,
  ptyCommand,
} from "../src/core/llm/claude-code-auth.js";

const ESC = "\x1b";

describe("claudeConfigDir", () => {
  it("follows XDG_CONFIG_HOME, which is the volume under Docker", () => {
    // The whole point: /app/data is the mounted volume, so the login survives a
    // container recreate. $HOME does not.
    expect(claudeConfigDir({ XDG_CONFIG_HOME: "/app/data/xdg" } as NodeJS.ProcessEnv)).toBe(
      "/app/data/xdg/kernl/claude",
    );
  });

  it("falls back to ~/.config on a native install", () => {
    const dir = claudeConfigDir({} as NodeJS.ProcessEnv);
    expect(dir.endsWith("/.config/kernl/claude")).toBe(true);
  });

  it("ignores an empty XDG_CONFIG_HOME rather than rooting at /kernl", () => {
    const dir = claudeConfigDir({ XDG_CONFIG_HOME: "" } as NodeJS.ProcessEnv);
    expect(dir.startsWith("/kernl")).toBe(false);
    expect(dir.endsWith("/.config/kernl/claude")).toBe(true);
  });
});

describe("claudeAuthEnv", () => {
  const env = { XDG_CONFIG_HOME: "/app/data/xdg", CLAUDE_CODE_OAUTH_TOKEN: "" } as NodeJS.ProcessEnv;

  it("always points the CLI at the persistent config dir", () => {
    expect(claudeAuthEnv({ env }).CLAUDE_CONFIG_DIR).toBe("/app/data/xdg/kernl/claude");
  });

  it("injects a pasted token for hosts with no usable terminal", () => {
    expect(claudeAuthEnv({ env, oauthToken: "sk-ant-oat01-xyz" }).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-xyz");
  });

  it("falls back to the environment when no token is passed in", () => {
    // The bug this exists to prevent: the adapter that makes real calls is
    // constructed with no config, so a token living only in the provider
    // registry never reached it. The dialog verified fine (it injected the
    // token itself) while every chat message still failed "Not logged in".
    const e = { XDG_CONFIG_HOME: "/app/data/xdg", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-from-env" } as NodeJS.ProcessEnv;
    expect(claudeAuthEnv({ env: e }).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-from-env");
  });

  it("prefers an explicitly passed token over the environment", () => {
    const e = { XDG_CONFIG_HOME: "/x", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-env" } as NodeJS.ProcessEnv;
    expect(claudeAuthEnv({ env: e, oauthToken: "sk-ant-explicit" }).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-explicit");
  });

  it("omits the variable entirely when there is no token", () => {
    // Setting it to "" would look like a configured-but-broken credential.
    expect("CLAUDE_CODE_OAUTH_TOKEN" in claudeAuthEnv({ env })).toBe(false);
    expect("CLAUDE_CODE_OAUTH_TOKEN" in claudeAuthEnv({ env, oauthToken: "   " })).toBe(false);
  });
});

describe("parseAuthStatus", () => {
  it("reads the CLI's real reply", () => {
    // Captured verbatim from `claude auth status --json` v2.1.114.
    const raw = '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}';
    expect(parseAuthStatus(raw)).toEqual({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" });
  });

  it("reports a token-authenticated session", () => {
    const raw = '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}';
    expect(parseAuthStatus(raw).loggedIn).toBe(true);
    expect(parseAuthStatus(raw).authMethod).toBe("oauth_token");
  });

  it("treats an unparseable reply as logged out instead of throwing", () => {
    // The binary is missing or crashed. Throwing here would hide the very
    // dialog the operator needs to fix it.
    expect(parseAuthStatus("claude: not found").loggedIn).toBe(false);
    expect(parseAuthStatus("").authMethod).toBe("none");
  });
});

describe("stripAnsi", () => {
  it("removes the CSI noise `script` records", () => {
    expect(stripAnsi(`${ESC}[90m21:50${ESC}[0m hello`)).toBe("21:50 hello");
  });

  it("turns cursor-forward into the spaces it stands for", () => {
    // Ink positions text by moving the cursor instead of writing spaces. Deleting
    // those ran words together: a real CLI error reached the dialog as
    // "Invalidcode. Please makesure the fullcde wascopied".
    expect(stripAnsi(`Invalid${ESC}[1Ccode.${ESC}[1CPlease${ESC}[1Cmake${ESC}[1Csure`))
      .toBe("Invalid code. Please make sure");
  });

  it("honours a repeat count on the cursor move", () => {
    expect(stripAnsi(`a${ESC}[4Cb`)).toBe("a    b");
  });

  it("removes OSC sequences terminated by BEL or ST", () => {
    expect(stripAnsi(`${ESC}]0;a title\x07text`)).toBe("text");
    expect(stripAnsi(`${ESC}]0;a title${ESC}\\text`)).toBe("text");
  });

  it("removes charset and keypad escapes", () => {
    expect(stripAnsi(`${ESC}(B${ESC}=x`)).toBe("x");
  });
});

describe("extractLoginUrl", () => {
  it("finds the authorize URL in the CLI's TUI output", () => {
    // Shape captured from a real `setup-token` run through a PTY.
    const out =
      `${ESC}[?25l${ESC}[1mWelcome${ESC}[0m to Claude Code v2.1.114\r\n` +
      `${ESC}[2C· Opening browser to sign in…\r\n` +
      `https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=abc\r\n`;
    expect(extractLoginUrl(out)).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=abc",
    );
  });

  it("rejoins a URL that Ink hard-wrapped across lines", () => {
    // Ink wraps to the terminal width, so the URL arrives split. Without the
    // rejoin we would hand the operator half a link.
    const wrapped = "https://claude.com/cai/oauth/authorize?code=true&\nclient_id=abc123&state=xyz\n";
    expect(extractLoginUrl(wrapped)).toBe("https://claude.com/cai/oauth/authorize?code=true&client_id=abc123&state=xyz");
  });

  it("prefers the oauth URL over other links in the banner", () => {
    const out = "Read the docs at https://docs.claude.com/x\nhttps://claude.com/cai/oauth/authorize?code=true&state=z\n";
    expect(extractLoginUrl(out)).toContain("/oauth/authorize");
  });

  it("returns null while the CLI has not printed a URL yet", () => {
    // The caller polls; a premature match would show the operator a dead link.
    expect(extractLoginUrl(`${ESC}[2C· Opening browser to sign in…`)).toBeNull();
    expect(extractLoginUrl("")).toBeNull();
  });
});

describe("ptyCommand", () => {
  it("borrows a PTY from script when it is available", () => {
    const cmd = ptyCommand((c) => (c === "script" ? "/usr/bin/script" : null));
    expect(cmd).toEqual(["/usr/bin/script", "-qec", "%CMD%", "/dev/null"]);
  });

  it("falls back to socat on images without util-linux", () => {
    const cmd = ptyCommand((c) => (c === "socat" ? "/usr/bin/socat" : null));
    expect(cmd?.[0]).toBe("/usr/bin/socat");
    expect(cmd?.[1]).toBe("-");
  });

  it("reports no PTY at all, so the caller can offer the token route", () => {
    // Windows without ConPTY, locked-down sandboxes. The dialog must still be
    // usable there — it just asks for a pasted token instead.
    expect(ptyCommand(() => null)).toBeNull();
  });
});

describe("truncated URLs", () => {
  it("refuses the 80-column wrap seen in production", () => {
    // Captured verbatim: Ink wrapped at the PTY's default width and this is
    // exactly what reached the operator — a link that loads a broken page.
    const cut = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88";
    expect(cut.length).toBe(80);
    expect(isCompleteLoginUrl(cut)).toBe(false);
    expect(extractLoginUrl(cut)).toBeNull();
  });

  it("accepts the full URL the CLI emits on a wide terminal", () => {
    const full =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
      "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
      "&scope=user%3Ainference&code_challenge=zy54ON6PgYK0kCYUNx5q6IU9PD_G3mA06Hlz35eOY8M" +
      "&code_challenge_method=S256&state=yk_fWJuoidvh5VJv6Oohw7UNOINmNxqeLh-sMq887N0";
    expect(isCompleteLoginUrl(full)).toBe(true);
    expect(extractLoginUrl(full)).toBe(full);
  });
});
