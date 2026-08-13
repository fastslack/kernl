/**
 * IRC upstream bouncer tests — the outbound half of the extension. Sockets and
 * timers are faked, so the whole state machine (registration, SASL, backoff,
 * rate limiting, relaying) runs without a network or a real second of waiting.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { allIrcMigrations } from "../assets/extensions/channels/irc/_module/migrations/index.js";
import { IrcStore } from "../assets/extensions/channels/irc/_module/store.js";
import { SaslAuthenticator } from "../assets/extensions/channels/irc/_module/security/sasl.js";
import { IrcServer } from "../assets/extensions/channels/irc/_module/server/ircd.js";
import { IrcClient } from "../assets/extensions/channels/irc/_module/server/client.js";
import { UpstreamStore } from "../assets/extensions/channels/irc/_module/upstream/store.js";
import { UpstreamManager } from "../assets/extensions/channels/irc/_module/upstream/manager.js";
import {
  UpstreamConnection,
  BACKOFF_MS,
  CONNECT_TIMEOUT_MS,
  type SocketFactory,
  type SocketHandlers,
} from "../assets/extensions/channels/irc/_module/upstream/connection.js";
import {
  toLocalTarget,
  parseLocalTarget,
  toLocalNick,
  toNetworkSlug,
} from "../assets/extensions/channels/irc/_module/upstream/naming.js";
import { NETWORK_PRESETS, findPreset } from "../assets/extensions/channels/irc/_module/upstream/networks.js";
import { normalizeWsFrame } from "../assets/extensions/channels/irc/_module/irc-transport.js";
import { generateKey } from "../src/core/crypto.js";

// ── fakes ─────────────────────────────────────────────────────

type TimerId = ReturnType<typeof setTimeout>;

/** Manual clock: timers only fire when the test advances time. */
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers: { id: number; fn: () => void; at: number }[] = [];
  return {
    setTimer(fn: () => void, ms: number): TimerId {
      const id = ++seq;
      timers.push({ id, fn, at: now + ms });
      return id as unknown as TimerId;
    },
    clearTimer(t: TimerId): void {
      const i = timers.findIndex((x) => x.id === (t as unknown as number));
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number): void {
      now += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
    },
    pending(): number {
      return timers.length;
    },
  };
}

interface FakeSocket {
  sent: string[];
  handlers: SocketHandlers;
  ended: boolean;
}

/** Records every socket the connection opens, so tests can drive them. */
function makeSocketHarness() {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = (_opts, handlers) => {
    const sock: FakeSocket = { sent: [], handlers, ended: false };
    sockets.push(sock);
    return {
      write: (data: string) => {
        sock.sent.push(data.replace(/\r\n$/, ""));
      },
      end: () => {
        sock.ended = true;
      },
    };
  };
  return {
    factory,
    sockets,
    latest: () => sockets[sockets.length - 1],
    /** Feed complete lines from the network. */
    feed(lines: string[]) {
      sockets[sockets.length - 1].handlers.onData(lines.map((l) => l + "\r\n").join(""));
    },
  };
}

function makeConnection(
  overrides: Partial<{ saslAccount: string; password: string }> = {},
) {
  const clock = makeClock();
  const harness = makeSocketHarness();
  const conn = new UpstreamConnection(
    {
      id: "u1",
      network: "dalnet",
      host: "irc.dal.net",
      port: 6697,
      tls: true,
      nick: "pepe",
      username: "pepe",
      realname: "Pepe",
      saslAccount: overrides.saslAccount ?? "",
      password: overrides.password ?? "",
    },
    {
      socketFactory: harness.factory,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      random: () => 0.5, // no jitter variance in tests
    },
  );
  return { conn, clock, harness };
}

/** Drive a connection all the way to registered. */
function bringUp(c: ReturnType<typeof makeConnection>) {
  c.conn.start();
  c.harness.latest().handlers.onOpen();
  c.harness.feed([":irc.dal.net CAP * LS :multi-prefix sasl", ":irc.dal.net 001 pepe :Welcome"]);
  c.clock.advance(0);
}

