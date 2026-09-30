/**
 * PeerJsTransport claim tests - the lobby-slot dance and the ordered
 * signaling-host fallback, run against an in-memory fake rendezvous.
 * No real PeerJS, no network: a scripted constructor decides per (host,id)
 * whether the id opens, is taken, the server is down, or the probe hangs.
 */
import { describe, expect, it } from "vitest";
import {
  claimLobbyId,
  extendedProbeWindow,
  PeerJsTransport,
  type PeerCtor,
  type TransportEvents,
} from "./transport";
import type { SignalingHost } from "../../network.config";

const HOST_A: SignalingHost = { host: "a.test", port: 443, path: "/", secure: true };
const HOST_B: SignalingHost = { host: "b.test", port: 443, path: "/", secure: true };
const HOST_C: SignalingHost = { host: "c.test", port: 443, path: "/", secure: true };

type Behavior = "open" | "taken" | "down" | "hang";
type Script = (host: string, id: string) => Behavior;

interface ProbeLog {
  created: Array<{ host: string; id: string }>;
  destroyed: string[];
  dialed: string[];
  /** Conns closed by the transport (the leak plug must reap every one). */
  closedDials: string[];
  /** Live dial-attempt conns right now / the peak (the pacing cap). */
  liveDials: number;
  maxLiveDials: number;
}

/** Poll until a condition holds - the paced dialer drains asynchronously. */
async function until(cond: () => boolean, ms: number, step = 20): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, step));
  }
}

function makeCtor(script: Script, log: ProbeLog): PeerCtor {
  class MockConn {
    peer: string;
    open = false;
    constructor(peer: string) {
      this.peer = peer;
      log.liveDials += 1;
      if (log.liveDials > log.maxLiveDials) log.maxLiveDials = log.liveDials;
    }
    on(): void {
      /* connections never open in these tests */
    }
    send(): void {}
    close(): void {
      log.liveDials -= 1;
      log.closedDials.push(this.peer);
    }
  }
  class MockPeer {
    private handlers = new Map<string, Array<(arg?: unknown) => void>>();
    public id: string;
    public opts: { host: string };
    constructor(id: string, opts: { host: string }) {
      this.id = id;
      this.opts = opts;
      log.created.push({ host: opts.host, id });
      const behavior = script(opts.host, id);
      queueMicrotask(() => {
        if (behavior === "open") this.emit("open", id);
        else if (behavior === "taken") this.emit("error", { type: "unavailable-id" });
        else if (behavior === "down") this.emit("error", { type: "network" });
        // "hang": never emits - the probe timeout must cut it off
      });
    }
    on(event: string, cb: (arg?: unknown) => void): void {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }
    private emit(event: string, arg?: unknown): void {
      for (const cb of this.handlers.get(event) ?? []) cb(arg);
    }
    connect(id: string): MockConn {
      log.dialed.push(id);
      return new MockConn(id);
    }
    reconnect(): void {}
    destroy(): void {
      log.destroyed.push(this.id);
    }
  }
  return MockPeer as unknown as PeerCtor;
}

function freshLog(): ProbeLog {
  return { created: [], destroyed: [], dialed: [], closedDials: [], liveDials: 0, maxLiveDials: 0 };
}

const OPTS = {
  slotPrefix: "pfx",
  slots: 3,
  perHostDeadlineMs: 5_000,
  probeTimeoutMs: 200,
  // fixed rotation start: existing expectations below assume slot-0 first
  startOffset: 0,
} as const;

describe("claimLobbyId - slot claiming", () => {
  it("claims slot-0 on the first host when free", async () => {
    const log = freshLog();
    const res = await claimLobbyId(
      makeCtor(() => "open", log),
      { hosts: [HOST_A], ...OPTS },
      () => undefined,
    );
    expect(res).toEqual({ id: "pfx-slot-0", host: HOST_A, slotClaimed: true });
  });

  it("skips taken ids and claims the first free slot", async () => {
    const log = freshLog();
    const res = await claimLobbyId(
      makeCtor((_h, id) => (id === "pfx-slot-1" ? "open" : "taken"), log),
      { hosts: [HOST_A], ...OPTS },
      () => undefined,
    );
    expect(res.id).toBe("pfx-slot-1");
    expect(res.slotClaimed).toBe(true);
    // taken probes destroyed after each failure
    expect(log.destroyed).toEqual(["pfx-slot-0"]);
  });
});

