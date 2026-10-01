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

  it("is capped to the viewport and never overlaps the wordmark's ink", () => {
    expect(tipBody).toContain("max-w-[calc(100vw-1rem)]");
    // positive margin only: bottom-full + mb-1 keeps it above the pre box;
    // a negative -mb-* covered the top glyph row on phones
    expect(tipBody).toContain("mb-1");
    expect(tipBody).not.toContain("-mb-");
  });
});