// ── naming ────────────────────────────────────────────────────

describe("upstream naming", () => {
  it("maps a channel to a suffixed local buffer and back", () => {
    expect(toLocalTarget("dalnet", "#argentina")).toBe("#argentina/dalnet");
    expect(parseLocalTarget("#argentina/dalnet")).toEqual({
      network: "dalnet",
      target: "#argentina",
      isChannel: true,
    });
  });

  it("maps a query the same way and flags it as not a channel", () => {
    expect(toLocalTarget("quakenet", "Pepe")).toBe("Pepe/quakenet");
    expect(parseLocalTarget("Pepe/quakenet")).toEqual({
      network: "quakenet",
      target: "Pepe",
      isChannel: false,
    });
  });

  it("splits on the last separator so upstream names may contain slashes", () => {
    expect(parseLocalTarget("#foo/bar/libera")).toEqual({
      network: "libera",
      target: "#foo/bar",
      isChannel: true,
    });
  });

  it("returns null for native targets and malformed names", () => {
    expect(parseLocalTarget("#general")).toBeNull();
    expect(parseLocalTarget("")).toBeNull();
    expect(parseLocalTarget("#argentina/")).toBeNull();
    expect(parseLocalTarget("/dalnet")).toBeNull();
    expect(parseLocalTarget("#chan/NotASlug")).toBeNull();
    expect(parseLocalTarget("#/dalnet")).toBeNull();
  });

  it("normalises user input into a slug", () => {
    expect(toNetworkSlug("DALnet")).toBe("dalnet");
    expect(toNetworkSlug("Libera.Chat")).toBe("libera-chat");
  });

  it("namespaces upstream nicks", () => {
    expect(toLocalNick("dalnet", "Pepe")).toBe("Pepe/dalnet");
  });
});

describe("network presets", () => {
  it("ships the classic networks with TLS defaults", () => {
    for (const slug of ["libera", "dalnet", "quakenet", "undernet", "brasnet"]) {
      const p = findPreset(slug);
      expect(p).toBeDefined();
      expect(p!.tls).toBe(true);
      expect(p!.port).toBe(6697);
    }
    expect(NETWORK_PRESETS.length).toBeGreaterThanOrEqual(10);
  });
});

// ── connection state machine ──────────────────────────────────

