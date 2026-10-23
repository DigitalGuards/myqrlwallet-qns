import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockChain } from "../../sdk/src/__tests__/mockProvider";
import { ACCOUNT, config, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { TestWallet } from "./__tests__/mockWallet";
import { extensionAnnouncement, WalletController } from "./wallet";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("wallet discovery and sessions", () => {
  it("accepts QRL extension announcements and rejects unrelated or malformed providers", () => {
    expect(
      extensionAnnouncement({
        info: { rdns: "com.qrlwallet.extension", uuid: "id", name: "MyQRLWallet" },
        provider: { request: () => Promise.resolve([]) },
      })?.name,
    ).toBe("MyQRLWallet Extension");
    for (const value of [
      null,
      {},
      {
        info: { rdns: "io.metamask", uuid: "id", name: "Other" },
        provider: {
          request() {
            // The unsupported wallet announcement is rejected before requests can run.
          },
        },
      },
      { info: { rdns: "com.qrlwallet.extension", uuid: "id", name: "Wallet" }, provider: {} },
    ])
      expect(extensionAnnouncement(value)).toBeNull();
  });
  it("discovers once, connects, changes accounts, and handles wallet disconnect", async () => {
    const controller = new WalletController(config);
    const stop = controller.start();
    const extension = new TestWallet();
    const event = new CustomEvent("eip6963:announceProvider", {
      detail: {
        info: { rdns: "com.qrlwallet.extension", uuid: "one", name: "Wallet" },
        provider: {
          request: (args: Parameters<MockChain["request"]>[0]) => extension.request(args),
          on: (event: string, handler: (value?: unknown) => void) =>
            extension.listen(event, handler),
        },
      },
    });
    window.dispatchEvent(event);
    window.dispatchEvent(event);
    expect(controller.getSnapshot().choices).toHaveLength(1);
    const choice = controller.getSnapshot().choices[0];
    if (!choice) throw new Error("Missing wallet choice");
    await controller.connectExtension(choice);
    expect(controller.getSnapshot().account).toBe(ACCOUNT);
    extension.emit("accountsChanged", [OTHER]);
    expect(controller.getSnapshot().account).toBe(OTHER);
    extension.emit("accountsChanged", []);
    expect(controller.getSnapshot().account).toBeNull();
    stop();
  });
  it("pairs, ignores duplicate handshakes, preserves a backgrounded session, and retires it", async () => {
    const relay = new TestWallet();
    const controller = new WalletController(config, () => relay);
    const stop = controller.start();
    await controller.pair();
    expect(controller.getSnapshot().uri).toBe(relay.uri);
    relay.stored = true;
    relay.connected = true;
    relay.emit("connect");
    await Promise.resolve();
    const revision = controller.getSnapshot().revision;
    relay.emit("connect");
    relay.emit("accountsChanged", [ACCOUNT]);
    await Promise.resolve();
    expect(controller.getSnapshot().account).toBe(ACCOUNT);
    expect(controller.getSnapshot().revision).toBe(revision);
    relay.emit("disconnect");
    expect(controller.getSnapshot().account).toBe(ACCOUNT);
    expect(controller.getSnapshot().status).toContain("Wallet away");
    await controller.disconnect();
    expect(relay.disconnected).toBe(1);
    expect(controller.getSnapshot().account).toBeNull();
    stop();
  });
  it("resets pairing and ignores stale relay events after selecting the extension", async () => {
    const relay = new TestWallet();
    const controller = new WalletController(config, () => relay);
    const stop = controller.start();
    await controller.pair();
    await controller.pair(true);
    expect(relay.resets).toBe(1);
    expect(controller.getSnapshot().uri).toBe(relay.uri + "-fresh");
    const extension = new TestWallet();
    extension.accounts = [OTHER];
    await controller.connectExtension({
      id: "com.qrlwallet.extension",
      name: "MyQRLWallet Extension",
      provider: extension,
    });
    relay.emit("accountsChanged", [ACCOUNT]);
    relay.emit("disconnect");
    expect(controller.getSnapshot().account).toBe(OTHER);
    stop();
  });
  it("restores relay authorization and clears a wallet-initiated disconnect", async () => {
    localStorage.setItem(
      `qns:wallet:${config.chainId}:${config.contracts.QNSRegistry ?? ""}`,
      "relay",
    );
    const relay = new TestWallet();
    relay.stored = true;
    relay.connected = true;
    const controller = new WalletController(config, () => relay);
    const stop = controller.start();
    await Promise.resolve();
    expect(controller.getSnapshot().account).toBe(ACCOUNT);
    expect(relay.calls.some((item) => item.method === "qrl_requestAccounts")).toBe(false);
    relay.stored = false;
    relay.emit("disconnect");
    expect(controller.getSnapshot().account).toBeNull();
    stop();
  });
  it("matches the expected late response ID and ignores missing or stale IDs", async () => {
    const relay = new TestWallet();
    const controller = new WalletController(config, () => relay);
    const stop = controller.start();
    await controller.pair();
    const hash = `0x${"1".repeat(64)}`;
    controller.expectLateResponse("previous-page");
    relay.emit("late_response", {
      id: "older-request",
      method: "qrl_sendTransaction",
      result: hash,
    });
    expect(controller.getSnapshot().lateTransaction).toBeNull();
    relay.emit("late_response", {
      id: "previous-page",
      method: "qrl_sendTransaction",
      result: hash,
    });
    expect(controller.getSnapshot().lateTransaction).toEqual({
      id: "previous-page",
      hash,
      rejected: false,
    });
    controller.clearLateTransaction();
    expect(controller.getSnapshot().lateTransaction).toBeNull();
    relay.emit("late_response", { method: "qrl_sendTransaction", error: { code: 4001 } });
    expect(controller.getSnapshot().lateTransaction).toBeNull();
    stop();
  });
});
