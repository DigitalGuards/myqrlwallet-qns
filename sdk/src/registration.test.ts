import { describe, expect, it } from "vitest";
import {
  addressWord,
  bytes32Word,
  selector,
  stringArgument,
  nodeStringArguments,
  hashText,
  uintWord,
} from "./abi.js";
import { assertNetwork, parseNetworkConfig } from "./config.js";
import { listOwnedNames } from "./owned.js";
import {
  assertDeployment,
  isAvailable,
  registerName,
  registrationName,
  type RegistrationOptions,
  type RegistrationState,
  type TransactionUpdate,
} from "./registration.js";
import { ACCOUNT, config, MockChain, OTHER } from "./__tests__/mockProvider.js";

function setup() {
  const provider = new MockChain();
  const updates: TransactionUpdate[] = [];
  const states: RegistrationState[] = [];
  const options: RegistrationOptions = {
    config,
    provider,
    wallet: provider,
    account: ACCOUNT,
    primary: false,
    transport: "extension",
    receiptTimeoutMs: 0,
    onUpdate: (update) => updates.push(update),
    onState: (state) => states.push(state),
  };
  return { provider, options, updates, states };
}

describe("registration names", () => {
  it("uses the SDK ASCII normalization for labels and full names", () => {
    expect(registrationName("ALICE")).toEqual(registrationName("Alice.QRL"));
    expect(registrationName("qrl").name).toBe("qrl.qrl");
    expect(registrationName("a--b").name).toBe("a--b.qrl");
    expect(registrationName("-a-").name).toBe("-a-.qrl");
  });
  it.each([
    "",
    " alice",
    "alice ",
    "alice.",
    "sub.alice.qrl",
    "alice.eth",
    "qrl.",
    "xn--alice",
    "ab--cd",
    "a_b",
    "alіce",
    "café",
    "a\n",
  ])("rejects %j before an RPC call", async (name) => {
    const { options, provider } = setup();
    await expect(isAvailable(name, options)).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });
});

describe("availability and configuration", () => {
  it("queries the registrar with a left-aligned bytes32 label", async () => {
    const { options, provider } = setup();
    expect(await isAvailable("alice", options)).toBe(true);
    expect(provider.calls[0]).toEqual({
      method: "qrl_call",
      params: [
        {
          to: config.contracts.FIFSQRLRegistrar,
          data: selector("available(bytes32)") + bytes32Word(registrationName("alice").labelHash),
        },
        "latest",
      ],
    });
    provider.seed("alice", OTHER);
    expect(await isAvailable("Alice.qrl", options)).toBe(false);
  });
  it.each(["0x", "0x01", `0x${"0".repeat(127)}2`, {}, null])(
    "fails closed on malformed availability %j",
    async (result: unknown) => {
      await expect(
        isAvailable("alice", { config, provider: { request: () => Promise.resolve(result) } }),
      ).rejects.toThrow();
    },
  );
  it("parses deployment JSON while dropping private metadata", () => {
    expect(
      parseNetworkConfig({
        ...config,
        deployer: "discard",
        previousContracts: {},
        arbitrary: "discard",
      }),
    ).toEqual(config);
    expect(() =>
      parseNetworkConfig({ ...config, contracts: { ...config.contracts, QNSRegistry: "Q123" } }),
    ).toThrow();
    expect(() =>
      parseNetworkConfig({ ...config, rpcUrl: "https://user:pass@example.test" }),
    ).toThrow();
    expect(() => parseNetworkConfig({ ...config, chainId: 0 })).toThrow();
  });
  it("checks chain, genesis and contract code", async () => {
    const { provider, options } = setup();
    provider.chainId = "0x1";
    await expect(assertNetwork(provider, config)).rejects.toThrow("Select chain");
    provider.chainId = "0x301824";
    provider.noCode = true;
    await expect(assertDeployment(options)).rejects.toThrow("No contract code");
    await expect(
      assertNetwork(
        {
          request: ({ method }) =>
            Promise.resolve(
              method === "qrl_chainId" ? "0x301824" : { hash: `0x${"f".repeat(64)}` },
            ),
        },
        { ...config, genesisHash: `0x${"a".repeat(64)}` },
      ),
    ).rejects.toThrow("genesis");
  });
});

