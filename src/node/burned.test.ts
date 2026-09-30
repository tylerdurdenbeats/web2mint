/**
 * Total-burned counter - the number behind the Terminal page's
 * "BURNED FOREVER: %x" line. totalBurned is derived, never stored:
 *
 *     totalBurned = (sum of every block reward ever emitted) - totalSupply
 *
 * Rewards are a pure function of height, so the emission sum is exact on
 * every chain path - and the gap between emission and live supply is by
 * construction the split burn + rounding dust + unclaimed PoP + fees.
 * These tests pin that identity with real blocks, real fees, a rollback,
 * and a file import.
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { COIN, hashMeetsTarget } from "@contracts/protocol";
import { signTransfer, walletFromPrivHex } from "@/lib/web2mint";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const w2 = walletFromPrivHex("02".repeat(32))!;

// Deterministic PoW, coinbase-only chain paying w1 (same preimages as
// chain-gate.test.ts / import-safety.test.ts - searched once, baked).
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "W2MT1|1|5a8cfffbd77d6bef7ba317c347ed9106e1af4613b483606ad183ac6e3c63a519|f72870b67951742ef177fff6205a59a4c9b93cf714c1c27ae3bc769606db18dc|1790726401|": { nonce: 10944280, hash: "000000a5a3de17724f73bad848a9e2e1588c12b8c1e62f7fab526c6865277910" },
  "W2MT1|2|000000a5a3de17724f73bad848a9e2e1588c12b8c1e62f7fab526c6865277910|db890a297076e7698a524f956677ae4a3256aba1c2d10e3f48728f0a732214e3|1790726402|": { nonce: 10249328, hash: "000003b5c1bc2d0dba1800fb3d5f51ad1b740c64c08b79408dfe8dc1cdaf04cc" },
  "W2MT1|2|000000a5a3de17724f73bad848a9e2e1588c12b8c1e62f7fab526c6865277910|3a89e8d011489d4d9b5ba885e3311a72134ec02ceae8391230be113d108e1ed3|1790726402|": { nonce: 4696894, hash: "0000008a9ebe6418645ebed6e6e2118e2d084181ef264c1d975d7a092872fbf4" },
  "W2MT1|3|0000008a9ebe6418645ebed6e6e2118e2d084181ef264c1d975d7a092872fbf4|b306d79aa1cad36f26cb906563f71acd4c3f49c291bfa951008bde13529d35d9|1790726403|": { nonce: 4438951, hash: "000002243a8692b6fe826e97559d6a4352df5a62856377263e98f51995b43ce3" },
};

function powSearch(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  if (baked) return baked;
  const prefix = utf8ToBytes(prefixAscii);
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

type ChainModule = typeof import("./chain");

async function freshChain(): Promise<ChainModule> {
  vi.resetModules();
  const chain = await import("./chain");
  await chain.initChain(new MemoryStorage());
  return chain;
}

async function mineOne(chain: ChainModule): Promise<{ height: number; hash: string }> {
  const tpl = await chain.buildTemplate(w1.address);
  const ts = tpl.minTimestamp;
  const { nonce } = powSearch(
    `W2MT1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  const r = await chain.submitBlock(tpl.templateId, ts, nonce);
  return { height: r.height, hash: r.hash };
}

// Bootstrap era: 500 W2MT per block; solo miner (zero attesting peers)
// mints only the 70% share = 350; the other 150 (10% burn + unclaimed 20%
// pool) is gone forever.
const BLOCK_EMISSION = 500 * COIN;
const SOLO_MINTED = 350 * COIN;
const SOLO_BURNED = BLOCK_EMISSION - SOLO_MINTED; // 150 W2MT

describe("totalBurned - the BURNED FOREVER counter", () => {
  it("genesis: nothing emitted, nothing burned", async () => {
    const chain = await freshChain();
    const info = await chain.getInfo();
    expect(info.totalSupply).toBe(0);
    expect(info.totalBurned).toBe(0);
  });

  it("one solo block: 500 emitted, 350 minted, exactly 150 burned", async () => {
    const chain = await freshChain();
    await mineOne(chain);
    const info = await chain.getInfo();
    expect(info.totalSupply).toBe(SOLO_MINTED);
    expect(info.totalBurned).toBe(SOLO_BURNED);
    // conservation: emission = supply + burned, to the last base unit
    expect(info.totalSupply + info.totalBurned).toBe(BLOCK_EMISSION);
  }, 300_000);

  it("fees join the burn: a mined transfer burns its fee on top of the split", async () => {
    const chain = await freshChain();
    await mineOne(chain); // fund w1 (baked)

    const unsigned = { from: w1.address, to: w2.address, amount: 10 * COIN, fee: 1_000, nonce: 0 };
    const signature = signTransfer(w1.privHex, unsigned);
    await chain.admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature });

    await mineOne(chain); // includes the transfer - live PoW (new merkle)
    const info = await chain.getInfo();
    expect(info.totalSupply).toBe(2 * SOLO_MINTED - 1_000); // fee left existence
    expect(info.totalBurned).toBe(2 * SOLO_BURNED + 1_000); // and joined the counter
    expect(info.totalSupply + info.totalBurned).toBe(2 * BLOCK_EMISSION);
    expect((await chain.getAddressOverview(w2.address)).balance).toBe(10 * COIN);
  }, 300_000);

  it("rollback un-burns exactly what the undone blocks had burned", async () => {
    const chain = await freshChain();
    await mineOne(chain);
    await mineOne(chain);
    expect((await chain.getInfo()).totalBurned).toBe(2 * SOLO_BURNED);

    await chain.rollbackToHeight(1);
    const info = await chain.getInfo();
    expect(info.height).toBe(1);
    expect(info.totalBurned).toBe(SOLO_BURNED); // emission cache rebuilt, not stale
    expect(info.totalSupply + info.totalBurned).toBe(BLOCK_EMISSION);
  }, 300_000);

  it("import: a fresh node derives the full burned figure from the file", async () => {
    const src = await freshChain();
    for (let h = 1; h <= 3; h++) await mineOne(src);
    const file = JSON.parse(JSON.stringify(await src.exportChain())) as unknown;
    expect((await src.getInfo()).totalBurned).toBe(3 * SOLO_BURNED);

    const dst = await freshChain();
    await dst.importChain(file);
    const info = await dst.getInfo();
    expect(info.height).toBe(3);
    expect(info.totalBurned).toBe(3 * SOLO_BURNED);
    expect(info.totalSupply + info.totalBurned).toBe(3 * BLOCK_EMISSION);
  }, 300_000);
});
