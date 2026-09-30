/**
 * Sybil-gate integration: a scripted fake peer over a stub transport proves
 * the handshake challenge actually gates data flow - silent peers are
 * dropped at the deadline (no strike: slow is not evil), data-before-
 * verification is buffered until the gate opens (timing is not malice),
 * and a wrong solution earns a strike.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAIN_ID, NODE_AGENT, P2P_VERSION, encodeMessage } from "@contracts/wire";

interface StubLink {
  id: string;
  sent: string[];
}

/** A Transport whose links the test scripts by hand. */
class StubTransport {
  readonly kind = "stub";
  readonly selfId = "stub-self";
  links_: StubLink[] = [];
  closed: string[] = [];
  private events!: import("./transport").TransportEvents;

  start(events: import("./transport").TransportEvents): Promise<void> {
    this.events = events;
    return Promise.resolve();
  }
  stop(): void {}
  dial(): void {}
  send(peerId: string, data: string): void {
    this.links_.find((l) => l.id === peerId)?.sent.push(data);
  }
  close(peerId: string): void {
    this.closed.push(peerId);
    this.links_ = this.links_.filter((l) => l.id !== peerId);
  }
  links(): string[] {
    return this.links_.map((l) => l.id);
  }

  // -- test-side scripting --
  connect(id: string): StubLink {
    const link: StubLink = { id, sent: [] };
    this.links_.push(link);
    this.events.onOpen(id);
    return link;
  }
  inbound(id: string, msg: unknown): void {
    this.events.onMessage(id, encodeMessage(msg as never));
  }
  lastSent<T = unknown>(id: string, type: string): T | null {
    const link = this.links_.find((l) => l.id === id);
    if (!link) return null;
    for (let i = link.sent.length - 1; i >= 0; i--) {
      const m = JSON.parse(link.sent[i]) as { type?: string };
      if (m.type === type) return m as T;
    }
    return null;
  }
}

type EngineModule = typeof import("./p2p");
type ChainModule = typeof import("./chain");

async function boot(challengeTimeoutMs: number): Promise<{
  engine: InstanceType<EngineModule["P2pEngine"]>;
  transport: StubTransport;
  chain: ChainModule;
}> {
  vi.resetModules();
  const chain = (await import("./chain")) as ChainModule;
  const { MemoryStorage } = await import("./storage");
  await chain.initChain(new MemoryStorage());
  const p2p = (await import("./p2p")) as EngineModule;
  const transport = new StubTransport();
  const engine = new p2p.P2pEngine([transport], { challengeTimeoutMs });
  await engine.start();
  return { engine, transport, chain };
}

async function sayHello(
  transport: StubTransport,
  chain: ChainModule,
  id: string,
): Promise<void> {
  const genesisHash = await chain.getGenesisHash();
  transport.inbound(id, {
    type: "hello",
    hello: {
      chainId: CHAIN_ID,
      p2pVersion: P2P_VERSION,
      agent: NODE_AGENT,
      genesisHash,
      height: 0,
      tipHash: genesisHash,
      serverTime: Math.floor(Date.now() / 1000),
      nodeId: id,
    },
  });
  // let the engine's per-peer queue run
  await new Promise((r) => setTimeout(r, 50));
}

