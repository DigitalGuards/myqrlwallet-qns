import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCurrentQrlAddress, qip55AddressFromBytes } from "@qrlwallet/connect";
import { ACCOUNT, config, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { deferred, TestExtension } from "./__tests__/mockExtension";
import { TestWallet } from "./__tests__/mockWallet";
import { extensionAnnouncement, WalletController } from "./wallet";

const walletId = "com.qrlwallet.extension";
const storageKey = `qns:wallet:${config.chainId}:${config.contracts.QNSRegistry ?? "pending"}`;
const lockedStatus = "Wallet locked. Unlock the extension, or press Disconnect.";
const stops: (() => void)[] = [];

function announcement(provider: TestExtension, id = walletId) {
  return { info: { rdns: id, uuid: id, name: "Wallet" }, provider };
}
function choice(provider: TestExtension, id = walletId) {
  const value = extensionAnnouncement(announcement(provider, id));
  if (!value) throw new Error("Missing extension choice");
  return value;
}
function setup(connected = false) {
  const provider = new TestExtension();
  provider.locked = !connected;
  provider.granted = connected;
  const relay = new TestWallet();
  const controller = new WalletController(config, () => relay);
  stops.push(controller.start());
  return { provider, relay, controller, wallet: choice(provider) };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe("extension wallet lifecycle", () => {
  it("subscribes before the first locked Connect and shares approval across clicks", async () => {
    const { controller, provider, wallet } = setup();
    const request = controller.connectExtension(wallet);
    const repeated = controller.connectExtension(wallet);
    await Promise.resolve();
    expect(provider.subscriptionsAtRequest).toEqual([[1, 1, 1]]);
    expect(controller.getSnapshot()).toMatchObject({
      account: null,
      provider: wallet.provider,
      transport: "extension",
      busy: true,
      status: "Unlock and approve in MyQRLWallet Extension",
    });
    expect(localStorage.getItem(storageKey)).toBe(walletId);
    provider.unlock();
    provider.approve();
    provider.emit("accountsChanged", [OTHER]);
    expect(controller.getSnapshot().account).toBeNull();
    await Promise.all([request, repeated]);
    expect(controller.getSnapshot()).toMatchObject({
      account: OTHER,
      status: "Connected",
      busy: false,
    });
    expect(provider.calls.map((call) => call.method)).toEqual(["qrl_requestAccounts"]);
  });

  it("restores a remembered locked extension and recovers on unlock", async () => {
    localStorage.setItem(storageKey, walletId);
    const { controller, provider } = setup();
    provider.granted = true;
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: announcement(provider) }),
    );
    await vi.waitFor(() => {
      expect(controller.getSnapshot()).toMatchObject({
        account: null,
        transport: "extension",
        status: lockedStatus,
      });
    });
    expect(localStorage.getItem(storageKey)).toBe(walletId);
    expect(provider.listenerCounts()).toEqual([1, 1, 1]);
    provider.unlock();
    expect(controller.getSnapshot().account).toBe(ACCOUNT);
    expect(provider.calls.map((call) => call.method)).toEqual(["qrl_accounts"]);
  });

  it("keeps the session and remembered wallet on lock and recovers without Connect", async () => {
    const { controller, provider, wallet } = setup(true);
    await controller.connectExtension(wallet);
    const revision = controller.getSnapshot().revision;
    provider.lock();
    expect(controller.getSnapshot()).toMatchObject({
      account: null,
      provider: wallet.provider,
      transport: "extension",
      status: lockedStatus,
    });
    expect(controller.getSnapshot().revision).toBeGreaterThan(revision);
    expect(provider.listenerCounts()).toEqual([1, 1, 1]);
    expect(localStorage.getItem(storageKey)).toBe(walletId);
    provider.unlock();
    expect(controller.getSnapshot()).toMatchObject({ account: ACCOUNT, status: "Connected" });
    expect(provider.calls.map((call) => call.method)).toEqual([
      "qrl_requestAccounts",
      "qrl_accounts",
    ]);
  });

  it.each([false, true])(
    "page Disconnect revokes and forgets the extension (locked=%s)",
    async (locked) => {
      const { controller, provider, wallet } = setup(true);
      await controller.connectExtension(wallet);
      if (locked) provider.lock();
      await controller.disconnect();
      expect(provider.calls.at(-1)).toEqual({
        method: "wallet_revokePermissions",
        params: [{ qrl_accounts: {} }],
      });
      expect(provider.granted).toBe(false);
      expect(localStorage.getItem(storageKey)).toBeNull();
      expect(provider.listenerCounts()).toEqual([0, 0, 0]);
      expect(controller.getSnapshot()).toMatchObject({
        account: null,
        provider: null,
        transport: null,
        status: "Disconnected",
        busy: false,
      });
      provider.unlock();
      expect(controller.getSnapshot().account).toBeNull();
    },
  );

  it("stays Disconnected after late approval and reuses its grant on the next Connect", async () => {
    const { controller, provider, wallet } = setup();
    const request = controller.connectExtension(wallet);
    const settled = vi.fn();
    void request.then(settled);
    await Promise.resolve();
    const captured = [...(provider.listeners.get("accountsChanged") ?? [])];
    await controller.disconnect();
    expect(controller.getSnapshot()).toMatchObject({
      account: null,
      busy: false,
      status: "Disconnected",
    });
    expect(provider.calls.at(-1)?.method).toBe("wallet_revokePermissions");
    await vi.waitFor(() => {
      expect(settled).toHaveBeenCalledOnce();
    });
    expect(provider.granted).toBe(false);
    const snapshot = controller.getSnapshot();
    provider.unlock();
    provider.approve();
    for (const listener of captured) listener([OTHER]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(provider.granted).toBe(true);
    expect(provider.calls.map((call) => call.method)).toEqual([
      "qrl_requestAccounts",
      "wallet_revokePermissions",
    ]);
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(provider.listenerCounts()).toEqual([0, 0, 0]);
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(provider.approvals).toHaveLength(1);

    await controller.connectExtension(wallet);
    expect(controller.getSnapshot()).toMatchObject({
      account: ACCOUNT,
      status: "Connected",
      busy: false,
    });
    expect(provider.granted).toBe(true);
    expect(provider.approvals).toHaveLength(1);
    expect(provider.calls.map((call) => call.method)).toEqual([
      "qrl_requestAccounts",
      "wallet_revokePermissions",
      "qrl_requestAccounts",
    ]);
    expect(localStorage.getItem(storageKey)).toBe(walletId);
  });

  it("keeps an extension cancelled while the previous relay finishes disconnecting", async () => {
    const { controller, provider, relay, wallet } = setup(true);
    await controller.pair();
    const retirement = deferred<undefined>();
    vi.spyOn(relay, "disconnect").mockReturnValue(retirement.promise);
    const request = controller.connectExtension(wallet);
    await controller.disconnect();
    const snapshot = controller.getSnapshot();
    retirement.resolve(undefined);
    await request;
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(controller.getSnapshot().status).toBe("Disconnected");
    expect(provider.calls.map((call) => call.method)).toEqual(["wallet_revokePermissions"]);
  });

  it("retains a multi-account session until one valid QRL account is selected", async () => {
    const { controller, provider, wallet } = setup(true);
    provider.accounts = [ACCOUNT, OTHER];
    await controller.connectExtension(wallet);
    expect(controller.getSnapshot()).toMatchObject({
      account: null,
      provider: wallet.provider,
      transport: "extension",
      status: "Select one QRL 2.0 account in your wallet",
    });
    expect(localStorage.getItem(storageKey)).toBe(walletId);
    provider.emit("accountsChanged", [OTHER]);
    expect(controller.getSnapshot()).toMatchObject({
      account: OTHER,
      status: "Connected",
      error: null,
    });
    provider.emit("accountsChanged", ["invalid"]);
    expect(controller.getSnapshot()).toMatchObject({
      account: null,
      provider: null,
      status: "Disconnected",
      error: "Wallet returned an invalid account list",
    });
    expect(localStorage.getItem(storageKey)).toBeNull();
    provider.emit("accountsChanged", [ACCOUNT]);
    expect(controller.getSnapshot().account).toBeNull();
    expect(provider.calls).toHaveLength(1);
    provider.accounts = [ACCOUNT];
    await controller.connectExtension(wallet);
    expect(controller.getSnapshot()).toMatchObject({ account: ACCOUNT, error: null });
  });

  it("shows Disconnected and forgets the wallet after extension-side disconnect while unlocked", async () => {
    const { controller, provider, wallet } = setup(true);
    await controller.connectExtension(wallet);
    provider.granted = false;
    provider.emit("accountsChanged", []);
    await vi.waitFor(() => {
      expect(controller.getSnapshot()).toMatchObject({
        account: null,
        provider: null,
        transport: null,
        status: "Disconnected",
        error: null,
        busy: false,
      });
    });
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(provider.listenerCounts()).toEqual([0, 0, 0]);
    expect(provider.calls.map((call) => call.method)).toEqual([
      "qrl_requestAccounts",
      "qrl_accounts",
    ]);

    const request = controller.connectExtension(wallet);
    await Promise.resolve();
    expect(provider.approvals).toHaveLength(1);
    expect(controller.getSnapshot().status).toContain("Unlock and approve");
    provider.approve();
    await request;
    expect(controller.getSnapshot().account).toBe(ACCOUNT);
    expect(provider.listenerCounts()).toEqual([1, 1, 1]);
    expect(provider.calls.map((call) => call.method)).toEqual([
      "qrl_requestAccounts",
      "qrl_accounts",
      "qrl_requestAccounts",
    ]);
  });

  it("stays Disconnected on reload after extension-side disconnect", async () => {
    const { controller, provider, wallet } = setup(true);
    await controller.connectExtension(wallet);
    provider.granted = false;
    provider.emit("accountsChanged", []);
    await vi.waitFor(() => {
      expect(controller.getSnapshot().status).toBe("Disconnected");
    });
    for (const stop of stops.splice(0)) stop();
    const calls = provider.calls.length;
    const reloaded = new WalletController(config);
    stops.push(reloaded.start());
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: announcement(provider) }),
    );
    await Promise.resolve();
    expect(reloaded.getSnapshot()).toMatchObject({
      account: null,
      provider: null,
      transport: null,
      status: "Disconnected",
      error: null,
      busy: false,
    });
    expect(reloaded.getSnapshot().choices).toHaveLength(1);
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(provider.calls).toHaveLength(calls);
    expect(provider.approvals).toHaveLength(0);
  });

  it("quietly forgets stale restore intent when the unlocked wallet returns 4100", async () => {
    localStorage.setItem(storageKey, walletId);
    const { controller, provider } = setup();
    provider.locked = false;
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: announcement(provider) }),
    );
    await vi.waitFor(() => {
      expect(controller.getSnapshot()).toMatchObject({
        account: null,
        provider: null,
        transport: null,
        status: "Disconnected",
        error: null,
        busy: false,
      });
    });
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(provider.listenerCounts()).toEqual([0, 0, 0]);
    expect(provider.calls.map((call) => call.method)).toEqual(["qrl_accounts"]);
  });

  it.each(["connect", "restore", "event"])(
    "checks QIP-55 account checksums on %s",
    async (source) => {
      const { controller, provider, wallet } = setup(true);
      const checksummed = qip55AddressFromBytes(new Uint8Array(64).fill(0xab));
      const badChecksum = checksummed.replace(/[a-f]/giu, (character) =>
        character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase(),
      );
      expect(isCurrentQrlAddress(badChecksum)).toBe(false);
      provider.accounts = [checksummed];
      await controller.connectExtension(wallet);
      expect(controller.getSnapshot()).toMatchObject({
        account: `Q${"ab".repeat(64)}`,
        status: "Connected",
        error: null,
      });
      provider.accounts = [badChecksum];
      if (source === "event") provider.emit("accountsChanged", provider.accounts);
      else await controller.connectExtension(wallet, source === "restore");
      expect(controller.getSnapshot()).toMatchObject({
        account: null,
        provider: null,
        status: "Disconnected",
        error: "Wallet returned an invalid account list",
      });
      expect(localStorage.getItem(storageKey)).toBeNull();
      expect(provider.listenerCounts()).toEqual([0, 0, 0]);
    },
  );

  it("preserves the connection and remembered wallet on recoverable disconnect 1013", async () => {
    const { controller, provider, wallet } = setup(true);
    await controller.connectExtension(wallet);
    const snapshot = controller.getSnapshot();
    provider.emit("disconnect", Object.assign(new Error("Try again later"), { code: 1013 }));
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(localStorage.getItem(storageKey)).toBe(walletId);
    expect(provider.listenerCounts()).toEqual([1, 1, 1]);
    expect(provider.calls.map((call) => call.method)).toEqual(["qrl_requestAccounts"]);
  });

  it.each([false, true])("switches to relay with local disposal (pending=%s)", async (pending) => {
    const { controller, provider, relay, wallet } = setup(!pending);
    const request = controller.connectExtension(wallet);
    if (pending) await Promise.resolve();
    else await request;
    await controller.pair();
    expect(controller.getSnapshot()).toMatchObject({
      account: null,
      uri: relay.uri,
      status: "Waiting for wallet",
      busy: false,
    });
    expect(localStorage.getItem(storageKey)).toBe("relay");
    expect(provider.listenerCounts()).toEqual([0, 0, 0]);
    provider.emit("accountsChanged", [OTHER]);
    provider.approvals[0]?.resolve([OTHER]);
    await request;
    expect(controller.getSnapshot().account).toBeNull();
    expect(provider.calls.map((call) => call.method)).toEqual(["qrl_requestAccounts"]);
    relay.connected = true;
    relay.emit("connect");
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ account: ACCOUNT, transport: "relay" });
  });

  it("switches extensions during approval and ignores old events and replies", async () => {
    const { controller, provider, wallet } = setup();
    const request = controller.connectExtension(wallet);
    await Promise.resolve();
    const other = new TestExtension();
    other.locked = false;
    other.granted = true;
    other.accounts = [OTHER];
    await controller.connectExtension(choice(other, "theqrl.org"));
    expect(controller.getSnapshot().account).toBe(OTHER);
    provider.approve();
    await request;
    expect(controller.getSnapshot().account).toBe(OTHER);
    expect(localStorage.getItem(storageKey)).toBe("theqrl.org");
    expect(provider.listenerCounts()).toEqual([0, 0, 0]);
    expect(provider.calls.map((call) => call.method)).toEqual(["qrl_requestAccounts"]);
  });

  it.each([-32601, 4200, 4001])("cleans up and reports revocation error %s", async (code) => {
    const { controller, provider, wallet } = setup(true);
    await controller.connectExtension(wallet);
    provider.revokeError = Object.assign(new Error("Wallet failure"), { code });
    await controller.disconnect();
    expect(controller.getSnapshot()).toMatchObject({
      account: null,
      provider: null,
      transport: null,
      status: "Disconnected",
      busy: false,
      error:
        code === -32601 ? null : "Disconnected on this page. The wallet reported: Wallet failure",
    });
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(provider.listenerCounts()).toEqual([0, 0, 0]);
  });

  it("waits for revocation before reconnecting to the same extension", async () => {
    const { controller, provider, wallet } = setup(true);
    await controller.connectExtension(wallet);
    provider.revocation = deferred<unknown>();
    const disconnect = controller.disconnect();
    const reconnect = controller.connectExtension(wallet);
    await Promise.resolve();
    expect(controller.getSnapshot().account).toBeNull();
    expect(provider.calls.map((call) => call.method)).toEqual([
      "qrl_requestAccounts",
      "wallet_revokePermissions",
    ]);
    provider.revocation.resolve(null);
    await disconnect;
    await Promise.resolve();
    provider.approve();
    await reconnect;
    expect(controller.getSnapshot()).toMatchObject({ account: ACCOUNT, status: "Connected" });
    expect(provider.granted).toBe(true);
    expect(localStorage.getItem(storageKey)).toBe(walletId);
  });

  it("handles early chain changes and provider disconnect without revocation", async () => {
    const { controller, provider, wallet } = setup();
    const request = controller.connectExtension(wallet);
    await Promise.resolve();
    const revision = controller.getSnapshot().revision;
    provider.emit("chainChanged", "0x2");
    expect(controller.getSnapshot().revision).toBeGreaterThan(revision);
    provider.emit("disconnect", Object.assign(new Error("Provider offline"), { code: 4900 }));
    expect(controller.getSnapshot()).toMatchObject({
      account: null,
      provider: null,
      transport: null,
      busy: false,
      error: "Provider offline",
    });
    provider.approve();
    await request;
    expect(controller.getSnapshot().account).toBeNull();
    expect(provider.calls.map((call) => call.method)).toEqual(["qrl_requestAccounts"]);
  });

  it("disposes on page teardown without revocation or forgetting restore intent", async () => {
    const { controller, provider, wallet } = setup(true);
    await controller.connectExtension(wallet);
    for (const stop of stops.splice(0)) stop();
    const snapshot = controller.getSnapshot();
    provider.lock();
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(provider.listenerCounts()).toEqual([0, 0, 0]);
    expect(provider.calls.map((call) => call.method)).toEqual(["qrl_requestAccounts"]);
    expect(localStorage.getItem(storageKey)).toBe(walletId);
  });
});
