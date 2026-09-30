/**
 * Reorg rollback - the undo path under a hostile lens: every effect of a
 * block must reverse EXACTLY, orphaned transfers must resurrect into the
 * mempool (they may be mined again on the winning branch), and state must
 * be byte-identical to the pre-block world.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { COIN, hashMeetsTarget } from "@contracts/protocol";
import { signTransfer, walletFromPrivHex } from "@/lib/web2mint";
import {
  admitTransfer,
  buildTemplate,
  getAddressOverview,
  getInfo,
  getMempool,
  initChain,
  rollbackToHeight,
  submitBlock,
} from "./chain";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const w2 = walletFromPrivHex("02".repeat(32))!;
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "W2MT1|1|5a8cfffbd77d6bef7ba317c347ed9106e1af4613b483606ad183ac6e3c63a519|f72870b67951742ef177fff6205a59a4c9b93cf714c1c27ae3bc769606db18dc|1790726401|": { nonce: 10944280, hash: "000000a5a3de17724f73bad848a9e2e1588c12b8c1e62f7fab526c6865277910" },
  "W2MT1|2|000000a5a3de17724f73bad848a9e2e1588c12b8c1e62f7fab526c6865277910|bad40a903f58dc31143af691e6d7445cc58cb0f9e05681959150851d2341a344|1790726402|": { nonce: 6755367, hash: "000000f2e3e0f93ee7d44e86e01a725019c5ba895cc1cdd858e2816e95f50ae3" },
  // block #1 paying w1 - identical preimage to chain.test.ts (same miner, same parent)
  // block #2 paying w1, carrying the w1->w2 transfer (deterministic txid) -
  // mined twice in the narrative (original chain + healing branch), same bake
};

function powSearch(prefixAscii: string, target: string): { nonce: number; hash: string } {
  const baked = BAKED[prefixAscii];
  if (baked && baked.hash) return baked;
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

async function mineOne(): Promise<{ height: number; hash: string }> {
  const tpl = await buildTemplate(w1.address);
  const ts = tpl.minTimestamp;
  const { nonce } = powSearch(
    `W2MT1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  const r = await submitBlock(tpl.templateId, ts, nonce);
  return { height: r.height, hash: r.hash };
}

let txid = "";
let supplyAt1 = 0;
let b2hash = "";

beforeAll(async () => {
  await initChain(new MemoryStorage());
  await mineOne(); // block 1: 350 W2MT to w1 (bootstrap 500 x 70%)
  const i1 = await getInfo();
  supplyAt1 = i1.totalSupply;

  // w1 sends 100 W2MT + fee to w2; the transfer sits in the mempool
  const signature = signTransfer(w1.privHex, {
    from: w1.address,
    to: w2.address,
    amount: 100 * COIN,
    fee: 1_000,
    nonce: 0,
  });
  const admitted = await admitTransfer({
    from: w1.address,
    to: w2.address,
    amount: 100 * COIN,
    fee: 1_000,
    nonce: 0,
    pubkey: w1.pubHex,
    signature,
  });
  txid = admitted.txid;
  expect((await getMempool(10)).length).toBe(1);

  b2hash = (await mineOne()).hash; // block 2 confirms the transfer
  expect((await getMempool(10)).length).toBe(0);
}, 300_000);

describe("rollback resurrects orphaned transfers and restores everything", () => {
  it("block 2 confirmed the transfer before the rollback", async () => {
    const w2v = await getAddressOverview(w2.address);
    expect(w2v.balance).toBe(100 * COIN);
    const w1v = await getAddressOverview(w1.address);
    expect(w1v.balance).toBe(2 * 350 * COIN - (100 * COIN + 1_000));
    const i = await getInfo();
    expect(i.height).toBe(2);
    expect(i.totalSupply).toBe(supplyAt1 + 350 * COIN - 1_000); // fee burned
  });

  it("rollback to height 1: tx back in mempool, balances and supply exact", async () => {
    await rollbackToHeight(1);

    // the orphaned transfer is spendable again - mempool resurrection
    const mp = await getMempool(10);
    expect(mp.length).toBe(1);
    expect(mp[0].txid).toBe(txid);
    expect(mp[0].fromAddress).toBe(w1.address);

    // balances return to the exact post-block-1 world
    const w1v = await getAddressOverview(w1.address);
    expect(w1v.balance).toBe(350 * COIN);
    const w2v = await getAddressOverview(w2.address);
    expect(w2v.balance).toBe(0);

    // supply reverses minted-minus-burned exactly
    const i = await getInfo();
    expect(i.height).toBe(1);
    expect(i.totalSupply).toBe(supplyAt1);
    expect(i.tipHash).not.toBe(b2hash);
  });

  it("the resurrected transfer mines again on the healing branch", async () => {
    const b2b = await mineOne(); // new block 2 picks the same tx up again
    expect(b2b.height).toBe(2);
    expect((await getMempool(10)).length).toBe(0);
    const w2v = await getAddressOverview(w2.address);
    expect(w2v.balance).toBe(100 * COIN); // arrived via the replacement block
  });
});
