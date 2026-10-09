import { describe, expect, it, vi } from "vitest";
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
const ALICE_NODE = "efe3586aa9a851831a32d38044822af21cc5380e38f05cdc0dd562b4cfada103";

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
      request(args) {
        requests.push(args);
        if (args.method.startsWith("eth_")) {
          return Promise.reject(new Error("wallet providers reject Ethereum RPC aliases"));
        }
        if (args.method !== "qrl_call") {
          return Promise.reject(new Error(`unexpected RPC method: ${args.method}`));
        }
        return Promise.resolve(`0x${RESOLVER_HEX}`);
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
          data: `0x0178b8bf${ALICE_NODE}${"0".repeat(64)}`,
        },
        "latest",
      ],
    });
  });

  it.each([null, undefined, true, 1, 1n, Symbol("response"), {}, [], ["0x"], new Uint8Array(64)])(
    "rejects non-string qrl_call response %s",
    async (response: unknown) => {
      const provider: RpcProvider = {
        request() {
          return Promise.resolve(response);
        },
      };

      await expect(getResolver("alice.qrl", { registry: REGISTRY, provider })).rejects.toThrow(
        TypeError,
      );
    },
  );

  it("rejects malformed provider values without invoking their string conversion", async () => {
    const toString = vi.fn(() => {
      throw new Error("untrusted string conversion");
    });
    const provider: RpcProvider = {
      request() {
        return Promise.resolve({ toString });
      },
    };

    await expect(getResolver("alice.qrl", { registry: REGISTRY, provider })).rejects.toThrow(
      "unexpected qrl_call result",
    );
    expect(toString).not.toHaveBeenCalled();
  });

  it("rejects non-hex and odd-length qrl_call responses", async () => {
    for (const response of [
      "0xgg",
      "0x0",
      "0x12zz",
      "",
      "12",
      "0X12",
      " 0x12",
      "0x12 ",
      `0x${RESOLVER_HEX}\n`,
      `0x${RESOLVER_HEX}\r\n`,
      `0x${RESOLVER_HEX}\u2028`,
    ]) {
      const provider: RpcProvider = {
        request() {
          return Promise.resolve(response);
        },
      };
      await expect(getResolver("alice.qrl", { registry: REGISTRY, provider })).rejects.toThrow(
        "unexpected qrl_call result",
      );
    }
  });

  it("rejects short and oversized ABI address words", async () => {
    for (const response of [`0x${"1".repeat(126)}`, `0x${"1".repeat(130)}`]) {
      const provider: RpcProvider = {
        request() {
          return Promise.resolve(response);
        },
      };
      await expect(getResolver("alice.qrl", { registry: REGISTRY, provider })).rejects.toThrow(
        "invalid ABI address return length",
      );
    }
  });

  it("resolves a native 64-byte address from 64-byte ABI words", async () => {
    const requests: Array<{ method: string; params?: unknown[] }> = [];
    const provider: RpcProvider = {
      request(args) {
        requests.push(args);
        return Promise.resolve(
          requests.length === 1 ? `0x${RESOLVER_HEX}` : `0x${ACCOUNT.slice(1)}`,
        );
      },
    };

    await expect(resolveName("alice.qrl", { registry: REGISTRY, provider })).resolves.toBe(ACCOUNT);
    expect(requests).toEqual([
      {
        method: "qrl_call",
        params: [{ to: REGISTRY, data: `0x0178b8bf${ALICE_NODE}${"0".repeat(64)}` }, "latest"],
      },
      {
        method: "qrl_call",
        params: [
          { to: `Q${RESOLVER_HEX}`, data: `0x3b3b57de${ALICE_NODE}${"0".repeat(64)}` },
          "latest",
        ],
      },
    ]);
  });

  it.each(["0x", `0x${"0".repeat(128)}`])(
    "preserves unset address response %s",
    async (response) => {
      const provider: RpcProvider = { request: () => Promise.resolve(response) };
      await expect(getResolver("alice.qrl", { registry: REGISTRY, provider })).resolves.toBeNull();
    },
  );

  it("preserves uppercase hex in valid address responses", async () => {
    const response = `0x${"AB".repeat(64)}`;
    const provider: RpcProvider = { request: () => Promise.resolve(response) };
    await expect(getResolver("alice.qrl", { registry: REGISTRY, provider })).resolves.toBe(
      `Q${response.slice(2)}`,
    );
  });

  it("decodes reverse names and forward-confirms the native address", async () => {
    let call = 0;
    const provider: RpcProvider = {
      request() {
        call += 1;
        if (call === 1 || call === 3) return Promise.resolve(`0x${RESOLVER_HEX}`);
        if (call === 2) return Promise.resolve(encodedString("alice.qrl"));
        return Promise.resolve(`0x${ACCOUNT.slice(1)}`);
      },
    };
    const config = { registry: REGISTRY, provider };

    await expect(verifyReverse(ACCOUNT, config)).resolves.toBe("alice.qrl");
  });

  it("rejects legacy-width reverse addresses", async () => {
    const provider: RpcProvider = { request: () => Promise.resolve("0x") };
    await expect(
      lookupAddress(`Q${"a".repeat(40)}`, { registry: REGISTRY, provider }),
    ).rejects.toThrow("expected 64-byte address hex");
  });
});
