import { describe, it, expect, beforeEach } from "bun:test";
import {
  discover,
  normalizeEmail,
  clearDiscoveryCache,
  hostDomain,
  type DiscoveryDeps,
} from "../assets/extensions/people/comms/_module/mail-discovery.js";

const autoconfigXml = (host: string) => `<clientConfig><emailProvider id="x">
  <displayName>Mi Hosting</displayName>
  <incomingServer type="imap"><hostname>imap.${host}</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.${host}</hostname><port>465</port><socketType>SSL</socketType></outgoingServer>
</emailProvider></clientConfig>`;

function deps(opts: { pages?: Record<string, string>; mx?: Record<string, string[]> } = {}) {
  const fetched: string[] = [];
  const mxAsked: string[] = [];
  const d: DiscoveryDeps = {
    fetchText: async (url) => { fetched.push(url); return opts.pages?.[url] ?? null; },
    resolveMx: async (domain) => { mxAsked.push(domain); return opts.mx?.[domain] ?? []; },
  };
  return { d, fetched, mxAsked };
}

beforeEach(() => clearDiscoveryCache());

describe("normalizeEmail", () => {
  it("trims and lowercases, and rejects what is not an address", () => {
    expect(normalizeEmail("  Maria@Gmail.COM ")).toBe("maria@gmail.com");
    expect(normalizeEmail("maria")).toBeNull();
    expect(normalizeEmail("maria@localhost")).toBeNull();
    expect(normalizeEmail("a b@x.com")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
  });
});

describe("discover", () => {
  it("answers a known provider from the built-in table without touching the network", async () => {
    const { d, fetched, mxAsked } = deps();
    const r = await discover("maria@gmail.com", d);
    expect(r.source).toBe("builtin");
    expect(r.provider).toEqual({ id: "gmail", name: "Gmail", auth: "app_password" });
    expect(r.imap?.host).toBe("imap.gmail.com");
    expect(r.helpUrl).toBe("https://myaccount.google.com/apppasswords");
    expect(fetched).toEqual([]);
    expect(mxAsked).toEqual([]);
  });

  it("uses the domain's own autoconfig before the ISPDB", async () => {
    const { d, fetched } = deps({
      pages: {
        "https://autoconfig.estudio.com.ar/mail/config-v1.1.xml?emailaddress=maria%40estudio.com.ar": autoconfigXml("estudio.com.ar"),
        "https://autoconfig.thunderbird.net/v1.1/estudio.com.ar": autoconfigXml("wrong.example"),
      },
    });
    const r = await discover("maria@estudio.com.ar", d);
    expect(r.source).toBe("autoconfig");
    expect(r.provider).toEqual({ id: null, name: "Mi Hosting", auth: "password" });
    expect(r.imap).toEqual({ host: "imap.estudio.com.ar", port: 993, secure: true });
    expect(fetched).not.toContain("https://autoconfig.thunderbird.net/v1.1/estudio.com.ar");
  });

  it("falls back to the .well-known autoconfig, then to the ISPDB", async () => {
    const wk = deps({ pages: { "https://estudio.com.ar/.well-known/autoconfig/mail/config-v1.1.xml": autoconfigXml("wk.example") } });
    expect((await discover("maria@estudio.com.ar", wk.d)).imap?.host).toBe("imap.wk.example");

    clearDiscoveryCache();
    const isp = deps({ pages: { "https://autoconfig.thunderbird.net/v1.1/estudio.com.ar": autoconfigXml("isp.example") } });
    const r = await discover("maria@estudio.com.ar", isp.d);
    expect(r.source).toBe("ispdb");
    expect(r.imap?.host).toBe("imap.isp.example");
  });

  it("recognises Google Workspace and Microsoft 365 behind a custom domain by MX", async () => {
    const g = deps({ mx: { "estudio.com.ar": ["aspmx.l.google.com"] } });
    const rg = await discover("maria@estudio.com.ar", g.d);
    expect(rg.source).toBe("mx");
    expect(rg.provider.id).toBe("gmail");
    expect(rg.imap?.host).toBe("imap.gmail.com");

    clearDiscoveryCache();
    const m = deps({ mx: { "estudio.com.ar": ["estudio-com-ar.mail.protection.outlook.com"] } });
    const rm = await discover("maria@estudio.com.ar", m.d);
    expect(rm.provider.auth).toBe("oauth_only");
  });

  it("asks the ISPDB with the MX host's domain when the MX is not a known provider", async () => {
    const { d } = deps({
      mx: { "estudio.com.ar": ["mx1.hostinger.com"] },
      pages: { "https://autoconfig.thunderbird.net/v1.1/hostinger.com": autoconfigXml("hostinger.com") },
    });
    const r = await discover("maria@estudio.com.ar", d);
    expect(r.source).toBe("mx");
    expect(r.imap?.host).toBe("imap.hostinger.com");
  });

  it("guesses imap./smtp. when nothing answers — never an error", async () => {
    const { d } = deps();
    const r = await discover("maria@estudio.com.ar", d);
    expect(r.source).toBe("guess");
    expect(r.provider).toEqual({ id: null, name: "estudio.com.ar", auth: "password" });
    expect(r.imap).toEqual({ host: "imap.estudio.com.ar", port: 993, secure: true });
    expect(r.smtp).toEqual({ host: "smtp.estudio.com.ar", port: 465, secure: true });
  });

  it("caches per domain", async () => {
    const { d, fetched } = deps();
    await discover("a@estudio.com.ar", d);
    const n = fetched.length;
    await discover("b@estudio.com.ar", d);
    expect(fetched.length).toBe(n);
  });

  it("never takes longer than the total budget, even if every step hangs", async () => {
    const hang = () => new Promise<never>(() => {});
    let t = 0;
    const r = await discover("maria@estudio.com.ar", {
      fetchText: (_u, timeoutMs) => new Promise((res) => setTimeout(() => res(null), Math.min(timeoutMs, 5))),
      resolveMx: hang as never,
      now: () => (t += 3000),
    });
    expect(r.source).toBe("guess");
  });

  it("skips a step whose answer is not usable XML", async () => {
    const { d } = deps({
      pages: { "https://autoconfig.estudio.com.ar/mail/config-v1.1.xml?emailaddress=maria%40estudio.com.ar": "<html>404</html>" },
    });
    expect((await discover("maria@estudio.com.ar", d)).source).toBe("guess");
  });

  it("caches autoconfig results per email when %EMAILLOCALPART% is used", async () => {
    const autoconfigWithPlaceholder = `<clientConfig><emailProvider id="x">
      <displayName>Company Mail</displayName>
      <incomingServer type="imap"><hostname>%EMAILLOCALPART%.mail.example.com</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
      <outgoingServer type="smtp"><hostname>%EMAILLOCALPART%.mail.example.com</hostname><port>465</port><socketType>SSL</socketType></outgoingServer>
    </emailProvider></clientConfig>`;
    const { d, fetched } = deps({
      pages: {
        "https://autoconfig.company.com/mail/config-v1.1.xml?emailaddress=alice%40company.com": autoconfigWithPlaceholder,
        "https://autoconfig.company.com/mail/config-v1.1.xml?emailaddress=bob%40company.com": autoconfigWithPlaceholder,
      },
    });
    const ra = await discover("alice@company.com", d);
    expect(ra.source).toBe("autoconfig");
    expect(ra.imap?.host).toBe("alice.mail.example.com");
    const n1 = fetched.length;

    // Different user at same domain gets different host from autoconfig, but query is still cached
    const rb = await discover("bob@company.com", d);
    expect(rb.source).toBe("autoconfig");
    expect(rb.imap?.host).toBe("bob.mail.example.com");
    const n2 = fetched.length;

    // Both required a fetch since they're cached per-email, not per-domain
    expect(n2).toBe(n1 + 1);
  });

  it("reuses non-autoconfig results (guess/ispdb/mx) across addresses in the same domain", async () => {
    const { d, fetched } = deps({
      pages: { "https://autoconfig.thunderbird.net/v1.1/example.com": autoconfigXml("example.com") },
    });
    const ra = await discover("alice@example.com", d);
    expect(ra.source).toBe("ispdb");
    const n1 = fetched.length;

    // Second address at same domain reuses the domain-level cache from ISPDB (no new fetch)
    const rb = await discover("bob@example.com", d);
    expect(rb.source).toBe("ispdb");
    expect(rb.imap?.host).toBe("imap.example.com");
    const n2 = fetched.length;

    // Only one fetch per domain for ispdb (cached), not per email
    expect(n2).toBe(n1);
  });
});

describe("hostDomain", () => {
  it("extracts registrable domain from MX hosts", () => {
    expect(hostDomain("mx1.hostinger.com")).toBe("hostinger.com");
    expect(hostDomain("mx.hosting.co.uk")).toBe("hosting.co.uk");
    expect(hostDomain("mx1.miempresa.com.ar")).toBe("miempresa.com.ar");
    expect(hostDomain("mail.example.com")).toBe("example.com");
  });

  it("handles trailing dots", () => {
    expect(hostDomain("mx.example.com.")).toBe("example.com");
  });

  it("handles short hosts", () => {
    expect(hostDomain("localhost")).toBe("localhost");
    expect(hostDomain("example")).toBe("example");
  });

  it("is used correctly in discover for MX ISPDB lookups", async () => {
    const { d, fetched } = deps({
      mx: { "company.com.ar": ["mx1.miempresa.com.ar"] },
      pages: { "https://autoconfig.thunderbird.net/v1.1/miempresa.com.ar": autoconfigXml("miempresa.com.ar") },
    });
    const r = await discover("maria@company.com.ar", d);
    expect(r.source).toBe("mx");
    expect(r.imap?.host).toBe("imap.miempresa.com.ar");
    expect(fetched).toContain("https://autoconfig.thunderbird.net/v1.1/miempresa.com.ar");
  });

  it("works with co.uk and similar second-level ccTLDs", async () => {
    const { d, fetched } = deps({
      mx: { "company.co.uk": ["mx.hostingprovider.co.uk"] },
      pages: { "https://autoconfig.thunderbird.net/v1.1/hostingprovider.co.uk": autoconfigXml("hostingprovider.co.uk") },
    });
    const r = await discover("user@company.co.uk", d);
    expect(r.source).toBe("mx");
    expect(fetched).toContain("https://autoconfig.thunderbird.net/v1.1/hostingprovider.co.uk");
  });
});
