import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registrationName, registrationTransaction } from "@qns/sdk";
import { addressWord, isRecord, selector } from "../../sdk/src/abi";
import { ACCOUNT, OTHER, config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import { App } from "./App";
import { WalletController } from "./wallet";
import { readPendingClaim, rememberName, savePendingClaim } from "./storage";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);

class UnusableResolverChain extends MockChain {
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    const call = args.params?.[0];
    if (args.method === "qrl_call" && isRecord(call) && call.to === OTHER)
      return Promise.resolve("0x");
    return super.request(args);
  }
}
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
  const button = screen.getByRole("button", { name: "Search" });
  await waitFor(() => {
    expect(button.hasAttribute("disabled")).toBe(false);
  });
  fireEvent.click(button);
}

describe("adversarial resolver recovery", () => {
  it("keeps ownership visible and allows replacing an unusable resolver", async () => {
    const chain = new UnusableResolverChain();
    const alice = registrationName("alice");
    chain.seed(alice.name, ACCOUNT);
    chain.resolvers.set(alice.node, OTHER);
    await mount(chain);
    await searchName(alice.name);
    await screen.findByText("Owned by you");
    const card = within(screen.getByRole("region", { name: "Find your .qrl name" }));
    expect(card.getByText("Resolver not usable")).toBeDefined();
    const action = screen.getByRole("button", { name: "Complete name setup" });
    expect(action.hasAttribute("disabled")).toBe(false);
    fireEvent.click(action);
    await waitFor(() => {
      expect(chain.spellings.get(alice.node)).toBe(alice.name);
    });
    expect(chain.sent.map((tx) => tx.data)).toEqual(
      (["resolver", "address", "name"] as const).map(
        (step) => registrationTransaction(alice.name, ACCOUNT, step, config).data,
      ),
    );
  });

  it("keeps every owned name visible when one transferred name uses an unusable resolver", async () => {
    const chain = new UnusableResolverChain();
    for (const spelling of ["alice", "external"]) {
      const parsed = registrationName(spelling);
      chain.seed(parsed.name, ACCOUNT);
      chain.resolvers.set(
        parsed.node,
        spelling === "external" ? OTHER : (config.contracts.QRLPublicResolver ?? ""),
      );
      chain.addresses.set(parsed.node, ACCOUNT);
      chain.spellings.set(parsed.node, parsed.name);
      rememberName(config, parsed.name);
    }
    await mount(chain);
    const names = within(screen.getByRole("region", { name: "My names" }));
    await names.findByText("alice.qrl");
    expect(names.getByText("external.qrl")).toBeDefined();
    expect(names.getByText("Resolver not usable")).toBeDefined();
    expect(names.getByText("Ready")).toBeDefined();
    const action = names.getByRole("button", { name: "Finish name setup" });
    expect(action.hasAttribute("disabled")).toBe(false);
    fireEvent.click(action);
    await screen.findByText("external.qrl is ready. It resolves to your address.");
    expect(chain.resolvers.get(registrationName("external").node)).toBe(
      config.contracts.QRLPublicResolver,
    );
    expect(chain.sent.map((tx) => tx.data)).toEqual([
      registrationTransaction("external", ACCOUNT, "resolver", config).data,
    ]);
  });
});

describe("adversarial progress accuracy", () => {
  it("does not describe a proven unrelated transaction as awaiting the next block", async () => {
    const hash = `0x${"d".repeat(64)}`;
    class UnrelatedChain extends MockChain {
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_getTransactionReceipt")
          return Promise.resolve({
            transactionHash: hash,
            blockHash: `0x${"c".repeat(64)}`,
            blockNumber: "0x20",
            status: "0x1",
          });
        if (args.method === "qrl_getTransactionByHash") {
          const tx = registrationTransaction("bob", OTHER, "register", config);
          return Promise.resolve({ ...tx, hash, input: tx.data, nonce: "0x0" });
        }
        return super.request(args);
      }
    }
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      primary: false,
      update: { step: "register", status: "unconfirmed", hash },
    });
    await mount(new UnrelatedChain());
    fireEvent.click(await screen.findByRole("button", { name: "Check confirmation" }));
    await screen.findByText(/does not match the pending step/);
    expect(
      screen.queryByText("Sent (waiting for the next block, about a minute)", { selector: "dd" }),
    ).toBeNull();
  });
});

