/**
 * Boot recovery - the balances table is derived state. If it is ever lost
 * while the blocks survive (partial storage eviction, profile damage), the
 * node must rebuild it: replaying from genesis, or from the latest local
 * state snapshot when one exists. Real PoW, memory adapter, one continuous
 * narrative (the chain module binds one storage per process).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { hashMeetsTarget } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/web2mint";
import {
  buildTemplate,
  getAddressOverview,
  getInfo,
  initChain,
  recoverChainState,
  submitBlock,
} from "./chain";
import { MemoryStorage } from "./storage";

// Baked PoW solutions (deterministic narrative: fixed keys, synthetic
// timestamps) - verified with ONE hash each; the live search only grinds
// when the narrative changes (and prints fresh solutions to bake).
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "W2MT1|1|5a8cfffbd77d6bef7ba317c347ed9106e1af4613b483606ad183ac6e3c63a519|c07694a6cdddcc6b8ca223191c73cc38440a9b82deda49b040e13d5652317f95|1790726401|": { nonce: 7466369, hash: "000001edaf9f63bf6c8d2392329b038cde757e1d9d2166c8b4d5bd9c0dd1cf20" },
  "W2MT1|2|000001edaf9f63bf6c8d2392329b038cde757e1d9d2166c8b4d5bd9c0dd1cf20|23f13cbdc09cd3f567b3fc1f2c52c9482f615b724438a1d5b7776af2d284c548|1790726402|": { nonce: 1703950, hash: "000002d69cb96952bd32112250e943d47132d510a33ddc4191bcab85dd7d6e7c" },
  "W2MT1|3|000002d69cb96952bd32112250e943d47132d510a33ddc4191bcab85dd7d6e7c|9aef239525e90cfa5897c697541d582a8032d878a479f4a6c989cfc9a0529d7d|1790726403|": { nonce: 1942207, hash: "0000001ac8402215de21b3a7891042a75fae14b6e3a8e0b284e8210ea46090ab" },
  "W2MT1|4|0000001ac8402215de21b3a7891042a75fae14b6e3a8e0b284e8210ea46090ab|ec74c1838bb66af95810060eaefca8d7428fb47c7762646a183c570d00358d4a|1790726404|": { nonce: 546201, hash: "00000267152472ee4c993dd65859d3b8a2865656bf5f3b90198b337da564afe4" },
};

function pow(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  const prefix = utf8ToBytes(prefixAscii);
  if (baked) {
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(baked.nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hash !== baked.hash || !hashMeetsTarget(hash, target)) {
      throw new Error(`baked solution invalid for ${prefixAscii}`);
    }
    return baked;
  }
  for (let nonce = 0; nonce < 2 ** 31; nonce++) {
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hashMeetsTarget(hash, target)) {
      console.log(`BAKE: "${prefixAscii}": { nonce: ${nonce}, hash: "${hash}" },`);
      return { nonce, hash };
    }
  }
  throw new Error("nonce space exhausted");
}

async function mineNext(miner: string): Promise<void> {
  const tpl = await buildTemplate(miner);
  const ts = tpl.minTimestamp; // synthetic - deterministic narrative
  const { nonce } = pow(
    `W2MT1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  await submitBlock(tpl.templateId, ts, nonce);
}

/** Simulate the disaster: every account zeroed (balances sum != supply). */
async function wipeBalances(storage: MemoryStorage): Promise<void> {
  await storage.transact(async (tx) => {
    for (const acc of await tx.allAccounts()) {
      await tx.putAccount({ ...acc, balance: 0 });
    }
  });
}