describe("claimLobbyId - host fallback", () => {
  it("falls through to the next host when the first is down", async () => {
    const log = freshLog();
    const res = await claimLobbyId(
      makeCtor((host) => (host === "a.test" ? "down" : "open"), log),
      { hosts: [HOST_A, HOST_B], ...OPTS },
      () => undefined,
    );
    expect(res.host).toBe(HOST_B);
    expect(res.id).toBe("pfx-slot-0");
    // exactly ONE probe against the dead host - fail fast, not 64 stalls
    expect(log.created.filter((c) => c.host === "a.test")).toHaveLength(1);
  });

  it("a down first host with a full second host overflows onto the second (first reachable)", async () => {
    const log = freshLog();
    const res = await claimLobbyId(
      // A dead; B reachable, all numbered slots taken, random overflow id free
      makeCtor((host, id) => (host === "a.test" ? "down" : id.includes("-x-") ? "open" : "taken"), log),
      { hosts: [HOST_A, HOST_B], ...OPTS },
      () => undefined,
    );
    expect(res.slotClaimed).toBe(false);
    expect(res.host).toBe(HOST_B);
    expect(res.id).toMatch(/^pfx-x-[0-9a-f]+$/);
  });

  it("a full first host does NOT overflow while a later host still has free slots", async () => {
    const log = freshLog();
    const res = await claimLobbyId(
      makeCtor((host) => (host === "a.test" ? "taken" : "open"), log),
      { hosts: [HOST_A, HOST_B], ...OPTS },
      () => undefined,
    );
    expect(res.host).toBe(HOST_B);
    expect(res.slotClaimed).toBe(true);
    expect(res.id).toBe("pfx-slot-0");
  });

  it("throws only when NO host answered at all", async () => {
    const log = freshLog();
    await expect(
      claimLobbyId(
        makeCtor(() => "down", log),
        { hosts: [HOST_A, HOST_B, HOST_C], ...OPTS },
        () => undefined,
      ),
    ).rejects.toThrow("signaling rendezvous unreachable");
    // one probe per dead host, nothing more
    expect(log.created).toHaveLength(3);
  });

  it("a hanging host is cut off by the per-host deadline, then the next host serves", async () => {
    const log = freshLog();
    const res = await claimLobbyId(
      makeCtor((host) => (host === "a.test" ? "hang" : "open"), log),
      { hosts: [HOST_A, HOST_B], slotPrefix: "pfx", slots: 64, perHostDeadlineMs: 70, probeTimeoutMs: 25 },
      () => undefined,
    );
    expect(res.host).toBe(HOST_B);
    // one probe + one shorter retry per silent id, then "down" - not 64 stalls
    expect(log.created.filter((c) => c.host === "a.test").length).toBeLessThanOrEqual(4);
  });

  it("silence is not 'busy': a dead-silent host is down after one retry, never 'reachable'", async () => {
    const log = freshLog();
    const res = await claimLobbyId(
      makeCtor((host) => (host === "a.test" ? "hang" : "open"), log),
      // generous deadline: it must be the silence rule that gives up on A,
      // not the per-host deadline
      { hosts: [HOST_A, HOST_B], slotPrefix: "pfx", slots: 4, perHostDeadlineMs: 5_000, probeTimeoutMs: 60, startOffset: 0 },
      () => undefined,
    );
    expect(res.host).toBe(HOST_B);
    // exactly probe + retry on ONE slot id, then the host is abandoned
    const aProbes = log.created.filter((c) => c.host === "a.test");
    expect(aProbes).toHaveLength(2);
    expect(aProbes[0].id).toBe("pfx-slot-0");
    expect(aProbes[1].id).toBe("pfx-slot-0");
  });

  it("overflow never parks on a silent host: full live second host still serves the random id", async () => {
    const log = freshLog();
    // A dead-silent; B alive with every numbered slot taken, overflow id free.
    // The old code marked A 'reachable' on timeouts, then probed the overflow
    // id on A (silent) and threw - stranding the node with B right there.
    const res = await claimLobbyId(
      makeCtor((host, id) => (host === "a.test" ? "hang" : id.includes("-x-") ? "open" : "taken"), log),
      { hosts: [HOST_A, HOST_B], slotPrefix: "pfx", slots: 3, perHostDeadlineMs: 5_000, probeTimeoutMs: 60, startOffset: 0 },
      () => undefined,
    );
    expect(res.slotClaimed).toBe(false);
    expect(res.host).toBe(HOST_B);
    expect(res.id).toMatch(/^pfx-x-[0-9a-f]+$/);
  });

  it("every probe carries the ICE kit (STUN + TURN) from network.config", async () => {
    const seen: unknown[] = [];
    class CapturePeer {
      constructor(_id: string, opts: unknown) {
        seen.push(opts);
        queueMicrotask(() => {
          // emit open so the claim resolves immediately
          for (const cb of this.handlers.get("open") ?? []) cb();
        });
      }
      private handlers = new Map<string, Array<() => void>>();
      on(event: string, cb: () => void): void {
        const list = this.handlers.get(event) ?? [];
        list.push(cb);
        this.handlers.set(event, list);
      }
      destroy(): void {}
    }
    const { ICE_SERVERS } = await import("../../network.config");
    await claimLobbyId(
      CapturePeer as unknown as PeerCtor,
      { hosts: [HOST_A], slotPrefix: "pfx", slots: 1, perHostDeadlineMs: 5_000, probeTimeoutMs: 200, startOffset: 0 },
      () => undefined,
    );
    expect(seen).toHaveLength(1);
    const opts = seen[0] as { config?: { iceServers?: unknown } };
    expect(opts.config?.iceServers).toEqual([...ICE_SERVERS]);
    // and the kit actually contains a TURN relay - the mobile-NAT escape hatch
    const urls = (ICE_SERVERS as readonly { urls: string | string[] }[]).flatMap((s) => s.urls);
    expect(urls.some((u) => u.startsWith("turn"))).toBe(true);
    expect(urls.some((u) => u.startsWith("stun"))).toBe(true);
  });
});

