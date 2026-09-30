/**
 * Chain state machine integration - memory adapter, REAL proof-of-work.
 * Genesis seal -> local mining -> transfer confirmation -> reorg rollback ->
 * a competing branch applied from "the wire" -> the chain heals forward.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  GENESIS_TIMESTAMP,
  COIN,
  hashMeetsTarget,
  nowSeconds,
  serializeCoinbase,
  serializePopTransfer,
  splitBlockReward,
  type PopAttestation,
} from "@contracts/protocol";
import type { WireBlock } from "@contracts/wire";
import { signPopAttestation, signTransfer, walletFromPrivHex, type WalletKeys } from "@/lib/web2mint";
import { dsha256Hex, merkleRootHex } from "./blockchain";
import {
  ChainValidationError,
  admitTransfer,
  applyWireBlock,
  buildTemplate,
  getAddressOverview,
  getInfo,
  getRecentBlocks,
  getMempool,
  getTipSummary,
  initChain,
  rollbackToHeight,
  setPopAttestationsProvider,
  setPopMinerNodeIdProvider,
  submitBlock,
  violatesMinerCooldown,
  type TemplateView,
} from "./chain";
import { MemoryStorage } from "./storage";

// -- PoW: baked solutions + live search fallback ----------------------------
// The narrative below is fully deterministic (fixed keys, fixed timestamps),
// so every block's winning nonce is constant. They were found once with the
// live search and are baked here - test runs verify them with ONE hash each
// instead of grinding ~2^22 hashes per block. Any narrative change simply
// falls back to the live search (slow but correct) and prints new solutions.
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "W2MT1|7|0000004d243dae71ecf0ec46b68894e1ea539baa824f60c17441c9a7ab8516df|25d594fe04953c0dd72a0179ad153a3cd3fc502c9128bfb3add3528508992bd7|1790780233|": { nonce: 131070, hash: "000000089945bc2be94a71d9745138ef5efbc9a103f7e888661762fb2d98015a" },
  "W2MT1|1|5a8cfffbd77d6bef7ba317c347ed9106e1af4613b483606ad183ac6e3c63a519|f72870b67951742ef177fff6205a59a4c9b93cf714c1c27ae3bc769606db18dc|1790726401|": { nonce: 10944280, hash: "000000a5a3de17724f73bad848a9e2e1588c12b8c1e62f7fab526c6865277910" },
  "W2MT1|2|000000a5a3de17724f73bad848a9e2e1588c12b8c1e62f7fab526c6865277910|3a89e8d011489d4d9b5ba885e3311a72134ec02ceae8391230be113d108e1ed3|1790726402|": { nonce: 4696894, hash: "0000008a9ebe6418645ebed6e6e2118e2d084181ef264c1d975d7a092872fbf4" },
  "W2MT1|3|0000008a9ebe6418645ebed6e6e2118e2d084181ef264c1d975d7a092872fbf4|94b68e6a0dd91fa295c40f13f66c58fe4f06be07d294a9a8182d2c512133c0f5|1790726403|": { nonce: 2219337, hash: "0000022028cb577a23c4f14f3aa5a0dc752098855ee0de95fab19ba01884486e" },
  "W2MT1|3|0000008a9ebe6418645ebed6e6e2118e2d084181ef264c1d975d7a092872fbf4|91cb83215e346b2c8f61af3b71c7ffa64e6a5f95dd2bee274b752f688ed4a2e4|1790726403|": { nonce: 1274072, hash: "0000012860582197d6fa0ee996861c6a6d7f67993e5de3fda444bd7fbcfdeac5" },
  "W2MT1|4|0000012860582197d6fa0ee996861c6a6d7f67993e5de3fda444bd7fbcfdeac5|70747da059e0ee7683bbe2668320fb77f3b93b0bbbe0765de3d3255bb5ddb020|1790726404|": { nonce: 5799592, hash: "000001ddd5940af634c02e1bc950ded89b0a900d978d85be880b03b50eb004b6" },
  "W2MT1|5|000001ddd5940af634c02e1bc950ded89b0a900d978d85be880b03b50eb004b6|971ebe8d1548c4d202ab3c3cc0c26cf412f8df000e931b3b4d05d72c75167d95|1790726405|": { nonce: 3139307, hash: "0000025af98d10dbe1a34b786b700b1e9ecff55f6c822bdec7fda26353146617" },
  "W2MT1|6|0000025af98d10dbe1a34b786b700b1e9ecff55f6c822bdec7fda26353146617|92dcc0e29deae52b5c0789b7352fdfac1ad5e8397aa384bca9eebc279417ce0b|1790726406|": { nonce: 13636091, hash: "0000004d243dae71ecf0ec46b68894e1ea539baa824f60c17441c9a7ab8516df" },
  "W2MT1|7|0000004d243dae71ecf0ec46b68894e1ea539baa824f60c17441c9a7ab8516df|4dc9f4ae2c13b2c1e5e53df5f9ce0bfc57520b19716188823ac4ec05b304c336|1790726407|": { nonce: 3725285, hash: "00000096b740b0d3b5ded4b6a059af8002332a591044ce2408d567fc04aa523b" },
  "W2MT1|7|0000004d243dae71ecf0ec46b68894e1ea539baa824f60c17441c9a7ab8516df|25d594fe04953c0dd72a0179ad153a3cd3fc502c9128bfb3add3528508992bd7|1790726407|": { nonce: 5726857, hash: "000000af1327967f31291904022907e285d125a1033ab7e98f5813ce8c8aa575" },
  "W2MT1|7|0000004d243dae71ecf0ec46b68894e1ea539baa824f60c17441c9a7ab8516df|a281471fe3dcea4c7e77e3fe294d23c924837d6c55feac0e902a16925adf4e01|1790726407|": { nonce: 1790151, hash: "000002b738dd4ce44c4244c2afa0cd008d950d947018dc20e00bc8b243d611a4" },
  "W2MT1|7|0000004d243dae71ecf0ec46b68894e1ea539baa824f60c17441c9a7ab8516df|89b82d612ece85e5e1371ddf0a79aea88b45a05167c0599ba17506dabadaa8ef|1790726407|": { nonce: 1762845, hash: "00000159cf2b255c15d308c0d2430bb6f1b8a94853b65ffd3a848ddc1c163db9" },
  "W2MT1|7|0000004d243dae71ecf0ec46b68894e1ea539baa824f60c17441c9a7ab8516df|25d594fe04953c0dd72a0179ad153a3cd3fc502c9128bfb3add3528508992bd7|1790775083|": { nonce: 2892711, hash: "00000188c211540e7be91a03c76f230c5bb882fdfa58311388f82e4caeb9bd01" },
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
  throw new Error("nonce space exhausted");
}

async function mineNextBlock(miner: string): Promise<{ height: number; hash: string }> {
  const tpl: TemplateView = await buildTemplate(miner);
  const ts = tpl.minTimestamp; // deterministic - the whole narrative is
  const { nonce } = powSearch(
    `W2MT1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  return submitBlock(tpl.templateId, ts, nonce);
}

/**
 * Attestation-acceptance blocks MUST carry a wall-clock timestamp: the 300 s
 * freshness window is measured against the block's timestamp, so a block
 * carrying real attestations has to live in real time too. Non-deterministic
 * (live PoW every run) - only ever used for the LAST block of a narrative.
 */
