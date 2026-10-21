import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  checkRegistrationTransaction,
  registrationName,
  registrationTransaction,
  reverseNodeFor,
} from "@qns/sdk";
import { MockChain, ACCOUNT, config, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { App } from "./App";
import { WalletController } from "./wallet";
import { readPendingClaim, savePendingClaim } from "./storage";
import { TestWallet } from "./__tests__/mockWallet";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);

const replacementCases = [false, true].flatMap((hashKnown) =>
  [false, true].flatMap((nonceKnown) =>
    (["earlier", "replacement", "unconsumed", "other sender"] as const).map((tracked) => ({
      hashKnown,
      nonceKnown,
      tracked,
    })),
  ),
);

it.each(replacementCases)(
  "requires original nonce settlement for $tracked (hash=$hashKnown, nonce=$nonceKnown)",
  async ({ hashKnown, nonceKnown, tracked }) => {
    const hash = `0x${"d".repeat(64)}`;
    const trackedHash = `0x${"e".repeat(64)}`;
    const tx = registrationTransaction("alice", ACCOUNT, "primary", config);
    class ReplacementChain extends MockChain {
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_getTransactionReceipt")
          return Promise.resolve(
            args.params?.[0] === hash
              ? null
              : {
                  transactionHash: trackedHash,
                  blockHash: `0x${"c".repeat(64)}`,
                  blockNumber: "0x20",
                  status: "0x1",
                },
          );
        if (args.method === "qrl_getTransactionByHash") {
          const original = args.params?.[0] === hash;
          return Promise.resolve({
            ...tx,
            from: !original && tracked === "other sender" ? OTHER : ACCOUNT,
            hash: original ? hash : trackedHash,
            input: tx.data,
            nonce: !original && tracked === "earlier" ? "0x6" : "0x7",
          });
        }
        return super.request(args);
      }
    }
    const chain = new ReplacementChain();
    const parsed = registrationName("alice");
    chain.seed(parsed.name, ACCOUNT);
    chain.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
    chain.addresses.set(parsed.node, ACCOUNT);
    chain.spellings.set(parsed.node, parsed.name);
    chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    chain.primary = parsed.name;
    chain.confirmedNonce = tracked === "replacement" ? 8n : 7n;
    const original = {
      name: parsed.name,
      account: ACCOUNT,
      primary: true,
      attemptId: "original-attempt",
      update: {
        step: "primary",
        status: "unconfirmed",
        requestId: "original-request",
        ...(hashKnown ? { hash } : {}),
        ...(nonceKnown ? { nonce: "0x7" } : {}),
      },
    } as const;
    savePendingClaim(config, original);
    const controller = new WalletController(config);
    render(<App config={config} provider={chain} controller={controller} />);
    await act(() =>
      controller.connectExtension({
        id: "com.qrlwallet.extension",
        name: "MyQRLWallet Extension",
        provider: { request: (args) => chain.request(args), listen: () => () => {} },
      }),
    );
    fireEvent.change(screen.getByLabelText("Transaction hash"), { target: { value: trackedHash } });
    fireEvent.click(screen.getByRole("button", { name: "Track transaction" }));
    expect(readPendingClaim(config, ACCOUNT)).toEqual({ ...original, trackedHash });
    fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Checking..." })).toBeNull();
    });
    const settled = tracked === "replacement" && (hashKnown || nonceKnown);
    expect(readPendingClaim(config, ACCOUNT)).toEqual(
      settled ? null : { ...original, trackedHash },
    );
    expect(
      screen.queryByText(
        "alice.qrl is ready. It resolves to your address and is your primary name.",
      ) !== null,
    ).toBe(settled);
    if (settled)
      expect(chain.calls).toContainEqual({
        method: "qrl_getTransactionCount",
        params: [ACCOUNT, "latest"],
      });
    expect(chain.sent).toHaveLength(0);
  },
);

