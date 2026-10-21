import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  registrationName,
  registrationTransaction,
  reverseNodeFor,
  type RpcProvider,
} from "@qns/sdk";
import { addressWord, isRecord, selector } from "../../sdk/src/abi";
import { ACCOUNT, OTHER, config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import { App } from "./App";
import { WalletController } from "./wallet";
import { TestWallet } from "./__tests__/mockWallet";
import { readPendingClaim, rememberName, savePendingClaim } from "./storage";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);

async function mount(chain: MockChain, provider: RpcProvider = chain) {
  const controller = new WalletController(config);
  render(<App config={config} provider={provider} controller={controller} />);
  await act(() =>
    controller.connectExtension({
      id: "com.qrlwallet.extension",
      name: "MyQRLWallet Extension",
      provider: { request: (args) => chain.request(args), listen: () => () => {} },
    }),
  );
}

function seedReady(chain: MockChain, name: string) {
  const parsed = registrationName(name);
  chain.seed(parsed.name, ACCOUNT);
  chain.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(parsed.node, ACCOUNT);
  chain.spellings.set(parsed.node, parsed.name);
  rememberName(config, parsed.name);
  return parsed;
}

it.each(["partial", "complete", "failed", "loading"] as const)(
  "counts the open wallet approval and future steps during a %s refresh",
  async (refresh) => {
    const alice = registrationName("alice");
    class SnapshotRace extends MockChain {
      arm = false;
      head = "0x20";
      refreshMode = false;
      resumes: Array<() => void> = [];
      reject: (() => void) | undefined;
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_blockNumber") {
          if (this.refreshMode && refresh === "failed")
            return Promise.reject(new Error("Snapshot unavailable"));
          if (this.refreshMode && refresh === "loading")
            return new Promise((resolve) => {
              this.resumes.push(() => {
                resolve(this.head);
              });
            });
          if (this.arm) {
            this.arm = false;
            this.head = "0x21";
            this.addresses.set(alice.node, OTHER);
          }
          return Promise.resolve(this.head);
        }
        if (args.method === "qrl_sendTransaction") {
          expect(args.params?.[0]).toMatchObject({
            data: registrationTransaction("alice", ACCOUNT, "address", config).data,
          });
          this.head = "0x20";
          return new Promise((_, reject) => {
            this.reject = () => {
              reject(Object.assign(new Error("User rejected request"), { code: 4001 }));
            };
          });
        }
        const call = args.params?.[0];
        if (
          args.method === "qrl_call" &&
          args.params?.[1] === "0x20" &&
          isRecord(call) &&
          typeof call.data === "string" &&
          call.data.startsWith(selector("addr(bytes32)")) &&
          call.data.slice(10, 74) === alice.node.slice(2)
        )
          return Promise.resolve(`0x${addressWord(ACCOUNT)}`);
        return super.request(args);
      }
    }
    const chain = new SnapshotRace();
    seedReady(chain, "alice");
    await mount(chain);
    const names = within(screen.getByRole("region", { name: "My names" }));
    const action = await names.findByRole("button", { name: "Make primary name" });
    chain.arm = true;
    fireEvent.click(action);
    await screen.findByText("Approve in your wallet now", { selector: "dd" });
    chain.refreshMode = true;
    if (refresh === "complete") {
      chain.primary = alice.name;
      chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    }
    fireEvent.click(screen.getByRole("button", { name: "Refresh names" }));
    if (refresh === "failed")
      await screen.findByText("Could not refresh name availability: Snapshot unavailable");
    else if (refresh === "loading")
      await waitFor(() => {
        expect(chain.resumes.length).toBeGreaterThan(0);
      });
    else await screen.findByText("Owned by you");
    try {
      expect(document.querySelector('[aria-current="step"]')?.textContent).toContain(
        "setAddr(node, owner)",
      );
      expect(screen.getByText("Wallet approvals").nextElementSibling?.textContent).toBe(
        "2 remaining",
      );
      const steps = within(screen.getByRole("list", { name: "Claim steps" }));
      expect(steps.getAllByText("Waiting", { selector: "dd" })).toHaveLength(1);
      expect(steps.getAllByText("Skipped", { selector: "dd" })).toHaveLength(3);
    } finally {
      await act(async () => {
        chain.refreshMode = false;
        for (const resume of chain.resumes) resume();
        chain.reject?.();
        await Promise.resolve();
      });
    }
    await screen.findByText("Request declined in your wallet. You can continue when ready.", {
      selector: '[role="alert"]',
    });
    if (refresh === "complete") {
      await screen.findByText(
        "alice.qrl is ready. It resolves to your address and is your primary name.",
      );
      expect(screen.queryByText("Wallet approvals")).toBeNull();
    } else
      expect(screen.getByText("Wallet approvals").nextElementSibling?.textContent).toBe(
        "1 remaining",
      );
  },
);