describe("claimLobbyId - extended overflow range", () => {
  it("claims the first extended slot when every primary slot is taken", async () => {
    const log = freshLog();
    const res = await claimLobbyId(
      makeCtor((_h, id) => (id === "pfx-slot-4" ? "open" : "taken"), log),
      { hosts: [HOST_A], slotPrefix: "pfx", slots: 3, extendedSlots: 3, perHostDeadlineMs: 5_000, probeTimeoutMs: 200, startOffset: 0 },
      () => undefined,
    );
    expect(res).toEqual({ id: "pfx-slot-4", host: HOST_A, slotClaimed: true });
    // walked primary 0..2, then extended 3..4 - in order, no skips
    expect(log.created.map((c) => c.id)).toEqual([
      "pfx-slot-0",
      "pfx-slot-1",
      "pfx-slot-2",
      "pfx-slot-3",
      "pfx-slot-4",
    ]);
  });

  it("overflows to the random id only when primary AND extended are all taken", async () => {
    const log = freshLog();
    const res = await claimLobbyId(
      makeCtor((_h, id) => (id.includes("-x-") ? "open" : "taken"), log),
      { hosts: [HOST_A], slotPrefix: "pfx", slots: 3, extendedSlots: 2, perHostDeadlineMs: 5_000, probeTimeoutMs: 200 },
      () => undefined,
    );
    expect(res.slotClaimed).toBe(false);
    expect(res.id).toMatch(/^pfx-x-[0-9a-f]+$/);
    expect(log.created.filter((c) => c.id.includes("-slot-"))).toHaveLength(5); // 3 + 2
  });
});

describe("extendedProbeWindow (pure)", () => {
  it("returns batch consecutive slots inside the extended range", () => {
    expect(extendedProbeWindow(0, 8, 192, 64)).toEqual([64, 65, 66, 67, 68, 69, 70, 71]);
    expect(extendedProbeWindow(8, 8, 192, 64)).toEqual([72, 73, 74, 75, 76, 77, 78, 79]);
  });

  it("wraps around the end of the extended range", () => {
    // cursor near the end: 190,191 then wrap to 0,1 (offset by primarySlots)
    expect(extendedProbeWindow(190, 4, 192, 64)).toEqual([254, 255, 64, 65]);
  });

  it("is empty when the extended range is disabled or the batch is zero", () => {
    expect(extendedProbeWindow(0, 8, 0, 64)).toEqual([]);
    expect(extendedProbeWindow(0, 0, 192, 64)).toEqual([]);
  });
});

describe("PeerJsTransport.start - with injected rendezvous", () => {
  const noopEvents: TransportEvents = {
    onOpen: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
  };

  it("claims a slot, sets selfId, and PACED-dials every other lobby slot plus the first extended batch", async () => {
    // The sweep is a paced queue now (DIAL_CONCURRENCY lanes, every failed
    // attempt reaped and CLOSED) - the round-13 fix for the RTCPeerConnection
    // storm that choked Safari's networking process. The fake conns never
    // open, so each attempt lives exactly one dialTimeoutMs.
    const log = freshLog();
    const t = new PeerJsTransport("pfx", makeCtor(() => "open", log), {
      dialTimeoutMs: 60,
    });
    await t.start(noopEvents);
    try {
      // the claim offset is random now - selfId is SOME primary slot
      expect(t.selfId).toMatch(/^pfx-slot-(\d+)$/);
      const own = Number(t.selfId.match(/^pfx-slot-(\d+)$/)![1]);
      expect(own).toBeGreaterThanOrEqual(0);
      expect(own).toBeLessThan(64);
      // redial plan: every primary slot except our own (LOBBY_SLOTS = 64),
      // plus the first rotating extended batch (EXTENDED_PROBE_BATCH = 8) -
      // all EVENTUALLY dialed, a few concurrent attempts at a time
      await until(() => log.dialed.length >= 63 + 8, 10_000);
      expect(log.dialed).not.toContain(t.selfId);
      for (let s = 0; s < 64; s++) {
        if (s !== own) expect(log.dialed).toContain(`pfx-slot-${s}`);
      }
      expect(log.dialed).toContain("pfx-slot-64"); // extended range begins
      expect(log.dialed).toContain("pfx-slot-71");
      expect(log.dialed).not.toContain("pfx-slot-72"); // next cycle's batch
      // the pacing cap held for the whole sweep (no more 72-at-once waves)
      expect(log.maxLiveDials).toBeGreaterThan(0);
      expect(log.maxLiveDials).toBeLessThanOrEqual(4); // DIAL_CONCURRENCY
      // LEAK PLUG: every attempt that never opened was reaped and CLOSED -
      // bare PeerJS leaves refused conns (and their RTCPeerConnections)
      // alive forever, which is what wedged WebKit's networking process
      await until(() => log.closedDials.length >= 63 + 8, 10_000);
      expect(log.liveDials).toBe(0);
    } finally {
      t.stop();
    }
  }, 25_000);

  it("early discovery boost re-dials the lobby within the first seconds", async () => {
    // A fresh node's first wave can race peers whose broker registration has
    // not propagated yet - the boost ladder must repeat the wave quickly
    // instead of waiting a full 60s healing cycle. With pacing, a re-offered
    // id that is still pending/queued is deduped; the repeat dials land as
    // the first attempts are reaped.
    const log = freshLog();
    const t = new PeerJsTransport("pfx", makeCtor(() => "open", log), {
      dialTimeoutMs: 60,
    });
    await t.start(noopEvents);
    try {
      await until(() => log.dialed.length >= 63 + 8, 10_000);
      const firstWave = log.dialed.length;
      // first boost rung at 3s: the primary lobby is re-dialed once the
      // first attempts died (never doubled while in flight)
      await until(() => log.dialed.length >= firstWave + 63, 12_000);
    } finally {
      t.stop();
    }
    // and the ladder stops with the transport: no late dials after stop
    const atStop = log.dialed.length;
    await new Promise((r) => setTimeout(r, 1_000));
    expect(log.dialed.length).toBe(atStop);
  }, 25_000);

  it("a dead rendezvous at boot does NOT kill the transport: it goes cold and self-heals", async () => {
    // THE regression test for "every device mines its own chain": a node
    // that boots while the rendezvous is unreachable used to lose its
    // WebRTC transport for the whole session. Now start() succeeds cold and
    // the reclaim ladder brings the registration up the moment a host
    // answers - no reload, no manual intervention.
    let healthy = false;
    const log = freshLog();
    const t = new PeerJsTransport("pfx", makeCtor(() => (healthy ? "open" : "down"), log), {
      watchdogMs: 40,
      reclaimLadderMs: [50, 50],
      dialTimeoutMs: 60,
    });
    await t.start(noopEvents); // resolves cold instead of throwing
    expect(t.selfId).toBe("pfx-pending");
    expect(t.links()).toEqual([]);
    healthy = true;
    // the reclaim ladder (first rung: 50ms) must bring us online
    for (let i = 0; i < 40 && t.selfId === "pfx-pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    try {
      expect(t.selfId).toMatch(/^pfx-slot-\d+$/);
      // and the fresh registration re-meshes immediately (paced lobby sweep)
      await until(() => log.dialed.length >= 63, 10_000);
    } finally {
      t.stop();
    }
  });

  it("claimLobbyId itself still throws when NO host answered (callers choose their policy)", async () => {
    const log = freshLog();
    await expect(
      claimLobbyId(
        makeCtor(() => "down", log),
        { hosts: [HOST_A], ...OPTS },
        () => undefined,
      ),
    ).rejects.toThrow("signaling rendezvous unreachable");
  });

  it("stop is clean and idempotent right after boot", async () => {
    const log = freshLog();
    const t = new PeerJsTransport("pfx", makeCtor(() => "open", log));
    await t.start(noopEvents);
    t.stop();
    expect(() => t.stop()).not.toThrow();
  });
});

