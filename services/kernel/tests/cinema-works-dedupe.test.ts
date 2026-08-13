/**
 * Collapsing the many uploads of one film into one work.
 *
 * The interesting cases are the two the naive version gets wrong: copies of
 * one film whose titles share almost nothing (only the canonical identity
 * knows they match), and a film with some copies identified and some not
 * (which must not become two works). Plus the case where merging would be a
 * lie — a title with no year, where "Dracula" could be any of three films.
 */

import { describe, it, expect } from "bun:test";
import {
  groupTitles,
  compareCopies,
  type WorkCandidateRow,
} from "../assets/extensions/leisure/cinema/_module/works.js";

function row(identifier: string, o: Partial<WorkCandidateRow> = {}): WorkCandidateRow {
  return {
    identifier,
    title: o.title ?? identifier,
    year: o.year ?? 0,
    runtime_sec: o.runtime_sec ?? 0,
    downloads: o.downloads ?? 0,
    week_downloads: o.week_downloads ?? 0,
    avg_rating: o.avg_rating ?? 0,
    num_reviews: o.num_reviews ?? 0,
    has_torrent: o.has_torrent ?? 1,
    qid: o.qid ?? "",
    collection_json: o.collection_json ?? '["feature_films"]',
  };
}

/** The group a given identifier landed in. */
function groupOf(groups: ReturnType<typeof groupTitles>, identifier: string) {
  return groups.find((g) => g.members.includes(identifier));
}

