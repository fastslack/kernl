/**
 * IRCv3 message parser / serializer.
 *
 * Implements the message-tags grammar (https://ircv3.net/specs/extensions/message-tags)
 * on top of the classic RFC 1459/2812 prefix + command + params shape:
 *
 *   [@tags] [:prefix] COMMAND [params...] [:trailing]
 *
 * Zero dependencies — this is the only protocol layer the IRCd needs.
 */

export interface IrcMessage {
  /** IRCv3 message tags (already unescaped). */
  tags: Record<string, string>;
  /** Source prefix without the leading ':' (servername or nick!user@host). */
  prefix?: string;
  /** Uppercased command or 3-digit numeric. */
  command: string;
  /** Positional parameters; the trailing param is the last element. */
  params: string[];
}

const TAG_UNESCAPE: Record<string, string> = {
  ":": ";",
  s: " ",
  "\\": "\\",
  r: "\r",
  n: "\n",
};

const TAG_ESCAPE: Record<string, string> = {
  ";": "\\:",
  " ": "\\s",
  "\\": "\\\\",
  "\r": "\\r",
  "\n": "\\n",
};

function unescapeTagValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      out += TAG_UNESCAPE[next] ?? next;
      i++;
    } else if (ch !== "\\") {
      out += ch;
    }
  }
  return out;
}

function escapeTagValue(value: string): string {
  let out = "";
  for (const ch of value) out += TAG_ESCAPE[ch] ?? ch;
  return out;
}

/** Parse a single raw IRC line (without the trailing CRLF). Returns null if blank. */
export function parseLine(line: string): IrcMessage | null {
  let rest = line.replace(/\r?\n$/, "");
  if (rest.trim() === "") return null;

  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    const tagPart = rest.slice(1, sp === -1 ? undefined : sp);
    rest = sp === -1 ? "" : rest.slice(sp + 1).replace(/^ +/, "");
    for (const raw of tagPart.split(";")) {
      if (!raw) continue;
      const eq = raw.indexOf("=");
      if (eq === -1) tags[raw] = "";
      else tags[raw.slice(0, eq)] = unescapeTagValue(raw.slice(eq + 1));
    }
  }

  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = rest.slice(1, sp === -1 ? undefined : sp);
    rest = sp === -1 ? "" : rest.slice(sp + 1).replace(/^ +/, "");
  }

  const params: string[] = [];
  while (rest.length > 0) {
    if (rest.startsWith(":")) {
      params.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(" ");
    if (sp === -1) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1).replace(/^ +/, "");
  }

  const command = (params.shift() ?? "").toUpperCase();
  if (!command) return null;
  return { tags, prefix, command, params };
}

/** Serialize an IrcMessage back into a wire line (no trailing CRLF). */
export function serialize(msg: Partial<IrcMessage> & { command: string }): string {
  let out = "";

  const tags = msg.tags ?? {};
  const tagKeys = Object.keys(tags);
  if (tagKeys.length > 0) {
    out +=
      "@" +
      tagKeys
        .map((k) => {
          const v = tags[k];
          return v === "" ? k : `${k}=${escapeTagValue(v)}`;
        })
        .join(";") +
      " ";
  }

  if (msg.prefix) out += `:${msg.prefix} `;
  out += msg.command;

  const params = msg.params ?? [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    const isLast = i === params.length - 1;
    // A trailing param is required when empty, contains a space, or starts with ':'
    if (isLast && (p === "" || p.includes(" ") || p.startsWith(":"))) {
      out += ` :${p}`;
    } else {
      out += ` ${p}`;
    }
  }
  return out;
}

/** Split a TCP/WebSocket chunk into complete lines + a leftover buffer. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r\n|\r|\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.length > 0), rest };
}
