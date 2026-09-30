/**
 * Legacy storage migration (rebrand): old keys must move to their new names
 * exactly once - copy, never clobber, then remove the old name. The wallet
 * never touches localStorage, so the worst case of a missed migration is a
 * lost preference, and a blocked store must never crash the boot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateLegacyStorage } from "./storage-migration";

function fakeStorage(initial: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

let localStore: Storage;
let sessionStore: Storage;

beforeEach(() => {
  localStore = fakeStorage({});
  sessionStore = fakeStorage({});
  vi.stubGlobal("localStorage", localStore);
  vi.stubGlobal("sessionStorage", sessionStore);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("migrateLegacyStorage", () => {
  it("moves every legacy localStorage key to its new name and removes the old one", () => {
    localStore.setItem("btwb.mining", "1");
    localStore.setItem("btwb.backup.v1", '{"backups":{}}');
    localStore.setItem("btwb.notifications.v1", "[]");
    localStore.setItem("btwb.pendingtx.v1", "[]");
    localStore.setItem("btwb.feedback.v1", '{"sound":false}');
    localStore.setItem("btwb.storagewarned.v1", "1");
    localStore.setItem("btwb-stale-chunk-reload", "1");

    migrateLegacyStorage();

    expect(localStore.getItem("w2mt.mining")).toBe("1");
    expect(localStore.getItem("w2mt.backup.v1")).toBe('{"backups":{}}');
    expect(localStore.getItem("w2mt.notifications.v1")).toBe("[]");
    expect(localStore.getItem("w2mt.pendingtx.v1")).toBe("[]");
    expect(localStore.getItem("w2mt.feedback.v1")).toBe('{"sound":false}');
    expect(localStore.getItem("w2mt.storagewarned.v1")).toBe("1");
    expect(localStore.getItem("w2mt-stale-chunk-reload")).toBe("1");
    for (const old of [
      "btwb.mining",
      "btwb.backup.v1",
      "btwb.notifications.v1",
      "btwb.pendingtx.v1",
      "btwb.feedback.v1",
      "btwb.storagewarned.v1",
      "btwb-stale-chunk-reload",
    ]) {
      expect(localStore.getItem(old)).toBeNull();
    }
  });

  it("moves legacy session keys too", () => {
    sessionStore.setItem("btwb.booted", "1");
    sessionStore.setItem("btwb.pendingMineToggle", "1");
    migrateLegacyStorage();
    expect(sessionStore.getItem("w2mt.booted")).toBe("1");
    expect(sessionStore.getItem("w2mt.pendingMineToggle")).toBe("1");
    expect(sessionStore.getItem("btwb.booted")).toBeNull();
    expect(sessionStore.getItem("btwb.pendingMineToggle")).toBeNull();
  });

  it("never clobbers a value the new build already wrote", () => {
    localStore.setItem("btwb.mining", "0"); // stale legacy value
    localStore.setItem("w2mt.mining", "1"); // fresh value wins
    migrateLegacyStorage();
    expect(localStore.getItem("w2mt.mining")).toBe("1");
    expect(localStore.getItem("btwb.mining")).toBeNull(); // old one still removed
  });

  it("is a no-op when no legacy keys exist, and leaves foreign keys alone", () => {
    localStore.setItem("w2mt.mining", "1");
    localStore.setItem("other.app.key", "keep-me");
    migrateLegacyStorage();
    expect(localStore.getItem("w2mt.mining")).toBe("1");
    expect(localStore.getItem("other.app.key")).toBe("keep-me");
    expect(localStore.length).toBe(2);
  });

  it("survives blocked storage without throwing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    vi.stubGlobal("sessionStorage", undefined);
    expect(() => migrateLegacyStorage()).not.toThrow();
  });
});
