// Regression guard: status lines carry raw 64-char txids - one unbreakable
// hex token. Without overflow-wrap:anywhere that token spills out of the
// bordered box on narrow screens (the mobile transfer-status overflow bug).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UI_TSX = fileURLToPath(new URL("./components/term/ui.tsx", import.meta.url));

describe("StatusLine long-token overflow", () => {
  it("wraps unbreakable tokens (txid) instead of overflowing the box", () => {
    const src = readFileSync(UI_TSX, "utf8");
    const fnStart = src.indexOf("export function StatusLine");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, fnStart + 1200);
    expect(fnBody).toContain("[overflow-wrap:anywhere]");
  });
});

describe("SupplyLogo tooltip", () => {
  const src = readFileSync(UI_TSX, "utf8");
  const tipStart = src.indexOf('role="tooltip"');
  const tipBody = src.slice(tipStart, tipStart + 900);

  it("never uses nowrap - the MINED line is wider than a 360px phone", () => {
    expect(tipStart).toBeGreaterThan(-1);
    expect(tipBody).not.toContain("whitespace-nowrap");
  });

  it("renders below the wordmark - above it, the topbar crops the top line", () => {
    expect(tipBody).toContain("max-w-[calc(100vw-1rem)]");
    // top-full + mt-1: fully below the pre box. bottom-full put the tooltip
    // under the sticky topbar (z-94 paints above the hero) and any negative
    // margin covered the top glyph row on phones.
    expect(tipBody).toContain("top-full");
    expect(tipBody).toContain("mt-1");
    expect(tipBody).not.toContain("bottom-full");
    expect(tipBody).not.toContain("-mb-");
  });

  it("shows the final supply rounded like the rest of the UI (10,500,025)", () => {
    // the emission total is a fractional-coin sum; flooring it displayed
    // "10,500,024" while Terminal/Manifesto show EMISSION_TOTAL_COINS
    expect(src).toContain("fmtInt(Math.round(softCap / COIN))");
  });
});

describe("notification bell vs iOS status bar", () => {
  const layout = readFileSync(
    fileURLToPath(new URL("./components/term/Layout.tsx", import.meta.url)),
    "utf8",
  );
  const css = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

  it("the absolute-anchored bell adds the safe-area inset into its offset", () => {
    // absolute top-N ignores the header's safe-area padding - plain top-2 put
    // the bell under the iOS status bar icons in the installed PWA
    expect(layout).toContain("top-[calc(0.5rem+var(--sat))]");
    expect(layout).not.toMatch(/absolute right-2 top-2/);
  });

  it("the header clears the status bar through the overridable --sat hook", () => {
    expect(layout).toContain("pt-[var(--sat)]");
    expect(css).toContain("--sat: env(safe-area-inset-top)");
  });
});