describe("claimLobbyId - probe rotation", () => {
  it("startOffset rotates the probe order (simultaneous boots do not herd onto slot-0)", async () => {
    const log = freshLog();
    const res = await claimLobbyId(
      makeCtor(() => "open", log),
      { hosts: [HOST_A], ...OPTS, startOffset: 2 },
      () => undefined,
    );
    expect(res.id).toBe("pfx-slot-2");
    expect(log.created[0]?.id).toBe("pfx-slot-2");
  });

  it("rotation wraps around the primary range", async () => {
    const log = freshLog();
    const res = await claimLobbyId(
      makeCtor((_h, id) => (id === "pfx-slot-2" ? "taken" : "open"), log),
      { hosts: [HOST_A], ...OPTS, startOffset: 2 },
      () => undefined,
    );
    expect(res.id).toBe("pfx-slot-0"); // 2 taken -> wraps to 0
    expect(log.created.map((c) => c.id)).toEqual(["pfx-slot-2", "pfx-slot-0"]);
  });

  it("default rotation is random across the primary range", async () => {
    // statistical smoke: with slots=3 the first probe must not be slot-0
    // every single time across many runs
    const firsts = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const log = freshLog();
      const o = { hosts: [HOST_A], ...OPTS } as Record<string, unknown>;
      delete o.startOffset;
      await claimLobbyId(makeCtor(() => "open", log), o as never, () => undefined);
      firsts.add(log.created[0]?.id ?? "?");
    }
    expect(firsts.size).toBeGreaterThan(1);
  });
});

/**
 * Registration self-healing - THE fix for "every device mines its own
 * chain". The lobby registration is a leased socket, not a fact: mobile
 * browsers suspend it, networks switch, slots get taken while we sleep.
 * The transport must notice and recover on its own, every time.
 */
