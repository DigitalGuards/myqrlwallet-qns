import { describe, expect, it } from "vitest";
import { ACCOUNT, OTHER, config, MockChain } from "./__tests__/mockProvider.js";
import { isRecord, selector } from "./abi.js";
import {
  checkRegistrationTransaction,
  readRegistrationState,
  registerName,
  registrationName,
  registrationPlan,
  registrationTransaction,
  RevertedTransactionError,
  TransactionMismatchError,
  type RegistrationStep,
  type TransactionUpdate,
} from "./registration.js";
import { reverseNodeFor } from "./resolver.js";

function seedReady(chain: MockChain) {
  const parsed = registrationName("alice");
  chain.seed(parsed.name, ACCOUNT);
  chain.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(parsed.node, ACCOUNT);
  chain.spellings.set(parsed.node, parsed.name);
  return parsed;
}

const steps: RegistrationStep[] = ["register", "resolver", "address", "name", "primary"];
const states = [false, true];
describe("remaining setup writes", () => {
  it.each(
    states.flatMap((selected) =>
      states.flatMap((address) =>
        states.flatMap((spelling) =>
          states.flatMap((primary) =>
            states.flatMap((owned) =>
              states.map((makePrimary) => ({
                selected,
                address,
                spelling,
                primary,
                owned,
                makePrimary,
              })),
            ),
          ),
        ),
      ),
    ),
  )(
    "matches the writes sent with resolver=$selected address=$address spelling=$spelling primary=$primary owned=$owned makePrimary=$makePrimary",
    async ({ selected, address, spelling, primary, owned, makePrimary }) => {
      class ResolverChain extends MockChain {
        override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
          const call = args.params?.[0];
          if (args.method === "qrl_call" && isRecord(call) && call.to === OTHER)
            return Promise.reject(new Error("execution reverted: custom resolver"));
          return super.request(args);
        }
      }
      const chain = new ResolverChain();
      const parsed = seedReady(chain);
      if (!owned) chain.owners.delete(parsed.node);
      if (!selected) chain.resolvers.set(parsed.node, OTHER);
      if (!address) chain.addresses.delete(parsed.node);
      if (!spelling) chain.spellings.delete(parsed.node);
      if (primary) {
        chain.primary = parsed.name;
        chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
      }
      const state = await readRegistrationState(parsed.name, ACCOUNT, { config, provider: chain });
      const plan = registrationPlan(state, makePrimary);
      const required = plan.filter((entry) => entry.required).map((entry) => entry.step);
      expect(plan.map((entry) => entry.step)).toEqual(
        steps.filter((step) => step !== "primary" || makePrimary),
      );
      if (!address) expect(state.complete.name).toBe(false);
      if (!selected || !address) expect(state.complete.primary).toBe(false);
      expect(chain.sent).toHaveLength(0);
      expect(
        chain.calls
          .filter((call) => call.method === "qrl_call")
          .every((call) => call.params?.[1] === "0x20"),
      ).toBe(true);
      await registerName(parsed.name, {
        config,
        provider: chain,
        wallet: chain,
        account: ACCOUNT,
        transport: "extension",
        primary: makePrimary,
        plan,
        onUpdate: () => {
          // The repair plan is checked against submitted transactions and final records.
        },
      });
      expect(chain.sent.map((tx) => tx.data)).toEqual(
        required.map((step) => registrationTransaction(parsed.name, ACCOUNT, step, config).data),
      );
      expect(chain.primary).toBe(makePrimary || primary ? parsed.name : "");
    },
  );
});

type Failure =
  "RPC" | "registry" | "estimate" | "wallet" | "chain" | "account" | "postverification";
const failures: { failure: Failure; message: string; sent: number }[] = [
  { failure: "RPC", message: "RPC unavailable", sent: 0 },
  { failure: "registry", message: "execution reverted: registry unavailable", sent: 0 },
  { failure: "estimate", message: "Gas estimate unavailable", sent: 0 },
  { failure: "wallet", message: "User rejected request", sent: 0 },
  { failure: "chain", message: "Select chain", sent: 0 },
  { failure: "account", message: "Wallet account changed", sent: 0 },
  { failure: "postverification", message: "execution reverted: primary verification", sent: 1 },
];

