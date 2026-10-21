import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@qns/sdk";
import { isRecord, selector } from "../../sdk/src/abi";
import { ACCOUNT, config, MockChain, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { App } from "./App";
import { TestWallet } from "./__tests__/mockWallet";
import { savePendingClaim } from "./storage";
import { WalletController } from "./wallet";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const steps: sdk.RegistrationStep[] = ["register", "resolver", "address", "name", "primary"];
const hash = `0x${"d".repeat(64)}`;
const third = `Q${"c".repeat(128)}`;

async function mount(chain = new TestWallet()) {
  const controller = new WalletController(config);
  const view = render(<App config={config} provider={chain} controller={controller} />);
  await act(() =>
    controller.connectExtension({
      id: "com.qrlwallet.extension",
      name: "MyQRLWallet Extension",
      provider: chain,
    }),
  );
  await screen.findByText("Ready");
  return { chain, controller, view };
}
async function search() {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Available", { selector: "dd" });
}
async function expectForeignOwner() {
  const section = within(screen.getByRole("region", { name: "Find your .qrl name" }));
  await section.findByText("Registered", { selector: "dd" });
  expect(section.getByText(OTHER, { selector: "dd" })).toBeDefined();
  expect(section.queryByText("Available", { selector: "dd" })).toBeNull();
  expect(section.queryByText("Owned by you", { selector: "dd" })).toBeNull();
  const button = section.queryByRole("button", { name: /^(Claim name|Complete name setup)$/ });
  if (button) expect(button.hasAttribute("disabled")).toBe(true);
}

describe("foreign owner refresh matrix", () => {
  it("search re-reads ownership", async () => {
    const { chain } = await mount();
    await search();
    chain.seed("alice", OTHER);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await expectForeignOwner();
    expect(chain.sent).toHaveLength(0);
  });

  it.each(steps)("confirmed %s re-reads ownership even with an older SDK state", async (step) => {
    const { chain } = await mount();
    await search();
    let finish: (() => void) | undefined;
    vi.spyOn(sdk, "registerName").mockImplementationOnce(async (_, options) => {
      chain.seed("alice", ACCOUNT);
      const state = await sdk.readRegistrationState("alice", ACCOUNT, { config, provider: chain });
      chain.seed("alice", OTHER);
      options.onUpdate({ step, status: "confirmed", hash });
      options.onState?.(state);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return "alice.qrl";
    });
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    try {
      await expectForeignOwner();
    } finally {
      await act(async () => {
        finish?.();
        await Promise.resolve();
      });
    }
    await expectForeignOwner();
    expect(screen.queryByText("alice.qrl is ready. It resolves to your address.")).toBeNull();
  });

  it.each(
    steps.flatMap((step) => [
      { step, failure: "rejected" },
      { step, failure: "reverted" },
    ]),
  )("$failure $step refreshes ownership", async ({ step, failure }) => {
    const target = steps.indexOf(step) + 1;
    class FailedStep extends TestWallet {
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_sendTransaction" && this.sent.length + 1 === target) {
          this.seed("alice", OTHER);
          if (failure === "rejected") this.rejectSend = target;
          else this.receiptStatus = "0x0";
        }
        return super.request(args);
      }
    }
    const chain = new FailedStep();
    await mount(chain);
    await search();
    fireEvent.click(screen.getByLabelText("Use as my primary name"));
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    await expectForeignOwner();
    expect(chain.sent).toHaveLength(failure === "reverted" ? target : target - 1);
  });

  it("SDK owner detection refreshes ownership before submission", async () => {
    const { chain } = await mount();
    await search();
    chain.seed("alice", OTHER);
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    await expectForeignOwner();
    expect(chain.sent).toHaveLength(0);
  });

  it.each([
    "pending receipt",
    "missing receipt and transaction",
    "reverted receipt",
    "replaced nonce",
    "confirmed receipt with incomplete records",
    "mismatched transaction",
    "receipt RPC failure",
    "direct state check",
    "direct state check with consumed nonce",
    "missing hash",
    "discard",
  ])("recovery: %s refreshes ownership", async (outcome) => {
    class RecoveryChain extends TestWallet {
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_getTransactionReceipt") {
          if (outcome === "receipt RPC failure")
            return Promise.reject(new Error("Receipt unavailable"));
          return Promise.resolve(
            [
              "reverted receipt",
              "confirmed receipt with incomplete records",
              "mismatched transaction",
            ].includes(outcome)
              ? {
                  transactionHash: hash,
                  blockHash: `0x${"e".repeat(64)}`,
                  blockNumber: "0x20",
                  status: outcome === "reverted receipt" ? "0x0" : "0x1",
                }
              : null,
          );
        }
        if (args.method === "qrl_getTransactionByHash")
          return Promise.resolve(
            outcome === "missing receipt and transaction"
              ? null
              : {
                  ...sdk.registrationTransaction("alice", ACCOUNT, "register", config),
                  hash,
                  input: sdk.registrationTransaction("alice", ACCOUNT, "register", config).data,
                  nonce: "0x7",
                  from: outcome === "mismatched transaction" ? OTHER : ACCOUNT,
                },
          );
        return super.request(args);
      }
    }
    const chain = new RecoveryChain();
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: {
        step: "register",
        status: "unconfirmed",
        nonce: "0x7",
        ...(outcome === "missing hash" ? {} : { hash }),
      },
    });
    await mount(chain);
    await search();
    chain.seed("alice", OTHER);
    if (outcome.includes("consumed") || outcome === "replaced nonce") chain.confirmedNonce = 8n;
    fireEvent.click(
      screen.getByRole("button", {
        name:
          outcome === "discard"
            ? "Discard pending state"
            : outcome.startsWith("direct") || outcome === "missing hash"
              ? "Re-check name state"
              : "Check confirmation",
      }),
    );
    await expectForeignOwner();
    expect(chain.sent).toHaveLength(0);
  });

  it.each(["account", "wallet chain", "disconnect", "config", "read provider"])(
    "%s switch refreshes the displayed name",
    async (change) => {
      const { chain, controller, view } = await mount();
      await search();
      chain.seed("alice", OTHER);
      if (change === "config")
        view.rerender(
          <App
            config={{ ...config, network: "another-config" }}
            provider={chain}
            controller={controller}
          />,
        );
      else if (change === "read provider") {
        const next = new TestWallet();
        next.seed("alice", OTHER);
        view.rerender(<App config={config} provider={next} controller={controller} />);
      } else if (change === "disconnect") await act(() => controller.disconnect());
      else
        act(() => {
          if (change === "account") {
            chain.accounts = [third];
            chain.emit("accountsChanged", [third]);
          } else chain.emit("chainChanged", chain.chainId);
        });
      await expectForeignOwner();
      expect(chain.sent).toHaveLength(0);
    },
  );
});