describe("groupTitles", () => {
  it("merges copies whose titles do not resemble each other, via the canonical id", () => {
    // This is the case plain title grouping cannot reach: these two share
    // almost no trigrams, and only the matcher knows they are one film.
    const groups = groupTitles([
      row("nosferatu-a", { title: "Nosferatu", year: 1922, qid: "Q151895" }),
      row("nosferatu-b", { title: "Nosferatu, eine Symphonie des Grauens", year: 1922, qid: "Q151895" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].copies).toBe(2);
    expect(groups[0].qid).toBe("Q151895");
  });

  it("keeps an unidentified copy in the SAME work as its identified siblings", () => {
    // Partial identification must not re-create the fragmentation it exists
    // to remove.
    const groups = groupTitles([
      row("known", { title: "Metropolis", year: 1927, qid: "Q483815" }),
      row("unknown", { title: "Metropolis (1927) 1080p", year: 1927 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toContain("unknown");
  });

  it("groups unidentified copies with each other by title and year", () => {
    const groups = groupTitles([
      row("a", { title: "Some Industrial Film", year: 1954 }),
      row("b", { title: "Some Industrial Film (1954)", year: 0 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].copies).toBe(2);
  });

  it("leaves yearless titles alone when nothing dated claims the name", () => {
    // Two uploads called "Dracula" and no evidence they are the same film.
    const groups = groupTitles([
      row("d1", { title: "Dracula" }),
      row("d2", { title: "Dracula" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("folds a yearless upload into the one film that answers to its title", () => {
    // `cinema_titles.year` is 0 across a large slice of the catalogue, so
    // treating a missing year as fatal would throw away most of the dedupe.
    // Nothing here is ambiguous: one film is called Metropolis.
    const groups = groupTitles([
      row("dated", { title: "Metropolis", year: 1927 }),
      row("undated", { title: "Metropolis FULL MOVIE" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].copies).toBe(2);
  });

  it("refuses when the title is claimed by more than one film", () => {
    // Ambiguity, not the missing year, is what forces the singleton: merging
    // here would silently pick one of two genuine remakes.
    const groups = groupTitles([
      row("d31", { title: "Dracula", year: 1931 }),
      row("d58", { title: "Dracula", year: 1958 }),
      row("undated", { title: "Dracula" }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groupOf(groups, "undated")?.copies).toBe(1);
  });

  it("folds a yearless upload into an IDENTIFIED film's group", () => {
    const groups = groupTitles([
      row("known", { title: "Metropolis", year: 1927, qid: "Q483815" }),
      row("undated", { title: "Metropolis" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groupOf(groups, "undated")?.qid).toBe("Q483815");
  });

  it("keeps genuine remakes apart", () => {
    const groups = groupTitles([
      row("d31", { title: "Dracula", year: 1931 }),
      row("d58", { title: "Dracula", year: 1958 }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("gives every title a group, including singletons", () => {
    const groups = groupTitles([row("lonely", { title: "Only Copy", year: 1930 })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].copies).toBe(1);
  });
});

describe("shelves whose items are never copies of each other", () => {
  const trailer = '["movie_trailers_unsorted","movie_trailers","moviesandfilms"]';

  it("never merges trailers that share a title", () => {
    // Measured on the live catalogue: archive.org's Turner import names every
    // clip after the film it promotes, so 38 distinct trailers arrive titled
    // "Family Guy" with the same year. Summing their downloads into one row
    // was simply wrong.
    const groups = groupTitles([
      row("t1", { title: "Family Guy", year: 1999, collection_json: trailer }),
      row("t2", { title: "Family Guy", year: 1999, collection_json: trailer }),
      row("t3", { title: "Family Guy", year: 1999, collection_json: trailer }),
    ]);
    expect(groups).toHaveLength(3);
  });

  it("does not let a real upload get pulled into the trailer pile", () => {
    // The trailer must not even register its signature, or the film would
    // join it.
    const groups = groupTitles([
      row("trailer", { title: "Metropolis", year: 1927, collection_json: trailer }),
      row("film", { title: "Metropolis", year: 1927 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groupOf(groups, "film")?.copies).toBe(1);
  });
});

describe("implausibly large groups", () => {
  const many = (n: number, title: string) =>
    Array.from({ length: n }, (_, i) => row(`x${i}`, { title, year: 1955 }));

  it("still merges the biggest groups that are genuinely one film", () => {
    // American Look (1958) really does have 14 separate uploads; White Zombie
    // (1932) has 11. The cap must sit above these.
    expect(groupTitles(many(14, "American Look"))).toHaveLength(1);
  });

  it("refuses a pile-up far past what one film attracts", () => {
    // "BOSTON BLACKIE TV SHOW" arrived 29 times, one per episode, from no
    // trailer shelf at all.
    expect(groupTitles(many(29, "Boston Blackie TV Show"))).toHaveLength(29);
  });

  it("splits a rejected group into singletons rather than truncating it", () => {
    // Keeping an arbitrary 20 of 29 would still merge items that are not
    // copies, and would do it invisibly.
    const groups = groupTitles(many(29, "Boston Blackie TV Show"));
    expect(groups.every((g) => g.copies === 1)).toBe(true);
  });
});

describe("aggregation across copies", () => {
  it("sums downloads that were split across uploads", () => {
    const groups = groupTitles([
      row("a", { title: "Metropolis", year: 1927, downloads: 50_000 }),
      row("b", { title: "Metropolis", year: 1927, downloads: 200 }),
      row("c", { title: "Metropolis", year: 1927, downloads: 800 }),
    ]);
    expect(groups[0].downloads).toBe(51_000);
  });

  it("sums the votes the weighted rating needs to say anything", () => {
    // The point of the whole exercise: thirty reviews split six ways left
    // every copy looking unmeasured.
    const groups = groupTitles([
      row("a", { title: "Metropolis", year: 1927, avg_rating: 5, num_reviews: 10 }),
      row("b", { title: "Metropolis", year: 1927, avg_rating: 4, num_reviews: 30 }),
    ]);
    expect(groups[0].num_reviews).toBe(40);
  });

  it("weights the mean rating by votes, not by copy", () => {
    // A mean of means would give 4.5 here; the honest answer is 4.25.
    const groups = groupTitles([
      row("a", { title: "Metropolis", year: 1927, avg_rating: 5, num_reviews: 10 }),
      row("b", { title: "Metropolis", year: 1927, avg_rating: 4, num_reviews: 30 }),
    ]);
    expect(groups[0].avg_rating).toBeCloseTo(4.25, 5);
  });

  it("reports a zero rating rather than dividing by no votes", () => {
    const groups = groupTitles([
      row("a", { title: "Metropolis", year: 1927 }),
      row("b", { title: "Metropolis", year: 1927 }),
    ]);
    expect(groups[0].avg_rating).toBe(0);
    expect(Number.isNaN(groups[0].avg_rating)).toBe(false);
  });
});

describe("choosing the copy to show", () => {
  it("prefers a playable copy over a more popular unplayable one", () => {
    const groups = groupTitles([
      row("popular", { title: "M", year: 1931, has_torrent: 0, downloads: 90_000 }),
      row("playable", { title: "M", year: 1931, has_torrent: 1, downloads: 10 }),
    ]);
    expect(groups[0].primary_identifier).toBe("playable");
  });

  it("prefers a copy with a known runtime over one without", () => {
    const groups = groupTitles([
      row("stub", { title: "M", year: 1931, runtime_sec: 0, downloads: 90_000 }),
      row("real", { title: "M", year: 1931, runtime_sec: 6_300, downloads: 10 }),
    ]);
    expect(groups[0].primary_identifier).toBe("real");
  });

  it("prefers the longer cut among real copies", () => {
    const groups = groupTitles([
      row("short", { title: "M", year: 1931, runtime_sec: 300 }),
      row("full", { title: "M", year: 1931, runtime_sec: 6_300 }),
    ]);
    expect(groups[0].primary_identifier).toBe("full");
  });

  it("falls back to downloads once the rest agree", () => {
    const groups = groupTitles([
      row("quiet", { title: "M", year: 1931, runtime_sec: 6_300, downloads: 5 }),
      row("loud", { title: "M", year: 1931, runtime_sec: 6_300, downloads: 5_000 }),
    ]);
    expect(groups[0].primary_identifier).toBe("loud");
  });

  it("is stable across rebuilds when everything else ties", () => {
    const a = row("bbb", { title: "M", year: 1931 });
    const b = row("aaa", { title: "M", year: 1931 });
    expect(groupTitles([a, b])[0].primary_identifier).toBe("aaa");
    expect(groupTitles([b, a])[0].primary_identifier).toBe("aaa");
  });

  it("orders copies deterministically", () => {
    expect(compareCopies(
      row("x", { has_torrent: 1 }),
      row("y", { has_torrent: 0 }),
    )).toBeLessThan(0);
  });
});

describe("grouping is order-independent", () => {
  it("produces the same works whichever order the rows arrive in", () => {
    const rows = [
      row("a", { title: "Metropolis", year: 1927, qid: "Q483815" }),
      row("b", { title: "Metropolis 1080p", year: 1927 }),
      row("c", { title: "Dracula", year: 1931 }),
    ];
    const forward = groupTitles(rows).map((g) => g.work_key).sort();
    const backward = groupTitles([...rows].reverse()).map((g) => g.work_key).sort();
    expect(forward).toEqual(backward);
  });

  it("attaches an unidentified copy to the qid group regardless of row order", () => {
    const rows = [
      row("unknown", { title: "Metropolis", year: 1927 }),
      row("known", { title: "Metropolis", year: 1927, qid: "Q483815" }),
    ];
    const groups = groupTitles(rows);
    expect(groups).toHaveLength(1);
    expect(groupOf(groups, "unknown")?.qid).toBe("Q483815");
  });
});
