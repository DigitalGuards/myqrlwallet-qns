import { describe, expect, it, vi } from "vitest";
import {
  ConnectionManager,
  ConnectionStatus,
  QRLConnectProvider,
  isCurrentQrlAddress,
  type JsonRpcRequest,
} from "@qrlwallet/connect";
import { resolveName, type RpcProvider } from "./resolver.js";

describe("Connect v5 QIP-55 composition", () => {
  it("routes complete 64-byte registry and resolver identities through the real provider", async () => {
    const registry = `Q${"11".repeat(64)}`;
    const resolver = `Q${"22".repeat(32)}${"ab".repeat(32)}`;
    const account = `Q${"33".repeat(32)}${"ab".repeat(32)}`;
    const provider = new QRLConnectProvider({
      dappMetadata: { name: "QNS test", url: "https://example.test" },
      chainId: "0x301825",
      autoReconnect: false,
      announceProvider: false,
    });
    const rpcProvider: RpcProvider = provider;
    const manager = (provider as unknown as { connectionManager: ConnectionManager })
      .connectionManager;
    vi.spyOn(manager, "getStatus").mockReturnValue(ConnectionStatus.CONNECTED);
    const requests: JsonRpcRequest[] = [];
    const send = vi.spyOn(manager, "sendJsonRpc").mockImplementation((request) => {
      if (request.id === undefined) throw new Error("expected a JSON-RPC request ID");
      requests.push(request);
      manager.emit("jsonrpc_response", {
        jsonrpc: "2.0",
        id: request.id,
        result: `0x${requests.length === 1 ? resolver.slice(1) : account.slice(1)}`,
      });
      return Promise.resolve();
    });
    try {
      expect(isCurrentQrlAddress(account)).toBe(true);
      expect(isCurrentQrlAddress(`Q${"ab".repeat(20)}`)).toBe(false);
      await expect(resolveName("alice.qrl", { registry, provider: rpcProvider })).resolves.toBe(
        account,
      );
      expect(send).toHaveBeenCalledTimes(2);
      expect(requests.map((request) => request.method)).toEqual(["qrl_call", "qrl_call"]);
      expect(requests.map((request) => (request.params?.[0] as { to: string }).to)).toEqual([
        registry,
        resolver,
      ]);
      for (const request of requests) {
        expect((request.params?.[0] as { data: string }).data).toMatch(/^0x[0-9a-f]{136}$/);
      }
    } finally {
      vi.restoreAllMocks();
      await provider.disconnect();
    }
  });
});