describe("UpstreamConnection", () => {
  it("registers with CAP, NICK and USER", () => {
    const c = makeConnection();
    c.conn.start();
    c.harness.latest().handlers.onOpen();
    const sent = c.harness.latest().sent;
    expect(sent[0]).toBe("CAP LS 302");
    expect(sent[1]).toBe("NICK pepe");
    expect(sent[2]).toBe("USER pepe 0 * :Pepe");
  });

  it("authenticates with SASL PLAIN when credentials are configured", () => {
    const c = makeConnection({ saslAccount: "pepe", password: "hunter2" });
    c.conn.start();
    c.harness.latest().handlers.onOpen();
    c.harness.feed([":irc.dal.net CAP * LS :multi-prefix sasl"]);
    expect(c.harness.latest().sent).toContain("CAP REQ :multi-prefix sasl");
    c.harness.feed([":irc.dal.net CAP * ACK :multi-prefix sasl"]);
    expect(c.harness.latest().sent).toContain("AUTHENTICATE PLAIN");
    c.harness.feed(["AUTHENTICATE +"]);
    const expected = Buffer.from("pepe\0pepe\0hunter2").toString("base64");
    expect(c.harness.latest().sent).toContain(`AUTHENTICATE ${expected}`);
    c.harness.feed([":irc.dal.net 903 pepe :SASL authentication successful"]);
    expect(c.harness.latest().sent).toContain("CAP END");
  });

  it("does not ask for SASL when no credentials are configured", () => {
    const c = makeConnection();
    c.conn.start();
    c.harness.latest().handlers.onOpen();
    c.harness.feed([":irc.dal.net CAP * LS :multi-prefix sasl"]);
    expect(c.harness.latest().sent.some((l) => l.includes("sasl"))).toBe(false);
  });

  it("stops retrying after an auth failure instead of hammering the network", () => {
    const c = makeConnection({ saslAccount: "pepe", password: "wrong" });
    c.conn.start();
    c.harness.latest().handlers.onOpen();
    c.harness.feed([":irc.dal.net 904 pepe :SASL authentication failed"]);
    expect(c.conn.state).toBe("error");
    expect(c.conn.lastError).toContain("authentication failed");
    // No reconnect was scheduled, and time passing changes nothing.
    expect(c.clock.pending()).toBe(0);
    c.clock.advance(600_000);
    expect(c.harness.sockets.length).toBe(1);
  });

  it("reconnects with backoff after a socket error", () => {
    const c = makeConnection();
    c.conn.start();
    c.harness.latest().handlers.onOpen();
    c.harness.latest().handlers.onError(new Error("ECONNRESET"));
    expect(c.conn.state).toBe("reconnecting");
    c.clock.advance(BACKOFF_MS[0] - 1);
    expect(c.harness.sockets.length).toBe(1); // not yet
    c.clock.advance(2);
    expect(c.harness.sockets.length).toBe(2); // reconnected
  });

  it("gives up on a handshake that never completes and retries", () => {
    const c = makeConnection();
    c.conn.start();
    // The TCP socket is up but TLS never finishes: onOpen never fires. Seen for
    // real against both DALnet and Libera depending on which round-robin node
    // answers, and it used to pin the connection at "connecting" forever.
    expect(c.conn.state).toBe("connecting");
    c.clock.advance(CONNECT_TIMEOUT_MS + 1);
    expect(c.conn.state).toBe("reconnecting");
    expect(c.conn.lastError).toContain("timed out");
    c.clock.advance(BACKOFF_MS[0]);
    expect(c.harness.sockets.length).toBe(2);
  });

  it("times out a registration that stalls after the socket opens", () => {
    const c = makeConnection();
    c.conn.start();
    c.harness.latest().handlers.onOpen(); // registering, but no 001 ever comes
    expect(c.conn.state).toBe("registering");
    c.clock.advance(CONNECT_TIMEOUT_MS + 1);
    expect(c.conn.state).toBe("reconnecting");
  });

  it("ignores events from a socket it already abandoned", () => {
    const c = makeConnection();
    c.conn.start();
    const stale = c.harness.latest();
    c.clock.advance(CONNECT_TIMEOUT_MS + 1);
    c.clock.advance(BACKOFF_MS[0]);
    expect(c.harness.sockets.length).toBe(2);
    // The dead socket finally reports back. It must not trigger another cycle.
    stale.handlers.onClose();
    stale.handlers.onData(":irc.dal.net 001 pepe :Welcome\r\n");
    c.clock.advance(BACKOFF_MS[1]);
    expect(c.harness.sockets.length).toBe(2);
    expect(c.conn.state).not.toBe("connected");
  });

  it("clears the timeout once registered so a live link is never dropped", () => {
    const c = makeConnection();
    bringUp(c);
    expect(c.conn.state).toBe("connected");
    c.clock.advance(CONNECT_TIMEOUT_MS * 3);
    expect(c.conn.state).toBe("connected");
    expect(c.harness.sockets.length).toBe(1);
  });

  it("mangles the nick on 433 and gives up after two tries", () => {
    const c = makeConnection();
    c.conn.start();
    c.harness.latest().handlers.onOpen();
    c.harness.feed([":irc.dal.net 433 * pepe :Nickname is already in use"]);
    expect(c.harness.latest().sent).toContain("NICK pepe_");
    c.harness.feed([":irc.dal.net 433 * pepe_ :Nickname is already in use"]);
    expect(c.harness.latest().sent).toContain("NICK pepe__");
    c.harness.feed([":irc.dal.net 433 * pepe__ :Nickname is already in use"]);
    expect(c.conn.state).toBe("error");
    expect(c.conn.lastError).toContain("in use");
  });

  it("answers PING to stay alive", () => {
    const c = makeConnection();
    bringUp(c);
    c.harness.feed(["PING :abc123"]);
    expect(c.harness.latest().sent).toContain("PONG abc123");
  });

  it("paces outbound messages instead of flooding", () => {
    const c = makeConnection();
    bringUp(c);
    const before = c.harness.latest().sent.length;
    c.conn.privmsg("#argentina", "one");
    c.conn.privmsg("#argentina", "two");
    c.clock.advance(0);
    expect(c.harness.latest().sent.length).toBe(before + 1); // only the first
    c.clock.advance(500);
    expect(c.harness.latest().sent.length).toBe(before + 2);
  });
});

