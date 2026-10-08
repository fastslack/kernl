import { describe, it, expect } from "bun:test";
import { extractBodies, extractMessage } from "../assets/extensions/people/comms/_module/providers/mime-decode.js";

// IMAP mailboxes showed bodies as raw transfer encoding — "=0A", "=3D",
// soft line breaks, whole previews in base64 — because the old splitter cut
// the source at boundaries and never decoded a part. These are the shapes
// real mail arrives in.

const bytes = (s: string, enc: "utf8" | "latin1" = "utf8") => Buffer.from(s.replace(/\n/g, "\r\n"), enc);

describe("extractBodies", () => {
  it("decodes quoted-printable text, including soft line breaks and =XX escapes", () => {
    const src = bytes(`From: a@b.c
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Great news! There are upcoming events near <a href=3D"https://x.io">Almelo</a> this w=
eek!=0AStarts: Sat
Caf=C3=A9 =E2=82=AC5
`);
    const { text, html } = extractBodies(src);
    expect(html).toBe("");
    expect(text).toContain('near <a href="https://x.io">Almelo</a> this week!');
    expect(text).toContain("Starts: Sat");
    expect(text).toContain("Café €5");
    expect(text).not.toMatch(/=0A|=3D|=C3/);
  });

  it("decodes base64 parts", () => {
    const body = Buffer.from("Veel gemeenten bieden gratis energiehulp.", "utf8").toString("base64");
    const src = bytes(`Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: base64

${body.slice(0, 20)}
${body.slice(20)}
`);
    expect(extractBodies(src).text).toBe("Veel gemeenten bieden gratis energiehulp.");
  });

  it("respects the part's charset (latin1 / windows-1252)", () => {
    const src = bytes(`Content-Type: text/plain; charset=iso-8859-1
Content-Transfer-Encoding: 8bit

Información de envío: año próximo
`, "latin1");
    expect(extractBodies(src).text.trim()).toBe("Información de envío: año próximo");
  });

  it("walks nested multipart (alternative inside mixed) and skips attachments", () => {
    const html = Buffer.from("<p>Hola <b>Matías</b></p>", "utf8").toString("base64");
    const src = bytes(`Content-Type: multipart/mixed; boundary="OUTER"

--OUTER
Content-Type: multipart/alternative; boundary=INNER

--INNER
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Hola Mat=C3=ADas
--INNER
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: base64

${html}
--INNER--

--OUTER
Content-Type: text/plain; name="notes.txt"
Content-Disposition: attachment; filename="notes.txt"

this is an attachment, not the body
--OUTER--
`);
    const b = extractBodies(src);
    expect(b.text.trim()).toBe("Hola Matías");
    expect(b.html).toBe("<p>Hola <b>Matías</b></p>");
  });

  it("an HTML-only message yields html and no text", () => {
    const src = bytes(`Content-Type: text/html; charset=utf-8

<div>Only html</div>
`);
    expect(extractBodies(src)).toEqual({ text: "", html: "<div>Only html</div>" });
  });

  it("keeps the first text part when several exist and tolerates an unknown charset", () => {
    const src = bytes(`Content-Type: multipart/alternative; boundary=B

--B
Content-Type: text/plain; charset=x-unknown-charset

first
--B
Content-Type: text/plain

second
--B--
`);
    expect(extractBodies(src).text.trim()).toBe("first");
  });

  it("empty or header-only source does not throw", () => {
    expect(extractBodies(Buffer.alloc(0))).toEqual({ text: "", html: "" });
    expect(extractBodies(bytes("Subject: x\n"))).toEqual({ text: "", html: "" });
  });
});

// Attachments used to be dropped on the floor: the walker skipped every part
// that was not a text body, nothing kept the bytes, and the mail view showed
// a "here's the screenshot" message with no screenshot anywhere.
describe("extractMessage attachments", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 250, 251]);

  it("keeps a screenshot pasted into Gmail (inline image with a Content-ID)", () => {
    const b64 = png.toString("base64");
    const src = bytes(`Content-Type: multipart/related; boundary="REL"

--REL
Content-Type: multipart/alternative; boundary="ALT"

--ALT
Content-Type: text/plain; charset="UTF-8"

Le envío captura de pantalla.
[image: image.png]
--ALT
Content-Type: text/html; charset="UTF-8"

<div>Le envío captura</div><img src="cid:ii_mgf3x1" alt="image.png">
--ALT--

--REL
Content-Type: image/png; name="image.png"
Content-Disposition: inline; filename="image.png"
Content-Transfer-Encoding: base64
Content-ID: <ii_mgf3x1>
X-Attachment-Id: ii_mgf3x1

${b64.slice(0, 8)}
${b64.slice(8)}
--REL--
`);
    const m = extractMessage(src);
    expect(m.text).toContain("Le envío captura de pantalla.");
    expect(m.html).toContain('src="cid:ii_mgf3x1"');
    expect(m.attachments).toHaveLength(1);
    const [a] = m.attachments;
    expect(a.filename).toBe("image.png");
    expect(a.mimeType).toBe("image/png");
    expect(a.contentId).toBe("ii_mgf3x1");
    expect(a.inline).toBe(true);
    expect(Buffer.from(a.content).equals(png)).toBe(true);
  });

  it("keeps regular attachments, including a text file, and decodes RFC 2231 / 2047 names", () => {
    const pdf = Buffer.from("%PDF-1.4 fake", "latin1").toString("base64");
    const word = Buffer.from("PK fake docx", "latin1").toString("base64");
    const src = bytes(`Content-Type: multipart/mixed; boundary="M"

--M
Content-Type: text/plain; charset=utf-8

cuerpo
--M
Content-Type: application/pdf
Content-Disposition: attachment; filename*=UTF-8''informe%20cl%C3%ADnico.pdf
Content-Transfer-Encoding: base64

${pdf}
--M
Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document;
 name="=?UTF-8?B?${Buffer.from("matrícula.docx").toString("base64")}?="
Content-Disposition: attachment
Content-Transfer-Encoding: base64

${word}
--M
Content-Type: text/plain; name="notes.txt"
Content-Disposition: attachment; filename="notes.txt"

this is an attachment, not the body
--M--
`);
    const m = extractMessage(src);
    expect(m.text).toBe("cuerpo");
    expect(m.attachments.map((a) => a.filename)).toEqual(["informe clínico.pdf", "matrícula.docx", "notes.txt"]);
    expect(m.attachments[0].mimeType).toBe("application/pdf");
    expect(Buffer.from(m.attachments[0].content).toString("latin1")).toBe("%PDF-1.4 fake");
    expect(m.attachments[0].inline).toBe(false);
    expect(Buffer.from(m.attachments[2].content).toString("utf8").trim()).toBe("this is an attachment, not the body");
  });

  it("names a part that carries no filename after its type", () => {
    const src = bytes(`Content-Type: multipart/mixed; boundary=M

--M
Content-Type: text/plain

hola
--M
Content-Type: image/jpeg
Content-Transfer-Encoding: base64

${png.toString("base64")}
--M--
`);
    const m = extractMessage(src);
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0].filename).toBe("attachment-1.jpg");
  });

  it("a plain message has no attachments", () => {
    expect(extractMessage(bytes(`Content-Type: text/plain\n\nhola\n`)).attachments).toEqual([]);
    expect(extractMessage(Buffer.alloc(0)).attachments).toEqual([]);
  });
});
