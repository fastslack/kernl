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

/** A part that is not one of the readable bodies: an attachment or an inline image. */
export interface MailPart {
  filename: string;
  mimeType: string;
  content: Uint8Array;
  /** Content-ID without the angle brackets — what `cid:` in the HTML points at. */
  contentId: string;
  /** Shown in the body (Content-Disposition: inline), e.g. a screenshot pasted into Gmail. */
  inline: boolean;
}

export interface DecodedMessage extends Bodies {
  attachments: MailPart[];
}

interface Headers {
  contentType: string;
  params: Record<string, string>;
  encoding: string;
  disposition: string;
  /** The part's name, decoded: Content-Disposition filename first, then Content-Type name. */
  filename: string;
  contentId: string;
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

/** RFC 2047 encoded words (`=?UTF-8?B?…?=`), as mail clients put them in `name=`. */
function decodeEncodedWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?') // whitespace between adjacent encoded words is not content
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
      const raw = enc.toUpperCase() === 'B'
        ? Uint8Array.from(Buffer.from(data, 'base64'))
        : decodeQuotedPrintable(data.replace(/_/g, ' '));
      return decodeCharset(raw, charset);
    });
}

/**
 * A parameter that may be RFC 2231 encoded (`filename*=UTF-8''a%20b.pdf`) or
 * split in numbered pieces (`filename*0=…; filename*1=…`).
 */
function paramValue(params: Record<string, string>, key: string): string {
  if (params[key + '*']) return decodeExtended(params[key + '*']);
  if (params[key + '*0'] || params[key + '*0*']) {
    let joined = '';
    let encoded = false;
    for (let i = 0; params[`${key}*${i}`] !== undefined || params[`${key}*${i}*`] !== undefined; i++) {
      const piece = params[`${key}*${i}*`];
      if (piece !== undefined) { encoded = true; joined += piece; } else joined += params[`${key}*${i}`];
    }
    return encoded ? decodeExtended(joined) : joined;
  }
  return params[key] ? decodeEncodedWords(params[key]) : '';
}

function decodeExtended(value: string): string {
  const m = /^([^']*)'[^']*'(.*)$/.exec(value);
  const charset = m ? m[1] : 'utf-8';
  const data = m ? m[2] : value;
  const bytes: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(data.slice(i + 1, i + 3))) {
      bytes.push(parseInt(data.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(data.charCodeAt(i) & 0xff);
  }
  return decodeCharset(Uint8Array.from(bytes), charset || 'utf-8');
}

function parseHeaders(block: string): Headers {
  // Unfold continuation lines, then read the headers that matter.
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
    disposition: disp.main,
    filename: (paramValue(disp.params, 'filename') || paramValue(ct.params, 'name')).trim(),
    contentId: get('content-id').replace(/^<|>$/g, '').trim(),
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

/** Extension for a part that arrived without a name. */
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/html': 'html', 'text/calendar': 'ics',
  'message/rfc822': 'eml',
};

function walk(raw: string, found: DecodedMessage, depth: number): void {
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
  const isBody = (h.contentType === 'text/plain' || h.contentType === 'text/html')
    && h.disposition !== 'attachment'
    && !(h.disposition === 'inline' && h.filename);
  if (!isBody) {
    const n = found.attachments.length + 1;
    const ext = EXT_BY_TYPE[h.contentType] ?? 'bin';
    found.attachments.push({
      filename: h.filename || `attachment-${n}.${ext}`,
      mimeType: h.contentType,
      content: decodeTransfer(body, h.encoding),
      contentId: h.contentId,
      inline: h.disposition === 'inline',
    });
    return;
  }

  const text = decodeCharset(decodeTransfer(body, h.encoding), h.params.charset)
    .replace(/\r\n/g, '\n')
    .trim();
  if (h.contentType === 'text/html') { if (!found.html) found.html = text; }
  else if (!found.text) found.text = text;
}

/**
 * Decoded `text/plain` and `text/html` bodies (first of each) plus every
 * other leaf part — attachments and inline images — with its decoded bytes.
 */
export function extractMessage(source: Uint8Array | Buffer): DecodedMessage {
  const found: DecodedMessage = { text: '', html: '', attachments: [] };
  if (!source || source.length === 0) return found;
  const raw = Buffer.from(source).toString('latin1');
  if (!/\r?\n\r?\n/.test(raw)) return found; // headers only, no body
  walk(raw, found, 0);
  return found;
}

/** Decoded `text/plain` and `text/html` bodies (first of each, attachments skipped). */
export function extractBodies(source: Uint8Array | Buffer): Bodies {
  const { text, html } = extractMessage(source);
  return { text, html };
}
