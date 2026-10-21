import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registrationName, type RpcProvider } from "@qns/sdk";
import { ACCOUNT, config, MockChain, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { App } from "./App";
import { TestWallet } from "./__tests__/mockWallet";
import { WalletController } from "./wallet";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

type Outcome = "confirmed" | "rejected" | "reverted";
type WalletChange = "account" | "network";
const outcomes: Outcome[] = ["confirmed", "rejected", "reverted"];
const changes: WalletChange[] = ["account", "network"];
const third = `Q${"c".repeat(128)}`;

class DelayedSettlement extends TestWallet {
  private held = false;
  private mined = false;
  resume: (() => void) | undefined;

  constructor(private readonly outcome: Outcome) {
    super();
  }

  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    if (args.method === "qrl_blockNumber") return Promise.resolve(this.mined ? "0x20" : "0x1f");
    if (
      !this.held &&
      args.method ===
        (this.outcome === "rejected" ? "qrl_sendTransaction" : "qrl_getTransactionReceipt")
    ) {
      this.held = true;
      return new Promise((resolve) => {
        this.resume = () => {
          this.mined = true;
          if (this.outcome === "rejected") this.rejectSend = 1;
          else if (this.outcome === "reverted") this.receiptStatus = "0x0";
          resolve(super.request(args));
        };
      });
    }
    return super.request(args);
  }
}

async function search(name: string) {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Available", { selector: "dd" });
}

async function startClaim(outcome: Outcome) {
  const chain = new DelayedSettlement(outcome);
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
  await search("alice");
  fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
  await waitFor(() => {
    expect(chain.resume).toBeDefined();
  });
  return { chain, controller };
}

async function switchWallet(chain: DelayedSettlement, change: WalletChange) {
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
}

async function settle(chain: DelayedSettlement) {
  const resume = chain.resume;
  if (!resume) throw new Error("Missing delayed settlement");
  await act(async () => {
    resume();
    await Promise.resolve();
  });
}

async function expectOwner(name: string, owner: string, account: string) {
  const section = within(screen.getByRole("region", { name: "Find your .qrl name" }));
  await waitFor(() => {
    expect(section.queryByText("Available", { selector: "dd" })).toBeNull();
    expect(section.getByText(`${name}.qrl`, { selector: "dd" })).toBeDefined();
    expect(section.getByText(owner, { selector: "dd" })).toBeDefined();
    expect(
      section.getByText(owner === account ? "Owned by you" : "Registered", { selector: "dd" }),
    ).toBeDefined();
  });
  if (owner !== account)
    expect(section.getByRole("button", { name: "Claim name" }).hasAttribute("disabled")).toBe(true);
}

describe("claim settlement after wallet changes", () => {
  it.each(changes.flatMap((change) => outcomes.map((outcome) => ({ change, outcome }))))(
    "refreshes after $outcome settles following a $change switch",
    async ({ change, outcome }) => {
      const { chain, controller } = await startClaim(outcome);
      await switchWallet(chain, change);
      expect(chain.owners.has(registrationName("alice").node)).toBe(false);
      // Another account can take the name after the switch refresh completes.
      if (outcome !== "confirmed") chain.seed("alice", third);
      await settle(chain);
      const owner = outcome === "confirmed" ? ACCOUNT : third;
      expect(chain.owners.get(registrationName("alice").node)).toBe(owner);
      await expectOwner("alice", owner, change === "account" ? OTHER : ACCOUNT);
      expect(controller.getSnapshot().account).toBe(change === "account" ? OTHER : ACCOUNT);
      expect(chain.sent).toHaveLength(outcome === "rejected" ? 0 : 1);
    },
  );

  it.each(outcomes)(
    "refreshes the newly selected name taken after the account switch when %s settles",
    async (outcome) => {
      const { chain } = await startClaim(outcome);
      await switchWallet(chain, "account");
      await search("bob");
      chain.seed("bob", third);
      await settle(chain);
      await expectOwner("bob", third, OTHER);
      const section = within(screen.getByRole("region", { name: "Find your .qrl name" }));
      expect(section.queryByText("alice.qrl", { selector: "dd" })).toBeNull();
      expect(chain.sent).toHaveLength(outcome === "rejected" ? 0 : 1);
    },
  );
});