describe("boot state recovery", () => {
  const storage = new MemoryStorage();
  const minerA = walletFromPrivHex("aa".repeat(32))!;
  const minerB = walletFromPrivHex("bb".repeat(32))!;

  beforeAll(async () => {
    await initChain(storage);
    await mineNext(minerA.address); // block 1
    await mineNext(minerA.address); // block 2
  }, 120_000);

  it("rebuilds lost balances by replaying blocks from genesis", async () => {
    const before = await getAddressOverview(minerA.address);
    const supplyBefore = (await getInfo()).totalSupply;
    expect(before.balance).toBeGreaterThan(0);

    await wipeBalances(storage);
    await recoverChainState();

    const after = await getAddressOverview(minerA.address);
    expect(after.balance).toBe(before.balance);
    expect((await getInfo()).totalSupply).toBe(supplyBefore);
  });

  /** The supply the BLOCKS themselves imply: sum(reward + pop - fees). */
  async function blockImpliedSupply(): Promise<number> {
    const tip = (await storage.tip())!;
    let sum = 0;
    for (let h = 1; h <= tip.height; h++) {
      const b = (await storage.blockAt(h))!;
      sum += b.reward + b.popTransfers.reduce((x, p) => x + p.amount, 0) - b.feesBurned;
    }
    return sum;
  }

  it("a corrupted totalSupply meta heals back to the block-implied value", async () => {
    // Drift left behind by any historical version: the meta row no longer
    // matches the chain. Balances are INTACT - a rebuild must restore the
    // meta without touching (let alone double-crediting) a single balance.
    const expected = await blockImpliedSupply();
    expect((await getInfo()).totalSupply).toBe(expected);
    const balA = (await getAddressOverview(minerA.address)).balance;

    await storage.transact(async (tx) => {
      await tx.setMeta("totalSupply", String(expected + 12_345));
    });
    await recoverChainState();

    expect((await getInfo()).totalSupply).toBe(expected);
    expect((await getAddressOverview(minerA.address)).balance).toBe(balA);
  });

  it("a single corrupted balance heals, supply untouched", async () => {
    const expected = await blockImpliedSupply();
    const balA = (await getAddressOverview(minerA.address)).balance;

    await storage.transact(async (tx) => {
      const acc = (await tx.account(minerA.address))!;
      await tx.putAccount({ ...acc, balance: acc.balance + 1 });
    });
    await recoverChainState();

    expect((await getInfo()).totalSupply).toBe(expected);
    expect((await getAddressOverview(minerA.address)).balance).toBe(balA);
  });

  it("supply and balances drifted TOGETHER still heals (the old check missed this)", async () => {
    // The pre-fix invariant was only sum(balances) === totalSupply: drift
    // that moved BOTH caches by the same amount passed it and lived
    // forever - which is exactly how devices ended up showing different
    // supply for the same chain. The block-implied cross-check catches it.
    const expected = await blockImpliedSupply();
    const balA = (await getAddressOverview(minerA.address)).balance;

    await storage.transact(async (tx) => {
      const acc = (await tx.account(minerA.address))!;
      await tx.putAccount({ ...acc, balance: acc.balance + 777 });
      await tx.setMeta("totalSupply", String(expected + 777));
    });
    // sanity: the OLD invariant alone would call this state healthy
    const accounts = await storage.allAccounts();
    const held = accounts.reduce((s, a) => s + a.balance, 0);
    expect(held).toBe(expected + 777);

    await recoverChainState();

    expect((await getInfo()).totalSupply).toBe(expected);
    expect((await getAddressOverview(minerA.address)).balance).toBe(balA);
  });

  it("rebuilds from the latest snapshot even when early blocks are gone", async () => {
    // The exact row the SNAPSHOT_INTERVAL hook persists every 1,000 blocks.
    // NOTE: destructive (block 1 is deleted) - the checkpoint tests below
    // intentionally run on this post-disaster state.
    const tip2 = (await storage.tip())!;
    expect(tip2.height).toBe(2);
    const accountsAt2 = await storage.allAccounts();
    const supplyAt2 = Number((await storage.getMeta("totalSupply")) ?? "0");
    await storage.transact(async (tx) => {
      await tx.putSnapshot({
        height: tip2.height,
        blockHash: tip2.hash,
        totalSupply: supplyAt2,
        accounts: accountsAt2,
      });
    });

    await mineNext(minerB.address); // block 3
    const before = await getAddressOverview(minerB.address);
    const supplyBefore = (await getInfo()).totalSupply;
    expect(before.balance).toBeGreaterThan(0);

    // Worse disaster: balances wiped AND block 1 pruned away - replaying
    // from genesis is impossible; only the snapshot path can heal this.
    await storage.transact(async (tx) => {
      for (const acc of await tx.allAccounts()) {
        await tx.putAccount({ ...acc, balance: 0 });
      }
      await tx.deleteTxsInBlock(1);
      await tx.deleteBlock(1);
    });
    await recoverChainState();

    const afterA = await getAddressOverview(minerA.address);
    const afterB = await getAddressOverview(minerB.address);
    expect(afterB.balance).toBe(before.balance);
    expect(afterA.balance).toBe(supplyAt2); // snapshot state survived intact
    expect((await getInfo()).totalSupply).toBe(supplyBefore);
  }, 120_000);

  it("checkpoint fast path: a fully verified chain costs ZERO block reads on the next check", async () => {
    // The rebuild above pinned the checkpoint at the tip. A healthy re-check
    // must not touch the blocks store at all - boot stays O(1) no matter
    // how long the chain grows. (This is the boot-time regression guard.)
    const spy = vi.spyOn(storage, "blockAt");
    try {
      await recoverChainState();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const cp = JSON.parse((await storage.getMeta("recoveryCheckpoint"))!);
    expect(cp.height).toBe((await storage.tip())!.height);
    expect(cp.expected).toBe((await getInfo()).totalSupply);
  });

  it("incremental scan: only blocks ABOVE the checkpoint are read", async () => {
    await mineNext(minerB.address); // block 4
    const spy = vi.spyOn(storage, "blockAt");
    try {
      await recoverChainState();
      expect(spy.mock.calls.map((c) => c[0])).toEqual([4]);
    } finally {
      spy.mockRestore();
    }
    // the checkpoint advanced to the new tip with the healed-true value
    const cp = JSON.parse((await storage.getMeta("recoveryCheckpoint"))!);
    expect(cp.height).toBe(4);
    expect(cp.expected).toBe((await getInfo()).totalSupply);
  });

  it("a garbage checkpoint meta falls back to a full scan and still boots healthy", async () => {
    // Corrupt the performance anchor itself: the node must simply pay one
    // full scan (and stay healthy - the derived caches here are intact).
    // Never trust the checkpoint format blindly.
    const validCp = (await storage.getMeta("recoveryCheckpoint")) ?? null;
    const supplyNow = (await getInfo()).totalSupply;
    await storage.transact(async (tx) => {
      await tx.setMeta("recoveryCheckpoint", "{definitely not json");
    });
    const spy = vi.spyOn(storage, "blockAt");
    try {
      await recoverChainState();
      const heights = spy.mock.calls.map((c) => c[0]);
      expect(heights).toContain(1); // full scan from genesis, not the fast path
    } finally {
      spy.mockRestore();
    }
    expect((await getInfo()).totalSupply).toBe(supplyNow); // untouched
    // restore the fast path for any later boots of this narrative
    if (validCp !== null) {
      await storage.transact(async (tx) => {
        await tx.setMeta("recoveryCheckpoint", validCp);
      });
    }
  });
});
