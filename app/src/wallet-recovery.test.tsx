import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ACCOUNT, config, MockChain, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { deferred, TestExtension } from "./__tests__/mockExtension";
import { TestWallet } from "./__tests__/mockWallet";
import { App } from "./App";
import { extensionAnnouncement, WalletController } from "./wallet";

const storageKey = `qns:wallet:${config.chainId}:${config.contracts.QNSRegistry ?? "pending"}`;
const timeoutMessage =
  "Disconnected on this page. The wallet did not answer; remove this site in the extension if it still shows as connected.";
const stops: (() => void)[] = [];

function announcement(provider: TestExtension, id = "com.qrlwallet.extension") {
  return { info: { rdns: id, uuid: id, name: "Wallet" }, provider };
}
function choice(provider: TestExtension, id = "com.qrlwallet.extension") {
  const selected = extensionAnnouncement(announcement(provider, id));
  if (!selected) throw new Error("Missing extension choice");
  return selected;
}
function extension(account = ACCOUNT) {
  const provider = new TestExtension();
  provider.locked = false;
  provider.granted = true;
  provider.accounts = [account];
  return provider;
}
function setup() {
  const provider = extension();
  const controller = new WalletController(config, () => new TestWallet());
  stops.push(controller.start());
  return { provider, controller, wallet: choice(provider) };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

it.each([ACCOUNT, OTHER])(
  "Reconnect wallet restores extension accounts and chain (%s)",
  async (account) => {
    const provider = extension();
    provider.chainId = "0x1";
    const controller = new WalletController(config, () => new TestWallet());
    render(<App config={config} provider={new MockChain()} controller={controller} />);
    await act(() => controller.connectExtension(choice(provider)));
    const reconnect = await screen.findByRole("button", { name: "Reconnect wallet" });
    const captured = [...(provider.listeners.get("accountsChanged") ?? [])];
    const revision = controller.getSnapshot().revision;
    const calls = provider.calls.length;
    provider.accounts = [account];
    provider.chainId = `0x${config.chainId.toString(16)}`;
    fireEvent.click(reconnect);
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      provider.calls.filter((call) => call.method === "wallet_revokePermissions"),
    ).toHaveLength(0);
    expect(provider.granted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ account, status: "Connected" });
    expect(controller.getSnapshot().revision).toBeGreaterThan(revision);
    expect(provider.calls.slice(calls).map((call) => call.method)).toContain("qrl_accounts");
    expect(provider.calls.slice(calls).map((call) => call.method)).toContain("qrl_chainId");
    expect(provider.calls.filter((call) => call.method === "qrl_requestAccounts")).toHaveLength(1);
    expect(provider.listenerCounts()).toEqual([1, 1, 1]);
    act(() => {
      for (const listener of captured) listener([account === ACCOUNT ? OTHER : ACCOUNT]);
    });
    expect(controller.getSnapshot().account).toBe(account);
    expect(screen.queryByRole("button", { name: "Reconnect wallet" })).toBeNull();
    expect(localStorage.getItem(storageKey)).toBe("com.qrlwallet.extension");
  },
);