describe("claim flow", () => {
  it("marks an interrupted approval as unresolved when broadcast status is unknown", async () => {
    const { options, updates, provider } = setup();
    await expect(
      registerName("alice", {
        ...options,
        wallet: {
          request(args) {
            if (args.method === "qrl_sendTransaction")
              return Promise.reject(new Error("Connection interrupted"));
            return provider.request(args);
          },
        },
      }),
    ).rejects.toThrow("Connection interrupted");
    expect(updates.at(-1)).toMatchObject({ step: "register", status: "unconfirmed" });
    expect(updates.every((update) => update.nonce === undefined)).toBe(true);
  });
  it("confirms four zero-value writes in order and verifies forward resolution", async () => {
    const { options, provider, updates, states } = setup();
    await expect(registerName("ALICE", options)).resolves.toBe("alice.qrl");
    const { node, labelHash } = registrationName("alice");
    expect(provider.sent.map((tx) => [tx.to, tx.data])).toEqual([
      [
        config.contracts.FIFSQRLRegistrar,
        selector("register(bytes32,address)") + bytes32Word(labelHash) + addressWord(ACCOUNT),
      ],
      [
        config.contracts.QNSRegistry,
        selector("setResolver(bytes32,address)") +
          bytes32Word(node) +
          addressWord(config.contracts.QRLPublicResolver ?? ""),
      ],
      [
        config.contracts.QRLPublicResolver,
        selector("setAddr(bytes32,address)") + bytes32Word(node) + addressWord(ACCOUNT),
      ],
      [
        config.contracts.QRLPublicResolver,
        selector("setName(bytes32,string)") + nodeStringArguments(node, "alice.qrl"),
      ],
    ]);
    expect(
      provider.sent.every(
        (tx) =>
          tx.value === "0" &&
          tx.type === "0x2" &&
          tx.gas === 120000 &&
          tx.gasLimit === undefined &&
          tx.chainId === "0x301824",
      ),
    ).toBe(true);
    expect(updates.map((update) => `${update.step}:${update.status}`)).toEqual([
      "register:approval",
      "register:pending",
      "register:pending",
      "register:confirmed",
      "resolver:approval",
      "resolver:pending",
      "resolver:pending",
      "resolver:confirmed",
      "address:approval",
      "address:pending",
      "address:pending",
      "address:confirmed",
      "name:approval",
      "name:pending",
      "name:pending",
      "name:confirmed",
    ]);
    expect(states.map((state) => state.owner)).toEqual([ACCOUNT, ACCOUNT, ACCOUNT, ACCOUNT]);
    expect(states.map((state) => Object.values(state.complete))).toEqual([
      [true, false, false, false, false],
      [true, true, false, false, false],
      [true, true, true, false, false],
      [true, true, true, true, false],
    ]);
  });
  it("adds a reverse write with 64-byte dynamic ABI offsets for relay wallets", async () => {
    const { options, provider } = setup();
    await registerName("alice", { ...options, primary: true, transport: "relay" });
    expect(provider.sent).toHaveLength(5);
    expect(provider.sent[4]?.data).toBe(selector("setName(string)") + stringArgument("alice.qrl"));
    expect(provider.sent[0]).toMatchObject({ gas: "0x1d4c0", value: "0x0" });
    expect(provider.primary).toBe("alice.qrl");
  });
  it("stops after rejection, then resumes the owner's remaining setup", async () => {
    const { options, provider, updates } = setup();
    provider.rejectSend = 2;
    await expect(registerName("alice", options)).rejects.toThrow("rejected");
    expect(provider.sent).toHaveLength(1);
    expect(updates.at(-1)).toMatchObject({ step: "resolver", status: "failed" });
    provider.rejectSend = 0;
    await registerName("alice", options);
    expect(provider.sent).toHaveLength(4);
    expect(updates).toContainEqual({ step: "register", status: "skipped" });
  });
  it("stops on a reverted receipt", async () => {
    const { provider, options, updates } = setup();
    provider.receiptStatus = "0x0";
    await expect(registerName("alice", options)).rejects.toThrow("reverted");
    expect(provider.sent).toHaveLength(1);
    expect(updates.at(-1)).toMatchObject({
      status: "failed",
      hash: provider.sent.length.toString(16).padStart(66, "0").replace(/^00/, "0x"),
    });
  });
  it("retains a pending hash and prevents later writes on timeout", async () => {
    const { provider, options, updates } = setup();
    provider.receiptPending = true;
    await expect(registerName("alice", options)).rejects.toThrow("Confirmation is still pending");
    expect(provider.sent).toHaveLength(1);
    expect(updates.at(-1)?.status).toBe("unconfirmed");
    expect(updates.at(-1)?.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it.each(["account", "chain", "owner"])(
    "stops when %s changes during the claim",
    async (change) => {
      const { provider, options } = setup();
      provider.afterReceipt = () => {
        if (change === "account") provider.accounts = [OTHER];
        if (change === "chain") provider.chainId = "0x1";
        if (change === "owner") provider.owners.set(registrationName("alice").node, OTHER);
      };
      await expect(registerName("alice", options)).rejects.toThrow();
      expect(provider.sent).toHaveLength(1);
    },
  );
  it("refuses a taken name and sends no transactions", async () => {
    const { provider, options } = setup();
    provider.seed("alice", OTHER);
    await expect(registerName("alice", options)).rejects.toThrow("already owned");
    expect(provider.sent).toHaveLength(0);
  });
});

describe("owned names", () => {
  it("recovers published names in a fresh browser with no reverse record or saved hints", async () => {
    const { provider, options } = setup();
    await registerName("alice", options);
    expect(provider.primary).toBe("");
    expect(await listOwnedNames(ACCOUNT, options)).toEqual([
      {
        name: "alice.qrl",
        node: registrationName("alice").node,
        labelHash: registrationName("alice").labelHash,
      },
    ]);
  });
  it("ignores forged or malformed spellings without losing owned records", async () => {
    const { provider, options } = setup();
    provider.seed("alice", ACCOUNT);
    const topics = [
      `0x${bytes32Word(hashText("NameChanged(bytes32,string)"))}`,
      `0x${bytes32Word(registrationName("alice").node)}`,
    ];
    provider.nameLogs = [
      {
        address: config.contracts.QRLPublicResolver,
        topics,
        data: `0x${stringArgument("bob.qrl")}`,
      },
      {
        address: config.contracts.QRLPublicResolver,
        topics,
        data: `0x${uintWord(64n)}${uintWord(99999999n)}`,
      },
      { address: OTHER, topics, data: `0x${stringArgument("alice.qrl")}` },
    ];
    expect((await listOwnedNames(ACCOUNT, options))[0]?.name).toBeNull();
  });
  it("finds names transferred in, excludes transfers out, and keeps unknown spellings visible", async () => {
    const { provider, options } = setup();
    provider.seed("alice", OTHER);
    provider.owners.set(registrationName("alice").node, ACCOUNT);
    provider.seed("bob", ACCOUNT);
    provider.owners.set(registrationName("bob").node, OTHER);
    provider.seed("carol", ACCOUNT);
    const names = await listOwnedNames(ACCOUNT, options, ["Alice.QRL", "bob", "café"]);
    expect(names).toHaveLength(2);
    expect(names).toContainEqual({
      name: "alice.qrl",
      node: registrationName("alice").node,
      labelHash: registrationName("alice").labelHash,
    });
    expect(names).toContainEqual({
      name: null,
      node: registrationName("carol").node,
      labelHash: registrationName("carol").labelHash,
    });
    const request = provider.calls.find((entry) => entry.method === "qrl_getLogs");
    expect(request?.params).toEqual([
      expect.objectContaining({
        fromBlock: "0xa",
        toBlock: "0x20",
        topics: [
          expect.stringMatching(/^0x[0-9a-f]{128}$/),
          expect.stringMatching(/^0x[0-9a-f]{128}$/),
        ],
      }),
    ]);
  });
  it("throws on truncated native log topics", async () => {
    const { provider, options } = setup();
    provider.logs = [{ address: config.contracts.QNSRegistry, topics: ["0x", "0x", "0x"] }];
    await expect(listOwnedNames(ACCOUNT, options)).rejects.toThrow("topics");
  });
});
