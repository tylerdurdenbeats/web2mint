/**
 * Import safety - the chain can never be downgraded by a file, and the
 * balance math has a numeric proof.
 *
 *   - SHORTER file: rejected by default (ChainDowngradeError), local chain
 *     and balances intact - even { replace: true } alone is not enough.
 *     Only { replace, allowDowngrade } (the UI's dangerous override, which
 *     shows both heights and both tip hashes) applies it - and logs it.
 *   - EQUAL height, same tip: "already up to date" no-op.
 *   - EQUAL height, different tip: fork conflict, default = keep local.
 *   - LONGER valid file: applied directly (the normal case).
 *   - LONGER invalid file: rejected before a single write.
 *   - NUMERIC PROOF: the known 14-block reference chain (heights 0-13, 13
 *     coinbases of 350 W2MT to one address) imported on an EMPTY node gives
 *     balance === spendable === 4550 W2MT, topbar compact "4.55k".
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { COIN, hashMeetsTarget, splitBlockReward } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/web2mint";
import { fmtCompact } from "@/lib/format";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const w2 = walletFromPrivHex("02".repeat(32))!;

const BAKED: Record<string, { nonce: number; hash: string }> = {
  "W2MT1|1|5a8cfffbd77d6bef7ba317c347ed9106e1af4613b483606ad183ac6e3c63a519|f72870b67951742ef177fff6205a59a4c9b93cf714c1c27ae3bc769606db18dc|1790726401|": { nonce: 10944280, hash: "000000a5a3de17724f73bad848a9e2e1588c12b8c1e62f7fab526c6865277910" },
  "W2MT1|2|000000a5a3de17724f73bad848a9e2e1588c12b8c1e62f7fab526c6865277910|3a89e8d011489d4d9b5ba885e3311a72134ec02ceae8391230be113d108e1ed3|1790726402|": { nonce: 4696894, hash: "0000008a9ebe6418645ebed6e6e2118e2d084181ef264c1d975d7a092872fbf4" },
  "W2MT1|3|0000008a9ebe6418645ebed6e6e2118e2d084181ef264c1d975d7a092872fbf4|b306d79aa1cad36f26cb906563f71acd4c3f49c291bfa951008bde13529d35d9|1790726403|": { nonce: 4438951, hash: "000002243a8692b6fe826e97559d6a4352df5a62856377263e98f51995b43ce3" },
  "W2MT1|4|000002243a8692b6fe826e97559d6a4352df5a62856377263e98f51995b43ce3|83c02178da8c69e355edfbf88d1fc5fd03ed665202e5777665bdcb9409222dee|1790726404|": { nonce: 16988104, hash: "000001da27e07dde2bd0cbea196ff41e25f2fe2fa87c1204c56b41bc9cdf04c4" },
  "W2MT1|5|000001da27e07dde2bd0cbea196ff41e25f2fe2fa87c1204c56b41bc9cdf04c4|d2f0b16bb3caa9335431070d3e3e13e1ebbd0ec59e42997a7ca08c605d679a6a|1790726405|": { nonce: 2353944, hash: "0000001ace9f465d03f06a7de5583b4fe1f1c092cbae8b6d8d78371df5540e5f" },
  "W2MT1|6|0000001ace9f465d03f06a7de5583b4fe1f1c092cbae8b6d8d78371df5540e5f|4369e0eaf220cea6e50cee82d37ae2ce3ac669cced98cbdae916d4c82d182ea2|1790726406|": { nonce: 6437845, hash: "0000004f3392fd05f68ded40cc5e6e5f9f2cf78bd1aa96e2e1b039268b9088fe" },
  "W2MT1|7|0000004f3392fd05f68ded40cc5e6e5f9f2cf78bd1aa96e2e1b039268b9088fe|37d171f284f66c2f63f9d3cfa05ce820702aeaebafa054c775ff4244a7c0d986|1790726407|": { nonce: 2601164, hash: "0000020c314b4f9af4022ee1dd265125cfc39ba14702faa978de999f42196b32" },
  "W2MT1|8|0000020c314b4f9af4022ee1dd265125cfc39ba14702faa978de999f42196b32|19960180ab202c8bc38b7d52b4ce6f9ce185bf07952ed7b219c2870c5fabd60d|1790726408|": { nonce: 2868825, hash: "000000affb701323238671fac8e95d1a7ee0e70b1a9f8cdb5ff5fe751f905db2" },
  "W2MT1|9|000000affb701323238671fac8e95d1a7ee0e70b1a9f8cdb5ff5fe751f905db2|6c36e8e5f546c15342f249405bbafec980793e137967ecd3203d1df7f85edab3|1790726409|": { nonce: 6850097, hash: "0000005ee6cc35371fd16d146d0cb191173c44a4630c3f01f7fea45c34cd0046" },
  "W2MT1|10|0000005ee6cc35371fd16d146d0cb191173c44a4630c3f01f7fea45c34cd0046|0c348f37ec78b51e452ec529d317e51f490630ea27a76e2c43d647cbddac54b8|1790726410|": { nonce: 8736064, hash: "000000f68f4b18aa83b2ad12419fdb1700fc3d6eb6fe7427092df15307582d62" },
  "W2MT1|11|000000f68f4b18aa83b2ad12419fdb1700fc3d6eb6fe7427092df15307582d62|e1eb392702d0546edd2d29d721aa40c37c852b86fff1945698ddbe39f2047164|1790726411|": { nonce: 24308765, hash: "0000007dec05bdb2ee1651358e492670b83ddf3a523cdeda9bb0caa88457f356" },
  "W2MT1|12|0000007dec05bdb2ee1651358e492670b83ddf3a523cdeda9bb0caa88457f356|a559dd2659490aa2d3a3897531bd1475bb703fba636218381315d849ccb28a90|1790726412|": { nonce: 6503227, hash: "000000a1ffc68ac99a9e1d198cf8825394f6860ea1ef7c89499c078781d77382" },
  "W2MT1|13|000000a1ffc68ac99a9e1d198cf8825394f6860ea1ef7c89499c078781d77382|5f0878ae9c93a8f76a8a62a5a6dac7bc965e36a5aa4b5335bed470f18e8e7b60|1790726413|": { nonce: 6517565, hash: "00000007403f9bb3696115fa59b2a4e149764a03764b7136ce80998e4868369d" },
  "W2MT1|1|5a8cfffbd77d6bef7ba317c347ed9106e1af4613b483606ad183ac6e3c63a519|3a6149de3c21abdda3db6ce78f0f360dac8012dbe4720d6428786a5d936a7a95|1790726401|": { nonce: 691486, hash: "0000012ad2fed0ac1a5e90a04e1cb041e276e1f386e61a3fd8a0dc7f07de9583" },
  // blocks 1-13 paying w1, one continuous coinbase-only chain (the known
  // 14-block reference chain) - deterministic preimages, baked once
  // block #1 paying w2 (the fork / longer-chain tests below)
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

async function mineOne(chain: ChainModule, miner: string): Promise<{ height: number; hash: string }> {
  const tpl = await chain.buildTemplate(miner);
  const ts = tpl.minTimestamp;
  const { nonce } = powSearch(
    `W2MT1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  const r = await chain.submitBlock(tpl.templateId, ts, nonce);
  return { height: r.height, hash: r.hash };
}

function asFile(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data));
}

describe("import safety - never downgrade the chain", () => {
  it("NUMERIC PROOF: 13 x 350 W2MT coinbases on an empty node -> 4550 / 4550 / compact", async () => {
    const src = await freshChain();
    for (let h = 1; h <= 13; h++) await mineOne(src, w1.address);
    const data = asFile(await src.exportChain());

    const dst = await freshChain(); // EMPTY node (genesis only)
    const res = await dst.importChain(data);
    expect(res).toEqual({ height: 13, applied: true });

    const perBlock = splitBlockReward(1, 0).miner; // 350 W2MT - the 70% share
    expect(perBlock).toBe(350 * COIN);
    const expected = 13 * perBlock; // 4,550 W2MT - no double counting of anything
    const view = await dst.getAddressOverview(w1.address);
    expect(view.balance).toBe(expected);
    expect(view.available).toBe(expected); // no pending outgoing
    expect(view.balance).toBe(4550 * COIN);
    expect(view.available).toBe(4550 * COIN);
    expect(fmtCompact(view.balance)).toBe("4.55k"); // the topbar figure in "W2MT: 4.55k"
    // the whole supply is exactly those 13 coinbases - nothing else exists
    expect((await dst.getInfo()).totalSupply).toBe(expected);
  }, 300_000);

  it("a SHORTER file is rejected by default - local chain and balance intact", async () => {
    const src = await freshChain();
    const b1 = await mineOne(src, w1.address);
    const shortFile = asFile(await src.exportChain()); // height 1

    const local = await freshChain();
    await local.importChain(shortFile);
    await mineOne(local, w1.address);
    const tip = await mineOne(local, w1.address); // local is now height 3
    const balBefore = (await local.getAddressOverview(w1.address)).balance;

    const err = await local.importChain(shortFile).catch((e) => e);
    expect(err).toBeInstanceOf(local.ChainDowngradeError);
    expect(err.kind).toBe("downgrade");
    expect(err.local).toEqual({ height: 3, hash: tip.hash });
    expect(err.incoming).toEqual({ height: 1, hash: b1.hash });
    expect(err.message).toMatch(/SHORTER \(H:1\) than your local chain \(H:3\)/);
    expect(err.message).toMatch(/lose 2 block\(s\)/);

    // untouched: tip, balance, and spendable are exactly what they were
    expect((await local.getInfo()).tipHash).toBe(tip.hash);
    const view = await local.getAddressOverview(w1.address);
    expect(view.balance).toBe(balBefore);
    expect(view.available).toBe(balBefore);
  }, 300_000);

  it("{ replace: true } alone is NOT enough for a downgrade", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    const shortFile = asFile(await src.exportChain());

    const local = await freshChain();
    await local.importChain(shortFile);
    await mineOne(local, w1.address);
    const tip = await local.getTipSummary();

    await expect(local.importChain(shortFile, { replace: true })).rejects.toBeInstanceOf(
      local.ChainDowngradeError,
    );
    expect((await local.getTipSummary()).hash).toBe(tip.hash);
  }, 300_000);

  it("dangerous override: shorter file applies ONLY with replace + allowDowngrade, and is logged", async () => {
    const src = await freshChain();
    const b1 = await mineOne(src, w1.address);
    const shortFile = asFile(await src.exportChain());

    const local = await freshChain();
    await local.importChain(shortFile);
    await mineOne(local, w1.address);
    await mineOne(local, w1.address); // local height 3

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await local.importChain(shortFile, { replace: true, allowDowngrade: true });
    expect(res).toEqual({ height: 1, applied: true });
    expect((await local.getTipSummary()).hash).toBe(b1.hash);
    // the override is on record - both heights, both tip hashes
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/DANGEROUS OVERRIDE/);
    expect(logged).toContain(b1.hash);
    warn.mockRestore();
  }, 300_000);

  it("equal height, same tip -> already up to date, zero change", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain());

    const dst = await freshChain();
    await dst.importChain(data);
    const res = await dst.importChain(data);
    expect(res).toEqual({ height: 1, applied: false });
  }, 300_000);

  it("equal height, different tip -> fork warning, default keeps local", async () => {
    const src = await freshChain();
    const fileTip = await mineOne(src, w1.address);
    const data = asFile(await src.exportChain());

    const local = await freshChain();
    const localTip = await mineOne(local, w2.address); // same height, other chain

    const err = await local.importChain(data).catch((e) => e);
    expect(err).toBeInstanceOf(local.ChainConflictError);
    expect(err.kind).toBe("fork");
    expect(err.local.hash).toBe(localTip.hash);
    expect(err.incoming.hash).toBe(fileTip.hash);
    // default = keep local
    expect((await local.getTipSummary()).hash).toBe(localTip.hash);
    // explicit opt-in replaces
    const res = await local.importChain(data, { replace: true });
    expect(res).toEqual({ height: 1, applied: true });
    expect((await local.getTipSummary()).hash).toBe(fileTip.hash);
  }, 300_000);

  it("a LONGER valid file applies directly - the normal case needs no confirmation", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    await mineOne(src, w1.address);
    const fileTip = await mineOne(src, w1.address); // height 3
    const data = asFile(await src.exportChain());

    const local = await freshChain();
    await mineOne(local, w2.address); // a DIFFERENT local chain, height 1

    const res = await local.importChain(data); // no replace flag at all
    expect(res).toEqual({ height: 3, applied: true });
    expect((await local.getTipSummary()).hash).toBe(fileTip.hash);
    // balances recomputed from the resulting chain: w2's local history is gone
    expect((await local.getAddressOverview(w2.address)).balance).toBe(0);
    expect((await local.getAddressOverview(w1.address)).balance).toBe(3 * 350 * COIN);
  }, 300_000);

  it("a LONGER invalid file is rejected - local chain fully intact", async () => {
    const src = await freshChain();
    await mineOne(src, w1.address);
    await mineOne(src, w1.address);
    const data = asFile(await src.exportChain()) as Awaited<ReturnType<typeof src.exportChain>>;
    data.blocks[2].txs[0].amount += 1; // forged coinbase on the longer chain

    const local = await freshChain();
    const localTip = await mineOne(local, w2.address);
    await expect(local.importChain(data)).rejects.toThrow(/coinbase|amount/i);
    expect((await local.getTipSummary()).hash).toBe(localTip.hash);
    expect((await local.getAddressOverview(w2.address)).balance).toBe(350 * COIN);
  }, 300_000);
});
