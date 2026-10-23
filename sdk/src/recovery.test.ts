import { describe, expect, it } from "vitest";
import { ACCOUNT, OTHER, config, MockChain } from "./__tests__/mockProvider.js";
import { addressWord, bytes32Word, isRecord, selector } from "./abi.js";
import {
  checkRegistrationTransaction,
  readRegistrationState,
  registerName,
  registrationName,
  registrationTransaction,
  TransactionMismatchError,
  type RegistrationStep,
  type TransactionUpdate,
} from "./registration.js";
import { reverseNodeFor } from "./resolver.js";

const hash = `0x${"d".repeat(64)}`;
const pending: TransactionUpdate = { step: "register", status: "unconfirmed", hash, nonce: "0x7" };
const transports: ("relay" | "extension")[] = ["relay", "extension"];

class RecoveryChain extends MockChain {
  transaction: unknown = {
    ...registrationTransaction("alice", ACCOUNT, "register", config),
    input: registrationTransaction("alice", ACCOUNT, "register", config).data,
    hash,
    nonce: "0x7",
  };
  mined = true;
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    if (args.method === "qrl_getTransactionByHash") return Promise.resolve(this.transaction);
    if (args.method === "qrl_getTransactionReceipt")
      return Promise.resolve(
        this.mined
          ? {
              transactionHash: hash,
              blockHash: `0x${"c".repeat(64)}`,
              blockNumber: "0x20",
              status: "0x1",
            }
          : null,
      );
    return super.request(args);
  }
}

