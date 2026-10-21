import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ACCOUNT, config, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { deferred } from "./__tests__/mockExtension";
import { TestWallet } from "./__tests__/mockWallet";
import { WalletController } from "./wallet";

const storageKey = `qns:wallet:${config.chainId}:${config.contracts.QNSRegistry ?? "pending"}`;
const stops: Array<() => void> = [];
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
});

function setup() {
  const relay = new TestWallet();
  const controller = new WalletController(config, () => relay);
  return { relay, controller };
}

it("restores relay intent and publishes the provider after authorization", () => {
  const { relay, controller } = setup();
  localStorage.setItem(storageKey, "relay");
  relay.stored = true;
  stops.push(controller.start());
  expect(controller.getSnapshot()).toMatchObject({
    status: "Reconnecting",
    account: null,
    provider: null,
    transport: null,
  });
  expect(localStorage.getItem(storageKey)).toBe("relay");
  relay.emit("connect");
  expect(controller.getSnapshot()).toMatchObject({
    status: "Connected",
    account: ACCOUNT,
    provider: relay,
    transport: "relay",
  });
  expect(relay.calls).toHaveLength(0);
});

it("preserves busy pairing, status events and storage until a URI is available", async () => {
  const { relay, controller } = setup();
  const previousChoice = "com.qrlwallet.extension";
  localStorage.setItem(storageKey, previousChoice);
  stops.push(controller.start());
  const uri = deferred<string>();
  const pairingApi = vi.spyOn(relay, "getConnectionURI").mockReturnValue(uri.promise);
  const pairing = controller.pair();
  try {
    expect(controller.getSnapshot()).toMatchObject({
      status: "Preparing connection",
      busy: true,
      provider: null,
      transport: null,
      uri: null,
    });
    expect(localStorage.getItem(storageKey)).toBe(previousChoice);
    relay.emit("statusChanged", "Relay waiting");
    relay.emit("connect");
    relay.emit("accountsChanged", [ACCOUNT]);
    expect(controller.getSnapshot()).toMatchObject({ status: "Relay waiting", account: null });
    const revision = controller.getSnapshot().revision;
    relay.emit("chainChanged");
    expect(controller.getSnapshot().revision).toBe(revision + 1);
    await controller.pair(true);
    await controller.disconnect();
    const extension = new TestWallet();
    await controller.connectExtension({ id: previousChoice, name: "Wallet", provider: extension });
    expect(extension.calls).toHaveLength(0);
    expect(pairingApi).toHaveBeenCalledOnce();
    expect(relay.resets).toBe(0);
    expect(relay.disconnected).toBe(0);
    expect(controller.getSnapshot().busy).toBe(true);
    expect(localStorage.getItem(storageKey)).toBe(previousChoice);
  } finally {
    uri.resolve(relay.uri);
    await pairing;
  }
  expect(controller.getSnapshot()).toMatchObject({
    status: "Waiting for wallet",
    busy: false,
    provider: null,
    transport: null,
    uri: relay.uri,
  });
  expect(localStorage.getItem(storageKey)).toBe("relay");
});

it("retains relay state during Disconnect and clears it after successful teardown", async () => {
  const { relay, controller } = setup();
  relay.connected = true;
  relay.stored = true;
  stops.push(controller.start());
  await controller.pair();
  const retirement = deferred<undefined>();
  const teardown = vi.spyOn(relay, "disconnect").mockReturnValue(retirement.promise);
  const closing = controller.disconnect();
  try {
    expect(controller.getSnapshot()).toMatchObject({
      busy: true,
      account: ACCOUNT,
      provider: relay,
      transport: "relay",
    });
    expect(localStorage.getItem(storageKey)).toBe("relay");
    relay.emit("statusChanged", "Relay closing");
    relay.emit("disconnect");
    relay.emit("accountsChanged", [OTHER]);
    expect(controller.getSnapshot()).toMatchObject({ status: "Relay closing", account: ACCOUNT });
    await controller.disconnect();
    expect(teardown).toHaveBeenCalledOnce();
  } finally {
    retirement.resolve(undefined);
    await closing;
  }
  expect(controller.getSnapshot()).toMatchObject({
    status: "Disconnected",
    busy: false,
    account: null,
    provider: null,
    transport: null,
    uri: null,
  });
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("keeps failed pairing cleanup retryable and retains storage until teardown succeeds", async () => {
  const { relay, controller } = setup();
  const previousChoice = "com.qrlwallet.extension";
  localStorage.setItem(storageKey, previousChoice);
  stops.push(controller.start());
  vi.spyOn(relay, "getConnectionURI").mockRejectedValueOnce(new Error("Pairing failed"));
  const teardown = vi
    .spyOn(relay, "disconnect")
    .mockRejectedValueOnce(new Error("Unable to retire the relay channel"));
  await controller.pair();
  expect(controller.getSnapshot()).toMatchObject({
    error: "Unable to retire the relay channel",
    busy: false,
    uri: null,
  });
  expect(localStorage.getItem(storageKey)).toBe(previousChoice);
  await controller.disconnect();
  expect(teardown).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem(storageKey)).toBeNull();
  await controller.pair();
  expect(controller.getSnapshot()).toMatchObject({ uri: relay.uri, error: null, busy: false });
  expect(localStorage.getItem(storageKey)).toBe("relay");
});
