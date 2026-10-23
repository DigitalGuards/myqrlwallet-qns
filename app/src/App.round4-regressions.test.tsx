import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registrationName, registrationTransaction } from "@qns/sdk";
import { ACCOUNT, config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import { ReadFailureChain } from "../../sdk/src/__tests__/readFailures";
import { App } from "./App";
import { readPendingClaim, savePendingClaim } from "./storage";
import { WalletController } from "./wallet";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);

async function mount(chain: MockChain) {
  const controller = new WalletController(config);
  render(<App config={config} provider={chain} controller={controller} />);
  await act(() =>
    controller.connectExtension({
      id: "com.qrlwallet.extension",
      name: "MyQRLWallet Extension",
      provider: {
        request: (args) => chain.request(args),
        listen: () => () => {
          // This request-only provider installs no event listeners to remove.
        },
      },
    }),
  );
}

function seedReady(chain: MockChain, spelling = "alice") {
  const parsed = registrationName(spelling);
  chain.seed(parsed.name, ACCOUNT);
  chain.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(parsed.node, ACCOUNT);
  chain.spellings.set(parsed.node, parsed.name);
  return parsed;
}

class DelayedNameRead extends MockChain {
  hold = false;
  resume: (() => void) | undefined;
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    if (this.hold && args.method === "qrl_blockNumber") {
      this.hold = false;
      return new Promise((resolve) => {
        this.resume = () => {
          resolve(super.request(args));
        };
      });
    }
    return super.request(args);
  }
}

const sentLabel = "Sent (waiting for the next block, about a minute)";
const readyLabel = "alice.qrl is ready. It resolves to your address and is your primary name.";

it.each([
  { recovery: "current session", finish: "receipt" },
  { recovery: "reload", finish: "receipt" },
  { recovery: "tracked hash", finish: "name state" },
  { recovery: "saved nonce", finish: "name state" },
])(
  "keeps the app's pending transaction after complete records ($recovery, then $finish)",
  async ({ recovery, finish }) => {
    const earlierHash = `0x${"1".padStart(64, "0")}`;
    const pendingHash = `0x${"2".padStart(64, "0")}`;
    class QueuedPrimary extends MockChain {
      firstLookup = true;
      minePending = false;
      override async request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_getTransactionReceipt" && args.params?.[0] === pendingHash) {
          if (this.firstLookup) {
            this.firstLookup = false;
            // An earlier approval mines while this app's transaction remains queued.
            await super.request({ method: "qrl_getTransactionReceipt", params: [earlierHash] });
            throw new Error("RPC receipt lookup timed out");
          }
          if (!this.minePending) return null;
        }
        return super.request(args);
      }
    }
    const chain = new QueuedPrimary();
    seedReady(chain);
    await chain.request({
      method: "qrl_sendTransaction",
      params: [registrationTransaction("alice", ACCOUNT, "primary", config)],
    });
    expect(chain.primary).toBe("");
    await mount(chain);
    const names = within(screen.getByRole("region", { name: "My names" }));
    fireEvent.click(await names.findByRole("button", { name: "Make primary name" }));
    await screen.findByText("RPC receipt lookup timed out", { selector: '[role="alert"]' });
    const submitted = readPendingClaim(config, ACCOUNT);
    if (!submitted) throw new Error("Expected a saved transaction");
    expect(submitted.attemptId).toEqual(expect.any(String));
    expect(submitted.update).toMatchObject({
      step: "primary",
      hash: pendingHash,
      status: "unconfirmed",
    });
    // The failed first receipt read precedes nonce discovery.
    expect(submitted.update.nonce).toBeUndefined();
    expect(chain.sent).toHaveLength(2);
    expect(chain.primary).toBe("alice.qrl");
    expect(chain.confirmedNonce).toBe(1n);
    expect(chain.sent[1]?.nonce).toBe("0x1");
    expect(screen.getByText(sentLabel, { selector: "dd" })).toBeDefined();

    if (recovery === "saved nonce")
      savePendingClaim(config, {
        name: submitted.name,
        account: submitted.account,
        primary: true,
        update: { ...submitted.update, nonce: "0x1" },
      });
    if (recovery === "reload" || recovery === "saved nonce") {
      cleanup();
      await mount(chain);
    }
    if (recovery === "tracked hash") {
      fireEvent.change(screen.getByLabelText("Transaction hash"), {
        target: { value: pendingHash },
      });
      fireEvent.click(screen.getByRole("button", { name: "Track transaction" }));
    }
    const saved = readPendingClaim(config, ACCOUNT);
    if (!saved) throw new Error("Expected the pending transaction");
    // A successful pending check supersedes the earlier receipt read error.
    delete saved.update.message;
    fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Checking..." })).toBeNull();
    });
    await screen.findByText("Owned by you");
    expect(
      await chain.request({ method: "qrl_getTransactionReceipt", params: [pendingHash] }),
    ).toBeNull();
    expect(chain.confirmedNonce).toBe(1n);
    expect({
      pendingStillSaved: readPendingClaim(config, ACCOUNT) !== null,
      finishedShown: screen.queryByText(readyLabel) !== null,
      pendingStepShown: screen.queryByText(sentLabel, { selector: "dd" }) !== null,
    }).toEqual({ pendingStillSaved: true, finishedShown: false, pendingStepShown: true });
    expect(readPendingClaim(config, ACCOUNT)).toEqual(saved);

    fireEvent.click(screen.getByRole("button", { name: "Refresh names" }));
    await screen.findByText("Owned by you");
    expect(screen.queryByText(readyLabel)).toBeNull();
    expect(screen.getByText(sentLabel, { selector: "dd" })).toBeDefined();
    expect(readPendingClaim(config, ACCOUNT)).toEqual(saved);

    if (finish === "receipt") chain.minePending = true;
    else chain.confirmedNonce = 2n;
    fireEvent.click(
      screen.getByRole("button", {
        name: finish === "receipt" ? "Check confirmation" : "Re-check name state",
      }),
    );
    await screen.findByText(readyLabel);
    expect(readPendingClaim(config, ACCOUNT)).toBeNull();
    expect(screen.queryByText(sentLabel)).toBeNull();
    expect(chain.confirmedNonce).toBe(2n);
    expect(chain.sent).toHaveLength(2);
  },
);

