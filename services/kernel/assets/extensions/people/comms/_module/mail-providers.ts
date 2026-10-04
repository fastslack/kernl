/**
 * Mail providers Kernl recognises without asking anyone: enough to connect
 * the common consumer mailboxes from an email address alone, and to explain
 * the ones that cannot be connected with a password.
 *
 * Hosts, ports and help links come from each provider's published setup
 * page. A wrong entry shows up as `unreachable`/`auth_failed` at connect time
 * and can be worked around from the Advanced panel.
 */

export type MailAuth = "password" | "app_password" | "oauth_only" | "bridge";

export interface ServerEndpoint {
  host: string;
  port: number;
  secure: boolean;
}

export interface KnownProvider {
  id: string;
  name: string;
  domains: string[];
  mxSuffixes?: string[];
  auth: MailAuth;
  imap?: ServerEndpoint;
  smtp?: ServerEndpoint;
  helpUrl?: string;
}

const tls = (host: string, port = 993): ServerEndpoint => ({ host, port, secure: true });
const starttls = (host: string, port = 587): ServerEndpoint => ({ host, port, secure: false });

export const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    id: "gmail", name: "Gmail", auth: "app_password",
    domains: ["gmail.com", "googlemail.com"],
    mxSuffixes: ["google.com", "googlemail.com"],
    imap: tls("imap.gmail.com"), smtp: tls("smtp.gmail.com", 465),
    helpUrl: "https://myaccount.google.com/apppasswords",
  },
  {
    id: "yahoo", name: "Yahoo Mail", auth: "app_password",
    domains: ["yahoo.com", "ymail.com", "rocketmail.com", "yahoo.com.ar", "yahoo.com.mx", "yahoo.es", "yahoo.co.uk", "yahoo.fr", "yahoo.de"],
    mxSuffixes: ["yahoodns.net"],
    imap: tls("imap.mail.yahoo.com"), smtp: tls("smtp.mail.yahoo.com", 465),
    helpUrl: "https://login.yahoo.com/myaccount/security/",
  },
  {
    id: "icloud", name: "iCloud Mail", auth: "app_password",
    domains: ["icloud.com", "me.com", "mac.com"],
    mxSuffixes: ["mail.icloud.com"],
    imap: tls("imap.mail.me.com"), smtp: starttls("smtp.mail.me.com"),
    helpUrl: "https://account.apple.com/account/manage",
  },
  {
    id: "aol", name: "AOL Mail", auth: "app_password",
    domains: ["aol.com"],
    mxSuffixes: ["mx.aol.com"],
    imap: tls("imap.aol.com"), smtp: tls("smtp.aol.com", 465),
    helpUrl: "https://login.aol.com/account/security",
  },
  {
    id: "outlook", name: "Outlook", auth: "oauth_only",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.es", "hotmail.es", "hotmail.com.ar", "live.com.ar"],
    mxSuffixes: ["mail.protection.outlook.com", "olc.protection.outlook.com"],
  },
  {
    id: "zoho", name: "Zoho Mail", auth: "password",
    domains: ["zoho.com", "zohomail.com"],
    mxSuffixes: ["zoho.com", "zoho.eu"],
    imap: tls("imap.zoho.com"), smtp: tls("smtp.zoho.com", 465),
  },
  {
    id: "fastmail", name: "Fastmail", auth: "app_password",
    domains: ["fastmail.com", "fastmail.fm"],
    mxSuffixes: ["messagingengine.com"],
    imap: tls("imap.fastmail.com"), smtp: tls("smtp.fastmail.com", 465),
    helpUrl: "https://app.fastmail.com/settings/security/apppasswords",
  },
  {
    id: "gmx", name: "GMX", auth: "password",
    domains: ["gmx.net", "gmx.de", "gmx.at", "gmx.ch"],
    mxSuffixes: ["gmx.net"],
    imap: tls("imap.gmx.net"), smtp: tls("mail.gmx.net", 465),
  },
  {
    id: "gmx-com", name: "GMX", auth: "password",
    domains: ["gmx.com", "gmx.us"],
    imap: tls("imap.gmx.com"), smtp: tls("mail.gmx.com", 465),
  },
  {
    id: "webde", name: "WEB.DE", auth: "password",
    domains: ["web.de"],
    mxSuffixes: ["web.de"],
    imap: tls("imap.web.de"), smtp: starttls("smtp.web.de"),
  },
  {
    id: "yandex", name: "Yandex Mail", auth: "app_password",
    domains: ["yandex.com", "yandex.ru", "ya.ru"],
    mxSuffixes: ["yandex.net", "yandex.ru"],
    imap: tls("imap.yandex.com"), smtp: tls("smtp.yandex.com", 465),
    helpUrl: "https://id.yandex.com/security/app-passwords",
  },
  {
    id: "proton", name: "Proton Mail", auth: "bridge",
    domains: ["proton.me", "protonmail.com", "protonmail.ch", "pm.me"],
    mxSuffixes: ["protonmail.ch"],
  },
];

const clean = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");

export function providerForDomain(domain: string): KnownProvider | null {
  const d = clean(domain);
  return KNOWN_PROVIDERS.find((p) => p.domains.includes(d)) ?? null;
}

export function providerForMx(mxHost: string): KnownProvider | null {
  const h = clean(mxHost);
  return KNOWN_PROVIDERS.find((p) =>
    (p.mxSuffixes ?? []).some((s) => h === s || h.endsWith(`.${s}`)),
  ) ?? null;
}
