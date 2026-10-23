import { ConnectionManager } from "@qrlwallet/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ACCOUNT, config, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { deferred, TestExtension } from "./__tests__/mockExtension";
import { TestWallet } from "./__tests__/mockWallet";
import { createRelay, extensionAnnouncement, WalletController } from "./wallet";

const storageKey = `qns:wallet:${config.chainId}:${config.contracts.QNSRegistry ?? "pending"}`;
const stops: (() => void)[] = [];

function extension(account = ACCOUNT, id = "com.qrlwallet.extension") {
  const provider = new TestExtension();
  provider.locked = false;
  provider.granted = true;
  provider.accounts = [account];
  const announcement = { info: { rdns: id, uuid: id, name: id }, provider };
  const choice = extensionAnnouncement(announcement);
  if (!choice) throw new Error("Missing extension choice");
  return { provider, choice, announcement };
}

async function flush() {
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

it.each([false, true])(
  "remembers A immediately when switching A to B to waiting A, then reloads (disconnect=%s)",
  async (disconnect) => {
    const a = extension();
    const b = extension(OTHER, "theqrl.org");
    const controller = new WalletController(config, () => new TestWallet());
    const stop = controller.start();
    stops.push(stop);
    await controller.connectExtension(a.choice);
    const revocation = deferred<unknown>();
    a.provider.revocation = revocation;
    const closing = controller.disconnect();
    await controller.connectExtension(b.choice);
    const returning = controller.connectExtension(a.choice);
    try {
      expect(localStorage.getItem(storageKey)).toBe(a.choice.id);
      expect(controller.getSnapshot()).toMatchObject({
        status: "Finishing disconnect in MyQRLWallet Extension",
        transport: "extension",
        provider: a.choice.provider,
        account: null,
        busy: true,
      });
      if (disconnect) {
        a.provider.revocation = undefined;
        await controller.disconnect();
        expect(localStorage.getItem(storageKey)).toBeNull();
      }
      stop();
      const reloaded = new WalletController(config, () => new TestWallet());
      const stopReloaded = reloaded.start();
      stops.push(stopReloaded);
      // Announce B first to exercise a reload's discovery order.
      for (const candidate of [b, a])
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", { detail: candidate.announcement }),
        );
      await flush();
      expect(reloaded.getSnapshot().account).toBe(disconnect ? null : ACCOUNT);
      expect(localStorage.getItem(storageKey)).toBe(disconnect ? null : a.choice.id);
      expect(b.provider.calls.filter((call) => call.method === "qrl_accounts")).toHaveLength(0);
      stopReloaded();
    } finally {
      stop();
      revocation.resolve(null);
      await Promise.all([closing, returning]);
    }
  },
);

it("remembers an extension as soon as it is selected during relay teardown", async () => {
  const { choice } = extension();
  const relay = new TestWallet();
  const controller = new WalletController(config, () => relay);
  stops.push(controller.start());
  await controller.pair();
  const retirement = deferred<undefined>();
  vi.spyOn(relay, "disconnect").mockReturnValue(retirement.promise);
  const connecting = controller.connectExtension(choice);
  try {
    expect(localStorage.getItem(storageKey)).toBe(choice.id);
    await controller.disconnect();
    expect(localStorage.getItem(storageKey)).toBeNull();
  } finally {
    retirement.resolve(undefined);
    await connecting;
  }
});

