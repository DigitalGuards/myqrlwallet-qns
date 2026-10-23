import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registrationName, registrationTransaction, reverseNodeFor } from "@qns/sdk";
import { ACCOUNT, config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import { App } from "./App";
import { ClaimProgress, ClaimSummary, claimSteps, stepDetails } from "./ClaimProgress";
import { WalletController } from "./wallet";
import { savePendingClaim } from "./storage";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);

async function mount(chain = new MockChain(), connected = true) {
  const controller = new WalletController(config);
  render(<App config={config} provider={chain} controller={controller} />);
  if (connected)
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
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Search" }).hasAttribute("disabled")).toBe(true);
  });
  return { chain, controller };
}

async function search(value = "alice") {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value } });
  const button = screen.getByRole("button", { name: "Search" });
  await waitFor(() => {
    expect(button.hasAttribute("disabled")).toBe(false);
  });
  fireEvent.click(button);
  await screen.findByRole("list", { name: "Claim steps" });
}

function seedRecords(chain: MockChain, name: string, primary = false) {
  const parsed = registrationName(name);
  chain.seed(name, ACCOUNT);
  chain.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(parsed.node, ACCOUNT);
  chain.spellings.set(parsed.node, parsed.name);
  if (primary) {
    chain.primary = parsed.name;
    chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
  }
  return parsed;
}

class GatedChain extends MockChain {
  approve: (() => void) | undefined;
  mine: (() => void) | undefined;
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    if (args.method === "qrl_sendTransaction" || args.method === "qrl_getTransactionReceipt") {
      return new Promise((resolve) => {
        const release = () => {
          resolve(super.request(args));
        };
        if (args.method === "qrl_sendTransaction") this.approve = release;
        else this.mine = release;
      });
    }
    return super.request(args);
  }
}

