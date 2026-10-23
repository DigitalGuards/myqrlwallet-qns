import { ReadFailureChain, readFailures } from "./__tests__/readFailures.js";
import { listOwnedNames } from "./owned.js";
import { registerName } from "./registration.js";
import { expect, it } from "vitest";
import { ACCOUNT, config, MockChain } from "./__tests__/mockProvider.js";
import { isRecord, selector } from "./abi.js";
import { readRegistrationState, registrationName } from "./registration.js";
import { reverseNodeFor } from "./resolver.js";
it("surfaces an RPC failure while reading the primary state", async () => {
  class SnapshotFailure extends MockChain {
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      const call = args.params?.[0];
      if (
        args.method === "qrl_call" &&
        args.params?.[1] !== "latest" &&
        isRecord(call) &&
        typeof call.data === "string" &&
        call.data.startsWith(selector("resolver(bytes32)")) &&
        call.data.slice(10, 74) === reverseNodeFor(ACCOUNT).slice(2)
      )
        return Promise.reject(new Error("RPC request failed: missing trie node"));
      return super.request(args);
    }
  }
  const chain = new SnapshotFailure();
  const alice = registrationName("alice");
  chain.seed(alice.name, ACCOUNT);
  chain.resolvers.set(alice.node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(alice.node, ACCOUNT);
  chain.spellings.set(alice.node, alice.name);
  chain.primary = alice.name;
  chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
  await expect(
    readRegistrationState(alice.name, ACCOUNT, { config, provider: chain }),
  ).rejects.toThrow("RPC request failed");
});

it.each(readFailures)("propagates a failed %s read and permits a clean retry", async (failure) => {
  const chain = new ReadFailureChain(failure);
  const context = { config, provider: chain };
  await expect(readRegistrationState("alice", ACCOUNT, context)).rejects.toThrow(chain.message);
  if (failure.startsWith("reverse"))
    await expect(listOwnedNames(ACCOUNT, context)).rejects.toThrow(chain.message);
  else if (!failure.startsWith("destination") && !failure.startsWith("old primary")) {
    const entries = await listOwnedNames(ACCOUNT, context);
    expect(entries).toMatchObject([{ records: null, primary: null }]);
    expect(entries[0]?.error).toContain(chain.message);
  } else expect(await listOwnedNames(ACCOUNT, context)).toHaveLength(1);
  await expect(
    registerName("alice", {
      ...context,
      wallet: chain,
      account: ACCOUNT,
      transport: "extension",
      primary: true,
      onUpdate: () => {
        // This test checks the propagated read failure and absence of transactions.
      },
    }),
  ).rejects.toThrow(chain.message);
  expect(chain.sent).toHaveLength(0);
  chain.failing = false;
  expect((await readRegistrationState("alice", ACCOUNT, context)).owner).toBe(ACCOUNT);
  expect(await listOwnedNames(ACCOUNT, context)).toHaveLength(1);
});

it.each(["execution reverted: reverse resolver", "RPC failure", "RPC failure: execution reverted"])(
  "preserves reverse record errors: %s",
  async (message) => {
    class BrokenReverse extends MockChain {
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        const call = args.params?.[0];
        if (
          args.method === "qrl_call" &&
          isRecord(call) &&
          typeof call.data === "string" &&
          call.data.startsWith(selector("name(bytes32)")) &&
          call.data.slice(10, 74) === reverseNodeFor(ACCOUNT).slice(2)
        )
          return Promise.reject(new Error(message));
        return super.request(args);
      }
    }
    const chain = new BrokenReverse();
    chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    await expect(
      readRegistrationState("alice", ACCOUNT, { config, provider: chain }),
    ).rejects.toThrow(message);
    await expect(listOwnedNames(ACCOUNT, { config, provider: chain })).rejects.toThrow(message);
  },
);
