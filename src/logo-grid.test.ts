// Regression guard for the hero wordmark's character grid.
//
// Two real bugs are pinned here:
//  1. Row-width drift: every ASCII_LOGO row must be exactly 75 columns wide,
//     otherwise the shadow rows (the box-drawing geometry under each glyph) stop
//     lining up with their letter rows.
//  2. Line-level centering: the wordmark <pre> elements must NOT use
//     text-center/text-align:center - that centers each line individually
//     (trailing spaces hang), which shifted the bottom shadow rows right off
//     the grid. Centering is done at block level (mx-auto w-fit).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ASCII_LOGO } from "./components/term/ui";

const UI_TSX = fileURLToPath(new URL("./components/term/ui.tsx", import.meta.url));
const APP_TSX = fileURLToPath(new URL("./App.tsx", import.meta.url));

describe("hero wordmark grid", () => {
  it("every ASCII_LOGO row is exactly 75 columns wide", () => {
    // the template literal carries leading/trailing newlines - ignore blanks
    const rows = ASCII_LOGO.split("\n").filter((r) => r.length > 0);
    expect(rows.length).toBe(6);
    for (const row of rows) expect([...row].length).toBe(75);
  });

  it("W shadow rows keep the canonical ANSI Shadow geometry", () => {
    // unicode escapes keep this file pure-ASCII (hygiene rule)
    const BLK = "\u2588";
    const TL = "\u255a";
    const HZ = "\u2550";
    const BR = "\u255d";
    const rows = ASCII_LOGO.split("\n").filter((r) => r.length > 0);
    expect(rows[0].startsWith(BLK + BLK)).toBe(true); // row 1 flush-left
    expect(rows[4].startsWith(TL)).toBe(true); // row 5 flush-left
    expect(rows[5].startsWith(" ")).toBe(true); // row 6 offset +1 by font design
    expect(rows[5].slice(0, 10)).toBe(" " + TL + HZ + HZ + BR + TL + HZ + HZ + BR + " ");
  });

  it("ascii art blocks never use line-level text centering", () => {
    for (const file of [UI_TSX, APP_TSX]) {
      const src = readFileSync(file, "utf8");
      // Find every element carrying the .ascii glyph class and assert its
      // class attribute does not also request text-center (line centering
      // breaks the shared column grid; block centering is mx-auto w-fit).
      const matches = src.matchAll(/className=\{?"([^"]*\bascii\b[^"]*)"/g);
      let count = 0;
      for (const m of matches) {
        count += 1;
        expect(m[1]).not.toMatch(/\btext-center\b/);
        expect(m[1]).not.toMatch(/\btext-right\b/);
      }
      expect(count).toBeGreaterThan(0);
    }
  });
});
