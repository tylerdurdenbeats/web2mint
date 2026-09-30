/**
 * Relay-policy guard: one sender may hold at most MAX_MEMPOOL_PER_SENDER
 * pending slots, so a single funded wallet cannot occupy the whole mempool
 * with min-fee spam. Node policy, NOT consensus - block validity is
 * untouched, which this test proves by mining the queued txs afterwards.
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { GENESIS_TIMESTAMP, hashMeetsTarget } from "@contracts/protocol";
import { signTransfer, walletFromPrivHex } from "@/lib/web2mint";

const w1 = walletFromPrivHex("01".repeat(32))!;

// Same deterministic block-1 as chain.test.ts: coinbase-only to w1 at the
// genesis+1 timestamp - the baked nonce verifies with ONE hash.
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "W2MT1|1|5a8cfffbd77d6bef7ba317c347ed9106e1af4613b483606ad183ac6e3c63a519|f72870b67951742ef177fff6205a59a4c9b93cf714c1c27ae3bc769606db18dc|1790726401|": { nonce: 10944280, hash: "000000a5a3de17724f73bad848a9e2e1588c12b8c1e62f7fab526c6865277910" },
};

function powSearch(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  if (baked) {
    const prefix = utf8ToBytes(prefixAscii);
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(baked.nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hash !== baked.hash || !hashMeetsTarget(hash, target)) {
      throw new Error(`baked solution invalid for ${prefixAscii}`);
    }
    return baked;
  }
  const prefix = utf8ToBytes(prefixAscii);
  for (let nonce = 0; nonce < 2 ** 31; nonce++) {
    const d1 = sha256.create().update(prefix).update(utf8ToBytes(String(nonce))).digest();
    const hash = bytesToHex(sha256(d1));
    if (hashMeetsTarget(hash, target)) {
      console.log(`BAKE: "${prefixAscii}": { nonce: ${nonce}, hash: "${hash}" },`);
      return { nonce, hash };
    }
  }
  throw new Error("pow search exhausted");
}

describe("mempool relay policy", () => {
  it("caps one sender at MAX_MEMPOOL_PER_SENDER pending slots", async () => {
    vi.resetModules();
    const chain = await import("./chain");
    const { MemoryStorage } = await import("./storage");
    await chain.initChain(new MemoryStorage());

    // fund w1 with one bootstrap coinbase (350 W2MT covers 64 x 1001 units)
    const tpl = await chain.buildTemplate(w1.address);
    const ts = GENESIS_TIMESTAMP + 1;
    const win = powSearch(
      `W2MT1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
      tpl.target,
    );
    await chain.submitBlock(tpl.templateId, ts, win.nonce);

    // exactly MAX_MEMPOOL_PER_SENDER sequential pending txs are admitted
    for (let nonce = 0; nonce < chain.MAX_MEMPOOL_PER_SENDER; nonce++) {
      const unsigned = { from: w1.address, to: w1.address, amount: 1, fee: 1_000, nonce };
      const signature = signTransfer(w1.privHex, unsigned);
      await chain.admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature });
    }
    expect(await chain.getMempool(100)).toHaveLength(chain.MAX_MEMPOOL_PER_SENDER);

    // slot 65 from the SAME sender is refused by policy
    const over = { from: w1.address, to: w1.address, amount: 1, fee: 1_000, nonce: chain.MAX_MEMPOOL_PER_SENDER };
    await expect(
      chain.admitTransfer({ ...over, pubkey: w1.pubHex, signature: signTransfer(w1.privHex, over) }),
    ).rejects.toThrow(/too many pending transactions from one sender/);

    // consensus untouched: the queued txs still mine into a valid block
    const tpl2 = await chain.buildTemplate(w1.address);
    expect(tpl2.txCount).toBeGreaterThan(0);
  }, 60_000);
});
