import { describe, it, expect } from "bun:test";
import { extractBodies } from "../assets/extensions/people/comms/_module/providers/mime-decode.js";

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
