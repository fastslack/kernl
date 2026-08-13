/**
 * The normalizer is load-bearing for three separate features — canonical
 * matching, work dedupe, and canon lists — so its behaviour is pinned here
 * rather than left to whichever caller happens to exercise it first.
 *
 * The cases are drawn from the shapes archive.org actually holds: uploader
 * annotation in the title, rip settings, the same film under its original and
 * translated names, and the near-miss pairs a fuzzy matcher must NOT collapse.
 */

import { describe, it, expect } from "bun:test";
import {
  normalizeTitle,
  extractYear,
  titleSimilarity,
  workKey,
} from "../assets/extensions/leisure/cinema/_module/title-norm.js";

describe("normalizeTitle", () => {
  it("strips the year an uploader parked in the title", () => {
    expect(normalizeTitle("Nosferatu (1922)")).toBe("nosferatu");
    expect(normalizeTitle("Metropolis [1927]")).toBe("metropolis");
    expect(normalizeTitle("Metropolis 1927")).toBe("metropolis");
  });

  it("strips rip settings and uploader editorial", () => {
    expect(normalizeTitle("Metropolis 1080p x264")).toBe("metropolis");
    expect(normalizeTitle("Nosferatu FULL MOVIE restored")).toBe("nosferatu");
    expect(normalizeTitle("Plan 9 From Outer Space DVDRip XviD")).toBe("plan 9 from outer space");
  });

  it("drops diacritics so both spellings of a title converge", () => {
    expect(normalizeTitle("El Ángel Exterminador")).toBe(normalizeTitle("El Angel Exterminador"));
    expect(normalizeTitle("El Ángel Exterminador")).toBe("angel exterminador");
  });

  it("drops only a LEADING article", () => {
    expect(normalizeTitle("The Cabinet of Dr. Caligari")).toBe("cabinet of dr caligari");
    // The interior "a" is part of the title and stays.
    expect(normalizeTitle("Sunrise: A Song of Two Humans")).toContain("a song of two humans");
  });

  it("undoes library-catalogue article inversion", () => {
    // "Farewell to Arms, A" is how a card catalogue files it, and archive.org
    // is full of titles entered that way. These were landing at ~0.94 —
    // correct matches sitting in the review queue over a displaced article.
    expect(normalizeTitle("Farewell to Arms, A")).toBe(normalizeTitle("A Farewell to Arms"));
    expect(normalizeTitle("Gold Rush, The")).toBe(normalizeTitle("The Gold Rush"));
  });

  it("does not eat a trailing word that only looks like an article", () => {
    // A title genuinely ending in one of these keeps its meaning: moving the
    // word to the front and then stripping it would erase it entirely.
    expect(normalizeTitle("Chariots of Fire")).toBe("chariots of fire");
  });

  it("never normalizes a real title down to nothing", () => {
    expect(normalizeTitle("The One")).toBe("one");
    expect(normalizeTitle("The")).toBe("the");
  });

  it("maps roman numerals so sequels agree", () => {
    expect(normalizeTitle("Part II")).toBe(normalizeTitle("Part 2"));
  });

  it("closes up apostrophes rather than splitting on them", () => {
    expect(normalizeTitle("L'Atalante")).toBe("latalante");
  });

  it("is idempotent, because normalized values get stored and re-normalized", () => {
    for (const raw of ["Nosferatu (1922)", "El Ángel Exterminador", "The Cabinet of Dr. Caligari"]) {
      expect(normalizeTitle(normalizeTitle(raw))).toBe(normalizeTitle(raw));
    }
  });
});

describe("extractYear", () => {
  it("prefers the parenthesised year over a number that IS the title", () => {
    expect(extractYear("2001: A Space Odyssey (1968)")).toBe(1968);
  });

  it("reads a bare year when there is no parenthesised one", () => {
    expect(extractYear("Metropolis 1927")).toBe(1927);
  });

  it("does not mistake a leading number for a year", () => {
    expect(extractYear("2001: A Space Odyssey")).toBe(0);
  });

  it("returns 0 when the uploader gave no year", () => {
    expect(extractYear("Nosferatu")).toBe(0);
  });
});

describe("titleSimilarity", () => {
  it("scores an exact normalized match at 1", () => {
    expect(titleSimilarity("metropolis", "metropolis")).toBe(1);
  });

  it("keeps a translated title close to its original", () => {
    // Both normalize to near-identical strings; the matcher's 0.80 floor
    // has to clear this comfortably.
    const a = normalizeTitle("The Cabinet of Dr. Caligari");
    const b = normalizeTitle("Cabinet of Doctor Caligari");
    expect(titleSimilarity(a, b)).toBeGreaterThan(0.8);
  });

  it("separates a film from a different film that merely contains its name", () => {
    // This is the failure mode that would let a home movie inherit a
    // canonical film's identity, so it must land well below the auto floor.
    const s = titleSimilarity(normalizeTitle("Dracula"), normalizeTitle("Dracula's Daughter"));
    expect(s).toBeLessThan(0.95);
  });

  it("scores unrelated titles near zero", () => {
    expect(titleSimilarity(normalizeTitle("Metropolis"), normalizeTitle("About Bananas")))
      .toBeLessThan(0.3);
  });

  it("returns 0 when either side is empty", () => {
    expect(titleSimilarity("", "metropolis")).toBe(0);
    expect(titleSimilarity("metropolis", "")).toBe(0);
  });
});

describe("workKey", () => {
  it("keeps remakes apart", () => {
    expect(workKey("dracula", 1931)).not.toBe(workKey("dracula", 1958));
  });

  it("groups yearless titles only with each other", () => {
    expect(workKey("dracula", 0)).toBe("dracula::?");
    expect(workKey("dracula", 0)).not.toBe(workKey("dracula", 1931));
  });
});