describe("sybil handshake gate", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it("issues a challenge on hello; a silent peer gets grace windows, then is dropped", async () => {
    // QoS0 transports lose frames and busy phones answer late, so the wire
    // timeout no longer drops on the FIRST window: the SAME nonce is
    // re-offered twice (a fresh nonce would orphan an in-flight honest
    // answer), and only a peer silent through all three windows is dropped.
    const { engine, transport, chain } = await boot(300);
    cleanup.push(() => engine.stop());

    transport.connect("ghost-1");
    await sayHello(transport, chain, "ghost-1");

    const seen = () => {
      const link = transport.links_.find((l) => l.id === "ghost-1")!;
      return link.sent
        .map((s) => JSON.parse(s) as { type?: string; nonce?: string })
        .filter((m) => m.type === "challenge");
    };
    expect(seen()).toHaveLength(1);
    const nonce = seen()[0].nonce;
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(engine.peerCount()).toBe(1); // still connected - the clock is ticking

    await new Promise((r) => setTimeout(r, 380)); // window 2: re-offer, same nonce
    expect(seen()).toHaveLength(2);
    expect(seen()[1].nonce).toBe(nonce);
    expect(engine.peerCount()).toBe(1); // grace: NOT dropped yet

    await new Promise((r) => setTimeout(r, 380)); // window 3: last re-offer
    expect(seen()).toHaveLength(3);
    expect(seen()[2].nonce).toBe(nonce);
    expect(engine.peerCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 380)); // silence through all windows
    expect(engine.peerCount()).toBe(0); // dropped, no strike - just gone
    expect(transport.closed).toContain("ghost-1");
  }, 20_000);

  it("a slow-but-honest peer answering in a grace window verifies - no drop, no strike", async () => {
    // The iPhone-mid-sync case: the answer lands in the SECOND window. The
    // gate must open normally and the link must survive long past the first
    // (frozen) wire timeout - grace never punishes lateness.
    const { engine, transport, chain } = await boot(250);
    cleanup.push(() => engine.stop());
    const { solveSybilChallenge } = await import("./blockchain");

    transport.connect("tardy-1");
    await sayHello(transport, chain, "tardy-1");
    const challenge = transport.lastSent<{ nonce: string }>("tardy-1", "challenge")!;

    await new Promise((r) => setTimeout(r, 320)); // first window expired, re-offer sent
    const solution = solveSybilChallenge(challenge.nonce, "0000")!;
    transport.inbound("tardy-1", { type: "challengeResponse", nonce: challenge.nonce, solution });
    await new Promise((r) => setTimeout(r, 150));

    expect(engine.peerCount()).toBe(1);
    expect(engine.peerList()[0]?.strikes).toBe(0);
    // verified: a getBlocks is now SERVED, and no further re-offers fire
    transport.inbound("tardy-1", { type: "getBlocks", from: 0, count: 1 });
    await new Promise((r) => setTimeout(r, 150));
    expect(transport.lastSent("tardy-1", "blocks")).toBeTruthy();
    const offers = transport.links_
      .find((l) => l.id === "tardy-1")!
      .sent.filter((s) => (JSON.parse(s) as { type?: string }).type === "challenge");
    await new Promise((r) => setTimeout(r, 600)); // two more windows pass
    const offersLater = transport.links_
      .find((l) => l.id === "tardy-1")!
      .sent.filter((s) => (JSON.parse(s) as { type?: string }).type === "challenge");
    expect(offersLater.length).toBe(offers.length); // timer cleared on verify
    expect(engine.peerCount()).toBe(1);
  }, 20_000);

  it("a re-delivered challenge is re-answered from the cache - the solver runs ONCE", async () => {
    // Broker fan-out can deliver one challenge frame twice, and the issuer
    // re-offers the nonce when our answer dies in transit. Every duplicate
    // must get the SAME cached bytes back - re-solving would burn another
    // ~65k hashes of main-thread CPU per duplicate (the Safari stutter).
    const { solveSybilChallenge } = await import("./blockchain");
    let solveCalls = 0;
    const spySolve = (nonce: string, prefix: string) => {
      solveCalls += 1;
      return Promise.resolve(solveSybilChallenge(nonce, prefix));
    };
    vi.resetModules();
    const chain = (await import("./chain")) as ChainModule;
    const { MemoryStorage } = await import("./storage");
    await chain.initChain(new MemoryStorage());
    const p2p = (await import("./p2p")) as EngineModule;
    const transport = new StubTransport();
    const engine = new p2p.P2pEngine([transport], {
      challengeTimeoutMs: 60_000,
      solveChallenge: spySolve,
    });
    cleanup.push(() => engine.stop());
    await engine.start();

    transport.connect("dup-1");
    await new Promise((r) => setTimeout(r, 50));
    const frame = { type: "challenge", nonce: "abcdef0123456789" };
    transport.inbound("dup-1", frame);
    await new Promise((r) => setTimeout(r, 300));
    transport.inbound("dup-1", frame); // the duplicate delivery
    transport.inbound("dup-1", frame); // ...and a third copy
    await new Promise((r) => setTimeout(r, 300));

    expect(solveCalls).toBe(1); // solved once, answered from cache twice more
    const link = transport.links_.find((l) => l.id === "dup-1")!;
    const answers = link.sent
      .map((s) => JSON.parse(s) as { type?: string; nonce?: string; solution?: string })
      .filter((m) => m.type === "challengeResponse");
    expect(answers).toHaveLength(3);
    expect(answers[0].nonce).toBe("abcdef0123456789");
    expect(answers[1]).toEqual(answers[0]); // byte-identical cached answer
    expect(answers[2]).toEqual(answers[0]);
    expect(engine.peerList()[0]?.strikes ?? 0).toBe(0);
  }, 20_000);

  it("data before verification is buffered, not struck - then flushed", async () => {
    // Timing races are not malice: a fast honest peer's first request can
    // arrive before our gate opens (e.g. right after a mutual-dial swap).
    // The gate must hold the frame - no strike, no service - and flush it
    // once the handshake completes.
    const { engine, transport, chain } = await boot(60_000);
    cleanup.push(() => engine.stop());
    const { solveSybilChallenge } = await import("./blockchain");

    transport.connect("rusher-1");
    await sayHello(transport, chain, "rusher-1");
    expect(transport.lastSent("rusher-1", "challenge")).toBeTruthy();

    transport.inbound("rusher-1", { type: "getBlocks", from: 0, count: 16 });
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.peerList()[0]?.strikes).toBe(0); // held, not punished...
    expect(transport.lastSent("rusher-1", "blocks")).toBeNull(); // ...not served yet

    const challenge = transport.lastSent<{ nonce: string }>("rusher-1", "challenge")!;
    const solution = solveSybilChallenge(challenge.nonce, "0000")!;
    transport.inbound("rusher-1", { type: "challengeResponse", nonce: challenge.nonce, solution });
    await new Promise((r) => setTimeout(r, 150));

    expect(engine.peerList()[0]?.strikes).toBe(0);
    expect(transport.lastSent("rusher-1", "blocks")).toBeTruthy(); // flushed + answered
  }, 20_000);

  it("a wrong solution earns a strike; the peer stays unverified", async () => {
    const { engine, transport, chain } = await boot(60_000);
    cleanup.push(() => engine.stop());

    transport.connect("cheat-1");
    await sayHello(transport, chain, "cheat-1");
    const challenge = transport.lastSent<{ nonce: string }>("cheat-1", "challenge")!;
    // deterministically wrong: the first candidate that fails verification
    const { checkSybilSolution } = await import("./blockchain");
    let wrong = "0";
    while (checkSybilSolution(challenge.nonce, wrong, "0000")) {
      wrong = (parseInt(wrong, 16) + 1).toString(16);
    }
    transport.inbound("cheat-1", {
      type: "challengeResponse",
      nonce: challenge.nonce,
      solution: wrong,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.peerList()[0]?.strikes).toBe(1);
    // still gated: a follow-up request is buffered, never served
    transport.inbound("cheat-1", { type: "getBlocks", from: 0, count: 16 });
    await new Promise((r) => setTimeout(r, 100));
    expect(transport.lastSent("cheat-1", "blocks")).toBeNull();
  }, 20_000);

  it("drops a peer speaking a different wire version - no strike, no sync", async () => {
    // Version skew after a consensus-relevant update must not fork the mesh:
    // a mismatched p2pVersion hello is refused BEFORE the challenge is even
    // issued. Politely: closed, not banned - running old code is not evil.
    const { engine, transport, chain } = await boot(60_000);
    cleanup.push(() => engine.stop());
    const genesisHash = await chain.getGenesisHash();

    transport.connect("old-1");
    transport.inbound("old-1", {
      type: "hello",
      hello: {
        chainId: CHAIN_ID,
        p2pVersion: P2P_VERSION + 1, // a node from another software generation
        agent: "web2mint-web-mainnet/99.0",
        genesisHash,
        height: 0,
        tipHash: genesisHash,
        serverTime: Math.floor(Date.now() / 1000),
        nodeId: "old-1",
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    expect(engine.peerCount()).toBe(0); // gone...
    expect(transport.closed).toContain("old-1"); // ...politely closed...
    expect(transport.lastSent("old-1", "challenge")).toBeNull(); // ...and never gated in
  }, 20_000);

  it("the full handshake unlocks data flow (hello -> challenge -> solve)", async () => {
    const { engine, transport, chain } = await boot(60_000);
    cleanup.push(() => engine.stop());
    const { solveSybilChallenge } = await import("./blockchain");

    transport.connect("honest-1");
    await sayHello(transport, chain, "honest-1");
    const challenge = transport.lastSent<{ nonce: string }>("honest-1", "challenge")!;
    const solution = solveSybilChallenge(challenge.nonce, "0000")!;
    transport.inbound("honest-1", { type: "challengeResponse", nonce: challenge.nonce, solution });
    await new Promise((r) => setTimeout(r, 150));

    // verified: no strikes, and a getBlocks now gets SERVED (blocks message)
    transport.inbound("honest-1", { type: "getBlocks", from: 0, count: 1 });
    await new Promise((r) => setTimeout(r, 150));
    expect(engine.peerList()[0]?.strikes).toBe(0);
    expect(transport.lastSent("honest-1", "blocks")).toBeTruthy();
  }, 20_000);
});

describe("the cooperative challenge solver", () => {
  it("finds byte-identical solutions to the sync solver - same scan order, same result", async () => {
    const { solveSybilChallenge, solveSybilChallengeAsync } = await import("./blockchain");
    for (const nonce of ["0123456789abcdef", "deadbeefcafebabe", "0000000000000001"]) {
      const sync = solveSybilChallenge(nonce, "0000");
      const coop = await solveSybilChallengeAsync(nonce, "0000");
      expect(coop).toBe(sync);
      expect(coop).not.toBeNull();
    }
  });

  it("the yield path is exercised and still exact (forced periodic slice expiry)", async () => {
    // Deterministic yield coverage: the pinned nonce's solution sits at scan
    // index 36,177 (verified by the sync solver here), and the mocked clock
    // jumps +1000ms every 2,000 reads so the 12ms slice check expires ~18
    // times mid-scan - the solver must hop through real macrotask awaits and
    // still return the byte-identical answer. (Yielding changes scheduling,
    // never the result.)
    const { solveSybilChallenge, solveSybilChallengeAsync } = await import("./blockchain");
    const nonce = "aaaabbbbccccdddd";
    const expected = solveSybilChallenge(nonce, "0000");
    expect(expected).toBe("8d51"); // pinned: scan index 36,177 - yields guaranteed
    const realNow = Date.now;
    let calls = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      calls += 1;
      return realNow() + Math.floor(calls / 2_000) * 1_000;
    });
    try {
      const coop = await solveSybilChallengeAsync(nonce, "0000");
      expect(coop).toBe(expected);
      expect(calls).toBeGreaterThan(30_000); // the full sliced scan really ran
    } finally {
      spy.mockRestore();
    }
  });
});
