import { expect, it } from "vitest";
import { ACCOUNT, OTHER, config, MockChain } from "./__tests__/mockProvider.js";
import { addressWord, isRecord, selector, uintWord, ZERO_ADDRESS } from "./abi.js";
import {
  registerName,
  registrationName,
  registrationTransaction,
  type RegistrationStep,
  type TransactionUpdate,
} from "./registration.js";
import { reverseNodeFor } from "./resolver.js";

const alice = registrationName("alice");

function seedReady(chain: MockChain): void {
  chain.seed(alice.name, ACCOUNT);
  chain.resolvers.set(alice.node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(alice.node, ACCOUNT);
  chain.spellings.set(alice.node, alice.name);
}

function run(chain: MockChain, onUpdate: (update: TransactionUpdate) => void, primary = false) {
  return registerName(alice.name, {
    config,
    provider: chain,
    wallet: chain,
    account: ACCOUNT,
    transport: "extension",
    primary,
    onUpdate,
  });
}

it.each(["owner", "availability", "deployment", "wiring", "account", "network", "gas"] as const)(
  "rejects a failed %s guard before the first approval",
  async (guard) => {
    class GuardFailure extends MockChain {
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        const call = args.params?.[0];
        if (args.method === "qrl_call" && isRecord(call) && typeof call.data === "string") {
          if (guard === "availability" && call.data.startsWith(selector("available(bytes32)")))
            return Promise.resolve(`0x${uintWord(0n)}`);
          if (guard === "wiring" && call.data === selector("qns()"))
            return Promise.resolve(`0x${addressWord(OTHER)}`);
        }
        if (guard === "gas" && args.method === "qrl_estimateGas") return Promise.resolve("0x0");
        return super.request(args);
      }
    }
    const chain = new GuardFailure();
    if (guard === "owner") chain.seed(alice.name, OTHER);
    if (guard === "deployment") chain.noCode = true;
    if (guard === "account") chain.accounts = [OTHER];
    if (guard === "network") chain.chainId = "0x1";
    const updates: TransactionUpdate[] = [];
    await expect(run(chain, (update) => updates.push(update))).rejects.toThrow();
    expect(chain.sent).toHaveLength(0);
    expect(updates.some((update) => update.status === "approval")).toBe(false);
  },
);

it("rejects the zero signer before reading or sending", async () => {
  const chain = new MockChain();
  await expect(
    registerName(alice.name, {
      config,
      provider: chain,
      wallet: chain,
      account: ZERO_ADDRESS,
      transport: "extension",
      primary: false,
      onUpdate: () => {},
    }),
  ).rejects.toThrow("nonzero");
  expect(chain.calls).toHaveLength(0);
});

it.each(["register", "resolver", "address", "name", "primary"] as const)(
  "verifies the mined %s postcondition before any further approval",
  async (step) => {
    const chain = new MockChain();
    seedReady(chain);
    if (step === "register") chain.owners.delete(alice.node);
    if (step === "resolver") chain.resolvers.delete(alice.node);
    if (step === "address") chain.addresses.delete(alice.node);
    if (step === "name") chain.spellings.delete(alice.node);
    chain.afterReceipt = () => {
      if (step === "register") chain.owners.delete(alice.node);
      if (step === "resolver") chain.resolvers.delete(alice.node);
      if (step === "address") chain.addresses.set(alice.node, OTHER);
      if (step === "name") chain.spellings.set(alice.node, "bob.qrl");
      if (step === "primary") chain.primary = "";
    };
    const updates: TransactionUpdate[] = [];
    await expect(run(chain, (update) => updates.push(update), true)).rejects.toThrow();
    expect(chain.sent.map((tx) => tx.data)).toEqual([
      registrationTransaction(alice.name, ACCOUNT, step, config).data,
    ]);
    expect(
      updates.filter((update) => update.status === "approval").map((update) => update.step),
    ).toEqual([step]);
    expect(updates.some((update) => update.status === "confirmed")).toBe(false);
  },
);

