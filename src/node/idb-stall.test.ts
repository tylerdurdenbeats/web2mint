/**
 * The zombie-connection guard: after an iOS page freeze, Safari can keep an
 * IndexedDB connection "open" while its requests NEVER settle - every chain
 * read then hangs forever, which is exactly how "NO PEERS CONNECTED" and the
 * frozen UPDATING overlay were born. withStallGuard turns that silent hang
 * into a loud IdbStallError (and poisons the storage so the next op reopens
 * the connection). These tests pin the guard's contract without a real IDB.
 */
import { describe, expect, it } from "vitest";
import { IdbStallError, withStallGuard } from "./idb";

describe("withStallGuard - the zombie IndexedDB connection detector", () => {
  it("passes through a request that settles in time", async () => {
    const stalled = { called: false };
    const value = await withStallGuard(
      Promise.resolve(42),
      () => {
        stalled.called = true;
      },
      50,
    );
    expect(value).toBe(42);
    expect(stalled.called).toBe(false);
  });

  it("rejects with IdbStallError - and poisons the owner - when the request never settles", async () => {
    const stalled = { called: false };
    const never = new Promise<number>(() => {}); // the zombie: never resolves
    await expect(
      withStallGuard(
        never,
        () => {
          stalled.called = true;
        },
        30,
      ),
    ).rejects.toBeInstanceOf(IdbStallError);
    expect(stalled.called).toBe(true);
  });

  it("a late rejection of the inner request wins over the stall timer", async () => {
    const stalled = { called: false };
    const boom = new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("quota exceeded")), 5),
    );
    await expect(
      withStallGuard(
        boom,
        () => {
          stalled.called = true;
        },
        1_000,
      ),
    ).rejects.toThrow("quota exceeded");
    expect(stalled.called).toBe(false);
  });
});

describe("connection liveness - congestion must never read as zombie", () => {
  /** Scripted liveness: aliveWithin answers from a queue, default false. */
  const fakeLive = (script: boolean[]) => {
    const seen: number[] = [];
    return {
      calls: seen,
      live: {
        touch() {
          seen.push(-1);
        },
        aliveWithin(ms: number) {
          seen.push(ms);
          return script.length > 0 ? script.shift()! : false;
        },
      },
    };
  };

  it("zero progress still poisons on the FIRST window - the zombie case is unchanged", async () => {
    const stalled = { called: false };
    const { live } = fakeLive([false]);
    const never = new Promise<number>(() => {});
    await expect(
      withStallGuard(
        never,
        () => {
          stalled.called = true;
        },
        30,
        live,
      ),
    ).rejects.toBeInstanceOf(IdbStallError);
    expect(stalled.called).toBe(true); // one window, one poison - as before
  });

  it("a congested-but-alive connection EXTENDS a slow request instead of poisoning it", async () => {
    const stalled = { called: false };
    // two windows of progress, then silence: extensions 1 and 2 re-arm, the
    // third window finds no progress and poisons
    const { live } = fakeLive([true, true, false]);
    const never = new Promise<number>(() => {});
    const t0 = Date.now();
    await expect(
      withStallGuard(
        never,
        () => {
          stalled.called = true;
        },
        40,
        live,
      ),
    ).rejects.toBeInstanceOf(IdbStallError);
    const waited = Date.now() - t0;
    expect(stalled.called).toBe(true);
    // three windows (~120ms) prove the two extensions really happened - a
    // first-window poison would settle in ~40ms
    expect(waited).toBeGreaterThanOrEqual(100);
  });

  it("a request that settles LATE on a progressing connection succeeds - no poison, and it touches liveness", async () => {
    const stalled = { called: false };
    const { live, calls } = fakeLive([true]); // the first window sees progress
    const slow = new Promise<number>((r) => setTimeout(() => r(7), 55)); // 1.4x the 40ms window
    const value = await withStallGuard(
      slow,
      () => {
        stalled.called = true;
      },
      40,
      live,
    );
    expect(value).toBe(7);
    expect(stalled.called).toBe(false);
    expect(calls).toContain(-1); // settling touched the shared liveness
  });
});
