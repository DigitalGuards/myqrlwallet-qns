import { expect, it } from "vitest";
import { ACCOUNT, OTHER, config, MockChain } from "./__tests__/mockProvider.js";
import { isRecord, selector } from "./abi.js";
import { listOwnedNames } from "./owned.js";
import { registrationName } from "./registration.js";
import { reverseNodeFor } from "./resolver.js";

const signatures = ["owner(bytes32)", "resolver(bytes32)", "addr(bytes32)", "name(bytes32)"];
const messages = ["execution timeout", "RPC request failed: missing trie node"];
it.each(
  signatures.flatMap((signature) =>
    messages.flatMap((message) =>
      [false, true].map((primary) => ({ signature, message, primary })),
    ),
  ),
)(
  "isolates $signature failure ($message, primary=$primary) and retries",
  async ({ signature, message, primary }) => {
    const bob = registrationName("bob");
    const alice = registrationName("alice");
    class PerNameFailure extends MockChain {
      failing = true;
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        const call = args.params?.[0];
        if (
          this.failing &&
          args.method === "qrl_call" &&
          isRecord(call) &&
          typeof call.data === "string" &&
          call.data.startsWith(selector(signature)) &&
          call.data.slice(10, 74) === bob.node.slice(2)
        )
          return Promise.reject(new Error(message));
        return super.request(args);
      }
    }
    const chain = new PerNameFailure();
    // Read the failing candidate first so a rejection must leave later names available.
    for (const name of [bob, alice]) {
      chain.seed(name.name, ACCOUNT);
      chain.resolvers.set(
        name.node,
        name === bob ? OTHER : (config.contracts.QRLPublicResolver ?? ""),
      );
      chain.addresses.set(name.node, ACCOUNT);
      chain.spellings.set(name.node, name.name);
    }
    if (primary) {
      chain.primary = bob.name;
      chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    }
    const context = { config, provider: chain };
    const names = await listOwnedNames(ACCOUNT, context, [bob.name]);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatchObject({
      name: alice.name,
      primary: false,
      records: { resolverStatus: "usable", address: ACCOUNT, spelling: alice.name },
    });
    expect(names[1]).toMatchObject({
      name: bob.name,
      records: null,
      primary: null,
      error: `Could not ${signature === "owner(bytes32)" ? "verify ownership" : "read name records"}: ${message}`,
    });
    chain.failing = false;
    expect((await listOwnedNames(ACCOUNT, context, [bob.name]))[1]).toMatchObject({
      name: bob.name,
      primary,
      records: { resolverStatus: "usable", address: ACCOUNT },
    });
    expect(chain.sent).toHaveLength(0);
    for (const request of chain.calls.filter((request) => request.method === "qrl_call"))
      expect(request.params?.[1]).toBe("0x20");
  },
);

it("keeps an unnamed failed record visible by hash and discovers its spelling on retry", async () => {
  const bob = registrationName("bob");
  class FailedRecord extends MockChain {
    failing = true;
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      const call = args.params?.[0];
      if (this.failing && args.method === "qrl_call" && isRecord(call) && call.to === OTHER)
        return Promise.reject(new Error("execution timeout"));
      return super.request(args);
    }
  }
  const chain = new FailedRecord();
  chain.seed(bob.name, ACCOUNT);
  chain.resolvers.set(bob.node, OTHER);
  chain.spellings.set(bob.node, bob.name);
  expect(await listOwnedNames(ACCOUNT, { config, provider: chain })).toMatchObject([
    {
      name: null,
      node: bob.node,
      records: null,
      error: "Could not read name records: execution timeout",
    },
  ]);
  chain.failing = false;
  expect((await listOwnedNames(ACCOUNT, { config, provider: chain }))[0]?.name).toBe(bob.name);
});

it("propagates cancellation during a per-name read", async () => {
  const abort = new AbortController();
  class CancelledRecord extends MockChain {
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      const call = args.params?.[0];
      if (args.method === "qrl_call" && isRecord(call) && call.to === OTHER) {
        abort.abort();
        return Promise.reject(new Error("request aborted"));
      }
      return super.request(args);
    }
  }
  const chain = new CancelledRecord();
  chain.seed("alice", ACCOUNT);
  chain.resolvers.set(registrationName("alice").node, OTHER);
  await expect(
    listOwnedNames(ACCOUNT, { config, provider: chain }, [], abort.signal),
  ).rejects.toThrow("aborted");
});
