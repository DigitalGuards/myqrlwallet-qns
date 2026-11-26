import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registrationName, registrationTransaction, type EarlierState } from "@qns/sdk";
import { ACCOUNT, config, MockChain, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { App, leftoverNotice } from "./App";
import { plannedClear } from "./storage";
import { WalletController } from "./wallet";

const alice = registrationName("alice");
const RECORDS = "An earlier owner left records on this name. Claiming clears them.";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);

class FailingLogs extends MockChain {
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    if (args.method === "qrl_getLogs")
      return Promise.reject(new Error("logs are not available on this endpoint"));
    return super.request(args);
  }
}

async function mount(chain: MockChain, connected: boolean, name = "alice") {
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
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  const button = screen.getByRole("button", { name: "Search" });
  await waitFor(() => {
    expect(button.hasAttribute("disabled")).toBe(false);
  });
  fireEvent.click(button);
  await screen.findByText(/^(Available|Owned by you|Registered)$/, { selector: "dd" });
}

function released(owner = OTHER): MockChain {
  const chain = new MockChain();
  chain.seedEarlierOwner(alice.name, owner);
  chain.release(alice.name);
  return chain;
}

describe("earlier owner line", () => {
  it("shows the line before a wallet is connected", async () => {
    await mount(released(), false);
    expect(screen.getByText(RECORDS)).toBeDefined();
  });

  it("lists the clear step, saves it with the claim and sends it right after the claim", async () => {
    const chain = released();
    await mount(chain, true);
    expect(screen.getByText(RECORDS)).toBeDefined();
    const steps = within(screen.getByRole("list", { name: "Claim steps" }));
    expect(steps.getByRole("heading", { name: "Clear earlier records" })).toBeDefined();
    expect(screen.getByText("Wallet approvals").nextElementSibling?.textContent).toBe(
      "4 remaining",
    );
    chain.afterReceipt = () => {
      if (chain.sent.length === 1) expect(plannedClear(config, ACCOUNT, alice.node)).not.toBeNull();
    };
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    await screen.findByText("alice.qrl is ready. It resolves to your address.");
    expect(chain.sent.map((tx) => tx.data)).toEqual(
      (["register", "clear", "address", "name"] as const).map(
        (step) => registrationTransaction(alice.name, ACCOUNT, step, config).data,
      ),
    );
    expect(chain.contenthashes.has(alice.node)).toBe(false);
    // The finished claim no longer carries a clear.
    expect(plannedClear(config, ACCOUNT, alice.node)).toBeNull();
  });

  it("mentions subnames that keep their owners", async () => {
    const chain = released();
    chain.seedSubname(alice.name, "pay", OTHER);
    await mount(chain, false);
    expect(
      screen.getByText(
        "An earlier owner left records and 1 subname on this name. Claiming clears the records; the subname keeps its owner.",
      ),
    ).toBeDefined();
  });

  it("hides the line when logs fail but still plans the clear", async () => {
    const chain = new FailingLogs();
    await mount(chain, true);
    expect(screen.queryByText(/An earlier owner/)).toBeNull();
    const steps = within(screen.getByRole("list", { name: "Claim steps" }));
    expect(steps.getByRole("heading", { name: "Clear earlier records" })).toBeDefined();
  });

  it("stays hidden for a fresh name and for a name the user owns", async () => {
    await mount(new MockChain(), true);
    expect(screen.queryByText(/An earlier owner/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Clear earlier records" })).toBeNull();
    cleanup();
    const owned = new MockChain();
    owned.seedEarlierOwner(alice.name, ACCOUNT);
    await mount(owned, true);
    expect(screen.queryByText(/An earlier owner/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Clear earlier records" })).toBeNull();
  });
});

describe("leftoverNotice", () => {
  const resolver = config.contracts.QRLPublicResolver ?? "";
  const zero = `Q${"0".repeat(128)}`;
  const state = (patch: Partial<EarlierState>): EarlierState => ({
    resolver: zero,
    records: false,
    logs: "none",
    subnames: 0,
    version: 0n,
    needsClear: false,
    ...patch,
  });
  it.each([
    [state({}), null],
    [state({ resolver }), RECORDS],
    [state({ records: true }), RECORDS],
    [state({ logs: "writes" }), RECORDS],
    [state({ resolver, logs: "unavailable", subnames: null }), null],
    [
      state({ subnames: 1 }),
      "An earlier owner left 1 subname under this name. It keeps its owner after you claim it.",
    ],
    [
      state({ subnames: 3 }),
      "An earlier owner left 3 subnames under this name. They keep their owners after you claim it.",
    ],
    [
      state({ records: true, subnames: 2 }),
      "An earlier owner left records and 2 subnames on this name. Claiming clears the records; the subnames keep their owners.",
    ],
  ])("words %#", (leftovers, expected) => {
    expect(leftoverNotice(leftovers)).toBe(expected);
  });
});