it("Reconnect wallet retains QRL Connect's pairing cleanup", async () => {
  const relay = new TestWallet();
  relay.chainId = "0x1";
  relay.connected = true;
  relay.stored = true;
  const controller = new WalletController(config, () => relay);
  render(<App config={config} provider={new MockChain()} controller={controller} />);
  await act(() => controller.pair());
  fireEvent.click(await screen.findByRole("button", { name: "Reconnect wallet" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(relay.disconnected).toBe(1);
  expect(relay.resets).toBe(0);
  expect(relay.stored).toBe(false);
  expect(controller.getSnapshot()).toMatchObject({ account: null, status: "Disconnected" });
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(
    within(screen.getByRole("banner")).getByRole("button", { name: "Connect wallet" }),
  ).toBeDefined();
});

it("Disconnect clears persisted restore intent synchronously before the wallet answers", async () => {
  const { provider, controller, wallet } = setup();
  await controller.connectExtension(wallet);
  provider.revocation = deferred<unknown>();
  const closing = controller.disconnect();
  expect(controller.getSnapshot().status).toBe("Disconnecting");
  expect(localStorage.getItem(storageKey)).toBeNull();
  provider.revocation.resolve(null);
  await closing;
});

it("reload during an unsupported revocation keeps the cancelled connection closed", async () => {
  const { provider, controller, wallet } = setup();
  await controller.connectExtension(wallet);
  provider.revocation = deferred<unknown>();
  const closing = controller.disconnect();
  await Promise.resolve();
  for (const stop of stops.splice(0)) stop();
  await closing;
  const calls = provider.calls.length;
  const reloaded = new WalletController(config, () => new TestWallet());
  stops.push(reloaded.start());
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", { detail: announcement(provider) }),
  );
  await vi.waitFor(() => {
    expect(reloaded.getSnapshot().busy).toBe(false);
  });
  provider.revocation.reject(Object.assign(new Error("Unsupported method"), { code: -32601 }));
  await Promise.resolve();
  await Promise.resolve();
  expect(reloaded.getSnapshot().account).toBeNull();
  expect(provider.calls).toHaveLength(calls);
  expect(provider.granted).toBe(true);
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it.each(["Connect", "Connect again", "restore", "switch", "rediscovery", "relay"])(
  "%s waits for the provider's revocation before requesting or probing accounts",
  async (action) => {
    const { provider, controller, wallet } = setup();
    await controller.connectExtension(wallet);
    provider.revocation = deferred<unknown>();
    const closing = controller.disconnect();
    if (action === "switch") {
      const second = extension(OTHER);
      await controller.connectExtension(choice(second, "theqrl.org"));
      expect(controller.getSnapshot().account).toBe(OTHER);
      expect(second.calls.map((call) => call.method)).toEqual(["qrl_requestAccounts"]);
    }
    if (action === "relay") await controller.pair();
    const connecting =
      action === "Connect again"
        ? controller.connectExtension()
        : controller.connectExtension(
            action === "rediscovery" ? choice(provider) : wallet,
            action === "restore",
          );
    await vi.waitFor(() => {
      expect(controller.getSnapshot()).toMatchObject({
        account: null,
        busy: true,
        status: "Finishing disconnect in MyQRLWallet Extension",
      });
    });
    expect(provider.calls.map((call) => call.method)).toEqual([
      "qrl_requestAccounts",
      "wallet_revokePermissions",
    ]);
    expect(provider.listenerCounts()).toEqual([0, 0, 0]);
    provider.revocation.resolve(null);
    await closing;
    if (action === "restore") {
      await connecting;
      expect(controller.getSnapshot().account).toBeNull();
      expect(provider.calls.at(-1)?.method).toBe("qrl_accounts");
    } else {
      await vi.waitFor(() => {
        expect(provider.approvals).toHaveLength(1);
      });
      provider.approve();
      await connecting;
      expect(controller.getSnapshot()).toMatchObject({ account: ACCOUNT, status: "Connected" });
      expect(provider.granted).toBe(true);
    }
  },
);

it("both extensions retain their own barriers across repeated switching and rejection", async () => {
  const { provider: first, controller, wallet: firstChoice } = setup();
  const second = extension(OTHER);
  const secondChoice = choice(second, "theqrl.org");
  await controller.connectExtension(firstChoice);
  first.revocation = deferred<unknown>();
  const firstClosing = controller.disconnect();
  await controller.connectExtension(secondChoice);
  second.revocation = deferred<unknown>();
  const secondClosing = controller.disconnect();
  const returningFirst = controller.connectExtension(firstChoice);
  await vi.waitFor(() => {
    expect(controller.getSnapshot().status).toBe("Finishing disconnect in MyQRLWallet Extension");
  });
  first.revocation.reject(Object.assign(new Error("Unsupported method"), { code: -32601 }));
  await Promise.all([firstClosing, returningFirst]);
  expect(controller.getSnapshot().account).toBe(ACCOUNT);
  const returningSecond = controller.connectExtension(secondChoice);
  await vi.waitFor(() => {
    expect(controller.getSnapshot().status).toBe("Finishing disconnect in QRL Web3 Wallet");
  });
  expect(second.calls.map((call) => call.method)).toEqual([
    "qrl_requestAccounts",
    "wallet_revokePermissions",
  ]);
  second.revocation.resolve(null);
  await secondClosing;
  await vi.waitFor(() => {
    expect(second.approvals).toHaveLength(1);
  });
  second.approve();
  await returningSecond;
  expect(controller.getSnapshot()).toMatchObject({ account: OTHER, status: "Connected" });
  expect(localStorage.getItem(storageKey)).toBe("theqrl.org");
});

it("unanswered revocation finishes local Disconnect at ten seconds despite repeated clicks", async () => {
  const provider = extension();
  const controller = new WalletController(config, () => new TestWallet());
  render(<App config={config} provider={new MockChain()} controller={controller} />);
  await act(() => controller.connectExtension(choice(provider)));
  const revocation = deferred<unknown>();
  provider.revocation = revocation;
  vi.useFakeTimers();
  const header = within(screen.getByRole("banner"));
  fireEvent.click(header.getByRole("button", { name: "Disconnect" }));
  await act(() => vi.advanceTimersByTimeAsync(9_999));
  expect(controller.getSnapshot().status).toBe("Disconnecting");
  fireEvent.click(header.getByRole("button", { name: "Disconnect" }));
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(header.getByRole("button", { name: "Connect wallet" }).hasAttribute("disabled")).toBe(
    false,
  );
  expect(screen.getByText(timeoutMessage)).toBeDefined();
  expect(controller.getSnapshot()).toMatchObject({
    account: null,
    provider: null,
    transport: null,
    status: "Disconnected",
    busy: false,
  });
  expect(provider.calls.filter((call) => call.method === "wallet_revokePermissions")).toHaveLength(
    1,
  );
  expect(provider.listenerCounts()).toEqual([0, 0, 0]);
  expect(localStorage.getItem(storageKey)).toBeNull();
  const snapshot = controller.getSnapshot();
  await act(async () => {
    revocation.resolve(null);
    await Promise.resolve();
  });
  expect(controller.getSnapshot()).toBe(snapshot);
});

it.each([false, true])(
  "a timed-out barrier keeps accounts gated until the actual revoke settles (restore=%s)",
  async (restore) => {
    const { provider, controller, wallet } = setup();
    await controller.connectExtension(wallet);
    provider.revocation = deferred<unknown>();
    vi.useFakeTimers();
    const closing = controller.disconnect();
    const closed = vi.fn();
    void closing.then(closed);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closed).toHaveBeenCalledOnce();
    await closing;
    expect(controller.getSnapshot().error).toBe(timeoutMessage);
    const connecting = controller.connectExtension(wallet, restore);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().status).toBe("Finishing disconnect in MyQRLWallet Extension");
    await vi.advanceTimersByTimeAsync(10_000);
    await connecting;
    expect(controller.getSnapshot()).toMatchObject({ account: null, busy: false });
    expect(provider.calls.map((call) => call.method)).toEqual([
      "qrl_requestAccounts",
      "wallet_revokePermissions",
    ]);
    provider.revocation.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    const retry = controller.connectExtension(wallet);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.approvals).toHaveLength(1);
    provider.approve();
    await retry;
    expect(controller.getSnapshot()).toMatchObject({ account: ACCOUNT, status: "Connected" });
  },
);

it("waits for every revocation when a newer request settles before an older request", async () => {
  const { provider, controller, wallet } = setup();
  const secondChoice = choice(extension(OTHER), "theqrl.org");
  await controller.connectExtension(wallet);
  const firstRevoke = deferred<unknown>();
  provider.revocation = firstRevoke;
  const firstClosing = controller.disconnect();
  await controller.connectExtension(secondChoice);
  const cancelled = controller.connectExtension(wallet);
  await vi.waitFor(() => {
    expect(controller.getSnapshot().status).toBe("Finishing disconnect in MyQRLWallet Extension");
  });
  const secondRevoke = deferred<unknown>();
  provider.revocation = secondRevoke;
  const secondClosing = controller.disconnect();
  await controller.connectExtension(secondChoice);
  const connecting = controller.connectExtension(wallet);
  await vi.waitFor(() => {
    expect(
      provider.calls.filter((call) => call.method === "wallet_revokePermissions"),
    ).toHaveLength(2);
  });
  secondRevoke.resolve(null);
  await Promise.all([firstClosing, secondClosing]);
  await Promise.resolve();
  expect(controller.getSnapshot().status).toBe("Finishing disconnect in MyQRLWallet Extension");
  expect(provider.calls.map((call) => call.method)).toEqual([
    "qrl_requestAccounts",
    "wallet_revokePermissions",
    "wallet_revokePermissions",
  ]);
  firstRevoke.resolve(null);
  await vi.waitFor(() => {
    expect(provider.approvals).toHaveLength(1);
  });
  provider.approve();
  await Promise.all([cancelled, connecting]);
  expect(controller.getSnapshot()).toMatchObject({ account: ACCOUNT, status: "Connected" });
  expect(provider.granted).toBe(true);
});