describe("PeerJsTransport - registration self-healing", () => {
  type Handler = (arg?: unknown) => void;

  class HealConn {
    peer: string;
    open = false;
    private handlers = new Map<string, Handler[]>();
    constructor(peer: string) {
      this.peer = peer;
    }
    on(event: string, cb: Handler): void {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }
    emit(event: string): void {
      for (const cb of this.handlers.get(event) ?? []) cb();
    }
    fireOpen(): void {
      this.open = true;
      this.emit("open");
    }
    send(): void {}
    close(): void {
      this.open = false;
      this.emit("close");
    }
  }

  class HealPeer {
    static created: HealPeer[] = [];
    id: string;
    disconnected = false;
    destroyed = false;
    reconnects = 0;
    dialed: string[] = [];
    conns: HealConn[] = [];
    private handlers = new Map<string, Handler[]>();
    constructor(id: string) {
      this.id = id;
      HealPeer.created.push(this);
      queueMicrotask(() => {
        if (!this.destroyed) this.emit("open", id);
      });
    }
    on(event: string, cb: Handler): void {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }
    emit(event: string, arg?: unknown): void {
      // snapshot: handlers registered DURING an emit fire on the next one
      for (const cb of [...(this.handlers.get(event) ?? [])]) cb(arg);
    }
    connect(id: string): HealConn {
      this.dialed.push(id);
      const c = new HealConn(id);
      this.conns.push(c);
      return c;
    }
    /** In-place socket recovery: same id comes back, links survive. */
    reconnect(): void {
      if (this.destroyed) throw new Error("destroyed");
      this.reconnects += 1;
      this.disconnected = false;
      queueMicrotask(() => this.emit("open", this.id));
    }
    destroy(): void {
      this.destroyed = true;
    }
  }

  function makeHealCtor() {
    HealPeer.created = [];
    return HealPeer as unknown as PeerCtor;
  }

  const events = () => {
    const log: Array<{ kind: string; id: string }> = [];
    return {
      log,
      handlers: {
        onOpen: (id: string) => log.push({ kind: "open", id }),
        onMessage: () => undefined,
        onClose: (id: string) => log.push({ kind: "close", id }),
      } satisfies TransportEvents,
    };
  };

  it("a dropped signaling socket is reconnected in place - same id, links survive", async () => {
    const ev = events();
    const t = new PeerJsTransport("pfx", makeHealCtor(), { watchdogMs: 40, dialTimeoutMs: 60 });
    await t.start(ev.handlers);
    try {
      const peer = HealPeer.created[0];
      const myId = t.selfId;
      // an open link must survive a signaling-socket drop (the manual dial
      // drains through the pacing queue behind the boot sweep)
      t.dial("zzz-peer");
      await until(() => peer.conns.some((c) => c.peer === "zzz-peer"), 5_000);
      peer.conns.find((c) => c.peer === "zzz-peer")!.fireOpen();
      expect(t.links()).toContain("zzz-peer");
      peer.disconnected = true; // socket silently died (backgrounded tab)
      for (let i = 0; i < 40 && peer.reconnects === 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(peer.reconnects).toBeGreaterThanOrEqual(1);
      // the re-open fires redialLobby: a fresh paced sweep heals the mesh,
      // and the surviving link was never torn down in between
      await until(() => peer.dialed.length >= 2 * 63, 10_000);
      expect(t.selfId).toBe(myId); // same registration, not a re-claim
      expect(HealPeer.created).toHaveLength(1); // no new peer object
      expect(t.links()).toContain("zzz-peer"); // DataChannel untouched
    } finally {
      t.stop();
    }
  }, 20_000);

  it("a slot stolen while away forces a FULL re-claim - and the engine hears every old link die", async () => {
    const ev = events();
    const t = new PeerJsTransport("pfx", makeHealCtor(), { watchdogMs: 40, dialTimeoutMs: 60 });
    await t.start(ev.handlers);
    try {
      const first = HealPeer.created[0];
      t.dial("zzz-peer");
      await until(() => first.conns.some((c) => c.peer === "zzz-peer"), 5_000);
      first.conns.find((c) => c.peer === "zzz-peer")!.fireOpen();
      expect(t.links()).toContain("zzz-peer");
      // then our slot gets stolen: a reconnect answered "unavailable-id"
      first.emit("error", { type: "unavailable-id" });
      for (let i = 0; i < 60 && HealPeer.created.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(HealPeer.created.length).toBeGreaterThanOrEqual(2); // re-claimed
      expect(first.destroyed).toBe(true); // old registration torn down
      expect(t.selfId).toMatch(/^pfx-slot-\d+$/); // a fresh slot is live
      // the engine heard the old link die - its peer book can never go stale
      expect(ev.log).toContainEqual({ kind: "close", id: "zzz-peer" });
    } finally {
      t.stop();
    }
  });

  it("a destroyed registration is re-claimed by the watchdog (no user action)", async () => {
    const ev = events();
    const t = new PeerJsTransport("pfx", makeHealCtor(), { watchdogMs: 40 });
    await t.start(ev.handlers);
    try {
      const first = HealPeer.created[0];
      first.destroyed = true; // peer object died silently (worst case)
      for (let i = 0; i < 60 && HealPeer.created.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(HealPeer.created.length).toBeGreaterThanOrEqual(2);
      expect(t.selfId).toMatch(/^pfx-slot-\d+$/);
    } finally {
      t.stop();
    }
  });

  it("a socket PeerJS never flags as dead is force-reclaimed on the SECOND revive", async () => {
    const ev = events();
    const t = new PeerJsTransport("pfx", makeHealCtor(), { watchdogMs: 40 });
    await t.start(ev.handlers);
    try {
      const first = HealPeer.created[0];
      expect(first.disconnected).toBe(false); // PeerJS is blind (iOS case)
      t.revive(); // first strike: soft probe only
      await new Promise((r) => setTimeout(r, 30));
      expect(HealPeer.created).toHaveLength(1); // no reclaim yet
      expect(first.destroyed).toBe(false);
      t.revive(); // second strike: stop trusting the blind socket
      for (let i = 0; i < 60 && HealPeer.created.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(HealPeer.created.length).toBeGreaterThanOrEqual(2);
      expect(first.destroyed).toBe(true); // torn down and re-claimed
      expect(t.selfId).toMatch(/^pfx-slot-\d+$/);
    } finally {
      t.stop();
    }
  });

  it("mesh activity resets the revive escalation - a healthy socket is never reclaimed", async () => {
    const ev = events();
    const t = new PeerJsTransport("pfx", makeHealCtor(), { watchdogMs: 40, dialTimeoutMs: 60 });
    await t.start(ev.handlers);
    try {
      const first = HealPeer.created[0];
      t.dial("zzz-peer");
      await until(() => first.conns.some((c) => c.peer === "zzz-peer"), 5_000);
      const conn = first.conns.find((c) => c.peer === "zzz-peer")!;
      t.revive(); // strike one
      await new Promise((r) => setTimeout(r, 30));
      conn.fireOpen(); // link opens -> proof of life, counter resets
      t.revive(); // strike one again (was reset)
      await new Promise((r) => setTimeout(r, 30));
      expect(HealPeer.created).toHaveLength(1); // still no reclaim
      t.revive(); // genuine strike two now
      for (let i = 0; i < 60 && HealPeer.created.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(HealPeer.created.length).toBeGreaterThanOrEqual(2);
      expect(first.destroyed).toBe(true);
    } finally {
      t.stop();
    }
  });

  it("stop() during a cold reclaim leaves nothing armed behind", async () => {
    const ev = events();
    // every probe is "down" via a HealPeer variant that never opens
    class DeadPeer {
      static created = 0;
      destroyed = false;
      disconnected = false;
      constructor() {
        DeadPeer.created += 1;
        queueMicrotask(() => this.fireError());
      }
      private handlers = new Map<string, Handler[]>();
      on(event: string, cb: Handler): void {
        const list = this.handlers.get(event) ?? [];
        list.push(cb);
        this.handlers.set(event, list);
      }
      fireError(): void {
        for (const cb of [...(this.handlers.get("error") ?? [])]) cb({ type: "network" });
      }
      connect(): never {
        throw new Error("unreachable");
      }
      reconnect(): void {}
      destroy(): void {
        this.destroyed = true;
      }
    }
    const t = new PeerJsTransport("pfx", DeadPeer as unknown as PeerCtor, {
      watchdogMs: 30,
      reclaimLadderMs: [30, 30],
    });
    await t.start(ev.handlers); // cold
    t.stop();
    const built = DeadPeer.created;
    await new Promise((r) => setTimeout(r, 150)); // several ladder rungs pass
    expect(DeadPeer.created).toBe(built); // no retry outlives stop()
    expect(() => t.stop()).not.toThrow();
  });
});

/**
 * Conn tie-break: when a mutual dial leaves TWO parallel conns to the same
 * peer, both ends must keep the SAME one. Rule: the lexicographically
 * smaller id keeps its OUTBOUND conn, the larger keeps its INBOUND one.
 */
describe("PeerJsTransport - mutual-dial tie-break", () => {
  type Handler = (arg?: unknown) => void;

  class FakeConn {
    peer: string;
    open = false;
    closed = false;
    private handlers = new Map<string, Handler[]>();
    constructor(peer: string) {
      this.peer = peer;
    }
    on(event: string, cb: Handler): void {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }
    emit(event: string): void {
      for (const cb of this.handlers.get(event) ?? []) cb();
    }
    fireOpen(): void {
      this.open = true;
      this.emit("open");
    }
    send(): void {}
    close(): void {
      this.closed = true;
      this.open = false;
      this.emit("close");
    }
  }

  class FakePeer {
    id: string;
    conns: FakeConn[] = [];
    private handlers = new Map<string, Handler[]>();
    constructor(id: string) {
      this.id = id;
      queueMicrotask(() => this.emit("open", id));
    }
    on(event: string, cb: Handler): void {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }
    emit(event: string, arg?: unknown): void {
      for (const cb of this.handlers.get(event) ?? []) cb(arg);
    }
    connect(id: string): FakeConn {
      const c = new FakeConn(id);
      this.conns.push(c);
      return c;
    }
    inbound(id: string): FakeConn {
      const c = new FakeConn(id);
      this.conns.push(c);
      this.emit("connection", c);
      return c;
    }
    reconnect(): void {}
    destroy(): void {}
  }

  async function startedWithPeer() {
    let peer!: FakePeer;
    class Ctor {
      constructor(id: string) {
        peer = new FakePeer(id);
        return peer;
      }
    }
    const events: Array<{ kind: string; id: string }> = [];
    // short reap timeout: the boot sweep's never-opening conns free the
    // pacing lanes fast, so a manual dial reaches the wire promptly
    const t = new PeerJsTransport("pfx", Ctor as unknown as PeerCtor, {
      dialTimeoutMs: 60,
    });
    await t.start({
      onOpen: (id) => events.push({ kind: "open", id }),
      onMessage: () => undefined,
      onClose: (id) => events.push({ kind: "close", id }),
    });
    return { t, peer: () => peer, events };
  }

  it("the smaller id keeps its OUTBOUND conn when an inbound duplicate opens", async () => {
    const { t, peer, events } = await startedWithPeer();
    try {
      const bigger = "zzz-bigger"; // lexicographically greater than any pfx-slot-N
      expect(t.selfId < bigger).toBe(true);
      t.dial(bigger);
      await until(() => peer().conns.some((c) => c.peer === bigger), 5_000);
      const outbound = peer().conns.find((c) => c.peer === bigger)!;
      outbound.fireOpen();
      const inboundDup = peer().inbound(bigger);
      inboundDup.fireOpen();

      expect(inboundDup.closed).toBe(true); // loser closed
      expect(outbound.closed).toBe(false); // winner kept
      expect(t.links()).toEqual([bigger]);
      // the loser never reaches the engine; its close is absorbed, not fanned out
      expect(events.filter((e) => e.id === bigger)).toEqual([{ kind: "open", id: bigger }]);
    } finally {
      t.stop();
    }
  });

  it("the larger id keeps the INBOUND conn when its own outbound opens second", async () => {
    const { t, peer, events } = await startedWithPeer();
    try {
      const smaller = "aaa-smaller"; // lexicographically smaller than pfx-slot-N
      expect(t.selfId > smaller).toBe(true);
      t.dial(smaller);
      await until(() => peer().conns.some((c) => c.peer === smaller), 5_000);
      const outbound = peer().conns.find((c) => c.peer === smaller)!;
      outbound.fireOpen();
      const inbound = peer().inbound(smaller);
      inbound.fireOpen();

      expect(outbound.closed).toBe(true); // our outbound loses on the polite side
      expect(inbound.closed).toBe(false);
      expect(t.links()).toEqual([smaller]);
      // engine sees both opens (state survives via the engine's dup guard),
      // and no close leaks for the absorbed loser
      expect(events.filter((e) => e.id === smaller)).toEqual([
        { kind: "open", id: smaller },
        { kind: "open", id: smaller },
      ]);
    } finally {
      t.stop();
    }
  });

  it("reverse open order converges on the same winner", async () => {
    const { t, peer } = await startedWithPeer();
    try {
      const bigger = "zzz-bigger";
      // real mutual-dial timing: we dial first, our outbound conn is still
      // connecting when the peer's inbound conn opens - then ours completes
      t.dial(bigger);
      await until(() => peer().conns.some((c) => c.peer === bigger), 5_000);
      const outbound = peer().conns.find((c) => c.peer === bigger)!;
      const inbound = peer().inbound(bigger);
      inbound.fireOpen();
      outbound.fireOpen();

      expect(inbound.closed).toBe(true); // smaller id keeps OUTBOUND
      expect(outbound.closed).toBe(false);
      expect(t.links()).toEqual([bigger]);
    } finally {
      t.stop();
    }
  });

  it("a dead existing conn is replaced without tie-break ceremony", async () => {
    const { t, peer, events } = await startedWithPeer();
    try {
      const idp = "zzz-bigger";
      t.dial(idp);
      await until(() => peer().conns.some((c) => c.peer === idp), 5_000);
      const first = peer().conns.find((c) => c.peer === idp)!;
      first.fireOpen();
      first.open = false; // silently dead (close event lost)
      const second = peer().inbound(idp);
      second.fireOpen();

      expect(first.closed).toBe(false); // never force-closed: it was already gone
      expect(t.links()).toEqual([idp]);
      expect(events.filter((e) => e.kind === "close" && e.id === idp)).toEqual([]);
    } finally {
      t.stop();
    }
  });
});

/**
 * Dial pacing and the RTCPeerConnection leak plug (round 13). Bare PeerJS
 * never closes a connection whose target is offline (the broker answers
 * EXPIRE -> a peer-level "peer-unavailable" error, and the DataConnection
 * with its RTCPeerConnection stays alive). Fired as a 72-id wave, that
 * leaked ~1,000 live RTCPeerConnections in 10 seconds and wedged WebKit's
 * shared networking process - Safari stalled system-wide, other sites
 * stopped loading, our own sockets starved. These tests pin the fix: a
 * bounded number of in-flight attempts, a guaranteed close on EVERY
 * outcome, an immediate reap on the broker's refusal, and nothing armed
 * after stop().
 */
describe("PeerJsTransport - dial pacing and the leak plug", () => {
  type Handler = (arg?: unknown) => void;

  interface DialLog {
    dialed: string[];
    closed: string[];
    live: number;
    maxLive: number;
  }

  /**
   * Behavior by dialed id:
   *   "open-*"  - the conn fires open after 10ms (a live peer answers)
   *   "hang-*"  - the conn neither opens nor is refused (backstop territory)
   *   anything else (all lobby slot ids included) - the broker refuses it
   *     after 10ms via the peer-level "peer-unavailable" error, exactly
   *     like the real cloud does for an offline id.
   */
  function makeDialCtor(log: DialLog) {
    class DialConn {
      peer: string;
      open = false;
      private handlers = new Map<string, Handler[]>();
      constructor(peer: string, peerObj: DialPeer) {
        this.peer = peer;
        log.live += 1;
        if (log.live > log.maxLive) log.maxLive = log.live;
        if (peer.startsWith("open-")) {
          setTimeout(() => {
            this.open = true;
            this.emit("open");
          }, 10);
        } else if (!peer.startsWith("hang-")) {
          setTimeout(() => {
            peerObj.emit("error", {
              type: "peer-unavailable",
              message: `Could not connect to peer ${peer}`,
            });
          }, 10);
        }
      }
      on(event: string, cb: Handler): void {
        const list = this.handlers.get(event) ?? [];
        list.push(cb);
        this.handlers.set(event, list);
      }
      emit(event: string): void {
        for (const cb of this.handlers.get(event) ?? []) cb();
      }
      send(): void {}
      close(): void {
        log.live -= 1;
        log.closed.push(this.peer);
        this.emit("close");
      }
    }
    class DialPeer {
      private handlers = new Map<string, Handler[]>();
      constructor(id: string) {
        queueMicrotask(() => this.emit("open", id));
      }
      on(event: string, cb: Handler): void {
        const list = this.handlers.get(event) ?? [];
        list.push(cb);
        this.handlers.set(event, list);
      }
      emit(event: string, arg?: unknown): void {
        for (const cb of [...(this.handlers.get(event) ?? [])]) cb(arg);
      }
      connect(id: string): DialConn {
        log.dialed.push(id);
        return new DialConn(id, this);
      }
      reconnect(): void {}
      destroy(): void {}
    }
    return DialPeer as unknown as PeerCtor;
  }

  function freshDialLog(): DialLog {
    return { dialed: [], closed: [], live: 0, maxLive: 0 };
  }

  const noopEvents: TransportEvents = {
    onOpen: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
  };

  it("the lobby sweep drains through bounded lanes with ZERO leaked conns - refusals reap instantly", async () => {
    const log = freshDialLog();
    // Backstop timeout is 30s on purpose: if the peer-unavailable fast path
    // broke, the sweep would stall at the concurrency cap forever and this
    // test times out - the ONLY way to drain is the immediate refusal reap.
    const t = new PeerJsTransport("pfx", makeDialCtor(log), {
      dialTimeoutMs: 30_000,
    });
    await t.start(noopEvents);
    try {
      await until(() => log.dialed.length >= 63 + 8, 10_000);
      // the cap held at every instant (the storm would show 70+)
      expect(log.maxLive).toBeGreaterThan(0);
      expect(log.maxLive).toBeLessThanOrEqual(4); // DIAL_CONCURRENCY
      // every refused conn was closed - nothing left holding an ICE agent
      await until(() => log.closed.length >= log.dialed.length, 10_000);
      expect(log.live).toBe(0);
    } finally {
      t.stop();
    }
  }, 25_000);

  it("a dial that OPENS is seated as a link, not closed, and frees its lane", async () => {
    const log = freshDialLog();
    const t = new PeerJsTransport("pfx", makeDialCtor(log), {
      dialTimeoutMs: 30_000,
    });
    await t.start(noopEvents);
    try {
      t.dial("open-peer");
      await until(() => t.links().includes("open-peer"), 5_000);
      // the winner is never reaped
      expect(log.closed).not.toContain("open-peer");
      // and the sweep kept flowing past it (the lane was freed on open)
      await until(() => log.dialed.length >= 63 + 8 + 1, 10_000);
      // every other attempt (all refused) was closed: only the live link
      expect(log.live).toBe(1);
    } finally {
      t.stop();
    }
  }, 25_000);

  it("the same id is never dialed twice while queued or pending", async () => {
    const log = freshDialLog();
    const t = new PeerJsTransport("pfx", makeDialCtor(log), {
      dialConcurrency: 1,
      dialTimeoutMs: 80, // short backstop: hang-a frees the lane for hang-b
    });
    await t.start(noopEvents);
    try {
      t.dial("hang-a"); // occupies the single lane until the backstop
      t.dial("hang-b");
      t.dial("hang-b"); // duplicate while queued - must be a no-op
      t.dial("hang-b"); // and again, for the pending window too
      await until(() => log.dialed.includes("hang-b"), 10_000);
      await new Promise((r) => setTimeout(r, 150));
      expect(log.dialed.filter((id) => id === "hang-b")).toHaveLength(1);
      expect(log.dialed.filter((id) => id === "hang-a")).toHaveLength(1);
    } finally {
      t.stop();
    }
  }, 25_000);

  it("stop() closes in-flight attempts and disarms the queue", async () => {
    const log = freshDialLog();
    // everything hangs: only stop() may reap the four parked attempts
    class AllHangPeer {
      private handlers = new Map<string, Handler[]>();
      constructor(id: string) {
        queueMicrotask(() => {
          for (const cb of this.handlers.get("open") ?? []) cb(id);
        });
      }
      on(event: string, cb: Handler): void {
        const list = this.handlers.get(event) ?? [];
        list.push(cb);
        this.handlers.set(event, list);
      }
      connect(id: string): unknown {
        log.dialed.push(id);
        log.live += 1;
        return {
          peer: id,
          open: false,
          on: () => undefined,
          send: () => undefined,
          close: () => {
            log.live -= 1;
            log.closed.push(id);
          },
        };
      }
      reconnect(): void {}
      destroy(): void {}
    }
    const t = new PeerJsTransport("pfx", AllHangPeer as unknown as PeerCtor, {
      dialTimeoutMs: 30_000,
    });
    await t.start(noopEvents);
    await until(() => log.dialed.length >= 4, 5_000); // lanes full, parked
    t.stop();
    expect(log.closed).toHaveLength(4); // every in-flight attempt closed
    expect(log.live).toBe(0);
    const atStop = log.dialed.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(log.dialed.length).toBe(atStop); // the queue died with it
  }, 15_000);
});
