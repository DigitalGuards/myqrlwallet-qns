import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registrationName, registrationTransaction } from "@qns/sdk";
import type { MockChain } from "../../sdk/src/__tests__/mockProvider";
import { ACCOUNT, config } from "../../sdk/src/__tests__/mockProvider";
import { isRecord, selector } from "../../sdk/src/abi";
import { App } from "./App";
import { WalletController } from "./wallet";
import { TestWallet } from "./__tests__/mockWallet";
import { readPendingClaim, savePendingClaim } from "./storage";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

async function mount(chain: TestWallet) {
  chain.connected = true;
  chain.stored = true;
  const controller = new WalletController(config, () => chain);
  render(<App config={config} provider={chain} controller={controller} />);
  await act(() => controller.pair());
  await screen.findByText(/Check the pending transaction for alice.qrl/);
}

async function searchBob() {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bob" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Available", { selector: "dd" });
}

function expectBobPreview() {
  expect(document.querySelector(".claim-summary")?.textContent).toBe(
    "Set up bob.qrl: 4 wallet approvals remaining.",
  );
  expect(document.querySelector('[aria-current="step"]')?.textContent).toContain(
    "Registers bob.qrl",
  );
  expect(screen.queryByText("Failed", { selector: "dd" })).toBeNull();
  expect(screen.queryByText("Done", { selector: "dd" })).toBeNull();
}

// The reviewer's restored-request probe also checks the selected name's preview.
it.each(["rejection", "success"] as const)(
  "keeps a late %s attached to its name after searching another name",
  async (outcome) => {
    const chain = new TestWallet();
    const hash = `0x${"d".repeat(64)}`;
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      primary: false,
      update: { step: "register", status: "unconfirmed", requestId: "alice-request" },
    });
    await mount(chain);
    await searchBob();
    act(() => {
      chain.emit("late_response", {
        id: "alice-request",
        method: "qrl_sendTransaction",
        ...(outcome === "rejection" ? { error: { code: 4001 } } : { result: hash }),
      });
    });
    if (outcome === "rejection") {
      await waitFor(() => {
        expect(readPendingClaim(config, ACCOUNT)).toBeNull();
      });
      await screen.findByText("Request declined in your wallet. You can continue when ready.", {
        selector: '[role="alert"]',
      });
    } else
      await waitFor(() => {
        expect(readPendingClaim(config, ACCOUNT)).toMatchObject({
          name: "alice.qrl",
          update: { requestId: "alice-request", hash },
        });
      });
    await screen.findByText("Available", { selector: "dd" });
    expectBobPreview();
    expect(chain.sent).toHaveLength(0);
  },
);

it.each(["confirmed", "reverted", "read failure"] as const)(
  "keeps a delayed %s recovery result out of a newer name search",
  async (outcome) => {
    class DelayedRecovery extends TestWallet {
      resume: (() => void) | undefined;
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_getTransactionReceipt" && !this.resume)
          return new Promise((resolve, reject) => {
            this.resume = () => {
              if (outcome === "read failure") reject(new Error("Receipt unavailable"));
              else {
                if (outcome === "reverted") this.receiptStatus = "0x0";
                resolve(super.request(args));
              }
            };
          });
        return super.request(args);
      }
    }
    const chain = new DelayedRecovery();
    const hash = await chain.request({
      method: "qrl_sendTransaction",
      params: [registrationTransaction("alice", ACCOUNT, "register", config)],
    });
    if (typeof hash !== "string") throw new Error("Missing mock hash");
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: { step: "register", status: "unconfirmed", hash, requestId: "alice-request" },
    });
    await mount(chain);
    fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
    await waitFor(() => {
      expect(chain.resume).toBeDefined();
    });
    await searchBob();
    await act(async () => {
      chain.resume?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Checking..." })).toBeNull();
    });
    await screen.findByText("Available", { selector: "dd" });
    expectBobPreview();
    expect(readPendingClaim(config, ACCOUNT)?.name ?? null).toBe(
      outcome === "read failure" ? "alice.qrl" : null,
    );
    if (outcome === "confirmed") {
      const names = within(screen.getByRole("region", { name: "My names" }));
      await names.findByText("alice.qrl");
    }
    expect(chain.sent).toHaveLength(1);
  },
);

it("drops a delayed name snapshot after a newer search request", async () => {
  const alice = registrationName("alice");
  class DelayedSnapshot extends TestWallet {
    hold = false;
    resumes: (() => void)[] = [];
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      const call = args.params?.[0];
      if (
        this.hold &&
        args.method === "qrl_call" &&
        isRecord(call) &&
        typeof call.data === "string" &&
        call.data === selector("available(bytes32)") + alice.labelHash.slice(2) + "0".repeat(64)
      )
        return new Promise((resolve) => {
          this.resumes.push(() => {
            resolve(super.request(args));
          });
        });
      return super.request(args);
    }
  }
  const chain = new DelayedSnapshot();
  savePendingClaim(config, {
    name: "alice.qrl",
    account: ACCOUNT,
    update: { step: "register", status: "unconfirmed", requestId: "alice-request" },
  });
  await mount(chain);
  chain.hold = true;
  fireEvent.click(screen.getByRole("button", { name: "Re-check name state" }));
  await waitFor(() => {
    expect(chain.resumes.length).toBeGreaterThan(0);
  });
  await searchBob();
  await act(async () => {
    chain.hold = false;
    for (const resume of chain.resumes) resume();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Re-check name state" }).hasAttribute("disabled"),
    ).toBe(false);
  });
  await screen.findByText("Available", { selector: "dd" });
  expectBobPreview();
  expect(readPendingClaim(config, ACCOUNT)?.update.requestId).toBe("alice-request");
  expect(chain.sent).toHaveLength(0);
});

it("drops an older recovery check after the same request receives its late hash", async () => {
  class DelayedNonce extends TestWallet {
    resume: (() => void) | undefined;
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      if (args.method === "qrl_getTransactionCount" && !this.resume)
        return new Promise((resolve) => {
          this.resume = () => {
            resolve("0x1");
          };
        });
      return super.request(args);
    }
  }
  const chain = new DelayedNonce();
  const hash = `0x${"d".repeat(64)}`;
  savePendingClaim(config, {
    name: "alice.qrl",
    account: ACCOUNT,
    update: {
      step: "register",
      status: "unconfirmed",
      requestId: "alice-request",
      nonce: "0x0",
    },
  });
  await mount(chain);
  fireEvent.click(screen.getByRole("button", { name: "Re-check name state" }));
  await waitFor(() => {
    expect(chain.resume).toBeDefined();
  });
  await searchBob();
  act(() => {
    chain.emit("late_response", {
      id: "alice-request",
      method: "qrl_sendTransaction",
      result: hash,
    });
  });
  await waitFor(() => {
    expect(readPendingClaim(config, ACCOUNT)?.update.hash).toBe(hash);
  });
  await act(async () => {
    chain.resume?.();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Re-check name state" }).hasAttribute("disabled"),
    ).toBe(false);
  });
  expect(readPendingClaim(config, ACCOUNT)).toMatchObject({
    name: "alice.qrl",
    update: { requestId: "alice-request", status: "unconfirmed", hash },
  });
  await screen.findByText("Available", { selector: "dd" });
  expectBobPreview();
  expect(chain.sent).toHaveLength(0);
});
