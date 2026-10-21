import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  registrationName,
  registrationTransaction,
  reverseNodeFor,
  readRegistrationState,
  verifyReverse,
} from "@qns/sdk";
import { isRecord, selector } from "../../sdk/src/abi";
import { ACCOUNT, OTHER, config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import { ReadFailureChain, readFailures } from "../../sdk/src/__tests__/readFailures";
import { readPendingClaim, savePendingClaim } from "./storage";
import { App } from "./App";
import { TestWallet } from "./__tests__/mockWallet";
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
      provider: { request: (args) => chain.request(args), listen: () => () => {} },
    }),
  );
  return controller;
}
async function searchName(name: string) {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Search" }).hasAttribute("disabled")).toBe(false);
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}
function seedReady(chain: MockChain, spelling = "alice", primary = false) {
  const parsed = registrationName(spelling);
  chain.seed(parsed.name, ACCOUNT);
  chain.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(parsed.node, ACCOUNT);
  chain.spellings.set(parsed.node, parsed.name);
  if (primary) {
    chain.primary = parsed.name;
    chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
  }
  return parsed;
}

it("advertises the actual writes for a released name with retained records", async () => {
  const chain = new MockChain();
  const alice = seedReady(chain);
  // QNSRegistry.setOwner(node, zero) retains resolver, address and spelling records.
  chain.owners.delete(alice.node);
  const required = await readRegistrationState(alice.name, ACCOUNT, { config, provider: chain });
  expect(
    Object.entries(required.required)
      .filter(([step, needed]) => step !== "primary" && needed)
      .map(([step]) => step),
  ).toEqual(["register"]);
  await mount(chain);
  await searchName(alice.name);
  await screen.findByText("Available", { selector: "dd" });
  const steps = within(screen.getByRole("list", { name: "Claim steps" }));
  expect(steps.getAllByText("Skipped", { selector: "dd" })).toHaveLength(3);
  expect(steps.getAllByText("Waiting", { selector: "dd" })).toHaveLength(1);
  const advertised = screen.getByText("Wallet approvals").nextElementSibling?.textContent;
  const summary = screen.getByText(/^Set up alice.qrl:/).textContent;
  fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
  await screen.findByText("alice.qrl is ready. It resolves to your address.");
  expect(chain.sent.map((tx) => tx.data)).toEqual([
    registrationTransaction(alice.name, ACCOUNT, "register", config).data,
  ]);
  expect({ advertised, summary }).toEqual({
    advertised: "1 remaining",
    summary: "Set up alice.qrl: 1 wallet approvals remaining.",
  });
});

class ReverseSnapshotFailure extends MockChain {
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    const call = args.params?.[0];
    if (
      args.method === "qrl_call" &&
      args.params?.[1] !== "latest" &&
      isRecord(call) &&
      typeof call.data === "string" &&
      call.data.startsWith(selector("resolver(bytes32)")) &&
      call.data.slice(10, 74) === reverseNodeFor(ACCOUNT).slice(2)
    )
      return Promise.reject(new Error("RPC request failed: missing trie node"));
    return super.request(args);
  }
}

it("surfaces an RPC failure while reading the primary state", async () => {
  const chain = new ReverseSnapshotFailure();
  seedReady(chain, "alice", true);
  expect(
    await verifyReverse(ACCOUNT, { registry: config.contracts.QNSRegistry ?? "", provider: chain }),
  ).toBe("alice.qrl");
  await expect(
    readRegistrationState("alice", ACCOUNT, { config, provider: chain }),
  ).rejects.toThrow("RPC request failed");
});