describe("transaction recovery", () => {
  it.each([false, true])(
    "preserves submitted identity across receipt errors and retries (nonce=%s)",
    async (knownNonce) => {
      class ReceiptFailure extends RecoveryChain {
        failReceipt = true;
        override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
          if (this.failReceipt && args.method === "qrl_getTransactionReceipt")
            return Promise.reject(new Error("Receipt RPC timed out"));
          return super.request(args);
        }
      }
      const provider = new ReceiptFailure();
      provider.mined = false;
      provider.confirmedNonce = 7n;
      const original = Object.freeze({
        step: "register",
        status: "unconfirmed",
        hash,
        requestId: "original-request",
        ...(knownNonce ? { nonce: "0x7" } : {}),
      } as const);
      const before = { ...original };
      await expect(
        checkRegistrationTransaction("alice", ACCOUNT, original, { config, provider }),
      ).rejects.toThrow("Receipt RPC timed out");
      expect(original).toEqual(before);
      provider.failReceipt = false;
      expect(
        await checkRegistrationTransaction("alice", ACCOUNT, original, { config, provider }),
      ).toBe("pending");
      expect(original).toEqual(before);
      provider.confirmedNonce = 8n;
      expect(
        await checkRegistrationTransaction("alice", ACCOUNT, original, { config, provider }),
      ).toBe("replaced");
      expect(original).toEqual(before);
      expect(provider.sent).toHaveLength(0);
    },
  );

  it("retains the sent hash and discovered nonce when a later transaction lookup changes", async () => {
    const provider = new MockChain();
    provider.confirmedNonce = 7n;
    provider.receiptPending = true;
    const updates: TransactionUpdate[] = [];
    await expect(
      registerName("alice", {
        config,
        provider,
        wallet: provider,
        account: ACCOUNT,
        transport: "extension",
        primary: false,
        pollIntervalMs: 0,
        onUpdate(update) {
          updates.push(update);
          if (update.status === "pending" && update.nonce !== undefined) {
            const tx = provider.sent[0];
            if (!tx) throw new Error("Missing submitted transaction");
            tx.nonce = "0x8";
            provider.receiptPending = false;
          }
        },
      }),
    ).rejects.toThrow(TransactionMismatchError);
    const submittedHash = `0x${"1".padStart(64, "0")}`;
    expect(
      updates
        .filter((update) => update.hash !== undefined)
        .every((update) => update.hash === submittedHash),
    ).toBe(true);
    expect(
      updates
        .filter((update) => update.nonce !== undefined)
        .every((update) => update.nonce === "0x7"),
    ).toBe(true);
    expect(updates.at(-1)).toMatchObject({
      hash: submittedHash,
      nonce: "0x7",
      status: "mismatched",
    });
    expect(provider.sent).toHaveLength(1);
  });

  it("detects a replaced nonce without a receipt and keeps an unused nonce pending", async () => {
    const provider = new RecoveryChain();
    provider.mined = false;
    provider.transaction = null;
    provider.confirmedNonce = 7n;
    expect(
      await checkRegistrationTransaction("alice", ACCOUNT, pending, { config, provider }),
    ).toBe("pending");
    provider.confirmedNonce = 8n;
    expect(
      await checkRegistrationTransaction("alice", ACCOUNT, pending, { config, provider }),
    ).toBe("replaced");
    expect(provider.calls).toContainEqual({
      method: "qrl_getTransactionCount",
      params: [ACCOUNT, "latest"],
    });
    expect(provider.sent).toHaveLength(0);
  });
  it("matches an exact operation and validates network identity", async () => {
    const provider = new RecoveryChain();
    expect(
      await checkRegistrationTransaction("alice", ACCOUNT, pending, { config, provider }),
    ).toBe("confirmed");
    provider.chainId = "0x1";
    await expect(
      checkRegistrationTransaction("alice", ACCOUNT, pending, { config, provider }),
    ).rejects.toThrow("Select chain");
  });
  it.each([
    { from: OTHER },
    { to: OTHER },
    { input: "0x" },
    {
      input:
        selector("register(bytes32,address)") +
        bytes32Word(registrationName("bob").labelHash) +
        addressWord(ACCOUNT),
    },
    {
      input:
        selector("register(bytes32,address)") +
        bytes32Word(registrationName("alice").labelHash) +
        addressWord(OTHER),
    },
    { chainId: "0x1" },
    { chainId: undefined },
    { nonce: "0x8" },
    { value: "0x1" },
    { hash: `0x${"e".repeat(64)}` },
  ])("rejects a recovery transaction with mismatched fields: %j", async (patch) => {
    const provider = new RecoveryChain();
    const expected = registrationTransaction("alice", ACCOUNT, "register", config);
    provider.transaction = { ...expected, input: expected.data, hash, nonce: "0x7", ...patch };
    await expect(
      checkRegistrationTransaction("alice", ACCOUNT, pending, { config, provider }),
    ).rejects.toThrow(TransactionMismatchError);
  });
  it("classifies a mismatched wallet hash during an active claim", async () => {
    class WrongSenderChain extends MockChain {
      override async request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        const result = await super.request(args);
        return args.method === "qrl_getTransactionByHash" && isRecord(result)
          ? { ...result, from: OTHER }
          : result;
      }
    }
    const provider = new WrongSenderChain();
    const updates: TransactionUpdate[] = [];
    await expect(
      registerName("alice", {
        config,
        provider,
        wallet: provider,
        account: ACCOUNT,
        transport: "extension",
        primary: false,
        onUpdate: (update) => updates.push(update),
      }),
    ).rejects.toThrow(TransactionMismatchError);
    expect(updates.at(-1)).toMatchObject({ step: "register", status: "mismatched" });
    expect(updates.at(-1)?.hash).toBeDefined();
    expect(provider.sent).toHaveLength(1);
  });
  it("stops an active claim as soon as its nonce is mined elsewhere", async () => {
    const provider = new MockChain();
    provider.receiptPending = true;
    const updates: TransactionUpdate[] = [];
    await expect(
      registerName("alice", {
        config,
        provider,
        wallet: provider,
        account: ACCOUNT,
        transport: "extension",
        primary: false,
        onUpdate: (update) => {
          updates.push(update);
          if (update.status === "pending") provider.confirmedNonce = 1n;
        },
      }),
    ).rejects.toThrow("saved nonce has been used");
    expect(provider.sent).toHaveLength(1);
    expect(updates.at(-1)).toMatchObject({ step: "register", status: "replaced", nonce: "0x0" });
  });
  it.each(transports)("reads the %s wallet's nonce after submission", async (transport) => {
    const provider = new MockChain();
    provider.receiptPending = true;
    provider.confirmedNonce = 7n;
    const updates: TransactionUpdate[] = [];
    await expect(
      registerName("alice", {
        config,
        provider,
        wallet: provider,
        account: ACCOUNT,
        transport,
        primary: false,
        receiptTimeoutMs: 0,
        onUpdate: (update) => updates.push(update),
      }),
    ).rejects.toThrow("pending");
    expect(updates[0]).toEqual({ step: "register", status: "approval" });
    expect(updates.at(-1)).toMatchObject({
      nonce: "0x7",
      hash: provider.sent.length.toString(16).padStart(66, "0").replace(/^00/, "0x"),
    });
    expect(provider.sent[0]?.nonce).toBe("0x7");
    const request = provider.calls.find((call) => call.method === "qrl_sendTransaction");
    expect(request?.params?.[0]).not.toHaveProperty("nonce");
    expect(request?.params?.[0]).not.toHaveProperty("gasLimit");
    expect(provider.calls.filter((call) => call.method === "qrl_getTransactionCount")).toEqual([
      { method: "qrl_getTransactionCount", params: [ACCOUNT, "latest"] },
    ]);
  });
  it("discovers a delayed transaction's nonce while waiting and detects its replacement", async () => {
    class DelayedTransaction extends MockChain {
      reads = 0;
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_getTransactionByHash") {
          this.reads++;
          if (this.reads === 1) return Promise.resolve(null);
        }
        return super.request(args);
      }
    }
    const provider = new DelayedTransaction();
    provider.confirmedNonce = 7n;
    provider.receiptPending = true;
    const updates: TransactionUpdate[] = [];
    await expect(
      registerName("alice", {
        config,
        provider,
        wallet: provider,
        account: ACCOUNT,
        transport: "relay",
        primary: false,
        pollIntervalMs: 0,
        onUpdate(update) {
          updates.push(update);
          if (update.nonce === "0x7") provider.confirmedNonce = 8n;
        },
      }),
    ).rejects.toThrow("saved nonce has been used");
    expect(provider.reads).toBe(2);
    expect(updates.at(-1)).toMatchObject({ status: "replaced", nonce: "0x7" });
  });
  it("keeps an unseen hash without a guessed nonce for name-state recovery", async () => {
    class UnseenTransaction extends MockChain {
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_getTransactionByHash") return Promise.resolve(null);
        return super.request(args);
      }
    }
    const provider = new UnseenTransaction();
    provider.receiptPending = true;
    const updates: TransactionUpdate[] = [];
    await expect(
      registerName("alice", {
        config,
        provider,
        wallet: provider,
        account: ACCOUNT,
        transport: "relay",
        primary: false,
        receiptTimeoutMs: 0,
        onUpdate: (update) => updates.push(update),
      }),
    ).rejects.toThrow("pending");
    const update = updates.at(-1);
    if (!update) throw new Error("Missing pending update");
    expect(update).toMatchObject({
      step: "register",
      status: "unconfirmed",
    });
    expect(update.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(update).not.toHaveProperty("nonce");
    provider.confirmedNonce = 8n;
    expect(await checkRegistrationTransaction("alice", ACCOUNT, update, { config, provider })).toBe(
      "pending",
    );
    provider.seed("alice", ACCOUNT);
    expect(
      (await readRegistrationState("alice", ACCOUNT, { config, provider })).complete.register,
    ).toBe(true);
    expect(provider.calls.some((call) => call.method === "qrl_getTransactionCount")).toBe(false);
    expect(provider.sent).toHaveLength(1);
  });
});

