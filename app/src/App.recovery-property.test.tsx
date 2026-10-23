import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registrationName, registrationTransaction, reverseNodeFor } from "@qns/sdk";
import { ACCOUNT, config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import { App } from "./App";
import { readPendingClaim, savePendingClaim } from "./storage";
import { WalletController } from "./wallet";

import {
  renderedRecoveryCases,
  renderedRetryCases,
  type CheckResult,
  type TrackingMode,
} from "./__tests__/recoveryCases";

const hash = `0x${"d".repeat(64)}`;
const earlierHash = `0x${"e".repeat(64)}`;
const ready = "alice.qrl is ready. It resolves to your address and is your primary name.";

// All RPC is in memory. Earlier transactions have already completed every name record.
class RecoveryChain extends MockChain {
  result: CheckResult = "pending";
  receiptObserved = false;
  nonceConsumed = false;
  failAfterCheck = false;
  recordsUnavailable = false;
  failReceipt = false;

  constructor() {
    super();
    const parsed = registrationName("alice");
    this.seed(parsed.name, ACCOUNT);
    this.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
    this.addresses.set(parsed.node, ACCOUNT);
    this.spellings.set(parsed.node, parsed.name);
    this.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    this.primary = parsed.name;
  }

  hasSettlementEvidence(): boolean {
    return this.receiptObserved || this.nonceConsumed;
  }

  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    if (args.method === "qrl_getTransactionReceipt") {
      if (args.params?.[0] === earlierHash)
        return Promise.resolve({
          transactionHash: earlierHash,
          blockHash: `0x${"c".repeat(64)}`,
          blockNumber: "0x10",
          status: "0x1",
        });
      if (this.failReceipt) return Promise.reject(new Error("Receipt RPC timed out"));
      if (this.result !== "confirmed" && this.result !== "reverted" && this.result !== "mismatched")
        return Promise.resolve(null);
      this.receiptObserved = this.result !== "mismatched";
      this.recordsUnavailable = this.failAfterCheck;
      return Promise.resolve({
        transactionHash: hash,
        blockHash: `0x${"c".repeat(64)}`,
        blockNumber: "0x20",
        status: this.result === "confirmed" ? "0x1" : "0x0",
      });
    }
    if (args.method === "qrl_getTransactionByHash") {
      if (args.params?.[0] === earlierHash) {
        const tx = registrationTransaction("alice", ACCOUNT, "primary", config);
        return Promise.resolve({ ...tx, hash: earlierHash, input: tx.data, nonce: "0x6" });
      }
      if (this.result === "not found") return Promise.resolve(null);
      const tx = registrationTransaction(
        this.result === "mismatched" ? "bob" : "alice",
        ACCOUNT,
        "primary",
        config,
      );
      return Promise.resolve({ ...tx, hash, input: tx.data, nonce: "0x7" });
    }
    if (args.method === "qrl_getTransactionCount") {
      this.nonceConsumed = this.result === "replaced";
      this.recordsUnavailable = this.failAfterCheck;
      return Promise.resolve(this.nonceConsumed ? "0x8" : "0x7");
    }
    if (args.method === "qrl_call" && this.recordsUnavailable)
      return Promise.reject(new Error("Name records temporarily unavailable"));
    return super.request(args);
  }
}

async function mount(chain: MockChain): Promise<void> {
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

async function click(label: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText(label, { selector: "button" }));
    await Promise.resolve();
  });
}