it("does not turn a primary-state RPC failure into a repeatable setup action that sends nothing", async () => {
  const chain = new ReverseSnapshotFailure();
  seedReady(chain, "alice", true);
  await mount(chain);
  const names = within(screen.getByRole("region", { name: "My names" }));
  await names.findByText("Could not read your names: RPC request failed: missing trie node");
  await searchName("alice");
  await screen.findByText(
    "Could not refresh name availability: RPC request failed: missing trie node",
  );
  expect(names.queryByText("Not set as primary")).toBeNull();
  expect(names.queryByRole("button", { name: "Make primary name" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Complete name setup" })).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh names" }).hasAttribute("disabled")).toBe(
    false,
  );
  expect(screen.getByRole("button", { name: "Search" }).hasAttribute("disabled")).toBe(false);
  expect(chain.sent).toHaveLength(0);
});

it("stops waiting for the original transaction after its nonce is consumed by a cancellation", async () => {
  class CancelledTransaction extends MockChain {
    override async request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      if (
        args.method === "qrl_getTransactionCount" &&
        args.params?.[1] === "latest" &&
        this.sent.length > 0
      )
        this.confirmedNonce = 1n;
      return super.request(args);
    }
  }
  const chain = new CancelledTransaction();
  chain.receiptPending = true;
  await mount(chain);
  await searchName("alice");
  fireEvent.click(await screen.findByRole("button", { name: "Claim name" }));
  await screen.findByText(
    "The saved nonce has been used by another transaction. Re-check name state to continue.",
    { selector: '[role="alert"]' },
  );
  expect(chain.sent).toHaveLength(1);
  expect(chain.confirmedNonce).toBe(1n);
  expect(
    screen
      .queryAllByText("Sent (waiting for the next block, about a minute)", { selector: "dd" })
      .map((node) => node.textContent),
  ).toEqual([]);
});

it("stops waiting for a successful receipt when a later write has invalidated its postcondition", async () => {
  class AdvancedBlock extends MockChain {
    head = "0x20";
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      if (args.method === "qrl_blockNumber") return Promise.resolve(this.head);
      return super.request(args);
    }
  }
  const chain = new AdvancedBlock();
  const alice = seedReady(chain);
  chain.addresses.delete(alice.node);
  chain.afterReceipt = () => {
    // A subsequent write by the owner or an approved operator changes the address again.
    chain.head = "0x21";
    chain.addresses.set(alice.node, OTHER);
  };
  await mount(chain);
  await searchName("alice");
  fireEvent.click(await screen.findByRole("button", { name: "Complete name setup" }));
  await screen.findByText(
    "The expected name record is still incomplete. Re-check name state to continue.",
    { selector: '[role="alert"]' },
  );
  expect(chain.sent.map((tx) => tx.data)).toEqual([
    registrationTransaction("alice", ACCOUNT, "address", config).data,
  ]);
  expect(chain.confirmedNonce).toBe(1n);
  expect(chain.addresses.get(alice.node)).toBe(OTHER);
  expect(
    screen
      .queryAllByText("Sent (waiting for the next block, about a minute)", { selector: "dd" })
      .map((node) => node.textContent),
  ).toEqual([]);
});

it.each(readFailures)(
  "keeps setup unavailable during a failed %s read and retries",
  async (failure) => {
    const chain = new ReadFailureChain(failure);
    await mount(chain);
    await searchName("alice");
    await screen.findByText(`Could not refresh name availability: ${chain.message}`);
    for (const button of screen.queryAllByRole("button", {
      name: /Make primary name|Finish name setup|Complete name setup|Claim name/,
    }))
      expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Wallet approvals")).toBeNull();
    expect(chain.sent).toHaveLength(0);
    chain.failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh names" }));
    await screen.findByText("Owned by you");
    await waitFor(() => {
      expect(
        screen.queryByText(`Could not refresh name availability: ${chain.message}`),
      ).toBeNull();
    });
    expect(chain.sent).toHaveLength(0);
  },
);

