import { describe, it, expect } from "bun:test";
import { parseHeaderBlock } from "../assets/extensions/people/comms/_module/providers/imap-smtp-provider.js";

describe("parseHeaderBlock", () => {
  it("extracts the wanted headers with lower-cased keys, and drops the rest", () => {
    const source = [
      "Message-ID: <msg2@cliente.com>",
      "In-Reply-To: <msg1@cliente.com>",
      "References: <root@cliente.com>",
      "Subject: Re: Proyecto web",
      "From: Ana <ana@cliente.com>",
      "",
      "cuerpo del mail",
    ].join("\r\n");

    const headers = parseHeaderBlock(source);
    expect(headers["message-id"]).toBe("<msg2@cliente.com>");
    expect(headers["in-reply-to"]).toBe("<msg1@cliente.com>");
    expect(headers["references"]).toBe("<root@cliente.com>");
    // Subject/From aren't in the wanted list — this mailbox only keeps what
    // the thread-safety checks need.
    expect(headers["subject"]).toBeUndefined();
    expect(headers["from"]).toBeUndefined();
  });

  it("unfolds continuation lines before matching (References spread over several lines)", () => {
    const source =
      "References: <a@cliente.com>\r\n <b@cliente.com>\r\n\t<c@cliente.com>\r\n" +
      "Subject: hi\r\n\r\nbody";

    const headers = parseHeaderBlock(source);
    expect(headers["references"]).toBe("<a@cliente.com> <b@cliente.com> <c@cliente.com>");
  });

  it("picks up Auto-Submitted / Precedence / List-Id / List-Unsubscribe", () => {
    const source = [
      "Auto-Submitted: auto-replied",
      "Precedence: bulk",
      "List-Id: <newsletter.example.com>",
      "List-Unsubscribe: <mailto:x@y.com>",
      "",
      "body",
    ].join("\r\n");

    const headers = parseHeaderBlock(source);
    expect(headers["auto-submitted"]).toBe("auto-replied");
    expect(headers["precedence"]).toBe("bulk");
    expect(headers["list-id"]).toBe("<newsletter.example.com>");
    expect(headers["list-unsubscribe"]).toBe("<mailto:x@y.com>");
  });

  it("returns {} for an empty source, and for a source with no header block", () => {
    expect(parseHeaderBlock("")).toEqual({});
    expect(parseHeaderBlock("just a body, no headers, no blank line")).toEqual({});
  });
});