// ── manager: relay in both directions ─────────────────────────

function makeRelay() {
  const db = new Database(":memory:");
  runMigrations(db, "irc", allIrcMigrations);
  const ircStore = new IrcStore(db);
  const sasl = new SaslAuthenticator(ircStore, { staticPassword: "secret" });
  const server = new IrcServer(
    {
      serverName: "irc.test",
      networkName: "test",
      motd: "hi",
      historyLimit: 100,
      requireSasl: false,
      requireClientCert: false,
    },
    ircStore,
    sasl,
  );
  const clock = makeClock();
  const harness = makeSocketHarness();
  const store = new UpstreamStore(db, generateKey());
  const manager = new UpstreamManager({
    server,
    store,
    ircStore,
    serverName: "irc.test",
    socketFactory: harness.factory,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  });
  server.onBeforeJoin = (client, channel) => manager.handleBeforeJoin(client, channel);
  server.onPart = (client, channel) => manager.handlePart(client, channel);
  server.onMessage = (ev) => {
    manager.handleOutbound(ev);
  };

  const row = store.create({
    account: "alice",
    network: "dalnet",
    host: "irc.dal.net",
    nick: "pepe",
    password: "hunter2",
  });

  /** A registered local client owned by the account that owns the upstream. */
  function login(nick: string, account: string) {
    const out: string[] = [];
    const client = new IrcClient({ host: "127.0.0.1", sink: (l) => out.push(l) });
    server.attach(client);
    const feed = (line: string) => {
      for (const m of client.feed(line + "\r\n")) server.handle(client, m);
    };
    feed("NICK " + nick);
    feed(`USER ${nick} 0 * :real`);
    client.account = account;
    return { client, out, feed };
  }

  /** Bring the upstream link up and drain the registration burst. */
  function connect() {
    manager.connect(row.id);
    harness.latest().handlers.onOpen();
    harness.feed([":irc.dal.net 001 pepe :Welcome"]);
    clock.advance(0);
  }

  return { db, server, ircStore, store, manager, harness, clock, row, login, connect };
}

