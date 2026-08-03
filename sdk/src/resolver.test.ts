import { describe, expect, it } from "vitest";
import { getResolver, type RpcProvider } from "./resolver.js";

const REGISTRY = "Q1111111111111111111111111111111111111111";
const RESOLVER_HEX = "2222222222222222222222222222222222222222";

describe("QNS resolver provider compatibility", () => {
  it("uses qrl_call for resolver reads", async () => {
    const requests: Array<{ method: string; params?: unknown[] }> = [];
    const provider: RpcProvider = {
      async request(args) {
        requests.push(args);
        if (args.method.startsWith("eth_")) {
          throw new Error("wallet providers reject Ethereum RPC aliases");
        }
        if (args.method !== "qrl_call") {
          throw new Error(`unexpected RPC method: ${args.method}`);
        }
        return `0x${"0".repeat(24)}${RESOLVER_HEX}`;
      },
    };

    await expect(getResolver("alice.qrl", { registry: REGISTRY, provider })).resolves.toBe(
      `0x${RESOLVER_HEX}`,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      method: "qrl_call",
      params: [
        {
          to: REGISTRY,
          data: expect.stringMatching(/^0x[0-9a-f]{72}$/),
        },
        "latest",
      ],
    });
  });

  it("identifies malformed qrl_call responses", async () => {
    const provider: RpcProvider = {
      async request() {
        return null;
      },
    };

    await expect(getResolver("alice.qrl", { registry: REGISTRY, provider })).rejects.toThrow(
      "unexpected qrl_call result",
    );
  });
});