it("discloses incomplete history for a config without the deployment block", () => {
  const legacy = sdk.parseNetworkConfig({ ...config, deploymentBlock: undefined });
  render(
    <App config={legacy} provider={new MockChain()} controller={new WalletController(legacy)} />,
  );
  const section = within(screen.getByRole("region", { name: "My names" }));
  expect(section.getByText(/deployment block is unknown.*may be incomplete/)).toBeDefined();
});

describe("stale ownership responses", () => {
  it.each(
    ["new search", "account", "wallet chain", "config", "read provider", "edit"].flatMap(
      (change) => [
        { change, fails: false },
        { change, fails: true },
      ],
    ),
  )("ignores the older response after $change (fails=$fails)", async ({ change, fails }) => {
    let finish: (() => void) | undefined;
    class DelayedOwner extends TestWallet {
      hold = false;
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        const call = args.params?.[0];
        if (
          this.hold &&
          args.method === "qrl_call" &&
          isRecord(call) &&
          typeof call.data === "string" &&
          call.data.startsWith(selector("owner(bytes32)"))
        ) {
          this.hold = false;
          const snapshot = super.request(args);
          return new Promise((resolve, reject) => {
            finish = () => {
              if (fails) reject(new Error("Older ownership read failed"));
              else resolve(snapshot);
            };
          });
        }
        return super.request(args);
      }
    }
    const chain = new DelayedOwner();
    const { controller, view } = await mount(chain);
    await search();
    chain.hold = true;
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(finish).toBeDefined();
    });
    chain.seed("alice", OTHER);
    if (change === "config")
      view.rerender(
        <App
          config={{ ...config, network: "another-config" }}
          provider={chain}
          controller={controller}
        />,
      );
    else if (change === "read provider") {
      const next = new TestWallet();
      next.seed("alice", OTHER);
      view.rerender(<App config={config} provider={next} controller={controller} />);
    } else if (change === "account" || change === "wallet chain")
      act(() => {
        if (change === "account") {
          chain.accounts = [third];
          chain.emit("accountsChanged", [third]);
        } else chain.emit("chainChanged", chain.chainId);
      });
    else {
      fireEvent.change(screen.getByLabelText("Name"), {
        target: { value: change === "edit" ? "bob" : "ALICE" },
      });
      if (change === "new search") fireEvent.click(screen.getByRole("button", { name: "Search" }));
    }
    if (change !== "edit") await expectForeignOwner();
    await act(async () => {
      finish?.();
      await Promise.resolve();
    });
    if (change !== "edit") await expectForeignOwner();
    else expect(screen.queryByText("alice.qrl", { selector: "dd" })).toBeNull();
    expect(screen.queryByText(/Older ownership read failed/)).toBeNull();
  });
});