it("keeps a reused helper cancellable while an older timed-out revoke remains pending", async () => {
  vi.useFakeTimers();
  const { choice, provider } = extension();
  const controller = new WalletController(config, () => new TestWallet());
  const stop = controller.start();
  stops.push(stop);
  await controller.connectExtension(choice);
  const revocation = deferred<unknown>();
  provider.revocation = revocation;
  const closing = controller.disconnect();
  await vi.advanceTimersByTimeAsync(10_000);
  await closing;
  const waiting = controller.connectExtension(choice);
  await flush();
  provider.revocation = undefined;
  await controller.disconnect();
  const retry = controller.connectExtension(choice);
  await flush();
  try {
    expect(controller.getSnapshot()).toMatchObject({
      status: "Finishing disconnect in MyQRLWallet Extension",
      transport: "extension",
      provider: choice.provider,
      account: null,
      busy: true,
      error: null,
    });
    expect(localStorage.getItem(storageKey)).toBe(choice.id);
    await controller.disconnect();
    expect(localStorage.getItem(storageKey)).toBeNull();
  } finally {
    await controller.disconnect();
    stop();
    revocation.resolve(null);
    await Promise.all([waiting, retry]);
  }
  expect(controller.getSnapshot()).toMatchObject({ status: "Disconnected", busy: false });
  expect(provider.calls.filter((call) => call.method === "qrl_requestAccounts")).toHaveLength(1);
});

it.each([false, true])(
  "waits for actual SDK teardown before pairing again (fresh=%s)",
  async (fresh) => {
    const { choice, provider } = extension();
    const retirement = deferred<undefined>();
    // Keep the SDK's public lifecycle guard and control its transport boundary.
    const teardown = vi
      .spyOn(ConnectionManager.prototype, "disconnect")
      .mockReturnValue(retirement.promise);
    const pairingApi = vi
      .spyOn(ConnectionManager.prototype, "getConnectionURI")
      .mockResolvedValue("qrlconnect://?q=fixture");
    vi.spyOn(ConnectionManager.prototype, "resetForNewChannel").mockResolvedValue();
    localStorage.setItem(storageKey, "relay");
    const controller = new WalletController(config, (options) =>
      createRelay({ ...options, autoReconnect: false }),
    );
    stops.push(controller.start());
    const switching = controller.connectExtension(choice);
    await flush();
    expect(teardown).toHaveBeenCalledOnce();
    const pairing = controller.pair(fresh);
    try {
      await flush();
      expect(controller.getSnapshot().error).toBeNull();
      expect(pairingApi).not.toHaveBeenCalled();
      expect(localStorage.getItem(storageKey)).toBe(choice.id);
      expect(controller.getSnapshot()).toMatchObject({
        status: "Preparing connection",
        transport: null,
        busy: true,
        error: null,
      });
    } finally {
      retirement.resolve(undefined);
      await Promise.all([switching, pairing]);
    }
    expect(pairingApi).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      uri: "qrlconnect://?q=fixture",
      error: null,
      busy: false,
    });
    expect(provider.calls).toHaveLength(0);
  },
);

it("keeps selection and controls while the reused helper completes an earlier revoke", async () => {
  const { choice, provider } = extension();
  const controller = new WalletController(config, () => new TestWallet());
  const stop = controller.start();
  stops.push(stop);
  await controller.connectExtension(choice);
  const revocation = deferred<unknown>();
  provider.revocation = revocation;
  const closing = controller.disconnect();
  const connecting = controller.connectExtension(choice);
  const remembered: (string | null)[] = [];
  const controls: (string | null)[] = [];
  const unsubscribe = controller.subscribe(() => {
    remembered.push(localStorage.getItem(storageKey));
    controls.push(controller.getSnapshot().transport);
  });
  try {
    revocation.resolve(null);
    await flush();
    expect(remembered.length).toBeGreaterThan(0);
    expect(remembered.every((id) => id === choice.id)).toBe(true);
    expect(controls.every((transport) => transport === "extension")).toBe(true);
    provider.approve();
    await connecting;
    expect(controller.getSnapshot().account).toBe(ACCOUNT);
  } finally {
    unsubscribe();
    stop();
    await Promise.all([closing, connecting]);
  }
});

