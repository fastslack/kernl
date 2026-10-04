import { describe, it, expect } from "bun:test";
import { parseAgendaItems } from "../assets/extensions/people/comms/_module/agenda-extract.js";

const NOW = "2026-09-25T23:50:00"; // viernes

describe("parseAgendaItems", () => {
  it("keeps a well-formed appointment", () => {
    const out = parseAgendaItems([{ kind: "appointment", title: "Dentista", start_at: "2026-10-02T10:00", all_day: false, confidence: "high", evidence: "el viernes 2 a las 10" }], NOW);
    expect(out).toEqual([{ kind: "appointment", title: "Dentista", start_at: "2026-10-02T10:00", all_day: false, confidence: "high", evidence: "el viernes 2 a las 10" }]);
  });

  it("resolves relative dates from the kernel-local now", () => {
    // The model is told "now" and must return absolute dates; we only verify we don't shift them.
    const out = parseAgendaItems([{ kind: "event", title: "Demo", start_at: "2026-10-02T15:00", all_day: false, confidence: "high", evidence: "next Friday 3pm" }], NOW);
    expect(out[0].start_at).toBe("2026-10-02T15:00");
  });

  it("drops items in the past", () => {
    expect(parseAgendaItems([{ kind: "deadline", title: "Old", start_at: "2026-09-20", all_day: true, confidence: "high", evidence: "x" }], NOW)).toEqual([]);
  });

  it("keeps an all-day item dated today", () => {
    expect(parseAgendaItems([{ kind: "expiry", title: "Factura", start_at: "2026-09-25", all_day: true, confidence: "high", evidence: "vence hoy" }], NOW).length).toBe(1);
  });

  it("drops malformed items and keeps valid ones", () => {
    const out = parseAgendaItems([
      { kind: "party", title: "x", start_at: "2026-10-01T10:00", all_day: false, confidence: "high", evidence: "x" },
      { kind: "event", title: "", start_at: "2026-10-01T10:00", all_day: false, confidence: "high", evidence: "x" },
      { kind: "event", title: "Sin fecha", start_at: "la semana que viene", all_day: false, confidence: "low", evidence: "x" },
      "garbage",
      { kind: "event", title: "Ok", start_at: "2026-10-01T10:00", all_day: false, confidence: "maybe", evidence: "x" },
    ], NOW);
    expect(out.map((i) => i.title)).toEqual(["Ok"]);
    expect(out[0].confidence).toBe("low"); // unknown confidence degrades to low
  });

  it("returns [] for non-arrays", () => {
    expect(parseAgendaItems(undefined, NOW)).toEqual([]);
    expect(parseAgendaItems({}, NOW)).toEqual([]);
  });

  it("trims long titles and evidence", () => {
    const out = parseAgendaItems([{ kind: "event", title: "a".repeat(300), start_at: "2026-10-01T10:00", all_day: false, confidence: "high", evidence: "b".repeat(900) }], NOW);
    expect(out[0].title.length).toBe(160);
    expect(out[0].evidence.length).toBe(300);
  });

  it("all-day span keeps date-only end_at", () => {
    const out = parseAgendaItems([{ kind: "event", title: "Conference", start_at: "2026-10-02", all_day: true, end_at: "2026-10-05", confidence: "high", evidence: "x" }], NOW);
    expect(out[0].end_at).toBe("2026-10-05");
  });

  it("all-day item with timed end_at on a later day keeps it truncated to the date", () => {
    const out = parseAgendaItems([{ kind: "event", title: "Conference", start_at: "2026-10-02", all_day: true, end_at: "2026-10-05T23:59", confidence: "high", evidence: "x" }], NOW);
    expect(out[0].end_at).toBe("2026-10-05");
  });

  it("all-day item with same-day timed end_at gets no end_at", () => {
    const out = parseAgendaItems([{ kind: "event", title: "Event", start_at: "2026-10-02", all_day: true, end_at: "2026-10-02T23:59", confidence: "high", evidence: "x" }], NOW);
    expect(out[0].end_at).toBeUndefined();
  });

  it("timed item with date-only end_at gets no end_at", () => {
    const out = parseAgendaItems([{ kind: "event", title: "Shift", start_at: "2026-10-02T09:00", all_day: false, end_at: "2026-10-02", confidence: "high", evidence: "x" }], NOW);
    expect(out[0].end_at).toBeUndefined();
  });

  it("all_day=true with a datetime start_at keeps only the date", () => {
    const out = parseAgendaItems([{ kind: "event", title: "Day Off", start_at: "2026-10-02T10:00", all_day: true, confidence: "high", evidence: "x" }], NOW);
    expect(out[0].start_at).toBe("2026-10-02");
    expect(out[0].all_day).toBe(true);
  });
});