it.each([false, true])(
  "keeps healthy names usable when a record fails (primary=%s)",
  async (primary) => {
    class PerNameReadFailure extends MockChain {
      failing = true;
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        const call = args.params?.[0];
        if (this.failing && args.method === "qrl_call" && isRecord(call) && call.to === OTHER)
          return Promise.reject(new Error("execution timeout"));
        return super.request(args);
      }
    }
    const chain = new PerNameReadFailure();
    seedReady(chain, "alice");
    const broken = seedReady(chain, "bob");
    chain.resolvers.set(broken.node, OTHER);
    if (primary) {
      chain.primary = broken.name;
      chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    }
    await mount(chain);
    await waitFor(() => {
      expect(screen.queryByText("Reading your names...")).toBeNull();
      expect(chain.calls.some((call) => call.method === "qrl_getLogs")).toBe(true);
    });
    const names = within(screen.getByRole("region", { name: "My names" }));
    expect(names.queryByText("alice.qrl")).not.toBeNull();
    expect(names.queryByRole("button", { name: "Make primary name" })).not.toBeNull();
    const bobRow = names.getByText("bob.qrl").closest("li");
    if (!bobRow) throw new Error("Missing Bob row");
    const bob = within(bobRow);
    expect(bob.getByText("Could not read name records: execution timeout")).toBeDefined();
    expect(bob.queryByRole("button", { name: /Make primary name|Finish name setup/ })).toBeNull();
    expect(bob.queryByText("Address record missing")).toBeNull();
    chain.failing = false;
    fireEvent.click(bob.getByRole("button", { name: "Retry name records" }));
    await names.findByText("Records contract needs setup");
    expect(names.getByRole("button", { name: "Finish name setup" })).toBeDefined();
    expect(names.queryByText("Could not read name records: execution timeout")).toBeNull();
    expect(chain.sent).toHaveLength(0);
  },
);

it("keeps an RPC-verified pending hash saved when legacy recovery metadata has no attempt or nonce", async () => {
  const chain = new MockChain();
  seedReady(chain, "alice");
  const first = await chain.request({
    method: "qrl_sendTransaction",
    params: [registrationTransaction("alice", ACCOUNT, "primary", config)],
  });
  const second = await chain.request({
    method: "qrl_sendTransaction",
    params: [registrationTransaction("alice", ACCOUNT, "primary", config)],
  });
  if (typeof first !== "string" || typeof second !== "string") throw new Error("Missing hashes");
  await chain.request({ method: "qrl_getTransactionReceipt", params: [first] });
  chain.receiptPending = true;
  savePendingClaim(config, {
    name: "alice.qrl",
    account: ACCOUNT,
    primary: true,
    update: { step: "primary", status: "pending", hash: second },
  });
  await mount(chain);
  fireEvent.click(await screen.findByRole("button", { name: "Check confirmation" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Checking..." })).toBeNull();
  });
  await screen.findByText("Owned by you");
  expect(
    chain.calls.some(
      (call) => call.method === "qrl_getTransactionByHash" && call.params?.[0] === second,
    ),
  ).toBe(true);
  expect(await chain.request({ method: "qrl_getTransactionReceipt", params: [second] })).toBeNull();
  expect({
    pendingStillSaved: readPendingClaim(config, ACCOUNT) !== null,
    finishedShown:
      screen.queryByText(
        "alice.qrl is ready. It resolves to your address and is your primary name.",
      ) !== null,
  }).toEqual({ pendingStillSaved: true, finishedShown: false });
});

const recoveryEntries = [
  "hash",
  "attempt",
  "nonce",
  "request",
  "unidentified",
  "tracked hash",
] as const;
it.each(recoveryEntries)("keeps %s recovery pending during a direct state check", async (entry) => {
  const chain = new MockChain();
  seedReady(chain, "alice");
  chain.primary = "alice.qrl";
  chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
  const hash = await chain.request({
    method: "qrl_sendTransaction",
    params: [registrationTransaction("alice", ACCOUNT, "primary", config)],
  });
  if (typeof hash !== "string") throw new Error("Missing hash");
  chain.receiptPending = true;
  savePendingClaim(config, {
    name: "alice.qrl",
    account: ACCOUNT,
    primary: true,
    ...(entry === "attempt" ? { attemptId: "saved-attempt" } : {}),
    update: {
      step: "primary",
      status: "unconfirmed",
      ...(entry === "hash" ? { hash } : {}),
      ...(entry === "nonce" ? { nonce: "0x0" } : {}),
      ...(entry === "request" ? { requestId: 0 } : {}),
    },
  });
  await mount(chain);
  if (entry === "tracked hash") {
    fireEvent.change(screen.getByLabelText("Transaction hash"), { target: { value: hash } });
    fireEvent.click(screen.getByRole("button", { name: "Track transaction" }));
  }
  const saved = readPendingClaim(config, ACCOUNT);
  fireEvent.click(await screen.findByRole("button", { name: "Re-check name state" }));
  await screen.findByText("Owned by you");
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Re-check name state" }).hasAttribute("disabled"),
    ).toBe(false);
  });
  expect(readPendingClaim(config, ACCOUNT)).toEqual(saved);
  expect(
    screen.queryByText("alice.qrl is ready. It resolves to your address and is your primary name."),
  ).toBeNull();
  expect(chain.sent).toHaveLength(1);
  // A saved hash or consumed nonce establishes settlement for the original request.
  chain.receiptPending = false;
  fireEvent.change(screen.getByLabelText("Transaction hash"), { target: { value: hash } });
  fireEvent.click(screen.getByRole("button", { name: "Track transaction" }));
  fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Checking..." })).toBeNull();
  });
  if (entry === "hash" || entry === "nonce") {
    await screen.findByText(
      "alice.qrl is ready. It resolves to your address and is your primary name.",
    );
    expect(readPendingClaim(config, ACCOUNT)).toBeNull();
  } else {
    expect(readPendingClaim(config, ACCOUNT)).toEqual({ ...saved, trackedHash: hash });
    expect(
      screen.queryByText(
        "alice.qrl is ready. It resolves to your address and is your primary name.",
      ),
    ).toBeNull();
  }
  expect(chain.sent).toHaveLength(1);
});

