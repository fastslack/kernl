import { describe, it, expect } from "bun:test";
import {
  KNOWN_PROVIDERS,
  providerForDomain,
  providerForMx,
} from "../assets/extensions/people/comms/_module/mail-providers.js";
import {
  parseAutoconfigXml,
  httpsFetchText,
  AUTOCONFIG_MAX_BYTES,
} from "../assets/extensions/people/comms/_module/mail-autoconfig.js";

describe("providerForDomain", () => {
  it("finds Gmail, Yahoo, iCloud and Outlook by email domain", () => {
    expect(providerForDomain("gmail.com")?.id).toBe("gmail");
    expect(providerForDomain("googlemail.com")?.id).toBe("gmail");
    expect(providerForDomain("yahoo.com.ar")?.id).toBe("yahoo");
    expect(providerForDomain("me.com")?.id).toBe("icloud");
    expect(providerForDomain("hotmail.com")?.auth).toBe("oauth_only");
    expect(providerForDomain("proton.me")?.auth).toBe("bridge");
  });

  it("is case-insensitive and returns null for unknown domains", () => {
    expect(providerForDomain("GMAIL.COM")?.id).toBe("gmail");
    expect(providerForDomain("estudio.com.ar")).toBeNull();
  });

  it("every provider that is not oauth_only/bridge has both servers", () => {
    for (const p of KNOWN_PROVIDERS) {
      if (p.auth === "oauth_only" || p.auth === "bridge") continue;
      expect(p.imap, p.id).toBeDefined();
      expect(p.smtp, p.id).toBeDefined();
    }
  });

  it("every app_password provider links to where the password is created", () => {
    for (const p of KNOWN_PROVIDERS.filter((x) => x.auth === "app_password")) {
      expect(p.helpUrl?.startsWith("https://"), p.id).toBe(true);
    }
  });
});

describe("providerForMx", () => {
  it("maps Google Workspace and Microsoft 365 MX hosts", () => {
    expect(providerForMx("aspmx.l.google.com")?.id).toBe("gmail");
    expect(providerForMx("smtp.google.com.")?.id).toBe("gmail");
    expect(providerForMx("estudio-com-ar.mail.protection.outlook.com")?.auth).toBe("oauth_only");
  });

  it("only matches on a label boundary", () => {
    expect(providerForMx("mx.notgoogle.com")).toBeNull();
    expect(providerForMx("mx1.hostinger.com")).toBeNull();
  });
});

const XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="hostinger.com">
    <displayName>Hostinger Mail</displayName>
    <incomingServer type="pop3">
      <hostname>pop.hostinger.com</hostname><port>995</port><socketType>SSL</socketType>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.hostinger.com</hostname><port>993</port><socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.%EMAILDOMAIN%</hostname><port>587</port><socketType>STARTTLS</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

describe("parseAutoconfigXml", () => {
  it("takes the first IMAP and SMTP server and resolves placeholders", () => {
    expect(parseAutoconfigXml(XML, "maria@estudio.com.ar")).toEqual({
      name: "Hostinger Mail",
      imap: { host: "imap.hostinger.com", port: 993, secure: true },
      smtp: { host: "smtp.estudio.com.ar", port: 587, secure: false },
    });
  });

  it("skips plain-text servers and returns null when no IMAP is usable", () => {
    const plainOnly = XML.replace(/<incomingServer type="imap">[\s\S]*?<\/incomingServer>/,
      `<incomingServer type="imap"><hostname>imap.x.com</hostname><port>143</port><socketType>plain</socketType></incomingServer>`);
    expect(parseAutoconfigXml(plainOnly, "a@x.com")).toBeNull();
    expect(parseAutoconfigXml("<clientConfig/>", "a@x.com")).toBeNull();
    expect(parseAutoconfigXml("not xml at all", "a@x.com")).toBeNull();
  });
});

describe("httpsFetchText", () => {
  const fake = (res: { ok?: boolean; url: string; body: string } | Error) =>
    async () => {
      if (res instanceof Error) throw res;
      return { ok: res.ok ?? true, url: res.url, text: async () => res.body };
    };

  it("returns the body of an https response", async () => {
    expect(await httpsFetchText("https://a.com/x", 1000, fake({ url: "https://a.com/x", body: "<ok/>" }))).toBe("<ok/>");
  });

  it("refuses non-https urls and redirects that land on http", async () => {
    expect(await httpsFetchText("http://a.com/x", 1000, fake({ url: "http://a.com/x", body: "<ok/>" }))).toBeNull();
    expect(await httpsFetchText("https://a.com/x", 1000, fake({ url: "http://evil.com/x", body: "<ok/>" }))).toBeNull();
  });

  it("returns null on non-2xx, oversize bodies and network errors", async () => {
    expect(await httpsFetchText("https://a.com/x", 1000, fake({ ok: false, url: "https://a.com/x", body: "" }))).toBeNull();
    expect(await httpsFetchText("https://a.com/x", 1000,
      fake({ url: "https://a.com/x", body: "x".repeat(AUTOCONFIG_MAX_BYTES + 1) }))).toBeNull();
    expect(await httpsFetchText("https://a.com/x", 1000, fake(new Error("ECONNRESET")))).toBeNull();
  });

  it("gives up when the response does not arrive in time", async () => {
    const slow = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const t0 = Date.now();
    expect(await httpsFetchText("https://a.com/x", 50, slow)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