const steps: RegistrationStep[] = ["register", "resolver", "address", "name", "primary"];

describe("name state recovery", () => {
  it.each([0, 1, 2, 3, 4, 5])(
    "reads the completed records and resumes at step %i",
    async (completed) => {
      const provider = new MockChain();
      const node = registrationName("alice").node;
      if (completed >= 1) provider.seed("alice", ACCOUNT);
      if (completed >= 2) provider.resolvers.set(node, config.contracts.QRLPublicResolver ?? "");
      if (completed >= 3) provider.addresses.set(node, ACCOUNT);
      if (completed >= 4) provider.spellings.set(node, "alice.qrl");
      if (completed >= 5) {
        provider.primary = "alice.qrl";
        provider.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
      }
      const state = await readRegistrationState("alice", ACCOUNT, { config, provider });
      expect(steps.map((step) => state.complete[step])).toEqual(
        steps.map((_, index) => index < completed),
      );
      expect(
        provider.calls
          .filter((call) => call.method === "qrl_call")
          .every((call) => call.params?.[1] === "0x20"),
      ).toBe(true);
      const updates: TransactionUpdate[] = [];
      await registerName("alice", {
        config,
        provider,
        wallet: provider,
        account: ACCOUNT,
        transport: "extension",
        primary: true,
        onUpdate: (update) => updates.push(update),
      });
      expect(provider.sent).toHaveLength(5 - completed);
      expect(
        updates.filter((update) => update.status === "approval").map((update) => update.step),
      ).toEqual(steps.slice(completed));
    },
  );
});
