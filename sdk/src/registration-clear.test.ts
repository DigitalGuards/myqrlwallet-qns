import { describe, expect, it } from "vitest";
import { ACCOUNT, OTHER, config, MockChain } from "./__tests__/mockProvider.js";
import {
  addressWord,
  bytes32Word,
  hashText,
  isRecord,
  selector,
  stringArgument,
  uintWord,
} from "./abi.js";
import { NameHistoryCache } from "./earlier.js";
import {
  readNameLeftovers,
  readRegistrationState,
  registerName,
  registrationName,
  registrationPlan,
  registrationTransaction,
  type RegistrationOptions,
  type RegistrationStep,
  type TransactionUpdate,
} from "./registration.js";

const alice = registrationName("alice");
const PUBLIC = config.contracts.QRLPublicResolver ?? "";
const ZERO = `Q${"0".repeat(128)}`;
const FOREIGN = `Q${"f".repeat(128)}`;
const TEXT = `0x${uintWord(128n)}${uintWord(256n)}${stringArgument("url").slice(128)}${stringArgument("web:old").slice(128)}`;

/** A chain where a foreign resolver contract answers with the earlier owner's address. */
class ForeignChain extends MockChain {
  failLogs = false;
  hideVersionLogs = false;
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    const call = args.params?.[0];
    if (args.method === "qrl_getLogs" && this.failLogs)
      return Promise.reject(new Error("logs are not available on this endpoint"));
    if (args.method === "qrl_call" && isRecord(call) && call.to === FOREIGN) {
      const data = typeof call.data === "string" ? call.data : "";
      if (data.startsWith(selector("addr(bytes32)")))
        return Promise.resolve(`0x${addressWord(OTHER)}`);
      return Promise.resolve(`0x${stringArgument("")}`);
    }
    const result = super.request(args);
    if (args.method === "qrl_getLogs" && this.hideVersionLogs)
      return result.then((logs) =>
        Array.isArray(logs)
          ? logs.filter(
              (entry: unknown) =>
                !(
                  isRecord(entry) &&
                  Array.isArray(entry.topics) &&
                  entry.topics[0] === `0x${bytes32Word(hashText("VersionChanged(bytes32,uint64)"))}`
                ),
            )
          : logs,
      );
    return result;
  }
}

/** What the name resolves to on this mock: through its registry pointer, or nothing. */
function resolves(chain: MockChain): string | null {
  const pointer = chain.resolvers.get(alice.node) ?? ZERO;
  if (pointer === ZERO) return null;
  if (pointer === FOREIGN) return OTHER;
  return chain.addresses.get(alice.node) ?? null;
}

function options(chain: MockChain, updates: TransactionUpdate[] = []): RegistrationOptions {
  return {
    config,
    provider: chain,
    wallet: chain,
    account: ACCOUNT,
    transport: "extension",
    primary: false,
    receiptTimeoutMs: 0,
    onUpdate: (update) => updates.push(update),
  };
}

function sentSteps(chain: MockChain): RegistrationStep[] {
  const steps: RegistrationStep[] = ["register", "clear", "address", "resolver", "name"];
  return chain.sent.map((tx) => {
    const step = steps.find(
      (candidate) =>
        registrationTransaction(alice.name, ACCOUNT, candidate, config).data === tx.data,
    );
    if (!step) throw new Error("Unexpected write");
    return step;
  });
}

/** OTHER set up alice.qrl with a text record and released it; the pointer is then set. */
function released(pointer: "zero" | "public" | "foreign"): ForeignChain {
  const chain = new ForeignChain();
  chain.seedEarlierOwner(alice.name, OTHER);
  chain.resolverLog("TextChanged(bytes32,string,string,string)", alice.node, TEXT);
  if (pointer === "zero") chain.resolvers.delete(alice.node);
  if (pointer === "foreign") chain.resolvers.set(alice.node, FOREIGN);
  chain.release(alice.name);
  return chain;
}

