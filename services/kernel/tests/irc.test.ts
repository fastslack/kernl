/**
 * IRC extension tests — exercise the protocol state machine with in-memory
 * fake clients (no sockets/TLS), the SQLite-backed bouncer/CHATHISTORY, and
 * the E2E crypto round-trip.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { ircMigrations } from "../assets/extensions/channels/irc/_module/migrations/001_irc.js";
import { IrcStore } from "../assets/extensions/channels/irc/_module/store.js";
import { SaslAuthenticator } from "../assets/extensions/channels/irc/_module/security/sasl.js";
import { IrcServer } from "../assets/extensions/channels/irc/_module/server/ircd.js";
import { IrcClient } from "../assets/extensions/channels/irc/_module/server/client.js";
import { parseLine, serialize } from "../assets/extensions/channels/irc/_module/server/parser.js";
import {
  generateIdentity,
  generateChannelKey,
  wrapChannelKey,
  unwrapChannelKey,
  encryptMessage,
  decryptMessage,
} from "../assets/extensions/channels/irc/_module/security/e2e.js";

function makeServer() {
  const db = new Database(":memory:");
  runMigrations(db, "irc", ircMigrations);
  const store = new IrcStore(db);
  const sasl = new SaslAuthenticator(store, { staticPassword: "secret" });
  const server = new IrcServer(
    {
      serverName: "irc.test",
      networkName: "test",
      motd: "hi",
      historyLimit: 100,
      requireSasl: false,
      requireClientCert: false,
    },
    store,
    sasl,
  );
  return { server, store, sasl };
}

function makeClient(server: IrcServer) {
  const out: string[] = [];
  const client = new IrcClient({ host: "127.0.0.1", sink: (l) => out.push(l) });
  server.attach(client);
  const feed = (line: string) => {
    for (const m of client.feed(line + "\r\n")) server.handle(client, m);
  };
  return { client, out, feed };
}

describe("IRCv3 parser", () => {
  it("round-trips tags, prefix, command and trailing params", () => {
    const line = "@time=2026-01-01T00:00:00.000Z;account=alice :alice!a@host PRIVMSG #room :hello world";
    const msg = parseLine(line)!;
    expect(msg.command).toBe("PRIVMSG");
    expect(msg.prefix).toBe("alice!a@host");
    expect(msg.tags.account).toBe("alice");
    expect(msg.params).toEqual(["#room", "hello world"]);
    const round = parseLine(serialize(msg))!;
    expect(round.params).toEqual(["#room", "hello world"]);
    expect(round.tags.account).toBe("alice");
  });

  it("unescapes tag values", () => {
    const msg = parseLine("@k=a\\sb\\:c CMD")!;
    expect(msg.tags.k).toBe("a b;c");
  });
});

describe("IrcServer registration + messaging", () => {
  let ctx: ReturnType<typeof makeServer>;
  beforeEach(() => {
    ctx = makeServer();
  });

  function register(server: IrcServer, nick: string) {
    const c = makeClient(server);
    c.feed("NICK " + nick);
    c.feed(`USER ${nick} 0 * :real`);
    return c;
  }

  it("welcomes a registered client", () => {
    const a = register(ctx.server, "alice");
    expect(a.out.some((l) => l.includes(" 001 alice"))).toBe(true);
    expect(a.out.some((l) => l.includes("376"))).toBe(true); // end of MOTD
  });

  it("authenticates via SASL PLAIN", async () => {
    const c = makeClient(ctx.server);
    c.feed("CAP LS 302");
    c.feed("CAP REQ :sasl");
    c.feed("AUTHENTICATE PLAIN");
    const payload = Buffer.from("alice\0alice\0secret").toString("base64");
    c.feed("AUTHENTICATE " + payload);
    // SASL verification is async (verifier may be async); let it settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(c.out.some((l) => l.includes(" 903 "))).toBe(true); // SASL success
    expect(c.client.account).toBe("alice");
  });

  it("delivers channel messages to other members and stores scrollback", () => {
    const a = register(ctx.server, "alice");
    const b = register(ctx.server, "bob");
    a.feed("JOIN #room");
    b.feed("JOIN #room");
    a.out.length = 0;
    b.out.length = 0;
    a.feed("PRIVMSG #room :hey bob");
    // bob receives it
    expect(b.out.some((l) => l.includes("PRIVMSG #room") && l.includes("hey bob"))).toBe(true);
    // sender does NOT echo without echo-message
    expect(a.out.some((l) => l.includes("PRIVMSG #room"))).toBe(false);
    // stored for the bouncer
    expect(ctx.store.history("#room", 10).length).toBe(1);
  });

  it("returns CHATHISTORY scrollback", () => {
    const a = register(ctx.server, "alice");
    a.feed("JOIN #room");
    a.feed("PRIVMSG #room :one");
    a.feed("PRIVMSG #room :two");
    a.out.length = 0;
    a.feed("CHATHISTORY LATEST #room * 10");
    const got = a.out.filter((l) => l.includes("PRIVMSG #room"));
    expect(got.length).toBe(2);
    expect(got[0]).toContain("one");
    expect(got[1]).toContain("two");
  });

  it("rejects sending to a non-member channel with +n", () => {
    const a = register(ctx.server, "alice");
    a.feed("JOIN #room"); // alice is in
    const b = register(ctx.server, "bob"); // bob is NOT in #room
    b.out.length = 0;
    b.feed("PRIVMSG #room :sneaky");
    expect(b.out.some((l) => l.includes(" 404 "))).toBe(true); // CANNOTSENDTOCHAN
  });
});

describe("E2E crypto", () => {
  it("wraps/unwraps a channel key for a member", () => {
    const alice = generateIdentity();
    const key = generateChannelKey();
    const wrapped = wrapChannelKey(key, alice.publicKey);
    expect(unwrapChannelKey(wrapped, alice.privateKey)).toBe(key);
  });

  it("encrypts/decrypts a message with the channel key", () => {
    const key = generateChannelKey();
    const wire = encryptMessage("secret message", key);
    expect(wire).not.toContain("secret message");
    expect(decryptMessage(wire, key)).toBe("secret message");
  });

  it("fails to unwrap with the wrong private key", () => {
    const alice = generateIdentity();
    const mallory = generateIdentity();
    const wrapped = wrapChannelKey(generateChannelKey(), alice.publicKey);
    expect(() => unwrapChannelKey(wrapped, mallory.privateKey)).toThrow();
  });
});