it.each(["Check confirmation", "Re-check name state"])(
  "keeps a late relay hash pending through %s until its own receipt arrives",
  async (action) => {
    const chain = new TestWallet();
    seedReady(chain, "alice");
    chain.primary = "alice.qrl";
    chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    const hash = await chain.request({
      method: "qrl_sendTransaction",
      params: [registrationTransaction("alice", ACCOUNT, "primary", config)],
    });
    if (typeof hash !== "string") throw new Error("Missing hash");
    chain.receiptPending = true;
    chain.connected = true;
    chain.stored = true;
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      primary: true,
      update: { step: "primary", status: "unconfirmed", requestId: 0 },
    });
    const controller = new WalletController(config, () => chain);
    render(<App config={config} provider={chain} controller={controller} />);
    await act(() => controller.pair());
    await screen.findByText(/Check the pending transaction for alice.qrl/);
    act(() => {
      chain.emit("late_response", { id: 0, method: "qrl_sendTransaction", result: hash });
    });
    await screen.findByText("Sent (waiting for the next block, about a minute)", {
      selector: "dd",
    });
    const saved = readPendingClaim(config, ACCOUNT);
    expect(saved?.attemptId).toBeUndefined();
    expect(saved?.update).toEqual({ step: "primary", status: "unconfirmed", requestId: 0, hash });
    fireEvent.click(screen.getByRole("button", { name: action }));
    await screen.findByText(
      "Confirmation is still pending. Re-check name state or discard pending state to continue.",
    );
    expect(readPendingClaim(config, ACCOUNT)).toEqual(saved);
    expect(
      screen.queryByText(
        "alice.qrl is ready. It resolves to your address and is your primary name.",
      ),
    ).toBeNull();
    chain.receiptPending = false;
    fireEvent.click(screen.getByRole("button", { name: action }));
    await screen.findByText(
      "alice.qrl is ready. It resolves to your address and is your primary name.",
    );
    expect(readPendingClaim(config, ACCOUNT)).toBeNull();
    expect(chain.sent).toHaveLength(1);
  },
);

it("counts each wallet approval through the frozen plan and returns to the search plan after failure", async () => {
  class HeldApprovals extends MockChain {
    answer: ((approve: boolean) => void) | undefined;
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      if (args.method === "qrl_sendTransaction")
        return new Promise((resolve, reject) => {
          this.answer = (approve) => {
            this.answer = undefined;
            if (approve) resolve(super.request(args));
            else reject(Object.assign(new Error("User rejected request"), { code: 4001 }));
          };
        });
      return super.request(args);
    }
  }
  const chain = new HeldApprovals();
  await mount(chain);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
  for (let remaining = 5; remaining >= 1; remaining--) {
    await screen.findByText("Approve in your wallet now", { selector: "dd" });
    expect(screen.getByText("Wallet approvals").nextElementSibling?.textContent).toBe(
      `${remaining} remaining`,
    );
    await act(async () => {
      chain.answer?.(remaining > 1);
      await Promise.resolve();
    });
  }
  await screen.findByText("Request declined in your wallet. You can continue when ready.", {
    selector: '[role="alert"]',
  });
  expect(screen.getByText("Wallet approvals").nextElementSibling?.textContent).toBe("1 remaining");
  expect(chain.sent.map((tx) => tx.data)).toEqual(
    (["register", "resolver", "address", "name"] as const).map(
      (step) => registrationTransaction("alice", ACCOUNT, step, config).data,
    ),
  );
  expect(readPendingClaim(config, ACCOUNT)).toBeNull();
  fireEvent.click(screen.getByRole("checkbox"));
  await screen.findByText("alice.qrl is ready. It resolves to your address.");
  expect(screen.queryByText("Wallet approvals")).toBeNull();
});
