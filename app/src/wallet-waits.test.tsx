import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import { deferred, TestExtension } from "./__tests__/mockExtension";
import { TestWallet } from "./__tests__/mockWallet";
import { App } from "./App";
import { extensionAnnouncement, WalletController } from "./wallet";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flush() {
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
}

function setup() {
  const provider = new TestExtension();
  provider.locked = false;
  provider.granted = true;
  const choice = extensionAnnouncement({
    info: { rdns: "com.qrlwallet.extension", uuid: "extension", name: "Wallet" },
    provider,
  });
  if (!choice) throw new Error("Missing extension choice");
  const relay = new TestWallet();
  const controller = new WalletController(config, () => relay);
  render(<App config={config} provider={new MockChain()} controller={controller} />);
  return { controller, provider, choice, relay };
}

it.each(["revocation", "relay"])(
  "keeps Disconnect available when a reused helper waits for earlier %s",
  async (source) => {
    vi.useFakeTimers();
    const { controller, provider, choice, relay } = setup();
    const previous = deferred<undefined>();
    const requests: Promise<void>[] = [];
    if (source === "revocation") {
      await act(() => controller.connectExtension(choice));
      provider.revocation = previous;
      await act(async () => {
        const closing = controller.disconnect();
        await vi.advanceTimersByTimeAsync(10_000);
        await closing;
      });
    } else {
      await act(() => controller.pair());
      vi.spyOn(relay, "disconnect").mockReturnValue(previous.promise);
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await act(async () => {
          requests.push(controller.connectExtension(choice));
          await flush();
        });
        expect(controller.getSnapshot()).toMatchObject({
          transport: "extension",
          provider: choice.provider,
          busy: true,
          account: null,
        });
        const button = within(screen.getByRole("banner")).getByRole("button", {
          name: "Disconnect",
        });
        expect(button.hasAttribute("disabled")).toBe(false);
        provider.revocation = undefined;
        await act(async () => {
          fireEvent.click(button);
          await flush();
        });
        expect(screen.getByText("Disconnected", { selector: "dd" })).toBeDefined();
        expect(
          within(screen.getByRole("banner"))
            .getByRole("button", { name: "Connect wallet" })
            .hasAttribute("disabled"),
        ).toBe(false);
      }
    } finally {
      cleanup();
      previous.resolve(undefined);
      await Promise.all(requests);
    }
    expect(provider.calls.filter((call) => call.method === "qrl_requestAccounts")).toHaveLength(
      source === "revocation" ? 1 : 0,
    );
    expect(provider.sent).toHaveLength(0);
  },
);

it("keeps the wallet control disabled during relay preparation", async () => {
  const { controller, relay } = setup();
  const uri = deferred<string>();
  vi.spyOn(relay, "getConnectionURI").mockReturnValue(uri.promise);
  let pairing: Promise<void> | undefined;
  await act(async () => {
    pairing = controller.pair();
    await flush();
  });
  try {
    const connecting = within(screen.getByRole("banner")).getByRole("button", {
      name: "Connecting...",
    });
    expect(connecting.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      fireEvent.click(connecting);
      await flush();
    });
    expect(screen.getByText("Preparing connection", { selector: "dd" })).toBeDefined();
  } finally {
    await act(async () => {
      uri.resolve("qrlconnect://?q=cancelled");
      await pairing;
    });
  }
  expect(controller.getSnapshot()).toMatchObject({
    status: "Waiting for wallet",
    uri: "qrlconnect://?q=cancelled",
  });
  expect(relay.disconnected).toBe(0);
});