describe("UpstreamManager relay", () => {
  let r: ReturnType<typeof makeRelay>;
  beforeEach(() => {
    r = makeRelay();
  });

  it("mirrors an upstream channel message into the local buffer and scrollback", () => {
    r.connect();
    const alice = r.login("alice", "alice");
    alice.feed("JOIN #argentina/dalnet");
    alice.out.length = 0;

    r.harness.feed([":Juan!j@dal PRIVMSG #argentina :hola gente"]);

    expect(alice.out.some((l) => l.includes("PRIVMSG #argentina/dalnet") && l.includes("hola gente"))).toBe(true);
    const history = r.ircStore.history("#argentina/dalnet", 10);
    expect(history.some((m) => m.payload === "hola gente" && m.sender === "Juan/dalnet")).toBe(true);
  });

  it("forwards a local message to the upstream network with the suffix stripped", () => {
    r.connect();
    const alice = r.login("alice", "alice");
    alice.feed("JOIN #argentina/dalnet");
    r.clock.advance(0);
    const before = r.harness.latest().sent.length;

    alice.feed("PRIVMSG #argentina/dalnet :buenas");
    r.clock.advance(0);

    const sent = r.harness.latest().sent.slice(before);
    expect(sent).toContain("PRIVMSG #argentina :buenas");
  });

  it("joins the upstream channel and rejoins it after a reconnect", () => {
    r.connect();
    const alice = r.login("alice", "alice");
    alice.feed("JOIN #argentina/dalnet");
    r.clock.advance(0);
    expect(r.harness.latest().sent).toContain("JOIN #argentina");
    expect(r.store.channels(r.row.id).map((c) => c.channel)).toEqual(["#argentina"]);

    // The link drops and comes back: membership must be restored.
    r.harness.latest().handlers.onClose();
    r.clock.advance(10_000);
    r.harness.latest().handlers.onOpen();
    r.harness.feed([":irc.dal.net 001 pepe :Welcome"]);
    r.clock.advance(0);
    expect(r.harness.latest().sent).toContain("JOIN #argentina");
  });

  it("lets a client with no SASL account own its networks by nick", () => {
    // Without a SASL password configured nobody can authenticate, so requiring
    // an account made the whole feature unusable on a single-owner kernel.
    r.connect();
    const out: string[] = [];
    const client = new IrcClient({ host: "127.0.0.1", sink: (l) => out.push(l) });
    r.server.attach(client);
    const feed = (line: string) => {
      for (const m of client.feed(line + "\r\n")) r.server.handle(client, m);
    };
    feed("NICK alice"); // note: no account is ever set
    feed("USER alice 0 * :real");
    expect(client.account).toBeNull();

    out.length = 0;
    feed("JOIN #argentina/dalnet");
    r.clock.advance(0);
    expect(out.some((l) => l.includes("403"))).toBe(false);
    expect(r.harness.latest().sent).toContain("JOIN #argentina");

    const before = r.harness.latest().sent.length;
    feed("PRIVMSG #argentina/dalnet :sin sasl y funciona");
    r.clock.advance(0);
    expect(r.harness.latest().sent.slice(before)).toContain("PRIVMSG #argentina :sin sasl y funciona");
  });

  it("still prefers the SASL account over the nick when one exists", () => {
    r.connect();
    // 'bob' authenticated as account 'bob', which owns no networks: the nick
    // fallback must not let him ride on someone else's dalnet row.
    const bob = r.login("bob", "bob");
    bob.out.length = 0;
    bob.feed("JOIN #argentina/dalnet");
    expect(bob.out.some((l) => l.includes("403"))).toBe(true);
  });

  it("refuses to join a network the account does not own", () => {
    r.connect();
    const bob = r.login("bob", "bob");
    bob.out.length = 0;
    bob.feed("JOIN #argentina/dalnet");
    expect(bob.out.some((l) => l.includes("403") && l.includes("dalnet"))).toBe(true);
    expect(bob.out.some((l) => l.includes("JOIN"))).toBe(false);
  });

  it("relays a private message to every session of the owning account", () => {
    r.connect();
    const alice = r.login("alice", "alice");
    alice.out.length = 0;

    r.harness.feed([":Juan!j@dal PRIVMSG pepe :hola en privado"]);

    expect(alice.out.some((l) => l.includes("Juan/dalnet") && l.includes("hola en privado"))).toBe(true);
    const history = r.ircStore.history("Juan/dalnet", 10);
    expect(history.some((m) => m.payload === "hola en privado")).toBe(true);
  });

  it("populates the mirrored member list from NAMES", () => {
    r.connect();
    const alice = r.login("alice", "alice");
    alice.feed("JOIN #argentina/dalnet");
    alice.out.length = 0;

    r.harness.feed([
      ":irc.dal.net 353 pepe = #argentina :@Juan +Maria pepe",
      ":irc.dal.net 366 pepe #argentina :End of /NAMES list",
    ]);
    alice.feed("NAMES #argentina/dalnet");

    const names = alice.out.find((l) => l.includes("353"));
    expect(names).toContain("Juan/dalnet");
    expect(names).toContain("Maria/dalnet");
  });

  it("tells the user instead of silently dropping when the network is down", () => {
    const alice = r.login("alice", "alice");
    alice.feed("JOIN #argentina/dalnet");
    alice.out.length = 0;
    alice.feed("PRIVMSG #argentina/dalnet :nadie me escucha");
    expect(alice.out.some((l) => l.includes("not connected"))).toBe(true);
  });

  it("leaves a native channel alone", () => {
    r.connect();
    const alice = r.login("alice", "alice");
    alice.feed("JOIN #general");
    r.clock.advance(0);
    const before = r.harness.latest().sent.length;
    alice.feed("PRIVMSG #general :local only");
    r.clock.advance(0);
    expect(r.harness.latest().sent.length).toBe(before);
  });
});