it("preserves busy pairing while extension-triggered relay retirement is pending", async () => {
  const { choice } = extension();
  const retirement = deferred<undefined>();
  const teardown = vi
    .spyOn(ConnectionManager.prototype, "disconnect")
    .mockReturnValue(retirement.promise);
  const pairingApi = vi
    .spyOn(ConnectionManager.prototype, "getConnectionURI")
    .mockResolvedValue("qrlconnect://?q=cancelled");
  localStorage.setItem(storageKey, "relay");
  const controller = new WalletController(config, (options) =>
    createRelay({ ...options, autoReconnect: false }),
  );
  stops.push(controller.start());
  const switching = controller.connectExtension(choice);
  await flush();
  const pairing = controller.pair();
  const closing = controller.disconnect();
  try {
    expect(controller.getSnapshot()).toMatchObject({
      transport: null,
      status: "Preparing connection",
      busy: true,
    });
  } finally {
    retirement.resolve(undefined);
    await Promise.all([switching, pairing, closing]);
  }
  expect(pairingApi).toHaveBeenCalledOnce();
  expect(teardown).toHaveBeenCalledOnce();
  expect(controller.getSnapshot()).toMatchObject({
    uri: "qrlconnect://?q=cancelled",
    status: "Waiting for wallet",
    busy: false,
    error: null,
  });
  expect(localStorage.getItem(storageKey)).toBe("relay");
});

it.each(["extension", "disconnect"])(
  "keeps actual SDK pairing busy when %s is requested",
  async (selection) => {
    const { choice } = extension();
    const uri = deferred<string>();
    const pairingApi = vi
      .spyOn(ConnectionManager.prototype, "getConnectionURI")
      .mockReturnValue(uri.promise);
    const teardown = vi.spyOn(ConnectionManager.prototype, "disconnect").mockResolvedValue();
    const controller = new WalletController(config, (options) =>
      createRelay({ ...options, autoReconnect: false }),
    );
    stops.push(controller.start());
    const pairing = controller.pair();
    await flush();
    expect(pairingApi).toHaveBeenCalledOnce();
    const switching =
      selection === "extension" ? controller.connectExtension(choice) : controller.disconnect();
    try {
      expect(localStorage.getItem(storageKey)).toBeNull();
      expect(controller.getSnapshot()).toMatchObject({
        transport: null,
        account: null,
        uri: null,
        status: "Preparing connection",
        busy: true,
      });
      expect(teardown).not.toHaveBeenCalled();
    } finally {
      uri.resolve("qrlconnect://?q=cancelled");
      await Promise.all([pairing, switching]);
    }
    expect(teardown).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      account: null,
      uri: "qrlconnect://?q=cancelled",
      status: "Waiting for wallet",
      error: null,
      busy: false,
    });
    expect(localStorage.getItem(storageKey)).toBe("relay");
  },
);

it.each([false, true])(
  "reports failed extension-triggered relay retirement and preserves retry (fresh=%s)",
  async (fresh) => {
    const { choice, provider } = extension();
    const retirement = deferred<undefined>();
    const failure = new Error("Unable to retire the relay channel");
    const teardown = vi
      .spyOn(ConnectionManager.prototype, "disconnect")
      .mockReturnValueOnce(retirement.promise)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue();
    const pairingApi = vi
      .spyOn(ConnectionManager.prototype, "getConnectionURI")
      .mockResolvedValue("qrlconnect://?q=retried");
    vi.spyOn(ConnectionManager.prototype, "resetForNewChannel").mockResolvedValue();
    localStorage.setItem(storageKey, "relay");
    const controller = new WalletController(config, (options) =>
      createRelay({ ...options, autoReconnect: false }),
    );
    stops.push(controller.start());
    const switching = controller.connectExtension(choice);
    await flush();
    const pairing = controller.pair(fresh);
    retirement.reject(failure);
    await Promise.all([switching, pairing]);
    expect(pairingApi).not.toHaveBeenCalled();
    expect(provider.calls).toHaveLength(0);
    expect(controller.getSnapshot()).toMatchObject({ error: failure.message, busy: false });
    expect(teardown).toHaveBeenCalledTimes(2);
    await controller.disconnect();
    expect(teardown).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem(storageKey)).toBeNull();
    await controller.pair(fresh);
    expect(pairingApi).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      uri: "qrlconnect://?q=retried",
      status: "Waiting for wallet",
      busy: false,
      error: null,
    });
    expect(localStorage.getItem(storageKey)).toBe("relay");
  },
);
