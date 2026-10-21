import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registrationName, registrationTransaction, type RpcProvider } from "@qns/sdk";
import { ACCOUNT, config, MockChain, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { App } from "./App";
import { TestWallet } from "./__tests__/mockWallet";
import { savePendingClaim } from "./storage";
import { WalletController } from "./wallet";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);
const third = `Q${"c".repeat(128)}`;
type Outcome = "confirmed" | "reverted" | "RPC failure";
type Change = "account" | "network";
const outcomes: Outcome[] = ["confirmed", "reverted", "RPC failure"];
const changes: Change[] = ["account", "network"];

class DelayedRecovery extends TestWallet {
  held = false;
  mined = false;
  resume: (() => void) | undefined;
  constructor(private readonly outcome: Outcome) {
    super();
  }
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    if (args.method === "qrl_blockNumber") return Promise.resolve(this.mined ? "0x20" : "0x1f");
    if (args.method === "qrl_getTransactionReceipt" && !this.held) {
      this.held = true;
      return new Promise((resolve, reject) => {
        this.resume = () => {
          this.mined = true;
          if (this.outcome !== "confirmed") this.seed("alice", third);
          if (this.outcome === "RPC failure") reject(new Error("Receipt temporarily unavailable"));
          else {
            if (this.outcome === "reverted") this.receiptStatus = "0x0";
            resolve(super.request(args));
          }
        };
      });
    }
    return super.request(args);
  }
}

it.each(changes.flatMap((change) => outcomes.map((outcome) => ({ change, outcome }))))(
  "refreshes delayed recovery after $change switch and $outcome settlement",
  async ({ change, outcome }) => {
    const chain = new DelayedRecovery(outcome);
    const hash = await chain.request({
      method: "qrl_sendTransaction",
      params: [registrationTransaction("alice", ACCOUNT, "register", config)],
    });
    if (typeof hash !== "string") throw new Error("Invalid mock hash");
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: { step: "register", status: "unconfirmed", hash },
    });
    const provider: RpcProvider = {
      request: (args) =>
        args.method === "qrl_chainId" ? Promise.resolve("0x301824") : chain.request(args),
    };
    const controller = new WalletController(config);
    render(<App config={config} provider={provider} controller={controller} />);
    await act(() =>
      controller.connectExtension({
        id: "com.qrlwallet.extension",
        name: "MyQRLWallet Extension",
        provider: chain,
      }),
    );
    await screen.findByText("Ready");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Available", { selector: "dd" });
    fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
    await waitFor(() => {
      expect(chain.resume).toBeDefined();
    });
    await act(async () => {
      if (change === "account") {
        chain.accounts = [OTHER];
        chain.emit("accountsChanged", [OTHER]);
      } else {
        chain.chainId = "0x1";
        chain.emit("chainChanged", chain.chainId);
      }
      await Promise.resolve();
    });
    if (change === "network")
      await act(async () => {
        chain.chainId = "0x301824";
        chain.emit("chainChanged", chain.chainId);
        await Promise.resolve();
      });
    await screen.findByText("Available", { selector: "dd" });
    expect(chain.owners.has(registrationName("alice").node)).toBe(false);
    await act(async () => {
      chain.resume?.();
      await Promise.resolve();
    });
    const expectedOwner = outcome === "confirmed" ? ACCOUNT : third;
    expect(chain.owners.get(registrationName("alice").node)).toBe(expectedOwner);
    const section = within(screen.getByRole("region", { name: "Find your .qrl name" }));
    await waitFor(() => {
      expect(section.queryByText("Available", { selector: "dd" })).toBeNull();
      expect(section.getByText(expectedOwner, { selector: "dd" })).toBeDefined();
    });
    expect(chain.sent).toHaveLength(1);
  },
);
