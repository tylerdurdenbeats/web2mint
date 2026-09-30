/**
 * Reset local data - the recovery hatch on the boot failure screen. Wipes
 * every piece of Web2Mint state on this origin (the IndexedDB chain database
 * with the wallet inside it, the localStorage preference keys, session
 * flags), then reloads the page so the node boots from a clean slate.
 * Lets a user escape any stale state without opening DevTools.
 */
import { CHAIN_ID } from "@contracts/protocol";

export async function resetLocalData(): Promise<void> {
  try {
    for (const key of Object.keys(localStorage)) {
      // current keys plus the pre-rebrand prefixes, so a reset after the
      // migration still wipes any legacy leftovers
      if (
        key.startsWith("w2mt.") ||
        key.startsWith("w2mt-") ||
        key.startsWith("btwb.") ||
        key.startsWith("btwb-")
      ) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // storage blocked - nothing to clear
  }
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
  try {
    // The current chain database plus the legacy pre-rebrand one (a foreign
    // chain now, but its bytes still sit on this origin until wiped).
    const names = [`w2mt-${CHAIN_ID}`, "bitweb-bitweb-mainnet-1"];
    for (const name of names) {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        const done = () => resolve();
        req.onsuccess = done;
        req.onerror = done; // a blocked/missing db must not trap the user
        req.onblocked = done;
      });
    }
  } catch {
    // IndexedDB unavailable - nothing to delete
  }
  location.reload();
}
