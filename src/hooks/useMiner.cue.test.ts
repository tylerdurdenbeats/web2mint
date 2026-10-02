/**
 * Mining-start sound cue tests.
 *
 * The feature: pressing START MINING (a manual, deliberate user gesture -
 * which is also the gesture that unlocks Web Audio under browser autoplay
 * policy) makes the terminal acknowledge with the CRT power-on chirp the
 * sound engine already defined for "mining_start". The engine's existing
 * design contract is preserved: the notify() "mining_start" tray entry
 * stays in the SILENT tier, so boot auto-starts, gate-close auto-resumes
 * and chain-update resumes never make a sound.
 *
 * Layers:
 *   1. miningStartCue() - the pure audibility policy (4 cases).
 *   2. Source wiring - both start commit points (Web Locks path and the
 *      BroadcastChannel fallback) carry the policy, the resume path does
 *      not, the Wallet button stays on the manual path, and the notify
 *      silent tier is untouched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { miningStartCue } from "./useMiner";

describe("miningStartCue policy", () => {
  it("a manual button press (no opts) earns the chirp", () => {
    expect(miningStartCue(undefined, "start")).toBe(true);
  });
  it("a boot / gate-close auto-start stays silent", () => {
    expect(miningStartCue({ auto: true }, "start")).toBe(false);
  });
  it("a chain-update resume never chirps, manual or not", () => {
    expect(miningStartCue(undefined, "resume")).toBe(false);
    expect(miningStartCue({ auto: true }, "resume")).toBe(false);
  });
});

describe("mining-start cue wiring", () => {
  const miner = readFileSync(fileURLToPath(new URL("./useMiner.ts", import.meta.url)), "utf8");
  const wallet = readFileSync(
    fileURLToPath(new URL("../pages/Wallet.tsx", import.meta.url)),
    "utf8",
  );
  const notifySrc = readFileSync(
    fileURLToPath(new URL("../lib/notify.ts", import.meta.url)),
    "utf8",
  );
  const soundSrc = readFileSync(fileURLToPath(new URL("../lib/sound.ts", import.meta.url)), "utf8");

  it("both start commit points (Web Locks + BroadcastChannel fallback) carry the policy", () => {
    const commits = miner.split('beginMining("start", miningStartCue(opts, "start"));').length - 1;
    expect(commits).toBe(2);
  });

  it("the chirp is gated on the cue inside beginMining, not fired unconditionally", () => {
    expect(miner).toContain('if (cue) soundEngine.feedback("mining_start");');
  });

  it("the chain-update resume path passes no cue", () => {
    expect(miner).toContain('beginMining("resume");');
    expect(miner).not.toContain('beginMining("resume", true)');
  });

  it("the Wallet START button stays on the manual path", () => {
    expect(wallet).toContain("onClick={() => miner.start()}");
  });

  it('the notify "mining_start" tray entry remains in the SILENT tier (no double sound)', () => {
    const audibleBlock = notifySrc.slice(
      notifySrc.indexOf("const AUDIBLE"),
      notifySrc.indexOf("};", notifySrc.indexOf("const AUDIBLE")),
    );
    expect(audibleBlock).not.toMatch(/^\s*mining_start:/m);
    expect(audibleBlock).toContain("silent: system, peer_connected, mining_start, mining_stop");
  });

  it('the sound engine defines the "mining_start" pattern and announcement', () => {
    expect(soundSrc).toContain("mining_start: [");
    expect(soundSrc).toContain('mining_start: "Mining started."');
  });
});
