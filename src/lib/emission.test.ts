/**
 * The displayed final supply is a DERIVED constant: it must equal the exact
 * discrete sum of the frozen emission curve. This test is the tripwire that
 * keeps the UI honest - if the module ever hardcodes a number, or the frozen
 * curve were ever touched (a hard fork), these expectations scream.
 */
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_BLOCKS,
  BOOTSTRAP_MULTIPLIER,
  COIN,
  EMISSION_DECAY_RATE,
  INITIAL_SUBSIDY,
  SOFT_CAP_SUPPLY,
} from "@contracts/protocol";
import { EMISSION_TOTAL, EMISSION_TOTAL_COINS } from "./emission";

// Independently recomputed inside the test (no shared code with the module):
// the module's constant must match a from-scratch walk of the frozen curve.
function referenceTotal(): number {
  let total = 0;
  let height = 0;
  for (;;) {
    const r =
      height < BOOTSTRAP_BLOCKS
        ? INITIAL_SUBSIDY * BOOTSTRAP_MULTIPLIER
        : Math.floor(INITIAL_SUBSIDY * Math.exp(-EMISSION_DECAY_RATE * (height - BOOTSTRAP_BLOCKS)));
    if (r === 0) break;
    total += r;
    height++;
  }
  return total;
}

describe("final total emission (derived from the frozen curve)", () => {
  it("equals the from-scratch discrete sum of the frozen constants", () => {
    expect(EMISSION_TOTAL).toBe(referenceTotal());
  });

  it("is exactly 1,050,002,497,584,144 base units (10,500,024.97584144 coins)", () => {
    // Locked figure: bootstrap 500,000 + decay tail ~10,000,025. A one-ulp
    // libm difference could shift this by a base unit or two on an exotic
    // engine, so assert the neighbourhood, not the atom.
    expect(Math.abs(EMISSION_TOTAL - 1_050_002_497_584_144)).toBeLessThanOrEqual(4);
    expect(EMISSION_TOTAL_COINS).toBe(10_500_025);
  });

  it("starts with the exact bootstrap tranche: 1,000 blocks x 500 coins", () => {
    const bootstrap = BOOTSTRAP_BLOCKS * INITIAL_SUBSIDY * BOOTSTRAP_MULTIPLIER;
    expect(bootstrap).toBe(500_000 * COIN);
    expect(EMISSION_TOTAL).toBeGreaterThan(bootstrap);
  });

  it("is far below the SOFT_CAP reference (which consensus never enforces)", () => {
    expect(EMISSION_TOTAL).toBeLessThan(SOFT_CAP_SUPPLY);
    // ...by roughly 4x: the displayed total is the real one, not the reference
    expect(EMISSION_TOTAL * 3).toBeLessThan(SOFT_CAP_SUPPLY);
  });

  it("the tail ends: subsidy reaches zero base units near block 4,467,541", () => {
    const zeroAt = (() => {
      let h = BOOTSTRAP_BLOCKS;
      while (Math.floor(INITIAL_SUBSIDY * Math.exp(-EMISSION_DECAY_RATE * (h - BOOTSTRAP_BLOCKS))) > 0)
        h++;
      return h;
    })();
    // ~8.5 years at 60s blocks: assert the window, not the atom
    expect(zeroAt).toBeGreaterThan(4_400_000);
    expect(zeroAt).toBeLessThan(4_550_000);
  });
});
