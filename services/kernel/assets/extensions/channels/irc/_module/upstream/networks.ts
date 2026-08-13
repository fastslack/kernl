/**
 * Known public IRC networks, offered as presets when adding an upstream.
 *
 * This is data, not configuration: adding a network is a commit, not a
 * migration. Users can always enter an arbitrary host instead.
 *
 * Hosts are the networks' round-robin records rather than individual servers,
 * so each connection lands on a node near the kernel.
 */

export interface NetworkPreset {
  /** Slug used as the buffer suffix (#channel/<slug>). */
  slug: string;
  name: string;
  host: string;
  port: number;
  tls: boolean;
  /** What the network is known for — shown in the picker. */
  note: string;
}

export const NETWORK_PRESETS: NetworkPreset[] = [
  {
    slug: "libera",
    name: "Libera.Chat",
    host: "irc.libera.chat",
    port: 6697,
    tls: true,
    note: "Free software: Arch, Debian, the kernel. The largest network today.",
  },
  {
    slug: "oftc",
    name: "OFTC",
    host: "irc.oftc.net",
    port: 6697,
    tls: true,
    note: "Debian, Tor and infrastructure projects.",
  },
  {
    slug: "dalnet",
    name: "DALnet",
    host: "irc.dal.net",
    port: 6697,
    tls: true,
    note: "Classic network, strong in Latin America and Asia.",
  },
  {
    slug: "quakenet",
    name: "QuakeNet",
    host: "irc.quakenet.org",
    port: 6697,
    tls: true,
    note: "Gaming. Peaked at 240k users in 2005.",
  },
  {
    slug: "undernet",
    name: "Undernet",
    host: "irc.undernet.org",
    port: 6697,
    tls: true,
    note: "Home of #argentina, #mexico and #chile through the 2000s.",
  },
  {
    slug: "brasnet",
    name: "BRASnet",
    host: "irc.brasnet.org",
    port: 6697,
    tls: true,
    note: "The largest network in Brazil.",
  },
  {
    slug: "chatzona",
    name: "ChatZona",
    host: "irc.chatzona.org",
    port: 6697,
    tls: true,
    note: "Spanish-language social chat.",
  },
  {
    slug: "rizon",
    name: "Rizon",
    host: "irc.rizon.net",
    port: 6697,
    tls: true,
    note: "Anime, fansub and general chat.",
  },
  {
    slug: "efnet",
    name: "EFnet",
    host: "irc.efnet.org",
    port: 6697,
    tls: true,
    note: "The oldest surviving network. No channel registration.",
  },
  {
    slug: "ircnet",
    name: "IRCnet",
    host: "open.ircnet.net",
    port: 6697,
    tls: true,
    note: "The 1996 split from EFnet. Strong in Europe.",
  },
];

/** Look up a preset by slug. */
export function findPreset(slug: string): NetworkPreset | undefined {
  return NETWORK_PRESETS.find((p) => p.slug === slug);
}