it("fills a delayed send hash once while preserving the independent tracked hash", async () => {
  const chain = new TestWallet();
  chain.connected = true;
  chain.stored = true;
  const hash = `0x${"d".repeat(64)}`;
  const trackedHash = `0x${"e".repeat(64)}`;
  const original = {
    name: "alice.qrl",
    account: ACCOUNT,
    primary: true,
    attemptId: "original-attempt",
    update: { step: "primary", status: "unconfirmed", requestId: "send-request", nonce: "0x7" },
  } as const;
  savePendingClaim(config, original);
  const controller = new WalletController(config, () => chain);
  render(<App config={config} provider={chain} controller={controller} />);
  await act(() => controller.pair());
  fireEvent.change(screen.getByLabelText("Transaction hash"), { target: { value: trackedHash } });
  fireEvent.click(screen.getByRole("button", { name: "Track transaction" }));
  expect(readPendingClaim(config, ACCOUNT)).toEqual({ ...original, trackedHash });
  act(() => {
    chain.emit("late_response", {
      id: "send-request",
      method: "qrl_sendTransaction",
      result: hash,
    });
  });
  await waitFor(() => {
    expect(readPendingClaim(config, ACCOUNT)).toEqual({
      ...original,
      trackedHash,
      update: { ...original.update, hash },
    });
  });
  act(() => {
    chain.emit("late_response", {
      id: "send-request",
      method: "qrl_sendTransaction",
      result: trackedHash,
    });
  });
  expect(readPendingClaim(config, ACCOUNT)?.update).toEqual({ ...original.update, hash });
  expect(chain.sent).toHaveLength(0);
});