describe("claim of a released name", () => {
  it.each([
    {
      pointer: "public" as const,
      plan: ["register", "clear", "address", "resolver", "name"],
      sent: ["register", "clear", "address", "name"],
      // The deployed registrar keeps the pointer, so the earlier address answers until the clear.
      trace: [OTHER, null, ACCOUNT, ACCOUNT],
    },
    {
      pointer: "zero" as const,
      plan: ["register", "clear", "address", "resolver", "name"],
      sent: ["register", "clear", "address", "resolver", "name"],
      trace: [null, null, null, ACCOUNT, ACCOUNT],
    },
    {
      pointer: "foreign" as const,
      plan: ["register", "clear", "resolver", "address", "name"],
      sent: ["register", "clear", "resolver", "address", "name"],
      // The foreign contract is replaced before the address; the public records are cleared.
      trace: [OTHER, OTHER, null, ACCOUNT, ACCOUNT],
    },
  ])("orders the steps for a $pointer pointer and never serves stale public records", async (c) => {
    const chain = released(c.pointer);
    const state = await readRegistrationState("alice", ACCOUNT, { config, provider: chain });
    expect(state.earlier?.needsClear).toBe(true);
    const plan = registrationPlan(state, false);
    expect(plan.map((entry) => entry.step)).toEqual(c.plan);
    expect(plan.find((entry) => entry.step === "clear")).toEqual({
      step: "clear",
      required: true,
      version: "0x0",
    });
    const trace: (string | null)[] = [];
    chain.afterReceipt = () => trace.push(resolves(chain));
    await registerName("alice", { ...options(chain), plan });
    expect(sentSteps(chain)).toEqual(c.sent);
    expect(trace).toEqual(c.trace);
    expect(chain.contenthashes.has(alice.node)).toBe(false);
    expect(chain.versions.get(alice.node)).toBe(1n);
  });

  it("plans no clear for a fresh name and writes the address before the resolver", async () => {
    const chain = new MockChain();
    const state = await readRegistrationState("alice", ACCOUNT, { config, provider: chain });
    expect(state.earlier).toMatchObject({ needsClear: false, logs: "none" });
    expect(registrationPlan(state, false).map((entry) => entry.step)).toEqual([
      "register",
      "address",
      "resolver",
      "name",
    ]);
  });

  it("finds a text-only leftover from the resolver logs", async () => {
    const chain = new MockChain();
    chain.seed(alice.name, OTHER);
    chain.resolverLog("TextChanged(bytes32,string,string,string)", alice.node, TEXT);
    chain.release(alice.name);
    const state = await readRegistrationState("alice", ACCOUNT, { config, provider: chain });
    expect(state.earlier).toMatchObject({ resolver: ZERO, records: false, logs: "writes" });
    expect(registrationPlan(state, false).map((entry) => entry.step)).toContain("clear");
  });

  it("ignores records cleared before the release", async () => {
    const chain = new MockChain();
    chain.seed(alice.name, OTHER);
    chain.resolverLog("TextChanged(bytes32,string,string,string)", alice.node, TEXT);
    chain.resolverLog("VersionChanged(bytes32,uint64)", alice.node, `0x${uintWord(1n)}`);
    chain.versions.set(alice.node, 1n);
    chain.release(alice.name);
    const state = await readRegistrationState("alice", ACCOUNT, { config, provider: chain });
    expect(state.earlier).toMatchObject({ logs: "none", needsClear: false, version: 1n });
  });
});

describe("log endpoint failures", () => {
  it("keeps a search working and claims with the clear when logs fail", async () => {
    const chain = new ForeignChain();
    chain.failLogs = true;
    const state = await readRegistrationState("alice", ACCOUNT, { config, provider: chain });
    expect(state.earlier).toMatchObject({ logs: "unavailable", needsClear: true });
    const plan = registrationPlan(state, false);
    expect(plan.map((entry) => entry.step)).toEqual([
      "register",
      "clear",
      "address",
      "resolver",
      "name",
    ]);
    await registerName("alice", { ...options(chain), plan });
    expect(sentSteps(chain)).toEqual(["register", "clear", "address", "resolver", "name"]);
    expect(await readNameLeftovers("bob", { config, provider: chain })).toMatchObject({
      logs: "unavailable",
      subnames: null,
    });
  });

  it("keeps the displayed plan when logs start failing during the claim", async () => {
    const chain = new ForeignChain();
    const state = await readRegistrationState("alice", ACCOUNT, { config, provider: chain });
    const plan = registrationPlan(state, false);
    expect(plan.some((entry) => entry.step === "clear")).toBe(false);
    chain.failLogs = true;
    await registerName("alice", { ...options(chain), plan });
    expect(sentSteps(chain)).toEqual(["register", "address", "resolver", "name"]);
  });

  it("finishes a claim whose clear is confirmed before its log is visible", async () => {
    const chain = released("public");
    const state = await readRegistrationState("alice", ACCOUNT, { config, provider: chain });
    const plan = registrationPlan(state, false);
    // The clear's VersionChanged log never becomes visible during the claim.
    chain.hideVersionLogs = true;
    await registerName("alice", { ...options(chain), plan });
    expect(chain.versions.get(alice.node)).toBe(1n);
    expect(sentSteps(chain)).toEqual(["register", "clear", "address", "name"]);
  });
});

