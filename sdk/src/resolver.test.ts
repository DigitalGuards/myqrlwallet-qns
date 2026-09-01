import { describe, expect, it } from "vitest";
import {
  getResolver,
  lookupAddress,
  resolveName,
  verifyReverse,
  type RpcProvider,
} from "./resolver.js";

const REGISTRY = `Q${"1".repeat(128)}`;
const RESOLVER_HEX = "2".repeat(128);
const ACCOUNT = `Q${"a".repeat(128)}`;

function word(value: number): string {
  return value.toString(16).padStart(128, "0");
}

function encodedString(value: string): string {
  const body = Buffer.from(value, "utf8").toString("hex");
  return `0x${word(64)}${word(Buffer.byteLength(value))}${body.padEnd(128, "0")}`;
}

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
        return `0x${RESOLVER_HEX}`;
      },
    };

    await expect(getResolver("alice.qrl", { registry: REGISTRY, provider })).resolves.toBe(
      `Q${RESOLVER_HEX}`,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      method: "qrl_call",
      params: [
        {
          to: REGISTRY,
          data: expect.stringMatching(/^0x[0-9a-f]{136}$/),
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

  it("rejects non-hex and odd-length qrl_call responses", async () => {
    for (const response of ["0xgg", "0x0", "0x12zz"]) {
      const provider: RpcProvider = {
        async request() {
          return response;
        },
      };
      await expect(
        getResolver("alice.qrl", { registry: REGISTRY, provider }),
      ).rejects.toThrow("unexpected qrl_call result");
    }
  });

  it("rejects short and oversized ABI address words", async () => {
    for (const response of [`0x${"1".repeat(126)}`, `0x${"1".repeat(130)}`]) {
      const provider: RpcProvider = {
        async request() {
          return response;
        },
      };
      await expect(
        getResolver("alice.qrl", { registry: REGISTRY, provider }),
      ).rejects.toThrow("invalid ABI address return length");
    }
  });

  it("resolves a native 64-byte address from 64-byte ABI words", async () => {
    let call = 0;
    const provider: RpcProvider = {
      async request() {
        call += 1;
        return call === 1 ? `0x${RESOLVER_HEX}` : `0x${ACCOUNT.slice(1)}`;
      },
    };

    await expect(resolveName("alice.qrl", { registry: REGISTRY, provider })).resolves.toBe(
      ACCOUNT,
    );
  });

  it("decodes reverse names and forward-confirms the native address", async () => {
    let call = 0;
    const provider: RpcProvider = {
      async request() {
        call += 1;
        if (call === 1 || call === 3) return `0x${RESOLVER_HEX}`;
        if (call === 2) return encodedString("alice.qrl");
        return `0x${ACCOUNT.slice(1)}`;
      },
    };
    const config = { registry: REGISTRY, provider };

    await expect(verifyReverse(ACCOUNT, config)).resolves.toBe("alice.qrl");
  });

  it("rejects legacy-width reverse addresses", async () => {
    const provider: RpcProvider = { async request() { return "0x"; } };
    await expect(
      lookupAddress(`Q${"a".repeat(40)}`, { registry: REGISTRY, provider }),
    ).rejects.toThrow("expected 64-byte address hex");
  });
});