// Round 6 probes: a completed step can regress when the next block arrives.
it.each(["confirmed", "skipped"] as const)(
  "stops before the next approval when a %s address regresses at the next block",
  async (status) => {
    class AdvancingChain extends MockChain {
      head = 32n;
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_blockNumber")
          return Promise.resolve(`0x${this.head.toString(16)}`);
        return super.request(args);
      }
    }
    const chain = new AdvancingChain();
    seedReady(chain);
    chain.spellings.delete(alice.node);
    if (status === "confirmed") chain.addresses.delete(alice.node);
    const updates: TransactionUpdate[] = [];
    await expect(
      run(chain, (update) => {
        updates.push(update);
        if (update.step === "address" && update.status === status) {
          chain.head++;
          chain.addresses.set(alice.node, OTHER);
        }
      }),
    ).rejects.toThrow();
    expect(chain.sent.map((tx) => tx.data)).toEqual(
      status === "confirmed"
        ? [registrationTransaction(alice.name, ACCOUNT, "address", config).data]
        : [],
    );
    expect(updates.some((update) => update.step === "name" && update.status === "approval")).toBe(
      false,
    );
  },
);

const guards: Array<{
  guard: string;
  after: RegistrationStep;
  next: RegistrationStep;
  signature: string;
  node: string;
}> = [
  ...(["register", "resolver", "address", "name"] as const).map((after) => ({
    guard: `owner after ${after}`,
    after,
    next: "primary" as const,
    signature: "owner(bytes32)",
    node: alice.node,
  })),
  {
    guard: "selected resolver",
    after: "register",
    next: "resolver",
    signature: "resolver(bytes32)",
    node: alice.node,
  },
  {
    guard: "destination address",
    after: "resolver",
    next: "address",
    signature: "addr(bytes32)",
    node: alice.node,
  },
  {
    guard: "forward resolution",
    after: "address",
    next: "name",
    signature: "addr(bytes32)",
    node: alice.node,
  },
  {
    guard: "destination spelling",
    after: "address",
    next: "name",
    signature: "name(bytes32)",
    node: alice.node,
  },
  {
    guard: "verified primary",
    after: "name",
    next: "primary",
    signature: "name(bytes32)",
    node: reverseNodeFor(ACCOUNT),
  },
];

it.each(guards)("runs the live $guard guard before any further approval", async (guard) => {
  class LiveReadFailure extends MockChain {
    armed = false;
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      const call = args.params?.[0];
      if (
        this.armed &&
        args.method === "qrl_call" &&
        args.params?.[1] === "latest" &&
        isRecord(call) &&
        typeof call.data === "string" &&
        call.data.startsWith(selector(guard.signature)) &&
        call.data.slice(10, 74) === guard.node.slice(2)
      )
        return Promise.reject(new Error(`Unavailable ${guard.guard}`));
      return super.request(args);
    }
  }
  const chain = new LiveReadFailure();
  seedReady(chain);
  if (guard.next === "resolver") chain.resolvers.delete(alice.node);
  if (guard.next === "address") chain.addresses.delete(alice.node);
  if (guard.next === "name") chain.spellings.delete(alice.node);
  chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
  const updates: TransactionUpdate[] = [];
  await expect(
    run(
      chain,
      (update) => {
        updates.push(update);
        if (update.step === guard.after && update.status === "skipped") chain.armed = true;
      },
      true,
    ),
  ).rejects.toThrow(`Unavailable ${guard.guard}`);
  expect(chain.sent).toHaveLength(0);
  expect(updates.some((update) => update.status === "approval")).toBe(false);
});

it.each(["confirmed", "skipped"] as const)(
  "checks ownership after the final %s name step without primary setup",
  async (status) => {
    const chain = new MockChain();
    seedReady(chain);
    if (status === "confirmed") chain.spellings.delete(alice.node);
    await expect(
      run(chain, (update) => {
        if (update.step === "name" && update.status === status) chain.owners.set(alice.node, OTHER);
      }),
    ).rejects.toThrow();
    expect(chain.sent).toHaveLength(status === "confirmed" ? 1 : 0);
  },
);

it("verifies spelling again after confirmation before a primary approval", async () => {
  const chain = new MockChain();
  seedReady(chain);
  chain.spellings.delete(alice.node);
  await expect(
    run(
      chain,
      (update) => {
        if (update.step === "name" && update.status === "confirmed")
          chain.spellings.set(alice.node, "bob.qrl");
      },
      true,
    ),
  ).rejects.toThrow();
  expect(chain.sent.map((tx) => tx.data)).toEqual([
    registrationTransaction(alice.name, ACCOUNT, "name", config).data,
  ]);
});

it("verifies primary again after confirmation before returning success", async () => {
  const chain = new MockChain();
  seedReady(chain);
  await expect(
    run(
      chain,
      (update) => {
        if (update.step === "primary" && update.status === "confirmed") chain.primary = "";
      },
      true,
    ),
  ).rejects.toThrow();
  expect(chain.sent).toHaveLength(1);
});