it.each(["replaced", "incomplete", "verification-failed"] as const)(
  "retains %s and recovery choices after reload and tracking the same hash",
  async (status) => {
    const chain = new MockChain();
    const hash = `0x${"d".repeat(64)}`;
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: { step: "register", status, hash },
    });
    await mount(chain);
    await screen.findByText(/^Needs attention:/, { selector: "dd" });
    fireEvent.change(screen.getByLabelText("Transaction hash"), { target: { value: hash } });
    fireEvent.click(screen.getByRole("button", { name: "Track transaction" }));
    expect(screen.queryByText("Sent (waiting for the next block, about a minute)")).toBeNull();
    expect(readPendingClaim(config, ACCOUNT)?.update.status).toBe(status);
    expect(screen.getByRole("button", { name: "Re-check name state" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Discard pending state" })).toBeDefined();
    expect(chain.sent).toHaveLength(0);
  },
);

it("preserves a successful receipt when its verification read fails", async () => {
  const chain = new ReadFailureChain("address");
  chain.failing = false;
  chain.addresses.delete(registrationName("alice").node);
  chain.afterReceipt = () => {
    chain.failing = true;
  };
  await mount(chain);
  await searchName("alice");
  fireEvent.click(await screen.findByRole("button", { name: "Complete name setup" }));
  await screen.findByText("Needs attention: could not verify name records", { selector: "dd" });
  expect(readPendingClaim(config, ACCOUNT)?.update.status).toBe("verification-failed");
  expect(screen.queryByText("Sent (waiting for the next block, about a minute)")).toBeNull();
  expect(chain.sent).toHaveLength(1);
  chain.failing = false;
  fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
  await screen.findByText(
    "alice.qrl is ready. It resolves to your address and is your primary name.",
  );
  expect(readPendingClaim(config, ACCOUNT)).toBeNull();
  expect(chain.sent).toHaveLength(1);
});

it("stops the network wait as soon as a receipt arrives while record verification is delayed", async () => {
  class DelayedVerification extends MockChain {
    hold = false;
    resumes: Array<() => void> = [];
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      if (this.hold && args.method === "qrl_call")
        return new Promise((resolve) => {
          this.resumes.push(() => {
            resolve(super.request(args));
          });
        });
      return super.request(args);
    }
  }
  const chain = new DelayedVerification();
  chain.afterReceipt = () => {
    chain.hold = true;
  };
  await mount(chain);
  await searchName("alice");
  fireEvent.click(await screen.findByRole("button", { name: "Claim name" }));
  try {
    await screen.findByText("Mined, checking name records", { selector: "dd" });
    expect(screen.queryByText("Sent (waiting for the next block, about a minute)")).toBeNull();
    expect(chain.sent).toHaveLength(1);
  } finally {
    await act(async () => {
      chain.hold = false;
      chain.afterReceipt = null;
      for (const resume of chain.resumes) resume();
      await Promise.resolve();
    });
  }
  await screen.findByText("alice.qrl is ready. It resolves to your address.");
});

it.each(["unconfirmed", "replaced"] as const)(
  "keeps a late matching hash consistent with %s",
  async (status) => {
    const hash = `0x${"d".repeat(64)}`;
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: { step: "register", status, nonce: "0x1", requestId: "alice-request" },
    });
    const relay = new TestWallet();
    relay.connected = true;
    relay.stored = true;
    const controller = new WalletController(config, () => relay);
    render(<App config={config} provider={relay} controller={controller} />);
    await act(() => controller.pair());
    await screen.findByText(/Check the pending transaction for alice.qrl/);
    act(() => {
      relay.emit("late_response", {
        id: "alice-request",
        method: "qrl_sendTransaction",
        result: hash,
      });
    });
    await waitFor(() => {
      expect(readPendingClaim(config, ACCOUNT)?.update).toMatchObject({ status, hash });
    });
    expect(
      screen.getByText(
        status === "replaced"
          ? "Needs attention: transaction replaced or cancelled"
          : "Sent (waiting for the next block, about a minute)",
        { selector: "dd" },
      ),
    ).toBeDefined();
    if (status === "replaced") expect(screen.queryByText(/Sent \(waiting/)).toBeNull();
    expect(relay.sent).toHaveLength(0);
  },
);
