import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { marketplaceMigrations } from "../src/modules/marketplace/migrations.js";
import { BUNDLED_THEMES, seedDefaultThemes } from "../src/modules/marketplace/seeders.js";

// WCAG 2.x relative luminance / contrast ratio.
function luminance(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("bundled theme contrast", () => {
  for (const theme of BUNDLED_THEMES) {
    for (const text of ["--text-1", "--text-2", "--text-3"]) {
      for (const bg of ["--bg", "--surface-1", "--surface-2"]) {
        it(`${theme.slug}: ${text} on ${bg} meets WCAG AA (4.5:1)`, () => {
          const fg = theme.variables[text];
          const back = theme.variables[bg];
          expect(fg).toBeDefined();
          expect(back).toBeDefined();
          expect(contrast(fg, back)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  it("re-seeding refreshes the palette of themes already installed", () => {
    const db = new Database(":memory:");
    runMigrations(db, "marketplace", marketplaceMigrations);
    seedDefaultThemes(db);
    db.prepare("UPDATE marketplace_themes SET variables = ?").run(JSON.stringify({ "--text-3": "#000000" }));
    seedDefaultThemes(db);
    const row = db.prepare(
      `SELECT t.variables FROM marketplace_themes t JOIN marketplace_items i ON i.id = t.item_id WHERE i.slug = 'midnight-gold'`,
    ).get() as { variables: string };
    expect(JSON.parse(row.variables)["--text-3"]).toBe(BUNDLED_THEMES[0].variables["--text-3"]);
  });
});