describe("claim explanations", () => {
  it.each([false, true])("explains an unsearched name (connected=%s)", async (connected) => {
    const { chain } = await mount(new MockChain(), connected);
    expect(screen.getByText("Search for a name to see the steps.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "alice" } });
    expect(screen.getByText("Search for a name to see the steps.")).toBeDefined();
    expect(screen.queryByRole("list", { name: "Claim steps" })).toBeNull();
    expect(screen.queryByText("Registration price")).toBeNull();
    expect(chain.sent).toHaveLength(0);
  });

  it("shows the free price and connection summary beside the disconnected claim steps", async () => {
    const { chain, controller } = await mount(new MockChain(), false);
    await search("ALICE");
    const card = within(screen.getByRole("region", { name: "Find your .qrl name" }));
    const disconnectedSummary = "Connect your wallet to see the approvals alice.qrl needs.";
    expect(card.getByRole("status").textContent).toBe(disconnectedSummary);
    expect(card.getByText("Step 1 of 4")).toBeDefined();
    expect(card.getByRole("button", { name: "Connect wallet to claim" })).toBeDefined();
    expect(card.getByText("Registration price").nextElementSibling?.textContent).toBe("Free");
    expect(card.queryByText("Wallet approvals")).toBeNull();

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
    await card.findByText("Set up alice.qrl: 4 wallet approvals remaining.");
    expect(card.getByText("Registration price").nextElementSibling?.textContent).toBe("Free");
    await act(() => controller.disconnect());
    await card.findByText(disconnectedSummary);
    expect(card.getByText("Registration price").nextElementSibling?.textContent).toBe("Free");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bob" } });
    expect(card.getByRole("status").textContent).toBe("Search for a name to see the steps.");
    expect(card.queryByText("Registration price")).toBeNull();
    expect(chain.sent).toHaveLength(0);
  });

  it.each([false, true])("shows a pending name read (connected=%s)", async (connected) => {
    const { chain } = await mount(new MockChain(), connected);
    let finish: (() => void) | undefined;
    const request = chain.request.bind(chain);
    vi.spyOn(chain, "request").mockImplementation((args) => {
      if (args.method === "qrl_blockNumber")
        return new Promise((resolve) => {
          finish = () => {
            resolve(request(args));
          };
        });
      return request(args);
    });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "ALICE" } });
    const button = screen.getByRole("button", { name: "Search" });
    await waitFor(() => {
      expect(button.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(button);
    await waitFor(() => {
      expect(finish).toBeDefined();
    });
    const card = within(screen.getByRole("region", { name: "Find your .qrl name" }));
    expect(card.getByRole("status").textContent).toBe("Reading alice.qrl...");
    expect(card.getByRole("button", { name: "Searching..." }).hasAttribute("disabled")).toBe(true);
    expect(card.queryByText("Registration price")).toBeNull();
    await act(async () => {
      finish?.();
      await Promise.resolve();
    });
    await card.findByText(
      connected
        ? "Set up alice.qrl: 4 wallet approvals remaining."
        : "Connect your wallet to see the approvals alice.qrl needs.",
    );
    expect(chain.sent).toHaveLength(0);
  });

  it.each([false, true])("points to the retryable read error (connected=%s)", async (connected) => {
    const { chain } = await mount(new MockChain(), connected);
    await search();
    const request = chain.request.bind(chain);
    const failedRead = vi
      .spyOn(chain, "request")
      .mockImplementation((args) =>
        args.method === "qrl_blockNumber"
          ? Promise.reject(new Error("Name lookup failed"))
          : request(args),
      );
    const button = screen.getByRole("button", { name: "Search" });
    await waitFor(() => {
      expect(button.hasAttribute("disabled")).toBe(false);
    });
    fireEvent.click(button);
    const card = within(screen.getByRole("region", { name: "Find your .qrl name" }));
    await card.findByText("Could not refresh name availability: Name lookup failed");
    expect(card.getByRole("status").textContent).toBe("Check the error below and search again.");
    expect(card.getByRole("alert").textContent).toContain("Name lookup failed");
    expect(card.queryByText("Registration price")).toBeNull();
    expect(button.hasAttribute("disabled")).toBe(false);
    failedRead.mockRestore();
    fireEvent.click(button);
    await card.findByText(
      connected
        ? "Set up alice.qrl: 4 wallet approvals remaining."
        : "Connect your wallet to see the approvals alice.qrl needs.",
    );
    expect(card.queryByRole("alert")).toBeNull();
    expect(chain.sent).toHaveLength(0);
  });

  it.each([false, true])(
    "highlights the restored pending step (hash returned=%s)",
    async (hasHash) => {
      savePendingClaim(config, {
        name: "alice.qrl",
        account: ACCOUNT,
        primary: true,
        update: {
          step: "address",
          status: hasHash ? "pending" : "approval",
          ...(hasHash ? { hash: `0x${"d".repeat(64)}` } : {}),
        },
      });
      const { chain } = await mount();
      await screen.findByText(
        hasHash
          ? "Sent (waiting for the next block, about a minute)"
          : "Claiming alice.qrl: 0 of 5 steps done, check your wallet activity.",
      );
      expect(document.querySelector('[aria-current="step"]')?.textContent).toContain(
        "Point the name to your address",
      );
      expect(screen.queryByText("Approve in your wallet now", { selector: "dd" })).toBeNull();
      expect(chain.sent).toHaveLength(0);
    },
  );

  it("requires verified records for the finished state even when every receipt succeeded", () => {
    const props = {
      name: "alice.qrl",
      config,
      primary: true,
      state: null,
      running: false,
      updates: claimSteps.map((step) => ({ step, status: "confirmed" as const })),
    };
    render(
      <>
        <ClaimSummary {...props} />
        <ClaimProgress {...props} />
      </>,
    );
    expect(
      screen.getByText(
        "Claiming alice.qrl: 5 of 5 steps done, search again to verify name records.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/is ready/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows every numbered step, exact signing target, approval and network wait, then removes the action", async () => {
    const chain = new GatedChain();
    await mount(chain);
    await search();
    fireEvent.click(screen.getByLabelText("Use as my primary name"));
    expect(screen.getByTitle(config.contracts.FIFSQRLRegistrar ?? "")).toBeDefined();
    expect(screen.getByText("No Quanta is sent; you pay a small network fee.")).toBeDefined();
    const steps = within(screen.getByRole("list", { name: "Claim steps" })).getAllByRole(
      "listitem",
    );
    expect(steps).toHaveLength(5);
    for (const [index, step] of claimSteps.entries()) {
      const row = steps[index];
      if (!row) throw new Error("Missing step");
      const view = within(row);
      const detail = stepDetails[step];
      expect(view.getByText(`Step ${index + 1} of 5`)).toBeDefined();
      expect(view.getByRole("heading", { name: detail.title })).toBeDefined();
      expect(view.getByText(detail.description("alice.qrl"))).toBeDefined();
      expect(view.getByText("Waiting")).toBeDefined();
    }
    expect(screen.getByText("Free")).toBeDefined();
    expect(screen.getByText("Each approval costs a small fee in Quanta.")).toBeDefined();
    expect(screen.queryByText(/\d+ QRL/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    for (const [index, step] of claimSteps.entries()) {
      await screen.findByText("Approve in your wallet now", { selector: "dd" });
      const current = document.querySelector('[aria-current="step"]');
      expect(current?.textContent).toContain(stepDetails[step].title);
      if (!(current instanceof HTMLElement)) throw new Error("Missing current step");
      const view = within(current);
      const tx = registrationTransaction("alice", ACCOUNT, step, config);
      expect(view.getByTitle(tx.to)).toBeDefined();
      expect(view.getByText(stepDetails[step].function)).toBeDefined();
      expect(view.getByText("No Quanta is sent; you pay a small network fee.")).toBeDefined();
      expect(
        screen.getByText(
          `Claiming alice.qrl: ${index} of 5 steps done, approve in your wallet now.`,
        ),
      ).toBeDefined();
      const approve = chain.approve;
      if (!approve) throw new Error("Missing approval");
      await act(async () => {
        approve();
        await Promise.resolve();
      });
      await screen.findByText("Sent (waiting for the next block, about a minute)", {
        selector: "dd",
      });
      expect(chain.sent).toHaveLength(index + 1);
      expect(
        screen.getByText(`Claiming alice.qrl: ${index} of 5 steps done, waiting for the network.`),
      ).toBeDefined();
      const mine = chain.mine;
      if (!mine) throw new Error("Missing receipt");
      await act(async () => {
        mine();
        await Promise.resolve();
      });
    }
    await screen.findByText(
      "alice.qrl is ready. It resolves to your address and is your primary name.",
    );
    expect(screen.getAllByText("Done", { selector: "dd" })).toHaveLength(5);
    const card = within(screen.getByRole("region", { name: "Find your .qrl name" }));
    expect(
      card.queryByRole("button", { name: /Claim name|Complete name setup|Claim in progress/ }),
    ).toBeNull();
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    await screen.findByText("Ready and your primary name");
    const names = within(screen.getByRole("region", { name: "My names" }));
    expect(names.queryByRole("button", { name: /Finish name setup|Make primary name/ })).toBeNull();
  });

  it("recognizes a completed name on search and after reloading, without an actionable setup button", async () => {
    const chain = new MockChain();
    seedRecords(chain, "alice", true);
    await mount(chain);
    await search();
    await screen.findByText(
      "alice.qrl is ready. It resolves to your address and is your primary name.",
    );
    expect(screen.queryByRole("button", { name: "Complete name setup" })).toBeNull();
    expect(chain.sent).toHaveLength(0);
  });

  it("finishes recovery with a ready message and no setup action", async () => {
    const chain = new MockChain();
    seedRecords(chain, "alice", true);
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      primary: true,
      update: { step: "primary", status: "verification-failed" },
    });
    await mount(chain);
    fireEvent.click(await screen.findByRole("button", { name: "Re-check name state" }));
    await screen.findByText(
      "alice.qrl is ready. It resolves to your address and is your primary name.",
    );
    expect(screen.queryByRole("button", { name: "Complete name setup" })).toBeNull();
    expect(screen.queryByText(/Continue from the first incomplete step/)).toBeNull();
    expect(chain.sent).toHaveLength(0);
  });
});

describe("My names actions", () => {
  it("discovers external names, shows plain states and makes a ready name primary with one approval", async () => {
    const chain = new MockChain();
    seedRecords(chain, "moscowchill", true);
    seedRecords(chain, "qa1789998197");
    await mount(chain);
    const names = within(screen.getByRole("region", { name: "My names" }));
    await names.findByText("Ready and your primary name");
    expect(names.getByText("qa1789998197.qrl")).toBeDefined();
    expect(names.getByText("Ready")).toBeDefined();
    expect(names.getByText("Not set as primary")).toBeDefined();
    fireEvent.click(names.getByRole("button", { name: "Make primary name" }));
    await screen.findByText(
      "qa1789998197.qrl is ready. It resolves to your address and is your primary name.",
    );
    expect(chain.sent.map(({ to, data }) => ({ to, data }))).toEqual([
      {
        to: config.contracts.ReverseRegistrar,
        data: registrationTransaction("qa1789998197", ACCOUNT, "primary", config).data,
      },
    ]);
    expect(screen.getAllByText("Skipped", { selector: "dd" })).toHaveLength(4);
  });

  it.each(["resolver", "address", "name"] as const)(
    "repairs missing %s records with only the required approvals",
    async (missing) => {
      const chain = new MockChain();
      const parsed = seedRecords(chain, "external");
      if (missing === "resolver") chain.resolvers.delete(parsed.node);
      if (missing === "address") chain.addresses.delete(parsed.node);
      if (missing === "name") chain.spellings.delete(parsed.node);
      // A known spelling can come from a prior search in any browser session.
      const { rememberName } = await import("./storage");
      rememberName(config, parsed.name);
      await mount(chain);
      const names = within(screen.getByRole("region", { name: "My names" }));
      const action = await names.findByRole("button", { name: "Finish name setup" });
      expect(
        names.getByText(missing === "name" ? "Name text missing" : "Address record missing"),
      ).toBeDefined();
      fireEvent.click(action);
      await screen.findByText("external.qrl is ready. It resolves to your address.");
      expect(chain.sent).toHaveLength(1);
      expect(chain.sent[0]?.data).toBe(
        registrationTransaction("external", ACCOUNT, missing, config).data,
      );
      expect(screen.queryByRole("button", { name: "Complete name setup" })).toBeNull();
    },
  );

  it("opens the chosen name after another search and does not claim that search result", async () => {
    const chain = new MockChain();
    const parsed = seedRecords(chain, "external");
    chain.addresses.delete(parsed.node);
    await mount(chain);
    await search("different");
    const names = within(screen.getByRole("region", { name: "My names" }));
    fireEvent.click(await names.findByRole("button", { name: "Finish name setup" }));
    await screen.findByText("external.qrl is ready. It resolves to your address.");
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]?.data).toBe(
      registrationTransaction("external", ACCOUNT, "address", config).data,
    );
  });
});
