/**
 * Pruning under a hostile lens: the opt-in history prune must delete ONLY
 * confirmed tx rows below the horizon, refuse anything inside the reorg
 * window, keep headers/balances/supply/tip perfectly intact, and the node
 * must keep mining and validating afterwards. A pruned node must also
 * REFUSE a full-chain export loudly (its history has holes).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { GENESIS_TIMESTAMP, TARGET_BLOCK_TIME, hashMeetsTarget } from "@contracts/protocol";
import { walletFromPrivHex } from "@/lib/web2mint";
import {
  ChainValidationError,
  buildTemplate,
  exportChain,
  getAddressOverview,
  getInfo,
  getWireBlock,
  initChain,
  pruneConfirmedTxsBelow,
  submitBlock,
} from "./chain";
import { MemoryStorage } from "./storage";

const w1 = walletFromPrivHex("01".repeat(32))!;
const PRUNE_NARRATIVE_BLOCKS = 35;

// Coinbase-only chain to w1: every preimage is deterministic, so nonces are
// baked after the first live grind (see chain.test.ts for the pattern).
const BAKED: Record<string, { nonce: number; hash: string }> = {
  "W2MT1|1|5a8cfffbd77d6bef7ba317c347ed9106e1af4613b483606ad183ac6e3c63a519|f72870b67951742ef177fff6205a59a4c9b93cf714c1c27ae3bc769606db18dc|1790726460|": { nonce: 3352506, hash: "0000008e635962a02905d2176c9c545fb1ecdef002960d56151483622f64c52f" },
  "W2MT1|2|0000008e635962a02905d2176c9c545fb1ecdef002960d56151483622f64c52f|3a89e8d011489d4d9b5ba885e3311a72134ec02ceae8391230be113d108e1ed3|1790726520|": { nonce: 8561958, hash: "000001cd8481b55d8c51363ba7f644715150dfef90ebc7c65bc3337f7e41d579" },
  "W2MT1|3|000001cd8481b55d8c51363ba7f644715150dfef90ebc7c65bc3337f7e41d579|b306d79aa1cad36f26cb906563f71acd4c3f49c291bfa951008bde13529d35d9|1790726580|": { nonce: 3128170, hash: "000002a5981fab7fe94959b399260bba6d0e15e480c5b42ff923cffdea4c0ede" },
  "W2MT1|4|000002a5981fab7fe94959b399260bba6d0e15e480c5b42ff923cffdea4c0ede|83c02178da8c69e355edfbf88d1fc5fd03ed665202e5777665bdcb9409222dee|1790726640|": { nonce: 5450784, hash: "0000024249c227737c2f8ba51d08e479a0112f05a19cf9a7eeb76bf0e5cf6519" },
  "W2MT1|5|0000024249c227737c2f8ba51d08e479a0112f05a19cf9a7eeb76bf0e5cf6519|d2f0b16bb3caa9335431070d3e3e13e1ebbd0ec59e42997a7ca08c605d679a6a|1790726700|": { nonce: 1304897, hash: "000003dfec2eac002a85f6487c2d80a960d4af457613b26ea34168e0868bc194" },
  "W2MT1|6|000003dfec2eac002a85f6487c2d80a960d4af457613b26ea34168e0868bc194|4369e0eaf220cea6e50cee82d37ae2ce3ac669cced98cbdae916d4c82d182ea2|1790726760|": { nonce: 4780878, hash: "0000028b23dc02bff3c25e27baad562f0b6f2a9ee05e33601ac7bcf32736365b" },
  "W2MT1|7|0000028b23dc02bff3c25e27baad562f0b6f2a9ee05e33601ac7bcf32736365b|37d171f284f66c2f63f9d3cfa05ce820702aeaebafa054c775ff4244a7c0d986|1790726820|": { nonce: 947102, hash: "0000000f13b7642922f03f69154151cfc3e60bb2cc74b9dee368e6fa2ee9b38d" },
  "W2MT1|8|0000000f13b7642922f03f69154151cfc3e60bb2cc74b9dee368e6fa2ee9b38d|19960180ab202c8bc38b7d52b4ce6f9ce185bf07952ed7b219c2870c5fabd60d|1790726880|": { nonce: 6754202, hash: "0000022447bf7d9b6d4b1b5375bdad8304761de2c1dbe4f02d4cd24115172084" },
  "W2MT1|9|0000022447bf7d9b6d4b1b5375bdad8304761de2c1dbe4f02d4cd24115172084|6c36e8e5f546c15342f249405bbafec980793e137967ecd3203d1df7f85edab3|1790726940|": { nonce: 5894356, hash: "00000324fccae053112f33cc657ed31ca0c6452193ff346f484438f3d4020e71" },
  "W2MT1|10|00000324fccae053112f33cc657ed31ca0c6452193ff346f484438f3d4020e71|0c348f37ec78b51e452ec529d317e51f490630ea27a76e2c43d647cbddac54b8|1790727000|": { nonce: 431997, hash: "000001a4854673e7ee818695578ab8a738f3906fa07914f4a7d265ef7e893e66" },
  "W2MT1|11|000001a4854673e7ee818695578ab8a738f3906fa07914f4a7d265ef7e893e66|e1eb392702d0546edd2d29d721aa40c37c852b86fff1945698ddbe39f2047164|1790727060|": { nonce: 6277631, hash: "000002b0f42a34a0f0a3f90470185054ca9e0c0d0c4d0b1673ed7b81df52fecd" },
  "W2MT1|12|000002b0f42a34a0f0a3f90470185054ca9e0c0d0c4d0b1673ed7b81df52fecd|a559dd2659490aa2d3a3897531bd1475bb703fba636218381315d849ccb28a90|1790727120|": { nonce: 365583, hash: "000002a4a1ff2b4aa6a973a5daf2cfd97402f954451fcb48cbe89dc49d0e9061" },
  "W2MT1|13|000002a4a1ff2b4aa6a973a5daf2cfd97402f954451fcb48cbe89dc49d0e9061|5f0878ae9c93a8f76a8a62a5a6dac7bc965e36a5aa4b5335bed470f18e8e7b60|1790727180|": { nonce: 1016183, hash: "000001ea9f487007da267a12ac113e165aa0e036568339535ab53cc4bac3ccfc" },
  "W2MT1|14|000001ea9f487007da267a12ac113e165aa0e036568339535ab53cc4bac3ccfc|41c7edb0e256408bdb837c42ab73be0f0152dab2aec87bfb9b028f9f08dc99e3|1790727240|": { nonce: 7373712, hash: "00000379a3f7cbe01ca3d941f36ed803e9006ba6f25a0a7840efcd0427cc0bdb" },
  "W2MT1|15|00000379a3f7cbe01ca3d941f36ed803e9006ba6f25a0a7840efcd0427cc0bdb|70880183798ea796e6c37dc72712485c53b0fb8b97bb24acd4238cf7955543a1|1790727300|": { nonce: 6628289, hash: "0000022e8092537f32ece590128ed0a071eed882866d3b18f775270ddbd3d3f8" },
  "W2MT1|16|0000022e8092537f32ece590128ed0a071eed882866d3b18f775270ddbd3d3f8|5cbac1bf62d06701d95cc09b5893bfc07a97d97318baae0c97006ba43fdfdbb8|1790727360|": { nonce: 5123368, hash: "000000f35a7dabbc875c031859e8277e7000d75849a9f0b69485959d4dcc8c98" },
  "W2MT1|17|000000f35a7dabbc875c031859e8277e7000d75849a9f0b69485959d4dcc8c98|f9edf97e97dc1a7600b45e98257839ad5a976a855e95318577988e0cf21b449a|1790727420|": { nonce: 9399402, hash: "0000004a94d47b91ff0222924fe35818322d3ad3a25b236d4b27f438a7313e0c" },
  "W2MT1|18|0000004a94d47b91ff0222924fe35818322d3ad3a25b236d4b27f438a7313e0c|b64e6cb4651a36ddfd69b63683f432fb95b5affa3f8221ec04efd32239fb0257|1790727480|": { nonce: 3789458, hash: "0000025e036a72bcb7fc4c332d2c6132308741f1cd4164d3f25ec8633bb1b573" },
  "W2MT1|19|0000025e036a72bcb7fc4c332d2c6132308741f1cd4164d3f25ec8633bb1b573|e98af4062a0fc1aa3ad8ebb173cdf18af4b8c7306351480fec92910b2f6c7576|1790727540|": { nonce: 16923563, hash: "000001bc0e8098e2bd8395345e3f018c13ae1c41b47a1d7f58d4a7ca9e7f3b23" },
  "W2MT1|20|000001bc0e8098e2bd8395345e3f018c13ae1c41b47a1d7f58d4a7ca9e7f3b23|4f1caff673ec411e9ec459accf7706002e344529d593d8f7bee2f2677329b5f7|1790727600|": { nonce: 1874819, hash: "0000014d30b831bcecf687e7cd29b026e0c8465892fb1d64acb30cffccd4fc14" },
  "W2MT1|21|0000014d30b831bcecf687e7cd29b026e0c8465892fb1d64acb30cffccd4fc14|b514f1b292a14b6fe91ec9ee4cb6f428a41f2813d3a36551adee4495f02c23b6|1790727660|": { nonce: 944093, hash: "000000057eb6d678e231c898b2f1b92b35b52fc8730fd5a503a512e4f416dabd" },
  "W2MT1|22|000000057eb6d678e231c898b2f1b92b35b52fc8730fd5a503a512e4f416dabd|53bd56d075bb9e5ee4648b6c2011ce74d03ee60eb77a601d42125357641bae39|1790727720|": { nonce: 16016866, hash: "000000dc70312e70888cfb16e01246750e13d4b68bb086b32ef4157c673ea244" },
  "W2MT1|23|000000dc70312e70888cfb16e01246750e13d4b68bb086b32ef4157c673ea244|d286484d270ebbc4de2b25a0c20872ae0d17f17b2714c3209c837b4f1438bb76|1790727780|": { nonce: 7246025, hash: "000000627f54f1e481e6ce83b6f310cf79b6c299d3e30db3047161109662af37" },
  "W2MT1|24|000000627f54f1e481e6ce83b6f310cf79b6c299d3e30db3047161109662af37|3b87f21ee3f0037e280c3d730cd6e461f1b71ddd8453d875b66d7993668acb1a|1790727840|": { nonce: 4322206, hash: "0000012bbeba254ccbd2a9f2f3d62c87964835f7377bf751457a8c3ba276699b" },
  "W2MT1|25|0000012bbeba254ccbd2a9f2f3d62c87964835f7377bf751457a8c3ba276699b|e40e79be3e3c12d24f20c20e72528aee3dea11ff9cd44faf4c900ac74e03df98|1790727900|": { nonce: 10290547, hash: "0000002728712d3efba3fce8475d3187b1259c0fea76f8756bffdcc0a7b35f33" },
  "W2MT1|26|0000002728712d3efba3fce8475d3187b1259c0fea76f8756bffdcc0a7b35f33|0384db35b07f13564611d151535d987593b3ab27ff670634dae955d0817ecc34|1790727960|": { nonce: 1330782, hash: "0000006c96358def92e2e5d3695891b1a3c5b3e3c2b66f921db090aa16aef697" },
  "W2MT1|27|0000006c96358def92e2e5d3695891b1a3c5b3e3c2b66f921db090aa16aef697|3d67a0e069b59d485fa5c58e65e04c20eb36a06ef4f100fbe554ffd973bc33f4|1790728020|": { nonce: 3889374, hash: "000000fd1e0c3db3106fe8f80ae0803a2835448dd8c82d0f4021bf82272a9925" },
  "W2MT1|28|000000fd1e0c3db3106fe8f80ae0803a2835448dd8c82d0f4021bf82272a9925|3a59ca5b307ddd55e33f76c1adc44a2bf23f3c98f57fc918d8fe1c387485f069|1790728080|": { nonce: 1937236, hash: "00000180eb30c32e40cdc4849ae5ba16292b1b5809ee283bed5353c74598c86e" },
  "W2MT1|29|00000180eb30c32e40cdc4849ae5ba16292b1b5809ee283bed5353c74598c86e|afe05d94c2b9ba5ac2c8edc9413dba6d03b925fc9932be7fe66aac4e5b01b0cf|1790728140|": { nonce: 1664475, hash: "000002494c9f565459853d1221855d3915d51758f1a2713cfa4fed63c4d1924e" },
  "W2MT1|30|000002494c9f565459853d1221855d3915d51758f1a2713cfa4fed63c4d1924e|df82039cc1a75be9f03ee2aa831e878f0db771abdfc14fcede8ca37d0c7ee686|1790728200|": { nonce: 4193209, hash: "0000013c354dc9e75d79a98301c1710fb9d8d53c9f914d7e9164857b69311be3" },
  "W2MT1|31|0000013c354dc9e75d79a98301c1710fb9d8d53c9f914d7e9164857b69311be3|d376aa431bcce00a6f04ac2fc6e2feaf8218ff047f40a11b04b10677a2bd08aa|1790728260|": { nonce: 567491, hash: "000000ccbbb36bc0653274a9ee43b0c0e0e91969f6c79558ec020fb578267466" },
  "W2MT1|32|000000ccbbb36bc0653274a9ee43b0c0e0e91969f6c79558ec020fb578267466|5440a468be79dcdd2784246bc8e19144d8fd05eb6ca2f3b8f2f497bb28dc1641|1790728320|": { nonce: 227792, hash: "000002019cafb423a48faa69b554302ffb9d80074f8e33e8b049dbca88e3e6a0" },
  "W2MT1|33|000002019cafb423a48faa69b554302ffb9d80074f8e33e8b049dbca88e3e6a0|8a65950b70e42685b625b9774963675dda0c614700af575c3d0446c8d28b06df|1790728380|": { nonce: 12318147, hash: "0000012254303b5254f22c6a159231105edf29e1a555ac5d6b38f4fae63fc82c" },
  "W2MT1|34|0000012254303b5254f22c6a159231105edf29e1a555ac5d6b38f4fae63fc82c|21f229af41477eee4bcf0520e0829864cae92557a71d0aa6b55540c002413133|1790728440|": { nonce: 2256028, hash: "0000006caea3b9231888fa0784c1c341cf3df1be0c5dafa38712c05d6818b696" },
  "W2MT1|35|0000006caea3b9231888fa0784c1c341cf3df1be0c5dafa38712c05d6818b696|5c9836c4dee998aaee337484e3ab30c20fe6e55cc3e566117778ca56e03de93f|1790728500|": { nonce: 1157600, hash: "0000009b181b44ea03aa46d7c316a85a5ec3866a1546ec256c63ff8f8968eb36" },
  "W2MT1|36|0000009b181b44ea03aa46d7c316a85a5ec3866a1546ec256c63ff8f8968eb36|1bed4dc4a087bc0996a1f902e5c49a85a7445c61c87f986f14fc5aebc732642c|1790728560|": { nonce: 847776, hash: "0000004043e81f9ccd51c097b710d45a1f2158c204b63c1612e42886c6421131" },

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

async function mineOne(): Promise<{ height: number; hash: string }> {
  const tpl = await buildTemplate(w1.address);
  // 60s block spacing: the 8-block retarget sees ideal pace and difficulty
  // stays at 1 forever - minTimestamp spacing would clamp 4x harder every
  // 8 blocks and make the long narrative ungrindable.
  const ts = Math.max(tpl.minTimestamp, GENESIS_TIMESTAMP + tpl.height * TARGET_BLOCK_TIME);
  const { nonce } = powSearch(
    `W2MT1|${tpl.height}|${tpl.prevHash}|${tpl.merkleRoot}|${ts}|`,
    tpl.target,
  );
  const r = await submitBlock(tpl.templateId, ts, nonce);
  return { height: r.height, hash: r.hash };
}

let storage: MemoryStorage;
let tipHash35 = "";
let supply35 = 0;
let balance35 = 0;

beforeAll(async () => {
  storage = new MemoryStorage();
  await initChain(storage);
  for (let h = 1; h <= PRUNE_NARRATIVE_BLOCKS; h++) {
    const r = await mineOne();
    if (h === PRUNE_NARRATIVE_BLOCKS) tipHash35 = r.hash;
  }
  const i = await getInfo();
  supply35 = i.totalSupply;
  balance35 = (await getAddressOverview(w1.address)).balance;
}, 900_000);

describe("pruneConfirmedTxsBelow", () => {
  it("refuses a horizon inside the reorg window", async () => {
    // tip 35 - MAX_REORG_DEPTH 32 => deepest legal horizon is 3
    await expect(pruneConfirmedTxsBelow(4)).rejects.toThrow(ChainValidationError);
    await expect(pruneConfirmedTxsBelow(35)).rejects.toThrow(ChainValidationError);
  });

  it("prunes below the legal horizon: txs gone, headers stay, state exact", async () => {
    const removed = await pruneConfirmedTxsBelow(3);
    expect(removed).toBeGreaterThan(0);

    // historical txs are gone - those heights can no longer be SERVED
    expect(await getWireBlock(1)).toBeNull();
    expect(await getWireBlock(2)).toBeNull();
    // ...but their HEADERS remain (the chain of proof is unbroken)
    expect((await storage.blockAt(2))?.height).toBe(2);
    // heights at/above the horizon still serve in full
    expect((await getWireBlock(3))?.height).toBe(3);
    expect((await getWireBlock(PRUNE_NARRATIVE_BLOCKS))?.hash).toBe(tipHash35);

    // tip, supply and balances are untouched by the prune
    const i = await getInfo();
    expect(i.height).toBe(PRUNE_NARRATIVE_BLOCKS);
    expect(i.tipHash).toBe(tipHash35);
    expect(i.totalSupply).toBe(supply35);
    expect((await getAddressOverview(w1.address)).balance).toBe(balance35);
  });

  it("a pruned node cannot export a full chain - it says so loudly", async () => {
    await expect(exportChain()).rejects.toThrow(/pruned/);
  });

  it("the pruned node keeps mining and validating", async () => {
    const r = await mineOne(); // block 36 on pruned storage
    expect(r.height).toBe(PRUNE_NARRATIVE_BLOCKS + 1);
    const i = await getInfo();
    expect(i.height).toBe(PRUNE_NARRATIVE_BLOCKS + 1);
  }, 120_000);
});