// ── websocket gateway framing ─────────────────────────────────

describe("WebSocket frame normalisation", () => {
  it("treats a terminator-less frame as one complete line", () => {
    // What every browser client sends: one command, no CRLF.
    expect(normalizeWsFrame("NICK alice")).toBe("NICK alice\r\n");
  });

  it("leaves an already-terminated frame alone", () => {
    expect(normalizeWsFrame("NICK alice\r\n")).toBe("NICK alice\r\n");
    expect(normalizeWsFrame("NICK alice\n")).toBe("NICK alice\n");
  });

  it("keeps a batched frame intact", () => {
    expect(normalizeWsFrame("CAP LS 302\r\nNICK alice\r\n")).toBe("CAP LS 302\r\nNICK alice\r\n");
    expect(normalizeWsFrame("CAP LS 302\r\nNICK alice")).toBe("CAP LS 302\r\nNICK alice\r\n");
  });

  it("feeds a raw frame through to a parsed command", () => {
    const db = new Database(":memory:");
    runMigrations(db, "irc", allIrcMigrations);
    const store = new IrcStore(db);
    const server = new IrcServer(
      { serverName: "irc.test", networkName: "test", motd: "hi", historyLimit: 50, requireSasl: false, requireClientCert: false },
      store,
      new SaslAuthenticator(store, {}),
    );
    const out: string[] = [];
    const client = new IrcClient({ host: "ws", sink: (l) => out.push(l) });
    server.attach(client);
    for (const frame of ["NICK alice", "USER alice 0 * :real"]) {
      for (const msg of client.feed(normalizeWsFrame(frame))) server.handle(client, msg);
    }
    expect(out.some((l) => l.includes(" 001 alice"))).toBe(true);
  });
});

// ── secrets ───────────────────────────────────────────────────

describe("UpstreamStore secrets", () => {
  function makeStore(key: string) {
    const db = new Database(":memory:");
    runMigrations(db, "irc", allIrcMigrations);
    return new UpstreamStore(db, key);
  }

  it("round-trips a password without storing it in the clear", () => {
    const store = makeStore(generateKey());
    const row = store.create({
      account: "alice",
      network: "dalnet",
      host: "irc.dal.net",
      nick: "pepe",
      password: "hunter2",
    });
    expect(row.secrets).not.toContain("hunter2");
    expect(store.password(row)).toBe("hunter2");
    expect(store.hasPassword(row)).toBe(true);
  });

  it("keeps the stored password on an update that omits it, and clears it on empty", () => {
    const store = makeStore(generateKey());
    const row = store.create({
      account: "alice",
      network: "dalnet",
      host: "irc.dal.net",
      nick: "pepe",
      password: "hunter2",
    });
    const kept = store.update(row.id, { nick: "pepito" })!;
    expect(kept.nick).toBe("pepito");
    expect(store.password(kept)).toBe("hunter2");

    const cleared = store.update(row.id, { password: "" })!;
    expect(store.password(cleared)).toBe("");
    expect(store.hasPassword(cleared)).toBe(false);
  });

  it("scopes rows to their account", () => {
    const store = makeStore(generateKey());
    store.create({ account: "alice", network: "dalnet", host: "h", nick: "pepe" });
    store.create({ account: "bob", network: "libera", host: "h", nick: "bob" });
    expect(store.list("alice").map((r) => r.network)).toEqual(["dalnet"]);
    expect(store.find("alice", "libera")).toBeUndefined();
  });
});

describe("UpstreamManager status", () => {
  it("never exposes the password, only whether one is set", () => {
    const r = makeRelay();
    const status = r.manager.status("alice");
    expect(status).toHaveLength(1);
    expect(status[0].hasPassword).toBe(true);
    expect(JSON.stringify(status)).not.toContain("hunter2");
  });
});
