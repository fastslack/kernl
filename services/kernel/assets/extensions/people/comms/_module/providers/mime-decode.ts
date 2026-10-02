/**
 * Pull the readable text and HTML bodies out of a raw RFC 5322 message, the
 * way IMAP's `source: true` fetch returns it.
 *
 * The splitter this replaces cut the source at the top-level boundary and
 * returned each part verbatim, so mailboxes showed transfer encoding instead
 * of mail: "=0A", "=3D" and soft line breaks from quoted-printable, whole
 * previews in base64, broken accents from latin1 read as UTF-8, and nothing
 * at all for the multipart/alternative-inside-multipart/mixed shape nearly
 * every message with an attachment has. This walks the MIME tree, decodes
 * each part's Content-Transfer-Encoding, then its charset.
 *
 * Works on bytes: the source is read as latin1 (one char per byte) so a part
 * can be turned back into the exact bytes its charset applies to.
 */

export interface Bodies {
  text: string;
  html: string;
}

interface Headers {
  contentType: string;
  params: Record<string, string>;
  encoding: string;
  attachment: boolean;
}

/** Split a header line's value into its main token and `key=value` params. */
function parseParams(value: string): { main: string; params: Record<string, string> } {
  const [main, ...rest] = value.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { main: (main ?? '').trim().toLowerCase(), params };
}

function parseHeaders(block: string): Headers {
  // Unfold continuation lines, then read the three headers that matter.
  const lines = block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  const get = (name: string) => {
    const line = lines.find((l) => l.toLowerCase().startsWith(name + ':'));
    return line ? line.slice(name.length + 1).trim() : '';
  };
  const ct = parseParams(get('content-type') || 'text/plain');
  const disp = parseParams(get('content-disposition'));
  return {
    contentType: ct.main || 'text/plain',
    params: ct.params,
    encoding: get('content-transfer-encoding').toLowerCase(),
    attachment: disp.main === 'attachment',
  };
}

/** Separate headers from body at the first blank line. */
function splitPart(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { head: raw, body: '' };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

function decodeQuotedPrintable(body: string): Uint8Array {
  const unwrapped = body.replace(/=\r?\n/g, ''); // soft line breaks
  const out: number[] = [];
  for (let i = 0; i < unwrapped.length; i++) {
    const c = unwrapped.charCodeAt(i);
    if (c === 0x3d && /^[0-9A-Fa-f]{2}$/.test(unwrapped.slice(i + 1, i + 3))) {
      out.push(parseInt(unwrapped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(c & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function decodeTransfer(body: string, encoding: string): Uint8Array {
  if (encoding === 'base64') return Uint8Array.from(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'));
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  return Uint8Array.from(Buffer.from(body, 'latin1'));
}

function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset || 'utf-8').trim().toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // An unknown or misspelled charset: UTF-8 is the best guess left.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function walk(raw: string, found: Bodies, depth: number): void {
  if (depth > 20) return; // a malformed or hostile message nesting forever
  const { head, body } = splitPart(raw);
  const h = parseHeaders(head);

  if (h.contentType.startsWith('multipart/')) {
    const boundary = h.params.boundary;
    if (!boundary) return;
    const delim = '--' + boundary;
    const end = body.indexOf(delim + '--');
    const scoped = end >= 0 ? body.slice(0, end) : body;
    const chunks = scoped.split(delim).slice(1); // [0] is the preamble
    for (const chunk of chunks) walk(chunk.replace(/^\r?\n/, ''), found, depth + 1);
    return;
  }
  if (h.attachment) return;
  if (h.contentType !== 'text/plain' && h.contentType !== 'text/html') return;

  const text = decodeCharset(decodeTransfer(body, h.encoding), h.params.charset)
    .replace(/\r\n/g, '\n')
    .trim();
  if (h.contentType === 'text/html') { if (!found.html) found.html = text; }
  else if (!found.text) found.text = text;
}

/** Decoded `text/plain` and `text/html` bodies (first of each, attachments skipped). */
export function extractBodies(source: Uint8Array | Buffer): Bodies {
  const found: Bodies = { text: '', html: '' };
  if (!source || source.length === 0) return found;
  const raw = Buffer.from(source).toString('latin1');
  if (!/\r?\n\r?\n/.test(raw)) return found; // headers only, no body
  walk(raw, found, 0);
  return found;
}