it("keeps the signing preview on the wallet request when a previous-block snapshot arrives", async () => {
  const alice = registrationName("alice");
  class SnapshotRaceChain extends MockChain {
    arm = false;
    oldSnapshotRead = false;
    head = "0x20";
    rejectApproval: (() => void) | undefined;
    walletRequest: unknown;
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      if (args.method === "qrl_blockNumber") {
        if (this.arm) {
          this.arm = false;
          this.head = "0x21";
          this.addresses.set(alice.node, OTHER);
        }
        return Promise.resolve(this.head);
      }
      if (args.method === "qrl_sendTransaction") {
        this.walletRequest = args.params?.[0];
        this.head = "0x20";
        return new Promise((_, reject) => {
          this.rejectApproval = () => {
            this.head = "0x21";
            reject(Object.assign(new Error("User rejected request"), { code: 4001 }));
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
  const chain = new SnapshotRaceChain();
  chain.seed(alice.name, ACCOUNT);
  chain.resolvers.set(alice.node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(alice.node, ACCOUNT);
  chain.spellings.set(alice.node, alice.name);
  await mount(chain);
  const names = within(screen.getByRole("region", { name: "My names" }));
  const action = await names.findByRole("button", { name: "Make primary name" });
  chain.arm = true;
  fireEvent.click(action);
  await waitFor(() => {
    expect(chain.walletRequest).toBeDefined();
  });
  chain.oldSnapshotRead = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh names" }));
  await waitFor(() => {
    expect(chain.oldSnapshotRead).toBe(true);
  });
  try {
    expect(chain.walletRequest).toMatchObject({
      data: registrationTransaction(alice.name, ACCOUNT, "address", config).data,
    });
    await waitFor(() => {
      expect(screen.queryByText("Searching...")).toBeNull();
    });
    const current = document.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Point the name to your address");
    expect(current?.textContent).toContain("Approve in your wallet now");
    if (!(current instanceof HTMLElement)) throw new Error("Missing current step");
    expect(within(current).getByTitle(config.contracts.QRLPublicResolver ?? "")).toBeDefined();
    expect(within(current).getByText("setAddr(node, owner)")).toBeDefined();
    expect(within(current).queryByText("Skipped")).toBeNull();
  } finally {
    await act(async () => {
      chain.rejectApproval?.();
      await Promise.resolve();
    });
  }
  await screen.findByText("Failed", { selector: "dd" });
  expect(screen.queryByText("Approve in your wallet now", { selector: "dd" })).toBeNull();
  expect(document.querySelector('[aria-current="step"]')?.textContent).toContain(
    "Point the name to your address",
  );
});

const recoveryHash = `0x${"d".repeat(64)}`;
class RecoveryChain extends MockChain {
  patch: Record<string, unknown> = {};
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    const hash = args.params?.[0];
    if (args.method === "qrl_getTransactionReceipt")
      return Promise.resolve({
        transactionHash: hash,
        blockHash: `0x${"c".repeat(64)}`,
        blockNumber: "0x20",
        status: "0x1",
      });
    if (args.method === "qrl_getTransactionByHash") {
      const tx = registrationTransaction("alice", ACCOUNT, "register", config);
      return Promise.resolve({ ...tx, hash, input: tx.data, nonce: "0x0", ...this.patch });
    }
    return super.request(args);
  }
}

async function recoverMismatch(chain: RecoveryChain) {
  savePendingClaim(config, {
    name: "alice.qrl",
    account: ACCOUNT,
    primary: false,
    update: { step: "register", status: "unconfirmed", hash: recoveryHash, nonce: "0x0" },
  });
  await mount(chain);
  fireEvent.click(await screen.findByRole("button", { name: "Check confirmation" }));
  await screen.findByText("Transaction does not match", { selector: "dd" });
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Check confirmation" }).hasAttribute("disabled"),
    ).toBe(false);
  });
}

it.each([
  { field: "sender", patch: { from: OTHER } },
  { field: "contract", patch: { to: OTHER } },
  {
    field: "calldata",
    patch: { input: registrationTransaction("bob", ACCOUNT, "register", config).data },
  },
  { field: "chain", patch: { chainId: "0x1" } },
  { field: "nonce", patch: { nonce: "0x1" } },
  { field: "value", patch: { value: "0x1" } },
])("persists a $field mismatch with every recovery choice available", async ({ patch }) => {
  const chain = new RecoveryChain();
  chain.patch = patch;
  await recoverMismatch(chain);
  expect(readPendingClaim(config, ACCOUNT)?.update.status).toBe("mismatched");
  expect(screen.queryByText(/Sent \(waiting/)).toBeNull();
  expect(screen.queryByText(/waiting for the network/)).toBeNull();
  // A new tab must retain the rejection even when the name's records are complete.
  chain.seed("alice", ACCOUNT);
  const { node, name } = registrationName("alice");
  chain.resolvers.set(node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(node, ACCOUNT);
  chain.spellings.set(node, name);
  cleanup();
  await mount(chain);
  await searchName("alice");
  await screen.findByText("Owned by you");
  expect(screen.getByText("Transaction does not match", { selector: "dd" })).toBeDefined();
  expect(screen.queryByText(/alice.qrl is ready/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Transaction hash"), {
    target: { value: `0x${"D".repeat(64)}` },
  });
  for (const choice of [
    "Check confirmation",
    "Re-check name state",
    "Discard pending state",
    "Track transaction",
  ]) {
    expect(screen.getByRole("button", { name: choice }).hasAttribute("disabled")).toBe(false);
  }
  fireEvent.click(screen.getByRole("button", { name: "Track transaction" }));
  expect(readPendingClaim(config, ACCOUNT)?.update.status).toBe("mismatched");
  expect(screen.queryByText(/Sent \(waiting/)).toBeNull();
  expect(screen.getByText("Transaction does not match", { selector: "dd" })).toBeDefined();
  expect(chain.sent).toHaveLength(0);
});

it.each(["Re-check name state", "Discard pending state", "Track transaction"])(
  "allows %s after rejecting a hash",
  async (choice) => {
    const chain = new RecoveryChain();
    chain.patch = { from: OTHER };
    await recoverMismatch(chain);
    if (choice === "Track transaction") {
      const correctedHash = `0x${"e".repeat(64)}`;
      chain.patch = {};
      chain.seed("alice", ACCOUNT);
      fireEvent.change(screen.getByLabelText("Transaction hash"), {
        target: { value: correctedHash },
      });
      fireEvent.click(screen.getByRole("button", { name: choice }));
      expect(readPendingClaim(config, ACCOUNT)?.update).toMatchObject({
        status: "unconfirmed",
        hash: correctedHash,
      });
      fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
    } else fireEvent.click(screen.getByRole("button", { name: choice }));
    await waitFor(() => {
      expect(readPendingClaim(config, ACCOUNT)).toBeNull();
      expect(screen.queryByText("Transaction does not match", { selector: "dd" })).toBeNull();
    });
    expect(chain.sent).toHaveLength(0);
  },
);