it.each(failures)(
  "surfaces $failure errors while repairing a broken previous primary",
  async ({ failure, message, sent }) => {
    class BrokenPrimary extends MockChain {
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        const call = args.params?.[0];
        if (args.method === "qrl_call" && isRecord(call)) {
          if (call.to === OTHER) {
            if (failure === "RPC") return Promise.reject(new Error("RPC unavailable"));
            if (failure === "chain") this.chainId = "0x1";
            if (failure === "account") this.accounts = [OTHER];
            return Promise.reject(new Error("execution reverted: old primary resolver"));
          }
          if (
            failure === "registry" &&
            call.to === config.contracts.QNSRegistry &&
            typeof call.data === "string" &&
            call.data.startsWith(selector("resolver(bytes32)")) &&
            call.data.slice(10, 74) === reverseNodeFor(ACCOUNT).slice(2)
          )
            return Promise.reject(new Error("execution reverted: registry unavailable"));
          if (
            failure === "postverification" &&
            this.primary === "alice.qrl" &&
            args.params?.[1] === "latest" &&
            typeof call.data === "string" &&
            call.data.startsWith(selector("addr(bytes32)"))
          )
            return Promise.reject(new Error("execution reverted: primary verification"));
        }
        if (failure === "estimate" && args.method === "qrl_estimateGas")
          return Promise.reject(new Error("Gas estimate unavailable"));
        return super.request(args);
      }
    }
    const chain = new BrokenPrimary();
    seedReady(chain);
    const old = registrationName("old");
    chain.seed(old.name, ACCOUNT);
    chain.resolvers.set(old.node, OTHER);
    chain.primary = old.name;
    chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    if (failure === "wallet") chain.rejectSend = 1;
    await expect(
      registerName("alice", {
        config,
        provider: chain,
        wallet: chain,
        account: ACCOUNT,
        transport: "extension",
        primary: true,
        onUpdate: () => {
          // Failure propagation and the number of submitted transactions are checked below.
        },
      }),
    ).rejects.toThrow(message);
    expect(chain.sent).toHaveLength(sent);
  },
);

it("classifies a matched reverted receipt during submission and saved recovery", async () => {
  const chain = new MockChain();
  chain.receiptStatus = "0x0";
  const updates: TransactionUpdate[] = [];
  await expect(
    registerName("alice", {
      config,
      provider: chain,
      wallet: chain,
      account: ACCOUNT,
      transport: "extension",
      primary: false,
      onUpdate: (update) => updates.push(update),
    }),
  ).rejects.toThrow(RevertedTransactionError);
  const failed = updates.at(-1);
  if (!failed) throw new Error("Missing failed receipt");
  expect(failed).toMatchObject({ status: "failed", message: "Transaction reverted", nonce: "0x0" });
  expect(failed.hash).toBeDefined();
  await expect(
    checkRegistrationTransaction("alice", ACCOUNT, failed, { config, provider: chain }),
  ).rejects.toThrow(RevertedTransactionError);
  await expect(
    checkRegistrationTransaction("bob", ACCOUNT, failed, { config, provider: chain }),
  ).rejects.toThrow(TransactionMismatchError);
  expect(chain.sent).toHaveLength(1);
});

it("retains recovery when an RPC error reports a revert without a receipt", async () => {
  class ReceiptFailure extends MockChain {
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      if (args.method === "qrl_getTransactionReceipt")
        return Promise.reject(new Error("Transaction reverted"));
      return super.request(args);
    }
  }
  const chain = new ReceiptFailure();
  const updates: TransactionUpdate[] = [];
  await expect(
    registerName("alice", {
      config,
      provider: chain,
      wallet: chain,
      account: ACCOUNT,
      transport: "extension",
      primary: false,
      onUpdate: (update) => updates.push(update),
    }),
  ).rejects.toThrow("Transaction reverted");
  expect(updates.at(-1)).toMatchObject({ status: "unconfirmed" });
  expect(updates.at(-1)?.hash).toBeDefined();
});

it("requires a new plan when records change after the approval preview", async () => {
  const chain = new MockChain();
  const parsed = seedReady(chain);
  chain.addresses.delete(parsed.node);
  const plan = registrationPlan(
    await readRegistrationState(parsed.name, ACCOUNT, { config, provider: chain }),
    false,
  );
  chain.spellings.delete(parsed.node);
  await expect(
    registerName(parsed.name, {
      config,
      provider: chain,
      wallet: chain,
      account: ACCOUNT,
      transport: "extension",
      primary: false,
      plan,
      onUpdate: () => {
        // The stale plan must reject before sending; progress needs no action.
      },
    }),
  ).rejects.toThrow("Name records changed");
  expect(chain.sent).toHaveLength(0);
});

it("stops before an unplanned write when records change during an approval", async () => {
  const chain = new MockChain();
  const parsed = seedReady(chain);
  chain.addresses.delete(parsed.node);
  const plan = registrationPlan(
    await readRegistrationState(parsed.name, ACCOUNT, { config, provider: chain }),
    false,
  );
  chain.afterReceipt = () => {
    chain.spellings.delete(parsed.node);
  };
  await expect(
    registerName(parsed.name, {
      config,
      provider: chain,
      wallet: chain,
      account: ACCOUNT,
      transport: "extension",
      primary: false,
      plan,
      onUpdate: () => {
        // The mid-repair change is checked through rejection and submitted transactions.
      },
    }),
  ).rejects.toThrow("Name records changed");
  expect(chain.sent.map((tx) => tx.data)).toEqual([
    registrationTransaction(parsed.name, ACCOUNT, "address", config).data,
  ]);
});