async function mineNextBlockRealtime(miner: string): Promise<{ height: number; hash: string }> {
  const tpl: TemplateView = await buildTemplate(miner);
  const ts = Math.max(tpl.minTimestamp, nowSeconds());
  const { nonce } = powSearch(
    `W2MT1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  return submitBlock(tpl.templateId, ts, nonce);
}

/** A REAL peer-signed attestation - the exact bytes a wallet would produce. */
function attest(w: WalletKeys, minerPeerId: string, timestamp: number): PopAttestation {
  return {
    address: w.address,
    pubkey: w.pubHex,
    signature: signPopAttestation(w.privHex, { minerPeerId, address: w.address, timestamp }),
    timestamp,
  };
}
const TEST_NODE_ID = "w2mt-test-miner-node";

/** Craft a valid coinbase-only block extending `storage`'s block at height-1. */
async function craftSideBlock(
  storage: MemoryStorage,
  height: number,
  miner: string,
): Promise<WireBlock> {
  const prev = await storage.blockAt(height - 1);
  if (!prev) throw new Error("side-block parent missing");
  const amount = splitBlockReward(height, 0).miner;
  const cbTxid = dsha256Hex(serializeCoinbase({ height, to: miner, amount }));
  const merkleRoot = merkleRootHex([cbTxid]);
  const ts = prev.timestamp + 1;
  const { nonce, hash } = powSearch(
    `W2MT1|${height}|${prev.hash}|${merkleRoot}|${ts}|`,
    prev.target,
  );
  return {
    height,
    hash,
    prevHash: prev.hash,
    merkleRoot,
    timestamp: ts,
    nonce,
    target: prev.target,
    miner,
    message: null,
    txs: [
      {
        txid: cbTxid,
        type: "coinbase",
        fromAddress: null,
        toAddress: miner,
        amount,
        fee: 0,
        nonce: null,
        pubkey: null,
        signature: null,
        timestamp: ts,
      },
    ],
  };
}

// -- the narrative -----------------------------------------------------------
// Every block in this file is a bootstrap-era block with an empty PoP pool
// (unless a test announces peers): miner gets exactly the 70% share.
const MINER_SHARE = splitBlockReward(1, 0).miner;
const storage = new MemoryStorage();
let w1: WalletKeys; // mines the first blocks, sends the transfer
let w2: WalletKeys; // recipient
let w3: WalletKeys; // mines the competing branch

describe("browser chain node - full lifecycle", () => {
  beforeAll(async () => {
    await initChain(storage);
    // fixed keys -> a byte-deterministic narrative (baked PoW stays valid)
    w1 = walletFromPrivHex("01".repeat(32))!;
    w2 = walletFromPrivHex("02".repeat(32))!;
    w3 = walletFromPrivHex("03".repeat(32))!;
  }, 10_000);

  it("seals the deterministic genesis (hash pinned across every node)", async () => {
    const g = await storage.blockAt(0);
    expect(g?.hash).toBe(
      "5a8cfffbd77d6bef7ba317c347ed9106e1af4613b483606ad183ac6e3c63a519",
    );
    expect(g?.timestamp).toBe(GENESIS_TIMESTAMP);
    const info = await getInfo();
    expect(info.height).toBe(0);
    expect(info.chainId).toBe("web2mint-mainnet-1");
    expect(info.totalSupply).toBe(0);
  });

  it("mines two real blocks locally - subsidy lands", async () => {
    const b1 = await mineNextBlock(w1.address);
    expect(b1.height).toBe(1);
    const b2 = await mineNextBlock(w1.address);
    expect(b2.height).toBe(2);
    const acct = await getAddressOverview(w1.address);
    expect(acct.balance).toBe(2 * MINER_SHARE);
    expect(acct.blocksMined).toBe(2);
  }, 120_000);

  it("rejects garbage transfers before they touch the mempool", async () => {
    const unsigned = {
      from: w1.address,
      to: w2.address,
      amount: 10 * COIN,
      fee: 1_000,
      nonce: 0,
    };
    const goodSig = signTransfer(w1.privHex, unsigned);
    await expect(
      admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature: goodSig, nonce: 7 }),
    ).rejects.toThrow(ChainValidationError);
    const forged = signTransfer(w3.privHex, unsigned); // wrong key for w1's address
    await expect(
      admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature: forged }),
    ).rejects.toThrow(ChainValidationError);
  });

  it("confirms a signed transfer in the next block", async () => {
    const unsigned = {
      from: w1.address,
      to: w2.address,
      amount: 10 * COIN,
      fee: 1_000,
      nonce: 0,
    };
    const signature = signTransfer(w1.privHex, unsigned);
    const { txid } = await admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature });
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    // re-admitting the same tx trips the state guard first (same as the
    // server reference: nonce rule precedes the duplicate check)
    await expect(
      admitTransfer({ ...unsigned, pubkey: w1.pubHex, signature }),
    ).rejects.toThrow(/bad nonce/);
    expect((await getMempool(10)).length).toBe(1);

    const b3 = await mineNextBlock(w1.address);
    expect(b3.height).toBe(3);
    expect((await getMempool(10)).length).toBe(0);
    const r = await getAddressOverview(w2.address);
    expect(r.balance).toBe(10 * COIN);
    const s = await getAddressOverview(w1.address);
    expect(s.nonce).toBe(1);
    // w1 mined block #3 itself, but the 1000-unit fee is BURNED in full -
    // it never comes back to anyone: 3 miner shares - 10 W2MT sent - fee.
    expect(s.balance).toBe(3 * MINER_SHARE - 10 * COIN - 1_000);
  }, 120_000);

  it("rolls back one block exactly - mempool, balances, supply restored", async () => {
    await rollbackToHeight(2);
    const tip = await getTipSummary();
    expect(tip.height).toBe(2);
    expect((await getMempool(10)).length).toBe(1); // transfer is pending again
    const r = await getAddressOverview(w2.address);
    expect(r.balance).toBe(0);
    const s = await getAddressOverview(w1.address);
    expect(s.balance).toBe(2 * MINER_SHARE);
    expect(s.nonce).toBe(0);
    const info = await getInfo();
    expect(info.totalSupply).toBe(2 * MINER_SHARE);
  });

  it("applies a competing branch from the wire and keeps the pending tx", async () => {
    const side3 = await craftSideBlock(storage, 3, w3.address);
    await applyWireBlock(side3);
    const side4 = await craftSideBlock(storage, 4, w3.address);
    await applyWireBlock(side4);
    const tip = await getTipSummary();
    expect(tip.height).toBe(4);
    expect(tip.hash).toBe(side4.hash);

    const s = await getAddressOverview(w1.address);
    expect(s.balance).toBe(2 * MINER_SHARE); // block #3 reward stayed rolled back
    const m = await getAddressOverview(w3.address);
    expect(m.balance).toBe(2 * MINER_SHARE); // side branch paid w3
    expect((await getMempool(10)).length).toBe(1); // still pending
  }, 120_000);

  it("mines on the winning branch and confirms the long-pending transfer", async () => {
    const b5 = await mineNextBlock(w3.address);
    expect(b5.height).toBe(5);
    expect((await getMempool(10)).length).toBe(0);
    const r = await getAddressOverview(w2.address);
    expect(r.balance).toBe(10 * COIN);
    const s = await getAddressOverview(w1.address);
    expect(s.nonce).toBe(1);
    const info = await getInfo();
    expect(info.height).toBe(5);
  }, 120_000);

  it("rejects forged wire blocks with ChainValidationError", async () => {
    const tip = await getTipSummary();
    const fake = await craftSideBlock(storage, tip.height + 1, w3.address);
    fake.hash = "0".repeat(64); // lie about the header hash
    await expect(applyWireBlock(fake)).rejects.toThrow(ChainValidationError);
  }, 120_000);

  it("no attestations -> the whole 20% peer pool burns", async () => {
    setPopMinerNodeIdProvider(() => TEST_NODE_ID);
    setPopAttestationsProvider(() => []);
    const before = await getInfo();
    let mined: { height: number; hash: string };
    try {
      mined = await mineNextBlock(w3.address);
    } finally {
      setPopMinerNodeIdProvider(() => null);
    }
    expect(mined.height).toBe(6);
    const after = await getInfo();
    // only the miner's 70% was minted - the unattested pool never existed
    expect(after.totalSupply - before.totalSupply).toBe(splitBlockReward(6, 0).miner);
  }, 120_000);

  it("rejects blocks whose PoP attestations fail in any way", async () => {
    const tip = await getTipSummary();
    const height = tip.height + 1; // 7
    const ts = (await storage.blockAt(height - 1))!.timestamp + 1; // deterministic
    const good1 = splitBlockReward(height, 1);
    const good2 = splitBlockReward(height, 2);

    // (a) INVALID SIGNATURE - garbage bytes where a signature should be
    const badSig = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer, index: 0 }],
      [{ ...attest(w1, TEST_NODE_ID, ts), signature: "cd".repeat(64) }],
    );
    await expect(applyWireBlock(badSig)).rejects.toThrow(/PoP/);

    // (b) WRONG ADDRESS - the attestation pays w2, the block pays w1
    const wrongAddr = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer, index: 0 }],
      [attest(w2, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(wrongAddr)).rejects.toThrow(/PoP/);

    // (c) EXPIRED - signed 301 s before the block's timestamp
    const expired = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer, index: 0 }],
      [attest(w1, TEST_NODE_ID, ts - 301)],
    );
    await expect(applyWireBlock(expired)).rejects.toThrow(/PoP/);

    // (d) UNATTESTED PEER - the miner pays w1 AND w2, but only w1 attested
    const unattested = await craftSideBlockFull(
      storage, height, w3.address,
      [
        { address: w1.address, amount: good2.perPeer, index: 0 },
        { address: w2.address, amount: good2.perPeer, index: 1 },
      ],
      [attest(w1, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(unattested)).rejects.toThrow(/PoP/);

    // (e) NOT THE EQUAL SPLIT - greedy share, attestation itself valid
    const greedy = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w1.address, amount: good1.perPeer + 1, index: 0 }],
      [attest(w1, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(greedy)).rejects.toThrow(/PoP/);

    // (f) SELF-PAYMENT - the miner "attests" itself with its own key
    const selfPay = await craftSideBlockFull(
      storage, height, w3.address,
      [{ address: w3.address, amount: good1.perPeer, index: 0 }],
      [attest(w3, TEST_NODE_ID, ts)],
    );
    await expect(applyWireBlock(selfPay)).rejects.toThrow(/PoP/);
  }, 300_000);

  it("valid attestations -> block accepted, pool split equally, burn never mints", async () => {
    const before = await getInfo();
    const [a1, a2, a3] = await Promise.all([
      getAddressOverview(w1.address),
      getAddressOverview(w2.address),
      getAddressOverview(w3.address),
    ]);
    // real signatures, real time - the last block of the narrative (its hash
    // is wall-clock-dependent, so nothing deterministic follows it)
    setPopMinerNodeIdProvider(() => TEST_NODE_ID);
    setPopAttestationsProvider(() => [
      attest(w1, TEST_NODE_ID, nowSeconds()),
      attest(w2, TEST_NODE_ID, nowSeconds()),
      attest(w1, TEST_NODE_ID, nowSeconds()), // duplicate - freshest wins
    ]);
    let mined: { height: number; hash: string };
    try {
      mined = await mineNextBlockRealtime(w3.address);
    } finally {
      setPopAttestationsProvider(() => []);
      setPopMinerNodeIdProvider(() => null);
    }
    expect(mined.height).toBe(7);

    const split = splitBlockReward(7, 2);
    const [b1, b2, b3] = await Promise.all([
      getAddressOverview(w1.address),
      getAddressOverview(w2.address),
      getAddressOverview(w3.address),
    ]);
    expect(b3.balance - a3.balance).toBe(split.miner);
    expect(b1.balance - a1.balance).toBe(split.perPeer);
    expect(b2.balance - a2.balance).toBe(split.perPeer);
    const after = await getInfo();
    expect(after.totalSupply - before.totalSupply).toBe(split.miner + 2 * split.perPeer);

    // the stored block carries the full attestation evidence for sync peers
    const stored = await storage.blockAt(7);
    expect(stored?.minerPeerId).toBe(TEST_NODE_ID);
    expect(stored?.popAttestations.length).toBe(2);
  }, 300_000);
});

/** Like craftSideBlock, but commits to explicit PoP payouts + attestations. */
async function craftSideBlockFull(
  storage: MemoryStorage,
  height: number,
  miner: string,
  pops: Array<{ address: string; amount: number; index: number }>,
  atts: PopAttestation[],
): Promise<WireBlock> {
  const prev = await storage.blockAt(height - 1);
  if (!prev) throw new Error("side-block parent missing");
  const amount = splitBlockReward(height, pops.length).miner;
  const cbTxid = dsha256Hex(serializeCoinbase({ height, to: miner, amount }));
  const popIds = pops.map((pop) =>
    dsha256Hex(
      serializePopTransfer({ height, index: pop.index, to: pop.address, amount: pop.amount }),
    ),
  );
  const merkleRoot = merkleRootHex([cbTxid, ...popIds]);
  const ts = prev.timestamp + 1;
  const { nonce, hash } = powSearch(
    `W2MT1|${height}|${prev.hash}|${merkleRoot}|${ts}|`,
    prev.target,
  );
  return {
    height,
    hash,
    prevHash: prev.hash,
    merkleRoot,
    timestamp: ts,
    nonce,
    target: prev.target,
    miner,
    message: null,
    popTransfers: pops,
    minerPeerId: TEST_NODE_ID,
    popAttestations: atts,
    txs: [
      {
        txid: cbTxid,
        type: "coinbase",
        fromAddress: null,
        toAddress: miner,
        amount,
        fee: 0,
        nonce: null,
        pubkey: null,
        signature: null,
        timestamp: ts,
      },
    ],
  };
}

describe("miner cooldown (consensus from block 2,000)", () => {
  it("no address may mine two consecutive blocks once active", () => {
    const a = "w2m1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "w2m1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(violatesMinerCooldown(1, a, a)).toBe(false); // bootstrap era
    expect(violatesMinerCooldown(1_999, a, a)).toBe(false); // below activation
    expect(violatesMinerCooldown(2_000, a, b)).toBe(false); // rotation is fine
    expect(violatesMinerCooldown(2_000, a, null)).toBe(false); // unknown parent
    expect(violatesMinerCooldown(2_000, a, a)).toBe(true); // consecutive self
    expect(violatesMinerCooldown(9_999, a, a)).toBe(true); // stays enforced
  });

  it("below activation a repeat miner still gets a template (the gate opens only at 2,000)", async () => {
    const tip = await getTipSummary();
    expect(tip.height).toBeLessThan(2_000);
    const tipBlock = (await getRecentBlocks(1))[0];
    const tpl = await buildTemplate(tipBlock.miner); // same miner again - allowed here
    expect(tpl.height).toBe(tip.height + 1);
    // ...but that exact pairing becomes a violation the moment the gate opens:
    expect(violatesMinerCooldown(2_000, tipBlock.miner, tipBlock.miner)).toBe(true);
  });
});