async function start(
  chain: RecoveryChain,
  tracked: boolean,
  knownNonce = false,
  tracking: TrackingMode = tracked ? "same hash" : "original",
): Promise<void> {
  savePendingClaim(config, {
    name: "alice.qrl",
    account: ACCOUNT,
    primary: true,
    attemptId: "claim-attempt",
    update: {
      step: "primary",
      status: "unconfirmed",
      requestId: "claim-request",
      ...(knownNonce ? { nonce: "0x7" } : {}),
      hash,
    },
  });
  await mount(chain);
  if (tracked) {
    fireEvent.change(screen.getByLabelText("Transaction hash"), {
      target: { value: tracking === "earlier identical calldata" ? earlierHash : hash },
    });
    await click("Track transaction");
  }
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

it.each(renderedRecoveryCases)(
  "requires original settlement: $trace ($tracking, receiptLookupFailed=$receiptLookupFailed, reload=$reload)",
  async ({ sequence, tracked, tracking, receiptLookupFailed, reload }) => {
    const chain = new RecoveryChain();
    await start(chain, tracked, !receiptLookupFailed, tracking);
    if (receiptLookupFailed) {
      const before = readPendingClaim(config, ACCOUNT);
      chain.failReceipt = true;
      await click("Check confirmation");
      expect(readPendingClaim(config, ACCOUNT)).toEqual(before);
      expect(readPendingClaim(config, ACCOUNT)?.update.nonce).toBeUndefined();
      chain.failReceipt = false;
    }
    expect(readPendingClaim(config, ACCOUNT)).not.toBeNull();
    expect(screen.queryByText(ready)).toBeNull();

    for (const result of sequence) {
      const before = readPendingClaim(config, ACCOUNT);
      if (before) {
        chain.result = result;
        await click("Check confirmation");
      }
      // Settlement closes this recovery flow. Later trace inputs have no check action to invoke.
      const settled = chain.hasSettlementEvidence();
      const saved = readPendingClaim(config, ACCOUNT);
      expect(saved === null).toBe(settled);
      expect(screen.queryByText(ready) !== null && !settled).toBe(false);
      if (!settled) {
        expect(saved?.update).toEqual({
          step: "primary",
          status: result === "mismatched" ? "mismatched" : "unconfirmed",
          requestId: "claim-request",
          hash,
          ...(!receiptLookupFailed ? { nonce: "0x7" } : {}),
        });
        expect(saved?.attemptId).toBe("claim-attempt");
        expect(saved?.trackedHash).toBe(
          tracked ? (tracking === "earlier identical calldata" ? earlierHash : hash) : undefined,
        );
        expect(screen.queryByText(ready)).toBeNull();
      }
      if (before && (result === "confirmed" || result === "replaced"))
        expect(screen.queryByText(ready)).not.toBeNull();
      if (reload && saved) {
        cleanup();
        await mount(chain);
        expect(readPendingClaim(config, ACCOUNT)).toEqual(saved);
        expect(screen.queryByText(ready)).toBeNull();
      }
      expect(chain.sent).toHaveLength(0);
    }
  },
);

it.each(renderedRetryCases)(
  "uses fresh $result after $previous and a record read failure (tracked=$tracked, reload=$reload)",
  async ({ result, previous, tracked, reload }) => {
    const chain = new RecoveryChain();
    await start(chain, tracked, true);
    chain.result = previous === "confirmed" ? "confirmed" : "replaced";
    chain.failAfterCheck = true;
    await click("Check confirmation");
    expect(readPendingClaim(config, ACCOUNT)?.update).toMatchObject({
      status: previous === "confirmed" ? "verification-failed" : "replaced",
      message: "Name records temporarily unavailable",
    });
    expect(screen.queryByText(ready)).toBeNull();

    chain.recordsUnavailable = false;
    chain.failAfterCheck = false;
    chain.receiptObserved = false;
    chain.nonceConsumed = false;
    chain.result = result;
    if (reload) {
      cleanup();
      await mount(chain);
    }
    await click("Check confirmation");
    const settled = chain.hasSettlementEvidence();
    const saved = readPendingClaim(config, ACCOUNT);
    expect(saved === null).toBe(settled);
    expect(screen.queryByText(ready) !== null && !settled).toBe(false);
    if (!settled) {
      expect(saved?.update.status).toBe(result === "mismatched" ? "mismatched" : "unconfirmed");
      expect(saved?.update.message).toBeUndefined();
      expect(saved?.update.hash).toBe(hash);
      expect(saved?.update.nonce).toBe("0x7");
    }
    expect(chain.sent).toHaveLength(0);
  },
);

it.each([false, true])(
  "permits explicit name-state recovery after a mismatch (reload=%s)",
  async (reload) => {
    const chain = new RecoveryChain();
    await start(chain, true);
    chain.result = "mismatched";
    await click("Check confirmation");
    expect(readPendingClaim(config, ACCOUNT)?.update.status).toBe("mismatched");
    if (reload) {
      cleanup();
      await mount(chain);
    }
    await click("Re-check name state");
    expect(readPendingClaim(config, ACCOUNT)).toBeNull();
    expect(screen.queryByText(ready)).not.toBeNull();
    expect(chain.hasSettlementEvidence()).toBe(false);
    expect(chain.sent).toHaveLength(0);
  },
);
