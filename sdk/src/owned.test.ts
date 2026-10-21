import { describe, expect, it } from "vitest";
import { isRecord, quantity, stringArgument, bytes32Word, hashText } from "./abi.js";
import { parseNetworkConfig } from "./config.js";
import { listOwnedNames } from "./owned.js";
import { registrationName } from "./registration.js";
import { ACCOUNT, config, MockChain } from "./__tests__/mockProvider.js";

const legacy = parseNetworkConfig({ ...config, deploymentBlock: undefined });

describe("deployment block validation", () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, null, "4", true])(
    "rejects an invalid supplied deployment block: %s",
    (deploymentBlock) => {
      expect(() => parseNetworkConfig({ ...config, deploymentBlock })).toThrow("positive integer");
    },
  );
  it.each([1, 4, Number.MAX_SAFE_INTEGER])("accepts block %s", (deploymentBlock) => {
    expect(parseNetworkConfig({ ...config, deploymentBlock }).deploymentBlock).toBe(
      deploymentBlock,
    );
  });
  it("preserves a missing deployment block so callers can disclose incomplete history", () => {
    expect(legacy.deploymentBlock).toBeUndefined();
    expect(parseNetworkConfig(JSON.parse(JSON.stringify(legacy))).deploymentBlock).toBeUndefined();
  });
});

class PagedChain extends MockChain {
  pages: Array<{ address: unknown; from: bigint; to: bigint }> = [];
  attempts = 0;
  head = 4103n;
  limit = 2000n;
  refuseResolverOnly = false;
  message = "qrl_getLogs block range exceeds maximum 127 blocks";
  onRefusal: (() => void) | undefined;
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    if (args.method === "qrl_blockNumber") return Promise.resolve(`0x${this.head.toString(16)}`);
    if (args.method === "qrl_getLogs") {
      this.attempts++;
      const filter = args.params?.[0];
      if (!isRecord(filter)) throw new Error("Missing log filter");
      const from = quantity(filter.fromBlock);
      const to = quantity(filter.toBlock);
      if (from === 0n) throw new Error("from genesis is not allowed; supply a recent fromBlock");
      if (
        to - from + 1n > this.limit &&
        (!this.refuseResolverOnly || filter.address === config.contracts.QRLPublicResolver)
      ) {
        this.onRefusal?.();
        return Promise.reject(Object.assign(new Error(this.message), { code: -32602 }));
      }
      this.pages.push({ address: filter.address, from, to });
      // Only the final page has a registration and published spelling.
      if (to !== this.head) return Promise.resolve([]);
    }
    return super.request(args);
  }
}

describe("owned-name log ranges", () => {
  it.each([
    {
      label: "configured deployment",
      network: config,
      limit: 2000n,
      resolverOnly: false,
      message: "unused",
    },
    {
      label: "legacy fallback",
      network: legacy,
      limit: 2000n,
      resolverOnly: false,
      message: "unused",
    },
    {
      label: "explicit block limit",
      network: config,
      limit: 127n,
      resolverOnly: false,
      message: "qrl_getLogs block range exceeds maximum 127 blocks",
    },
    {
      label: "resolver block limit",
      network: config,
      limit: 127n,
      resolverOnly: true,
      message: "qrl_getLogs block range limit is 127",
    },
    {
      label: "unnamed block limit",
      network: config,
      limit: 127n,
      resolverOnly: false,
      message: "requested block range is too large",
    },
    {
      label: "comma separated limit",
      network: config,
      limit: 1000n,
      resolverOnly: false,
      message: "limited to 1,000 blocks",
    },
  ])(
    "pages $label without gaps and verifies owners at one head",
    async ({ network, limit, resolverOnly, message }) => {
      const chain = new PagedChain();
      chain.limit = limit;
      chain.refuseResolverOnly = resolverOnly;
      chain.message = message;
      chain.seed("alice", ACCOUNT);
      const parsed = registrationName("alice");
      chain.nameLogs = [
        {
          address: config.contracts.QRLPublicResolver,
          topics: [
            `0x${bytes32Word(hashText("NameChanged(bytes32,string)"))}`,
            `0x${bytes32Word(parsed.node)}`,
          ],
          data: `0x${stringArgument(parsed.name)}`,
        },
      ];
      expect(await listOwnedNames(ACCOUNT, { config: network, provider: chain })).toEqual([
        { name: parsed.name, node: parsed.node, labelHash: parsed.labelHash },
      ]);
      for (const address of [config.contracts.QNSRegistry, config.contracts.QRLPublicResolver]) {
        let next = BigInt(network.deploymentBlock ?? 1);
        for (const page of chain.pages.filter((item) => item.address === address)) {
          // A resolver refusal retries the registry page with the smaller range.
          if (
            resolverOnly &&
            address === config.contracts.QNSRegistry &&
            page.to - page.from + 1n > limit
          )
            continue;
          expect(page.from).toBe(next);
          expect(page.to - page.from + 1n).toBeLessThanOrEqual(limit);
          next = page.to + 1n;
        }
        expect(next).toBe(chain.head + 1n);
      }
      expect(
        chain.calls.some(
          (call) =>
            call.method === "qrl_call" && call.params?.[1] === `0x${chain.head.toString(16)}`,
        ),
      ).toBe(true);
      expect(chain.sent).toHaveLength(0);
    },
  );

  it("does not request logs when the head predates deployment", async () => {
    const chain = new PagedChain();
    chain.head = 3n;
    expect(await listOwnedNames(ACCOUNT, { config, provider: chain })).toEqual([]);
    expect(chain.attempts).toBe(0);
  });
  it("stops at a refused single block", async () => {
    const chain = new PagedChain();
    chain.limit = 0n;
    chain.head = 10n;
    await expect(listOwnedNames(ACCOUNT, { config, provider: chain })).rejects.toThrow("maximum");
    expect(chain.attempts).toBe(1);
  });
  it("propagates unrelated errors without retries", async () => {
    const chain = new PagedChain();
    chain.limit = 0n;
    chain.message = "RPC authentication failed";
    await expect(listOwnedNames(ACCOUNT, { config, provider: chain })).rejects.toThrow(
      chain.message,
    );
    expect(chain.attempts).toBe(1);
  });
  it("stops an aborted range retry", async () => {
    const chain = new PagedChain();
    const abort = new AbortController();
    chain.limit = 1n;
    chain.onRefusal = () => {
      abort.abort();
    };
    await expect(
      listOwnedNames(ACCOUNT, { config, provider: chain }, [], abort.signal),
    ).rejects.toThrow("aborted");
    expect(chain.attempts).toBe(1);
  });
  it("rejects block zero even if a caller bypasses configuration parsing", async () => {
    const chain = new PagedChain();
    await expect(
      listOwnedNames(ACCOUNT, { config: { ...config, deploymentBlock: 0 }, provider: chain }),
    ).rejects.toThrow("positive integer");
    expect(chain.attempts).toBe(0);
  });
});
