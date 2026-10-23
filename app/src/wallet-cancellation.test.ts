import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ACCOUNT, config } from "../../sdk/src/__tests__/mockProvider";
import { deferred, TestExtension } from "./__tests__/mockExtension";
import { TestWallet } from "./__tests__/mockWallet";
import { extensionAnnouncement, WalletController } from "./wallet";

const storageKey = `qns:wallet:${config.chainId}:${config.contracts.QNSRegistry ?? "pending"}`;
const stops: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
function setup() {
  const provider = new TestExtension();
  provider.locked = false;
  provider.granted = true;
  const choice = extensionAnnouncement({
    info: { rdns: "com.qrlwallet.extension", uuid: "test", name: "Wallet" },
    provider,
  });
  if (!choice) throw new Error("No choice");
  const relay = new TestWallet();
  const controller = new WalletController(config, () => relay);
  stops.push(controller.start());
  return { provider, choice, relay, controller };
}

it("settles a cancelled extension activation even when relay retirement never answers", async () => {
  const { controller, relay, choice, provider } = setup();
  await controller.pair();
  const retirement = deferred<undefined>();
  vi.spyOn(relay, "disconnect").mockReturnValue(retirement.promise);
  let settled = false;
  const connecting = controller.connectExtension(choice).then(() => {
    settled = true;
  });
  try {
    await flush();
    await controller.disconnect();
    await flush();
    expect(controller.getSnapshot()).toMatchObject({
      transport: null,
      busy: false,
      status: "Disconnected",
    });
    expect(provider.listenerCounts()).toEqual([0, 0, 0]);
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(settled).toBe(true);
  } finally {
    retirement.resolve(undefined);
    await connecting;
  }
});

it("settles a disposed extension activation even when relay retirement never answers", async () => {
  const { controller, relay, choice } = setup();
  await controller.pair();
  const retirement = deferred<undefined>();
  vi.spyOn(relay, "disconnect").mockReturnValue(retirement.promise);
  let settled = false;
  const connecting = controller.connectExtension(choice).then(() => {
    settled = true;
  });
  try {
    await flush();
    for (const stop of stops.splice(0)) stop();
    await flush();
    expect(settled).toBe(true);
  } finally {
    retirement.resolve(undefined);
    await connecting;
  }
});

it("qualifies a failed revoke after Connect then Disconnect while closing", async () => {
  const { controller, choice, provider } = setup();
  await controller.connectExtension(choice);
  const revoke = deferred<unknown>();
  provider.revocation = revoke;
  const closing = controller.disconnect();
  const connecting = controller.connectExtension(choice);
  await flush();
  expect(controller.getSnapshot().status).toBe("Finishing disconnect in MyQRLWallet Extension");
  const cancelled = controller.disconnect();
  revoke.reject(Object.assign(new Error("Wallet is busy"), { code: 4200 }));
  await Promise.all([closing, connecting, cancelled]);
  expect(controller.getSnapshot()).toMatchObject({
    transport: null,
    busy: false,
    status: "Disconnected",
    account: null,
  });
  expect(controller.getSnapshot().error).toBe(
    "Disconnected on this page. The wallet reported: Wallet is busy",
  );
});

it("retains relay teardown recovery when a disconnect fails", async () => {
  const { controller, relay } = setup();
  relay.connected = true;
  relay.stored = true;
  await controller.pair();
  await flush();
  expect(controller.getSnapshot().account).toBe(ACCOUNT);
  const teardown = vi
    .spyOn(relay, "disconnect")
    .mockRejectedValueOnce(new Error("Unable to retire the relay channel"));
  await controller.disconnect();
  expect(controller.getSnapshot().error).toBe("Unable to retire the relay channel");
  await controller.disconnect();
  expect(teardown).toHaveBeenCalledTimes(2);
  expect(relay.stored).toBe(false);
});

it("keeps a successful extension connection current after prior revoke rejection", async () => {
  const { controller, provider, choice } = setup();
  await controller.connectExtension(choice);
  const revoke = deferred<unknown>();
  provider.revocation = revoke;
  const closing = controller.disconnect();
  const connecting = controller.connectExtension(choice);
  revoke.reject(Object.assign(new Error("Unsupported"), { code: -32601 }));
  await Promise.all([closing, connecting]);
  expect(controller.getSnapshot()).toMatchObject({
    account: ACCOUNT,
    transport: "extension",
    error: null,
    busy: false,
  });
  expect(provider.listenerCounts()).toEqual([1, 1, 1]);
  expect(localStorage.getItem(storageKey)).toBe(choice.id);
});
