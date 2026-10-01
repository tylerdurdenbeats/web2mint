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