describe("names that already have an owner", () => {
  it("never plans a clear and keeps the owner's own later records", async () => {
    const chain = new MockChain();
    chain.seedEarlierOwner(alice.name, OTHER);
    chain.resolverLog("TextChanged(bytes32,string,string,string)", alice.node, TEXT);
    chain.release(alice.name);
    // Claimed by an earlier app version without a clear, then the owner's own records.
    chain.seed(alice.name, ACCOUNT);
    chain.addresses.set(alice.node, ACCOUNT);
    chain.resolverLog("AddrChanged(bytes32,address)", alice.node, `0x${addressWord(ACCOUNT)}`);
    chain.contenthashes.set(alice.node, "e3");
    const state = await readRegistrationState("alice", ACCOUNT, { config, provider: chain });
    expect(state.earlier).toBeNull();
    const plan = registrationPlan(state, true);
    expect(plan.some((entry) => entry.step === "clear")).toBe(false);
    await registerName("alice", { ...options(chain), primary: true, plan });
    expect(chain.sent.some((tx) => tx.data.startsWith(selector("clearRecords(bytes32)")))).toBe(
      false,
    );
    expect(chain.contenthashes.get(alice.node)).toBe("e3");
    expect(chain.versions.get(alice.node)).toBeUndefined();
  });

  it("sets up an owned name whose claim log is missing", async () => {
    const chain = new MockChain();
    chain.owners.set(alice.node, ACCOUNT);
    const state = await readRegistrationState("alice", ACCOUNT, { config, provider: chain });
    expect(state.earlier).toBeNull();
    const plan = registrationPlan(state, false);
    expect(plan.map((entry) => entry.step)).toEqual(["register", "address", "resolver", "name"]);
    await registerName("alice", { ...options(chain), plan });
    expect(sentSteps(chain)).toEqual(["address", "resolver", "name"]);
  });
});

describe("resuming a claim", () => {
  it("runs the saved clear after an interruption and drops it once the version moved", async () => {
    const chain = released("public");
    const first = registrationPlan(
      await readRegistrationState("alice", ACCOUNT, { config, provider: chain }),
      false,
    );
    const saved = first.find((entry) => entry.step === "clear")?.version;
    expect(saved).toBe("0x0");
    chain.rejectSend = 2;
    const updates: TransactionUpdate[] = [];
    await expect(
      registerName("alice", { ...options(chain, updates), plan: first }),
    ).rejects.toThrow("rejected");
    expect(updates.at(-1)).toMatchObject({ step: "clear", status: "failed" });
    chain.rejectSend = 0;
    const owned = await readRegistrationState("alice", ACCOUNT, { config, provider: chain });
    // Without the saved plan an owned name gets no clear.
    expect(registrationPlan(owned, false).some((entry) => entry.step === "clear")).toBe(false);
    const resumed = registrationPlan(owned, false, { version: saved ?? "" });
    expect(resumed.map((entry) => entry.step)).toEqual([
      "register",
      "clear",
      "address",
      "resolver",
      "name",
    ]);
    await registerName("alice", { ...options(chain), plan: resumed });
    expect(sentSteps(chain)).toEqual(["register", "clear", "address", "name"]);
    const done = await readRegistrationState("alice", ACCOUNT, { config, provider: chain });
    expect(registrationPlan(done, false, { version: saved ?? "" }).map((e) => e.step)).toEqual([
      "register",
      "address",
      "resolver",
      "name",
    ]);
  });
});

describe("earlier-owner line inputs", () => {
  it("reports the pointer, records and one level of subnames for an unowned name", async () => {
    const chain = released("public");
    chain.seedSubname(alice.name, "pay", OTHER);
    expect(await readNameLeftovers("alice", { config, provider: chain })).toMatchObject({
      resolver: PUBLIC,
      records: true,
      logs: "writes",
      subnames: 1,
      needsClear: true,
    });
  });

  it("returns nothing for an owned name", async () => {
    const chain = new MockChain();
    chain.seed(alice.name, ACCOUNT);
    expect(await readNameLeftovers("alice", { config, provider: chain })).toBeNull();
  });

  it("rescans only the recent tail with a session cache", async () => {
    class TallChain extends MockChain {
      head = 5000n;
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_blockNumber")
          return Promise.resolve(`0x${this.head.toString(16)}`);
        return super.request(args);
      }
    }
    const chain = new TallChain();
    const history = new NameHistoryCache();
    await readNameLeftovers("alice", { config, provider: chain, history });
    expect(chain.calls.filter((call) => call.method === "qrl_getLogs")).toHaveLength(3);
    chain.head = 5010n;
    chain.calls = [];
    await readNameLeftovers("alice", { config, provider: chain, history });
    const tail = chain.calls.filter((call) => call.method === "qrl_getLogs");
    expect(tail).toHaveLength(1);
    expect(tail[0]?.params?.[0]).toMatchObject({ fromBlock: "0x1309", toBlock: "0x1392" });
  });
});
