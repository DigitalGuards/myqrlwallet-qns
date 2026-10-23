import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registrationName, registrationTransaction, reverseNodeFor } from "@qns/sdk";
import { addressWord, isRecord, selector } from "../../sdk/src/abi";
import { ACCOUNT, OTHER, config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import { App } from "./App";
import { WalletController } from "./wallet";
import { readPendingClaim, savePendingClaim } from "./storage";

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

async function searchName(name: string) {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Search" }).hasAttribute("disabled")).toBe(false);
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

function seedReady(chain: MockChain, spelling = "alice") {
  const parsed = registrationName(spelling);
  chain.seed(parsed.name, ACCOUNT);
  chain.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(parsed.node, ACCOUNT);
  chain.spellings.set(parsed.node, parsed.name);
  return parsed;
}

it("marks a saved transaction Failed when recovery confirms a revert and allows retry", async () => {
  const chain = new MockChain();
  const hash = await chain.request({
    method: "qrl_sendTransaction",
    params: [registrationTransaction("alice", ACCOUNT, "register", config)],
  });
  if (typeof hash !== "string") throw new Error("Bad fixture hash");
  chain.receiptStatus = "0x0";
  savePendingClaim(config, {
    name: "alice.qrl",
    account: ACCOUNT,
    update: { step: "register", status: "unconfirmed", hash },
  });
  await mount(chain);
  fireEvent.click(await screen.findByRole("button", { name: "Check confirmation" }));
  await screen.findByText("Transaction reverted", { selector: '[role="alert"]' });
  expect(
    screen.queryByText("Sent (waiting for the next block, about a minute)", { selector: "dd" }),
  ).toBeNull();
  expect(screen.getByText("Failed", { selector: "dd" })).toBeDefined();
  expect(document.querySelector('[aria-current="step"]')?.textContent).toContain("Claim the name");
  expect(readPendingClaim(config, ACCOUNT)).toBeNull();
  const retry = await screen.findByRole("button", { name: "Claim name" });
  await waitFor(() => {
    expect(retry.hasAttribute("disabled")).toBe(false);
  });
  chain.receiptStatus = "0x1";
  fireEvent.click(retry);
  await screen.findByText("alice.qrl is ready. It resolves to your address.");
  expect(chain.sent).toHaveLength(5);
});

it("keeps a sent address correction active until its receipt despite an older complete snapshot", async () => {
  const alice = registrationName("alice");
  class RaceChain extends MockChain {
    arm = false;
    oldSnapshotRead = false;
    head = "0x20";
    approve: (() => void) | undefined;
    mine: (() => void) | undefined;
    heldSend = false;
    heldReceipt = false;
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      if (args.method === "qrl_blockNumber") {
        if (this.arm) {
          this.arm = false;
          this.head = "0x21";
          this.addresses.set(alice.node, OTHER);
        }
        return Promise.resolve(this.head);
      }
      if (args.method === "qrl_sendTransaction" && !this.heldSend) {
        this.heldSend = true;
        this.head = "0x20";
        return new Promise((resolve) => {
          this.approve = () => {
            resolve(super.request(args));
          };
        });
      }
      if (args.method === "qrl_getTransactionReceipt" && !this.heldReceipt) {
        this.heldReceipt = true;
        return new Promise((resolve) => {
          this.mine = () => {
            this.head = "0x21";
            resolve(super.request(args));
          };
        });
      }
      const call = args.params?.[0];
      if (
        args.method === "qrl_call" &&
        isRecord(call) &&
        typeof call.data === "string" &&
        call.data.startsWith(selector("addr(bytes32)")) &&
        call.data.slice(10, 74) === alice.node.slice(2)
      ) {
        if (args.params?.[1] === "0x20") {
          this.oldSnapshotRead = true;
          return Promise.resolve(`0x${addressWord(ACCOUNT)}`);
        }
      }
      return super.request(args);
    }
  }
  const chain = new RaceChain();
  seedReady(chain);
  await mount(chain);
  const names = within(screen.getByRole("region", { name: "My names" }));
  const action = await names.findByRole("button", { name: "Make primary name" });
  chain.arm = true;
  fireEvent.click(action);
  await screen.findByText("Approve in your wallet now", { selector: "dd" });
  chain.oldSnapshotRead = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh names" }));
  await waitFor(() => {
    expect(chain.oldSnapshotRead).toBe(true);
  });
  await waitFor(() => {
    expect(screen.queryByText("Searching...")).toBeNull();
  });
  expect(document.querySelector('[aria-current="step"]')?.textContent).toContain(
    "Point the name to your address",
  );
  await act(async () => {
    chain.approve?.();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(chain.mine).toBeDefined();
  });
  try {
    expect(chain.sent.map((tx) => tx.data)).toEqual([
      registrationTransaction("alice", ACCOUNT, "address", config).data,
    ]);
    const current = document.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Point the name to your address");
    if (!(current instanceof HTMLElement)) throw new Error("Missing sent step");
    const row = within(current);
    expect(row.getByText("Sent (waiting for the next block, about a minute)")).toBeDefined();
    expect(row.getByText("setAddr(node, owner)")).toBeDefined();
    expect(row.queryByText("Skipped")).toBeNull();
    expect(
      screen.getByText("Claiming alice.qrl: 3 of 5 steps done, waiting for the network."),
    ).toBeDefined();
  } finally {
    await act(async () => {
      chain.mine?.();
      await Promise.resolve();
    });
    await screen.findByText(
      "alice.qrl is ready. It resolves to your address and is your primary name.",
    );
  }
});

it.each(["Make primary name", "Complete name setup"])(
  "%s repairs a reverting previous primary resolver",
  async (action) => {
    class BrokenPreviousPrimary extends MockChain {
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        const call = args.params?.[0];
        if (args.method === "qrl_call" && isRecord(call) && call.to === OTHER)
          return Promise.reject(new Error("execution reverted: old primary resolver"));
        return super.request(args);
      }
    }
    const chain = new BrokenPreviousPrimary();
    seedReady(chain);
    const old = registrationName("old");
    chain.seed(old.name, ACCOUNT);
    chain.resolvers.set(old.node, OTHER);
    chain.primary = old.name;
    chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    await mount(chain);
    const names = within(screen.getByRole("region", { name: "My names" }));
    if (action === "Make primary name")
      fireEvent.click(await names.findByRole("button", { name: action }));
    else {
      const alice = registrationName("alice");
      chain.addresses.delete(alice.node);
      await searchName(alice.name);
      await screen.findByRole("button", { name: action });
      fireEvent.click(screen.getByLabelText("Use as my primary name"));
      fireEvent.click(screen.getByRole("button", { name: action }));
    }
    await waitFor(() => {
      expect(chain.sent.map((tx) => tx.data)).toEqual([
        ...(action === "Complete name setup"
          ? [registrationTransaction("alice", ACCOUNT, "address", config).data]
          : []),
        registrationTransaction("alice", ACCOUNT, "primary", config).data,
      ]);
    });
    await screen.findByText(
      "alice.qrl is ready. It resolves to your address and is your primary name.",
    );
    expect(chain.primary).toBe("alice.qrl");
  },
);

it("counts one remaining approval when only the address needs repair", async () => {
  const chain = new MockChain();
  const alice = seedReady(chain);
  chain.addresses.delete(alice.node);
  await mount(chain);
  await searchName(alice.name);
  await screen.findByRole("button", { name: "Complete name setup" });
  const advertised = screen.getByText("Wallet approvals").nextElementSibling?.textContent;
  const summary = screen.getByText(/^Set up alice.qrl:/).textContent;
  fireEvent.click(screen.getByRole("button", { name: "Complete name setup" }));
  await screen.findByText("alice.qrl is ready. It resolves to your address.");
  expect(chain.sent.map((tx) => tx.data)).toEqual([
    registrationTransaction("alice", ACCOUNT, "address", config).data,
  ]);
  expect(advertised).toBe("1 remaining");
  expect(summary).toBe("Set up alice.qrl: 1 wallet approvals remaining.");
});
