/**
 * One-time storage migration for the rebrand: every pre-rebrand
 * localStorage/sessionStorage key is copied to its new name and then
 * removed, so no legacy key lingers on this origin. Runs once at boot,
 * BEFORE any module reads its key.
 *
 * Only preferences and intents move. The wallet private key lives in the
 * IndexedDB database and is deliberately untouched by this migration.
 * A user who somehow ends up on an old cached build afterwards loses only
 * these preferences (mining intent, notification feed, sound toggle) -
 * never coins.
 */
const LOCAL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["btwb.mining", "w2mt.mining"],
  ["btwb.backup.v1", "w2mt.backup.v1"],
  ["btwb.notifications.v1", "w2mt.notifications.v1"],
  ["btwb.pendingtx.v1", "w2mt.pendingtx.v1"],
  ["btwb.feedback.v1", "w2mt.feedback.v1"],
  ["btwb.storagewarned.v1", "w2mt.storagewarned.v1"],
  ["btwb-stale-chunk-reload", "w2mt-stale-chunk-reload"],
];

const SESSION_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["btwb.booted", "w2mt.booted"],
  ["btwb.pendingMineToggle", "w2mt.pendingMineToggle"],
];

function migrateStore(store: Storage | undefined, pairs: ReadonlyArray<readonly [string, string]>): void {
  if (!store) return;
  for (const [oldKey, newKey] of pairs) {
    try {
      const value = store.getItem(oldKey);
      if (value === null) continue;
      // never clobber a value the new build already wrote
      if (store.getItem(newKey) === null) store.setItem(newKey, value);
      store.removeItem(oldKey);
    } catch {
      // storage blocked (private mode) - leave everything exactly as found
    }
  }
}

export function migrateLegacyStorage(): void {
  try {
    migrateStore(globalThis.localStorage, LOCAL_KEYS);
  } catch {
    // localStorage unavailable
  }
  try {
    migrateStore(globalThis.sessionStorage, SESSION_KEYS);
  } catch {
    // sessionStorage unavailable
  }
}