it.each(["primary", "address"] as const)(
  "opens an owned name after a malformed search and runs only its missing %s step",
  async (step) => {
    const chain = new MockChain();
    const parsed = seedReady(chain);
    if (step === "address") chain.addresses.delete(parsed.node);
    await mount(chain);
    const names = within(screen.getByRole("region", { name: "My names" }));
    const button = await names.findByRole("button", {
      name: step === "primary" ? "Make primary name" : "Finish name setup",
    });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "invalid name" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("alert");
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(screen.getByRole("textbox", { name: "Name" }).getAttribute("value")).toBe(parsed.name);
    expect(screen.queryByRole("alert")).toBeNull();
    await screen.findByText(
      step === "primary" ? readyLabel : "alice.qrl is ready. It resolves to your address.",
    );
    expect(chain.sent.map(({ to, data }) => ({ to, data }))).toEqual([
      {
        to: registrationTransaction(parsed.name, ACCOUNT, step, config).to,
        data: registrationTransaction(parsed.name, ACCOUNT, step, config).data,
      },
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it.each(["primary", "address"] as const)(
  "opens an owned name for its missing %s step while an unrelated search is loading",
  async (step) => {
    const chain = new DelayedNameRead();
    const parsed = seedReady(chain);
    if (step === "address") chain.addresses.delete(parsed.node);
    await mount(chain);
    const names = within(screen.getByRole("region", { name: "My names" }));
    const button = await names.findByRole("button", {
      name: step === "primary" ? "Make primary name" : "Finish name setup",
    });
    chain.hold = true;
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(chain.resume).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Searching..." })).toBeDefined();
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    const ready =
      step === "primary" ? readyLabel : "alice.qrl is ready. It resolves to your address.";
    await screen.findByText(ready);
    await act(async () => {
      chain.resume?.();
      await Promise.resolve();
    });
    expect(screen.getByText(ready)).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Name" }).getAttribute("value")).toBe(parsed.name);
    expect(chain.sent.map((tx) => tx.data)).toEqual([
      registrationTransaction(parsed.name, ACCOUNT, step, config).data,
    ]);
  },
);

it("keeps an owned-name read failure retryable after an invalid search", async () => {
  const chain = new ReadFailureChain("address");
  chain.failing = false;
  chain.addresses.delete(registrationName("alice").node);
  await mount(chain);
  const names = within(screen.getByRole("region", { name: "My names" }));
  const button = await names.findByRole("button", { name: "Finish name setup" });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "invalid name" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("alert");
  chain.failing = true;
  fireEvent.click(button);
  await screen.findByText(`Could not refresh name availability: ${chain.message}`);
  expect(chain.sent).toHaveLength(0);
  expect(screen.queryByText("Wallet approvals")).toBeNull();
  expect(button.hasAttribute("disabled")).toBe(true);
  chain.failing = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh names" }));
  await screen.findByText("Owned by you");
  const retry = await names.findByRole("button", { name: "Finish name setup" });
  expect(retry.hasAttribute("disabled")).toBe(false);
  expect(chain.sent).toHaveLength(0);
  fireEvent.click(retry);
  await screen.findByText(readyLabel);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(chain.sent.map((tx) => tx.data)).toEqual([
    registrationTransaction("alice", ACCOUNT, "address", config).data,
  ]);
});

it("keeps another owned name actionable when the searched name's records fail to load", async () => {
  const chain = new ReadFailureChain("destination address");
  seedReady(chain, "bob");
  await mount(chain);
  const names = within(screen.getByRole("region", { name: "My names" }));
  const finish = await names.findByRole("button", { name: "Finish name setup" });
  const primary = names.getByRole("button", { name: "Make primary name" });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText(`Could not refresh name availability: ${chain.message}`);
  expect(finish.hasAttribute("disabled")).toBe(true);
  expect(primary.hasAttribute("disabled")).toBe(false);
  fireEvent.click(primary);
  await screen.findByText(
    "bob.qrl is ready. It resolves to your address and is your primary name.",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(chain.sent.map((tx) => tx.data)).toEqual([
    registrationTransaction("bob", ACCOUNT, "primary", config).data,
  ]);
});

it("cancels an owned-name action if selection changes during its refresh", async () => {
  const chain = new DelayedNameRead();
  seedReady(chain);
  await mount(chain);
  const names = within(screen.getByRole("region", { name: "My names" }));
  const button = await names.findByRole("button", { name: "Make primary name" });
  chain.hold = true;
  fireEvent.click(button);
  await waitFor(() => {
    expect(chain.resume).toBeDefined();
  });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bob" } });
  await act(async () => {
    chain.resume?.();
    await Promise.resolve();
  });
  expect(chain.sent).toHaveLength(0);
});
