/**
 * Reset local data - unit tests with faked browser globals. Verifies the
 * exact wipe set: w2mt.* localStorage keys plus any pre-rebrand btwb.*
 * leftovers, all of sessionStorage, the chain database by its real name
 * (plus the legacy pre-re-genesis database), then a reload - and that a
 * blocked or missing IndexedDB still ends in reload (the user must never
 * stay trapped on the failure screen).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_ID } from "@contracts/protocol";
import { resetLocalData } from "./reset";

type DeleteHandler = (() => void) | null;

class FakeIDBRequest {
  onsuccess: DeleteHandler = null;
  onerror: DeleteHandler = null;
  onblocked: DeleteHandler = null;
}

function makeLocalStorage(initial: Record<string, string>) {
  // Real Storage exposes stored keys as own enumerable string properties,
  // which is what Object.keys(localStorage) walks. Mirror that with a Proxy
  // so the wipe loop under test sees exactly what a browser would show it.
  const map = new Map(Object.entries(initial));
  const methods = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  return new Proxy(methods, {
    ownKeys: () => [...map.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    get: (target, prop: string | symbol) => {
      if (typeof prop === "string" && map.has(prop)) return map.get(prop);
      return Reflect.get(target, prop);
    },
  }) as typeof methods;
}

let localStore: ReturnType<typeof makeLocalStorage>;
let sessionClear: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
let deletedNames: string[];
let fireOn: "onsuccess" | "onerror" | "onblocked";

beforeEach(() => {
  localStore = makeLocalStorage({
    "w2mt.notifications.v1": "[]",
    "w2mt.pendingtx.v1": "[]",
    "w2mt.mining": "1",
    "btwb.mining": "1", // pre-rebrand leftover - reset must kill it too
    "other.app.key": "keep-me",
  });
  sessionClear = vi.fn();
  reload = vi.fn();
  deletedNames = [];
  fireOn = "onsuccess";

  vi.stubGlobal("localStorage", localStore);
  vi.stubGlobal("sessionStorage", { clear: sessionClear });
  vi.stubGlobal("indexedDB", {
    deleteDatabase: (name: string) => {
      deletedNames.push(name);
      const req = new FakeIDBRequest();
      queueMicrotask(() => req[fireOn]?.());
      return req;
    },
  });
  vi.stubGlobal("location", { reload });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resetLocalData", () => {
  it("removes every w2mt.* and legacy btwb.* key but leaves foreign keys alone", async () => {
    await resetLocalData();
    expect(localStore.getItem("w2mt.notifications.v1")).toBeNull();
    expect(localStore.getItem("w2mt.pendingtx.v1")).toBeNull();
    expect(localStore.getItem("w2mt.mining")).toBeNull();
    expect(localStore.getItem("btwb.mining")).toBeNull();
    expect(localStore.getItem("other.app.key")).toBe("keep-me");
  });

  it("clears sessionStorage and deletes the chain database by its real name", async () => {
    await resetLocalData();
    expect(sessionClear).toHaveBeenCalledOnce();
    expect(deletedNames).toEqual([`w2mt-${CHAIN_ID}`, "bitweb-bitweb-mainnet-1"]);
    expect(deletedNames[0]).toBe("w2mt-web2mint-mainnet-1");
  });

  it("reloads after a successful wipe", async () => {
    await resetLocalData();
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each(["onerror", "onblocked"] as const)(
    "still reloads when the database delete fires %s",
    async (event) => {
      fireOn = event;
      await resetLocalData();
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  it("still reloads when IndexedDB itself throws (blocked storage)", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await resetLocalData();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("still reloads when localStorage access throws", async () => {
    vi.stubGlobal("localStorage", {
      get length() {
        throw new Error("denied");
      },
    });
    // Object.keys on the stub throws -> caught -> continue with the rest
    await resetLocalData();
    expect(sessionClear).toHaveBeenCalledOnce();
    expect(deletedNames).toEqual([`w2mt-${CHAIN_ID}`, "bitweb-bitweb-mainnet-1"]);
    expect(reload).toHaveBeenCalledOnce();
  });
});
