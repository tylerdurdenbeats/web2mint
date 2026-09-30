/**
 * The chain's FINAL total emission, derived - not declared.
 *
 * The frozen protocol expresses monetary policy as a curve, not a number:
 * 1,000 bootstrap blocks at 10x, then an exponentially decaying subsidy
 * (floor to base units every block) that reaches zero around block 4.47M
 * (~8.5 years). The sum of that curve is a fixed, computable constant of
 * nature: exactly how many coins will ever exist. This module walks the
 * frozen curve once at load and adds it up (~4.5M cheap iterations, a few
 * tens of milliseconds) so the UI can show the REAL total instead of the
 * asymptotic SOFT_CAP reference, which consensus never enforces.
 *
 * Because the figure is computed from the frozen constants themselves, it
 * can never drift out of sync with the protocol: change the curve (a hard
 * fork) and this number changes with it. No hardcoded supply anywhere.
 */
import {
  BOOTSTRAP_BLOCKS,
  BOOTSTRAP_MULTIPLIER,
  COIN,
  EMISSION_DECAY_RATE,
  INITIAL_SUBSIDY,
} from "@contracts/protocol";

function rewardAt(height: number): number {
  if (height < BOOTSTRAP_BLOCKS) return INITIAL_SUBSIDY * BOOTSTRAP_MULTIPLIER;
  return Math.floor(INITIAL_SUBSIDY * Math.exp(-EMISSION_DECAY_RATE * (height - BOOTSTRAP_BLOCKS)));
}

function computeTotalEmission(): number {
  let total = 0;
  let height = 0;
  // Once the floor()ed subsidy hits zero it can never come back (the curve
  // is monotone decreasing), so the loop provably terminates.
  for (;;) {
    const r = rewardAt(height);
    if (r === 0) break;
    total += r;
    height++;
  }
  return total;
}

/** Every base unit the emission curve will ever mint (gross, before burn). */
export const EMISSION_TOTAL = computeTotalEmission();

/** Whole coins, rounded for display: 10,500,025. */
export const EMISSION_TOTAL_COINS = Math.round(EMISSION_TOTAL / COIN);
