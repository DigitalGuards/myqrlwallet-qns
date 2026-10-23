import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionManager,
  ConnectionStatus,
  QRLConnectProvider,
  type JsonRpcRequest,
} from "@qrlwallet/connect";
import { version } from "@qrlwallet/connect/package.json";
import {
  registerName,
  registrationTransaction,
  type RegistrationStep,
  type TransactionUpdate,
} from "@qns/sdk";
import { ACCOUNT, config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import { WalletController } from "./wallet";
import { TestWallet } from "./__tests__/mockWallet";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const steps: RegistrationStep[] = ["register", "resolver", "address", "name", "primary"];

function connectedRelay(chain: MockChain) {
  const wallet = new QRLConnectProvider({
    dappMetadata: { name: "QNS transaction test", url: "https://example.test" },
    chainId: "0x301824",
    autoReconnect: false,
    announceProvider: false,
  });
  const manager: unknown = Reflect.get(wallet, "connectionManager");
  if (!(manager instanceof ConnectionManager)) throw new Error("Missing connection manager");
  vi.spyOn(manager, "getAccounts").mockReturnValue([ACCOUNT]);
  vi.spyOn(manager, "getStatus").mockReturnValue(ConnectionStatus.CONNECTED);
  const requests: JsonRpcRequest[] = [];
  vi.spyOn(manager, "sendJsonRpc").mockImplementation(async (request) => {
    const { id, method, params } = request;
    if (id === undefined) throw new Error("Missing JSON-RPC request ID");
    requests.push(request);
    const result = await chain.request({ method, ...(params !== undefined ? { params } : {}) });
    manager.emit("jsonrpc_response", { jsonrpc: "2.0", id, result });
  });
  return { wallet, requests };
}

describe("Connect 5.0.2 transaction validation", () => {
  it("accepts every registration step through the installed provider", async () => {
    expect(version).toBe("5.0.2");
    const chain = new MockChain();
    chain.confirmedNonce = 7n;
    const { wallet, requests } = connectedRelay(chain);
    const updates: TransactionUpdate[] = [];
    try {
      await expect(
        registerName("alice", {
          config,
          provider: chain,
          wallet,
          account: ACCOUNT,
          transport: "relay",
          primary: true,
          onUpdate: (update) => updates.push(update),
        }),
      ).resolves.toBe("alice.qrl");
      const writes = requests.filter((request) => request.method === "qrl_sendTransaction");
      expect(writes).toHaveLength(5);
      for (const [index, request] of writes.entries()) {
        const step = steps[index];
        if (!step) throw new Error("Unexpected registration step");
        const { to, data } = registrationTransaction("alice", ACCOUNT, step, config);
        expect(request.params).toEqual([
          {
            from: ACCOUNT,
            to,
            data,
            chainId: "0x301824",
            value: "0x0",
            gas: "0x1d4c0",
          },
        ]);
      }
      expect(
        updates.filter((update) => update.status === "confirmed").map((update) => update.nonce),
      ).toEqual(["0x7", "0x8", "0x9", "0xa", "0xb"]);
    } finally {
      await wallet.disconnect();
    }
  });
  it.each(["nonce", "gasLimit", "type"])(
    "rejects unsupported %s before the transport",
    async (field) => {
      const { wallet, requests } = connectedRelay(new MockChain());
      try {
        await expect(
          wallet.request({
            method: "qrl_sendTransaction",
            params: [
              { ...registrationTransaction("alice", ACCOUNT, "register", config), [field]: "0x0" },
            ],
          }),
        ).rejects.toThrow(`transaction field is not supported: ${field}`);
        expect(requests).toHaveLength(0);
      } finally {
        await wallet.disconnect();
      }
    },
  );
});

it("uses the supported extension transaction fields through EIP-6963 discovery", async () => {
  const chain = new TestWallet();
  const controller = new WalletController(config);
  const stop = controller.start();
  try {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: {
            rdns: "com.qrlwallet.extension",
            uuid: "qns-extension-test",
            name: "MyQRLWallet Extension",
          },
          provider: chain,
        },
      }),
    );
    const choice = controller.getSnapshot().choices[0];
    if (!choice) throw new Error("Extension was not discovered");
    await controller.connectExtension(choice);
    const wallet = controller.getSnapshot().provider;
    if (!wallet) throw new Error("Extension was not connected");
    await registerName("alice", {
      config,
      provider: chain,
      wallet,
      account: ACCOUNT,
      transport: "extension",
      primary: true,
      onUpdate: () => {
        // This test inspects submitted wallet requests; progress needs no action.
      },
    });
    const requests = chain.calls.filter((request) => request.method === "qrl_sendTransaction");
    expect(requests).toHaveLength(5);
    for (const [index, request] of requests.entries()) {
      const step = steps[index];
      if (!step) throw new Error("Unexpected registration step");
      const { to, data } = registrationTransaction("alice", ACCOUNT, step, config);
      expect(request.params).toEqual([
        {
          from: ACCOUNT,
          to,
          data,
          chainId: "0x301824",
          value: "0",
          gas: 120000,
          type: "0x2",
        },
      ]);
    }
  } finally {
    stop();
    await controller.disconnect();
  }
});
