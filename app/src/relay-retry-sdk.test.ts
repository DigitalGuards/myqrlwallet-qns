import { ConnectionManager, ConnectionStatus, SocketClient } from "@qrlwallet/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ACCOUNT, config } from "../../sdk/src/__tests__/mockProvider";
import { createRelay, type Relay, WalletController } from "./wallet";

const storageKey = `qns:wallet:${config.chainId}:${config.contracts.QNSRegistry ?? "pending"}`;
const sessionKey = `${storageKey}:session`;

function storedSession() {
  return JSON.stringify({
    version: 5,
    channelId: "11111111-1111-4111-8111-111111111111",
    keyExchange: {
      protocolVersion: 3,
      cid: "ERERERERQRGBEREREREREQ==",
      kAeadRaw: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      htx: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      sendDir: "AAAAAQ==",
      recvDir: "AAAAAg==",
      sendSeq: 4,
      recvSeq: 7,
    },
    dappMetadata: { name: "QNS test fixture", url: "https://example.invalid" },
    connectedAccounts: [ACCOUNT],
    chainId: `0x${config.chainId.toString(16)}`,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("navigator", {
    locks: {
      request: async <T>(
        name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => T | PromiseLike<T>,
      ) => await callback({ name, mode: "exclusive" }),
    },
  });
  vi.spyOn(SocketClient.prototype, "connect").mockImplementation(() => {});
  vi.spyOn(SocketClient.prototype, "joinChannel").mockResolvedValue({
    bufferedMessages: [],
    channelPublicKey: null,
    participants: ["wallet"],
    terminated: false,
  });
  vi.spyOn(ConnectionManager.prototype, "getStatus").mockReturnValue(ConnectionStatus.CONNECTED);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("retries actual SDK retirement after failure and clears the stored session", async () => {
  localStorage.setItem(storageKey, "relay");
  localStorage.setItem(sessionKey, storedSession());
  let relay: Relay | undefined;
  const controller = new WalletController(config, (options) => {
    relay = createRelay({ ...options, autoReconnect: false });
    return relay;
  });
  const closeChannel = vi
    .spyOn(SocketClient.prototype, "closeChannel")
    .mockResolvedValueOnce(false)
    .mockResolvedValue(true);
  const stop = controller.start();
  try {
    expect(controller.getSnapshot().account).toBe(ACCOUNT);
    await controller.disconnect();
    expect(controller.getSnapshot()).toMatchObject({
      account: ACCOUNT,
      transport: "relay",
      busy: false,
      error: "Unable to retire the relay channel",
    });
    expect(localStorage.getItem(storageKey)).toBe("relay");
    expect(localStorage.getItem(sessionKey)).not.toBeNull();
    expect(relay?.hasStoredSession()).toBe(true);
    await controller.disconnect();
    expect(closeChannel).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(sessionKey)).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({
      account: null,
      transport: null,
      status: "Disconnected",
      busy: false,
    });
  } finally {
    stop();
    await relay?.disconnect();
  }
});

it("preserves cancellable QR pairing after actual SDK retirement fails", async () => {
  vi.spyOn(ConnectionManager.prototype, "getStatus").mockReturnValue(ConnectionStatus.WAITING);
  let relay: Relay | undefined;
  const controller = new WalletController(config, (options) => {
    relay = createRelay({ ...options, autoReconnect: false });
    return relay;
  });
  const closeChannel = vi
    .spyOn(SocketClient.prototype, "closeChannel")
    .mockResolvedValueOnce(false)
    .mockResolvedValue(true);
  const stop = controller.start();
  try {
    await controller.pair();
    const uri = controller.getSnapshot().uri;
    expect(uri).toMatch(/^qrlconnect:/);
    await controller.disconnect();
    expect(controller.getSnapshot()).toMatchObject({
      uri,
      busy: false,
      error: "Unable to retire the relay channel",
    });
    expect(localStorage.getItem(storageKey)).toBe("relay");
    await controller.disconnect();
    expect(closeChannel).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().uri).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
  } finally {
    stop();
    await relay?.disconnect();
  }
});