it("keeps the submitted identity usable when pending storage writes fail", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  class ReceiptFailure extends MockChain {
    failReceipt = true;
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      if (args.method === "qrl_getTransactionReceipt" && this.failReceipt)
        return Promise.reject(new Error("Receipt RPC timed out"));
      return super.request(args);
    }
  }
  const chain = new ReceiptFailure();
  const parsed = registrationName("alice");
  chain.seed(parsed.name, ACCOUNT);
  chain.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(parsed.node, ACCOUNT);
  chain.spellings.set(parsed.node, parsed.name);
  const controller = new WalletController(config);
  render(<App config={config} provider={chain} controller={controller} />);
  await act(() =>
    controller.connectExtension({
      id: "com.qrlwallet.extension",
      name: "MyQRLWallet Extension",
      provider: { request: (args) => chain.request(args), listen: () => () => {} },
    }),
  );
  fireEvent.click(
    await within(screen.getByRole("region", { name: "My names" })).findByRole("button", {
      name: "Make primary name",
    }),
  );
  await screen.findByText("Receipt RPC timed out", { selector: '[role="alert"]' });
  const hash = `0x${"1".padStart(64, "0")}`;
  const trackedHash = `0x${"e".repeat(64)}`;
  fireEvent.change(screen.getByLabelText("Transaction hash"), { target: { value: trackedHash } });
  fireEvent.click(screen.getByRole("button", { name: "Track transaction" }));
  chain.failReceipt = false;
  chain.receiptPending = true;
  fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Checking..." })).toBeNull();
  });
  for (const link of screen.getAllByRole("link", { name: "View transaction" }))
    expect(link.getAttribute("href")).toContain(hash);
  expect(
    screen.getByRole("link", { name: "View tracked transaction" }).getAttribute("href"),
  ).toContain(trackedHash);
  expect(
    screen.queryByText("alice.qrl is ready. It resolves to your address and is your primary name."),
  ).toBeNull();
  chain.receiptPending = false;
  chain.receiptStatus = "0x0";
  fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
  await screen.findByText("Failed", { selector: "dd" });
  expect(screen.queryByRole("button", { name: "Check confirmation" })).toBeNull();
  expect(chain.sent).toHaveLength(1);
});
it.each([false, true])(
  "keeps the original transaction pending when tracking an earlier identical operation (reload=%s)",
  async (reload) => {
    const earlierHash = `0x${"1".padStart(64, "0")}`;
    const pendingHash = `0x${"2".padStart(64, "0")}`;
    class Queue extends MockChain {
      firstLookup = true;
      confirmOriginal = false;
      override async request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (
          args.method === "qrl_getTransactionReceipt" &&
          args.params?.[0] === pendingHash &&
          !this.confirmOriginal
        ) {
          if (this.firstLookup) {
            this.firstLookup = false;
            await super.request({ method: "qrl_getTransactionReceipt", params: [earlierHash] });
            throw new Error("Receipt RPC timed out");
          }
          return null;
        }
        return super.request(args);
      }
    }
    const chain = new Queue();
    const parsed = registrationName("alice");
    chain.seed(parsed.name, ACCOUNT);
    chain.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
    chain.addresses.set(parsed.node, ACCOUNT);
    chain.spellings.set(parsed.node, parsed.name);
    await chain.request({
      method: "qrl_sendTransaction",
      params: [registrationTransaction("alice", ACCOUNT, "primary", config)],
    });
    const controller = new WalletController(config);
    render(<App config={config} provider={chain} controller={controller} />);
    await act(() =>
      controller.connectExtension({
        id: "com.qrlwallet.extension",
        name: "MyQRLWallet Extension",
        provider: { request: (args) => chain.request(args), listen: () => () => {} },
      }),
    );
    const names = within(screen.getByRole("region", { name: "My names" }));
    fireEvent.click(await names.findByRole("button", { name: "Make primary name" }));
    await screen.findByText("Receipt RPC timed out", { selector: '[role="alert"]' });
    expect(readPendingClaim(config, ACCOUNT)?.update).toMatchObject({
      hash: pendingHash,
      status: "unconfirmed",
    });
    expect(readPendingClaim(config, ACCOUNT)?.update.nonce).toBeUndefined();
    const original = readPendingClaim(config, ACCOUNT);
    if (!original) throw new Error("Original pending claim missing");
    expect(
      await checkRegistrationTransaction(original.name, original.account, original.update, {
        config,
        provider: chain,
      }),
    ).toBe("pending");
    fireEvent.change(screen.getByLabelText("Transaction hash"), { target: { value: earlierHash } });
    fireEvent.click(screen.getByRole("button", { name: "Track transaction" }));
    expect(readPendingClaim(config, ACCOUNT)).toEqual({ ...original, trackedHash: earlierHash });
    if (reload) {
      cleanup();
      render(<App config={config} provider={chain} controller={controller} />);
    }
    for (const link of screen.getAllByRole("link", { name: "View transaction" }))
      expect(link.getAttribute("href")).toContain(pendingHash);
    expect(
      screen.getByRole("link", { name: "View tracked transaction" }).getAttribute("href"),
    ).toContain(earlierHash);
    fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Checking..." })).toBeNull();
    });
    await screen.findByText("Owned by you", { selector: "dd" });
    expect(
      await chain.request({ method: "qrl_getTransactionReceipt", params: [pendingHash] }),
    ).toBeNull();
    expect(
      await checkRegistrationTransaction(original.name, original.account, original.update, {
        config,
        provider: chain,
      }),
    ).toBe("pending");
    expect(chain.confirmedNonce).toBe(1n);
    expect(chain.sent[1]?.nonce).toBe("0x1");
    expect({
      saved: readPendingClaim(config, ACCOUNT) !== null,
      ready:
        screen.queryByText(
          "alice.qrl is ready. It resolves to your address and is your primary name.",
        ) !== null,
    }).toEqual({ saved: true, ready: false });
    const saved = readPendingClaim(config, ACCOUNT);
    expect(saved?.update.hash).toBe(pendingHash);
    expect(saved?.update.nonce).toBeUndefined();
    expect(saved?.attemptId).toBe(original.attemptId);
    expect(saved?.trackedHash).toBe(earlierHash);
    await within(screen.getByRole("region", { name: "My names" })).findByText(
      "Ready and your primary name",
    );
    chain.confirmOriginal = true;
    fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
    await screen.findByText(
      "alice.qrl is ready. It resolves to your address and is your primary name.",
    );
    expect(readPendingClaim(config, ACCOUNT)).toBeNull();
    expect(chain.sent).toHaveLength(2);
  },
);
