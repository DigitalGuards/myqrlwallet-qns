import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT, config, MockChain, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { TestWallet } from "./__tests__/mockWallet";
import { registrationName } from "@qns/sdk";
import { App } from "./App";
import { WalletController, type WalletProvider } from "./wallet";
import { readPendingClaim, savePendingClaim } from "./storage";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

async function renderConnected(readChain = new MockChain(), walletChain = readChain) {
  const controller = new WalletController(config);
  const provider: WalletProvider = {
    request: (args) => walletChain.request(args),
    listen: (event, handler) =>
      walletChain instanceof TestWallet ? walletChain.listen(event, handler) : () => {},
  };
  render(<App config={config} provider={readChain} controller={controller} />);
  await act(() =>
    controller.connectExtension({
      id: "com.qrlwallet.extension",
      name: "MyQRLWallet Extension",
      provider,
    }),
  );
  await screen.findByText("Ready");
  return { chain: readChain, controller };
}

async function searchName(value = "ALICE") {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Available", { selector: "dd" });
}

describe("registration page", () => {
  it("keeps undeployed configurations explicit and blocks RPC and writes", async () => {
    const undeployed = {
      ...config,
      contracts: {
        QNSRegistry: null,
        Root: null,
        FIFSQRLRegistrar: null,
        ReverseRegistrar: null,
        QRLPublicResolver: null,
        QRLSignatureVerifier: null,
      },
    };
    const chain = new MockChain();
    render(
      <App config={undeployed} provider={chain} controller={new WalletController(undeployed)} />,
    );
    expect(screen.getByText(/QNS deployment is pending/)).toBeDefined();
    const button = screen.getByRole("button", { name: "Search" });
    expect(button.getAttribute("disabled")).toBe("");
    await Promise.resolve();
    expect(chain.calls).toHaveLength(0);
  });
  it("normalizes, claims, shows transaction links, lists the name and resolves both directions", async () => {
    const { chain } = await renderConnected();
    await searchName();
    expect(screen.getByText("alice.qrl", { selector: "dd" })).toBeDefined();
    fireEvent.click(screen.getByLabelText("Use as my primary name"));
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    await screen.findByText(
      "alice.qrl is ready. It resolves to your address and is your primary name.",
    );
    expect(chain.sent).toHaveLength(5);
    expect(screen.getAllByText("Done", { selector: "dd" })).toHaveLength(5);
    expect(
      screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("href")?.startsWith("https://zondscan.com/tx/")),
    ).toHaveLength(5);
    await screen.findByText("Ready and your primary name");
    expect(screen.queryByRole("button", { name: "Complete name setup" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Name or QRL address"), {
      target: { value: "ALICE.qrl" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await waitFor(() => {
      expect(screen.getAllByText(ACCOUNT).length).toBeGreaterThan(1);
    });
    fireEvent.change(screen.getByLabelText("Name or QRL address"), { target: { value: ACCOUNT } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    await screen.findByText("Primary name");
  });
  it("shows a rejected step and can complete the remaining setup", async () => {
    const chain = new MockChain();
    chain.rejectSend = 2;
    await renderConnected(chain);
    await searchName();
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    await screen.findByText("Request declined in your wallet. You can continue when ready.");
    expect(chain.sent).toHaveLength(1);
    expect(chain.owners.get(registrationName("alice").node)).toBe(ACCOUNT);
    expect(screen.getByText("Owned by you", { selector: "dd" })).toBeDefined();
    expect(screen.queryByText("Available", { selector: "dd" })).toBeNull();
    expect(screen.getByText("Done", { selector: "dd" })).toBeDefined();
    chain.rejectSend = 0;
    fireEvent.click(screen.getByRole("button", { name: "Complete name setup" }));
    await screen.findByText("alice.qrl is ready. It resolves to your address.");
    expect(chain.sent).toHaveLength(4);
    expect(screen.getByText("Skipped")).toBeDefined();
  });
  it.each(["reverted", "rejected"] as const)(
    "refreshes a name taken during approval after the claim is %s",
    async (failure) => {
      let approve: (() => void) | undefined;
      class DelayedApproval extends MockChain {
        override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
          if (args.method === "qrl_sendTransaction")
            return new Promise((resolve, reject) => {
              approve = () => {
                void super.request(args).then(resolve, reject);
              };
            });
          return super.request(args);
        }
      }
      const chain = new DelayedApproval();
      await renderConnected(chain);
      await searchName();
      fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
      await screen.findByText("Approve in your wallet now");
      chain.seed("alice", OTHER);
      if (failure === "reverted") chain.receiptStatus = "0x0";
      else chain.rejectSend = 1;
      const finish = approve;
      if (!finish) throw new Error("Missing wallet approval");
      await act(async () => {
        finish();
        await Promise.resolve();
      });
      await screen.findByText("Failed", { selector: "dd" });
      await screen.findByText("Registered", { selector: "dd" });
      expect(screen.getByText(OTHER, { selector: "dd" })).toBeDefined();
      expect(screen.queryByText("Available", { selector: "dd" })).toBeNull();
      const claimButton = screen.getByRole("button", { name: "Claim name" });
      expect(claimButton.hasAttribute("disabled")).toBe(true);
      fireEvent.click(claimButton);
      expect(chain.sent).toHaveLength(failure === "reverted" ? 1 : 0);
      expect(readPendingClaim(config, ACCOUNT)).toBeNull();
    },
  );
  it("refreshes a name when the SDK finds another owner before submission", async () => {
    const { chain } = await renderConnected();
    await searchName();
    chain.seed("alice", OTHER);
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    await screen.findByText("This name is already owned by another account");
    await screen.findByText("Registered", { selector: "dd" });
    expect(screen.getByText(OTHER, { selector: "dd" })).toBeDefined();
    expect(screen.queryByText("Available", { selector: "dd" })).toBeNull();
    const claimButton = screen.getByRole("button", { name: "Claim name" });
    expect(claimButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(claimButton);
    expect(chain.sent).toHaveLength(0);
    expect(chain.calls.some((request) => request.method === "qrl_sendTransaction")).toBe(false);
    expect(readPendingClaim(config, ACCOUNT)).toBeNull();
  });
  it("clears stale availability if the refresh fails and allows a fresh search", async () => {
    class FailedRefresh extends MockChain {
      failReads = false;
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (this.failReads && args.method === "qrl_call")
          return Promise.reject(new Error("Name lookup failed"));
        return super.request(args);
      }
    }
    const chain = new FailedRefresh();
    chain.receiptStatus = "0x0";
    chain.afterReceipt = () => {
      chain.seed("alice", OTHER);
      chain.failReads = true;
    };
    await renderConnected(chain);
    await searchName();
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    await screen.findByText("Could not refresh name availability: Name lookup failed");
    expect(screen.getAllByText("Transaction reverted").length).toBeGreaterThan(0);
    expect(screen.queryByText("Available", { selector: "dd" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Claim name" })).toBeNull();
    chain.failReads = false;
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Registered", { selector: "dd" });
    expect(screen.getByText(OTHER, { selector: "dd" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Claim name" }).hasAttribute("disabled")).toBe(true);
    expect(chain.sent).toHaveLength(1);
  });
  it("keeps a delayed failure refresh out of a new account's search", async () => {
    let release: (() => void) | undefined;
    class DelayedRefresh extends TestWallet {
      delayRead = false;
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (this.delayRead && args.method === "qrl_call") {
          this.delayRead = false;
          return new Promise((resolve) => {
            release = () => {
              resolve(super.request(args));
            };
          });
        }
        return super.request(args);
      }
    }
    const chain = new DelayedRefresh();
    chain.receiptStatus = "0x0";
    chain.afterReceipt = () => {
      chain.seed("alice", OTHER);
      chain.delayRead = true;
    };
    await renderConnected(chain);
    await searchName();
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    await waitFor(() => {
      expect(release).toBeDefined();
    });
    expect(screen.queryByText("Available", { selector: "dd" })).toBeNull();
    act(() => {
      chain.accounts = [OTHER];
      chain.emit("accountsChanged", [OTHER]);
    });
    await searchName("bob");
    const finish = release;
    if (!finish) throw new Error("Missing delayed availability refresh");
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    const registration = within(screen.getByRole("region", { name: "Find your .qrl name" }));
    expect(registration.getByText("bob.qrl", { selector: "dd" })).toBeDefined();
    expect(registration.queryByText("alice.qrl", { selector: "dd" })).toBeNull();
    expect(registration.getByText("Available", { selector: "dd" })).toBeDefined();
    expect(chain.sent).toHaveLength(1);
  });
  it("blocks claims on a mismatched wallet network", async () => {
    const wallet = new MockChain();
    wallet.chainId = "0x1";
    await renderConnected(new MockChain(), wallet);
    await searchName();
    expect(screen.getByRole("button", { name: "Claim name" }).getAttribute("disabled")).toBe("");
    expect(screen.getByText(/Select chain 3151908/)).toBeDefined();
    expect(wallet.sent).toHaveLength(0);
  });
  it("restores a pending transaction and blocks resubmission", async () => {
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: { step: "register", status: "pending", hash: `0x${"1".repeat(64)}` },
    });
    await renderConnected();
    await searchName();
    expect(screen.getByRole("button", { name: "Claim name" }).getAttribute("disabled")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
    await screen.findByText(/Confirmation is still pending/);
  });
  it("rejects a subdomain and never queries its availability", async () => {
    const { chain } = await renderConnected();
    const before = chain.calls.length;
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "sub.alice.qrl" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Enter one name, such as alice or alice.qrl");
    expect(
      chain.calls.slice(before).some((request) => request.method === "qrl_sendTransaction"),
    ).toBe(false);
  });
  it.each(["0xdeadbeef.qrl", "0xdeadbeef", `q${"a".repeat(128)}.qrl`])(
    "resolves %s as a name",
    async (input) => {
      const chain = new MockChain();
      const { name, node } = registrationName(input);
      chain.seed(name, ACCOUNT);
      chain.resolvers.set(node, config.contracts.QRLPublicResolver ?? "");
      chain.addresses.set(node, ACCOUNT);
      await renderConnected(chain);
      fireEvent.change(screen.getByLabelText("Name or QRL address"), { target: { value: input } });
      fireEvent.click(screen.getByRole("button", { name: "Look up" }));
      const section = within(screen.getByRole("region", { name: "Find an address or name" }));
      await section.findByText(ACCOUNT);
      expect(section.getByText(name)).toBeDefined();
      expect(section.queryByRole("alert")).toBeNull();
    },
  );
  it.each([ACCOUNT, ACCOUNT.toLowerCase(), `0x${ACCOUNT.slice(1)}`])(
    "looks up a complete native address: %s",
    async (address) => {
      await renderConnected();
      fireEvent.change(screen.getByLabelText("Name or QRL address"), {
        target: { value: address },
      });
      fireEvent.click(screen.getByRole("button", { name: "Look up" }));
      await screen.findByText("No verified primary name");
      expect(screen.getByText("Primary name")).toBeDefined();
    },
  );
  it("can discard a replaced hash and claim again", async () => {
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: { step: "register", status: "unconfirmed", hash: `0x${"1".repeat(64)}` },
    });
    const { chain } = await renderConnected();
    fireEvent.click(screen.getByRole("button", { name: "Discard pending state" }));
    await searchName();
    fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
    await screen.findByText("alice.qrl is ready. It resolves to your address.");
    expect(chain.sent).toHaveLength(4);
  });
  it("shows the connected account's own pending state", async () => {
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: { step: "register", status: "unconfirmed", hash: `0x${"1".repeat(64)}` },
    });
    const chain = new MockChain();
    chain.accounts = [OTHER];
    await renderConnected(chain);
    await searchName();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Claim name" }).getAttribute("disabled"),
      ).toBeNull();
    });
  });
  it("rejects a recovery receipt for another account's transaction", async () => {
    const hash = `0x${"2".repeat(64)}`;
    class UnrelatedChain extends MockChain {
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_getTransactionReceipt")
          return Promise.resolve({
            transactionHash: hash,
            blockHash: `0x${"c".repeat(64)}`,
            blockNumber: "0x20",
            status: "0x1",
          });
        if (args.method === "qrl_getTransactionByHash")
          return Promise.resolve({
            hash,
            from: OTHER,
            to: OTHER,
            input: "0x",
            chainId: this.chainId,
            nonce: "0x0",
            value: "0x0",
          });
        return super.request(args);
      }
    }
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: { step: "register", status: "unconfirmed", hash },
    });
    const { chain } = await renderConnected(new UnrelatedChain());
    fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
    await screen.findByText(/does not match the pending step/);
    expect(screen.queryByText("Done", { selector: "dd" })).toBeNull();
    expect(chain.owners.size).toBe(0);
  });
});

describe("pending claim recovery", () => {
  it.each([false, true])(
    "releases recovery controls after switching networks and back (read fails=%s)",
    async (fails) => {
      let release: (() => void) | undefined;
      class DelayedState extends TestWallet {
        delay = false;
        override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
          if (this.delay && args.method === "qrl_blockNumber") {
            this.delay = false;
            return new Promise((resolve, reject) => {
              release = () => {
                if (fails) reject(new Error("Old network read failed"));
                else resolve("0x20");
              };
            });
          }
          return super.request(args);
        }
      }
      const saved = {
        name: "alice.qrl",
        account: ACCOUNT,
        update: { step: "register", status: "unconfirmed" },
      } satisfies Parameters<typeof savePendingClaim>[1];
      savePendingClaim(config, saved);
      const chain = new DelayedState();
      await renderConnected(chain);
      await searchName();
      chain.delay = true;
      fireEvent.click(screen.getByRole("button", { name: "Re-check name state" }));
      await waitFor(() => {
        expect(release).toBeDefined();
      });
      chain.seed("alice", ACCOUNT);
      act(() => {
        chain.chainId = "0x1";
        chain.emit("chainChanged", "0x1");
      });
      await screen.findByText("Select chain 3151908 in your wallet");
      act(() => {
        chain.chainId = "0x301824";
        chain.emit("chainChanged", "0x301824");
      });
      await waitFor(() => {
        expect(screen.queryByText("Select chain 3151908 in your wallet")).toBeNull();
      });
      const finish = release;
      if (!finish) throw new Error("Missing delayed recovery");
      await act(async () => {
        finish();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Re-check name state" }).hasAttribute("disabled"),
        ).toBe(false);
        expect(
          screen.getByRole("button", { name: "Discard pending state" }).hasAttribute("disabled"),
        ).toBe(false);
      });
      expect(readPendingClaim(config, ACCOUNT)).toMatchObject(saved);
      // The network-switch refresh may show current ownership while recovery stays saved.
      await screen.findByText("Owned by you");
      expect(screen.queryByText(/Old network read failed/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Re-check name state" }));
      await screen.findByText(
        "Confirmation is still pending. Re-check name state or discard pending state to continue.",
      );
      expect(readPendingClaim(config, ACCOUNT)).toMatchObject(saved);
      fireEvent.click(screen.getByRole("button", { name: "Discard pending state" }));
      await screen.findByText("Owned by you");
      expect(readPendingClaim(config, ACCOUNT)).toBeNull();
      expect(
        screen.getByRole("button", { name: "Complete name setup" }).hasAttribute("disabled"),
      ).toBe(false);
    },
  );
  it("keeps an unseen hash without a nonce until explicitly discarded", async () => {
    const chain = new MockChain();
    chain.seed("alice", ACCOUNT);
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: { step: "register", status: "unconfirmed", hash: `0x${"d".repeat(64)}` },
    });
    await renderConnected(chain);
    fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
    await screen.findByText(
      "Confirmation is still pending. Re-check name state or discard pending state to continue.",
    );
    expect(readPendingClaim(config, ACCOUNT)?.update.hash).toBe(`0x${"d".repeat(64)}`);
    fireEvent.click(screen.getByRole("button", { name: "Discard pending state" }));
    await screen.findByText("Owned by you");
    expect(readPendingClaim(config, ACCOUNT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Complete name setup" }));
    await screen.findByText("alice.qrl is ready. It resolves to your address.");
    expect(chain.sent).toHaveLength(3);
  });
  it.each([false, true])(
    "recovers a consumed nonce after cancellation or speed-up (registered=%s)",
    async (registered) => {
      const chain = new MockChain();
      chain.confirmedNonce = 8n;
      if (registered) chain.seed("alice", ACCOUNT);
      savePendingClaim(config, {
        name: "alice.qrl",
        account: ACCOUNT,
        primary: true,
        update: {
          step: "register",
          status: "unconfirmed",
          hash: `0x${"d".repeat(64)}`,
          nonce: "0x7",
        },
      });
      await renderConnected(chain);
      fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
      await screen.findByText(/The saved nonce has been used/);
      expect(readPendingClaim(config, ACCOUNT)).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: registered ? "Complete name setup" : "Claim name" }),
      );
      await screen.findByText(
        "alice.qrl is ready. It resolves to your address and is your primary name.",
      );
      expect(chain.sent).toHaveLength(registered ? 4 : 5);
    },
  );
  it("rechecks name state after nonce settlement and resumes with only the missing records", async () => {
    const chain = new MockChain();
    chain.seed("alice", ACCOUNT);
    chain.resolvers.set(registrationName("alice").node, config.contracts.QRLPublicResolver ?? "");
    chain.confirmedNonce = 1n;
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: {
        step: "resolver",
        status: "unconfirmed",
        hash: `0x${"d".repeat(64)}`,
        nonce: "0x0",
      },
    });
    await renderConnected(chain);
    fireEvent.click(screen.getByRole("button", { name: "Re-check name state" }));
    await screen.findByText(/The saved nonce has been used/);
    expect(readPendingClaim(config, ACCOUNT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Complete name setup" }));
    await screen.findByText("alice.qrl is ready. It resolves to your address.");
    expect(chain.sent).toHaveLength(2);
  });
  it("restores separate pending claims when switching accounts in both directions", async () => {
    const wallet = new TestWallet();
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: { step: "register", status: "unconfirmed" },
    });
    savePendingClaim(config, {
      name: "bob.qrl",
      account: OTHER,
      update: { step: "address", status: "unconfirmed" },
    });
    const controller = new WalletController(config);
    render(<App config={config} provider={wallet} controller={controller} />);
    await act(() =>
      controller.connectExtension({
        id: "com.qrlwallet.extension",
        name: "MyQRLWallet Extension",
        provider: wallet,
      }),
    );
    await screen.findByText(/Check the pending transaction for alice.qrl/);
    act(() => {
      wallet.accounts = [OTHER];
      wallet.emit("accountsChanged", [OTHER]);
    });
    await screen.findByText(/Check the pending transaction for bob.qrl/);
    fireEvent.click(screen.getByRole("button", { name: "Discard pending state" }));
    expect(readPendingClaim(config, OTHER)).toBeNull();
    act(() => {
      wallet.accounts = [ACCOUNT];
      wallet.emit("accountsChanged", [ACCOUNT]);
    });
    await screen.findByText(/Check the pending transaction for alice.qrl/);
    expect(readPendingClaim(config, ACCOUNT)?.name).toBe("alice.qrl");
  });
  it.each(["hash", "rejection"])(
    "ignores an older request's late %s and accepts only a matching ID",
    async (kind) => {
      const hash = `0x${"d".repeat(64)}`;
      savePendingClaim(config, {
        name: "alice.qrl",
        account: ACCOUNT,
        update: {
          step: "register",
          status: "unconfirmed",
          nonce: "0x1",
          requestId: "alice-request",
        },
      });
      const relay = new TestWallet();
      relay.connected = true;
      relay.stored = true;
      const controller = new WalletController(config, () => relay);
      render(<App config={config} provider={relay} controller={controller} />);
      await act(() => controller.pair());
      await screen.findByText(/Check the pending transaction for alice.qrl/);
      const result = kind === "hash" ? { result: hash } : { error: { code: 4001 } };
      act(() => {
        relay.emit("late_response", {
          id: "older-bob-request",
          method: "qrl_sendTransaction",
          ...result,
        });
      });
      expect(readPendingClaim(config, ACCOUNT)?.update).toMatchObject({
        requestId: "alice-request",
      });
      expect(readPendingClaim(config, ACCOUNT)?.update.hash).toBeUndefined();
      act(() => {
        relay.emit("late_response", {
          id: "alice-request",
          method: "qrl_sendTransaction",
          ...result,
        });
      });
      if (kind === "hash") {
        await waitFor(() => {
          expect(readPendingClaim(config, ACCOUNT)?.update.hash).toBe(hash);
        });
        expect(screen.queryByText("Done", { selector: "dd" })).toBeNull();
      } else
        await waitFor(() => {
          expect(readPendingClaim(config, ACCOUNT)).toBeNull();
        });
    },
  );
  it("ignores late responses when the saved request has no known ID", async () => {
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      update: { step: "register", status: "unconfirmed" },
    });
    const relay = new TestWallet();
    relay.connected = true;
    const controller = new WalletController(config, () => relay);
    render(<App config={config} provider={relay} controller={controller} />);
    await act(() => controller.pair());
    await screen.findByText(/Check the pending transaction for alice.qrl/);
    act(() => {
      relay.emit("late_response", {
        id: "unknown-request",
        method: "qrl_sendTransaction",
        result: `0x${"d".repeat(64)}`,
      });
    });
    expect(readPendingClaim(config, ACCOUNT)?.update.hash).toBeUndefined();
  });
});

it("keeps an old approval promise out of a newer claim with the same name and nonce", async () => {
  const requests: Array<(value: unknown) => void> = [];
  class DelayedWallet extends TestWallet {
    override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
      if (args.method === "qrl_sendTransaction")
        return new Promise((resolve) => {
          requests.push(resolve);
        });
      return super.request(args);
    }
  }
  const chain = new MockChain();
  const wallet = new DelayedWallet();
  const controller = new WalletController(config);
  render(<App config={config} provider={chain} controller={controller} />);
  await act(() =>
    controller.connectExtension({
      id: "com.qrlwallet.extension",
      name: "MyQRLWallet Extension",
      provider: wallet,
    }),
  );
  await screen.findByText("Ready");
  await searchName();
  fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  act(() => {
    wallet.accounts = [OTHER];
    wallet.emit("accountsChanged", [OTHER]);
  });
  act(() => {
    wallet.accounts = [ACCOUNT];
    wallet.emit("accountsChanged", [ACCOUNT]);
  });
  await screen.findByRole("button", { name: "Discard pending state" });
  fireEvent.click(screen.getByRole("button", { name: "Discard pending state" }));
  await searchName();
  fireEvent.click(screen.getByRole("button", { name: "Claim name" }));
  await waitFor(() => {
    expect(requests).toHaveLength(2);
  });
  const current = readPendingClaim(config, ACCOUNT);
  const old = requests[0];
  const next = requests[1];
  if (!old || !next) throw new Error("Expected two approval requests");
  await act(async () => {
    old(`0x${"d".repeat(64)}`);
    await Promise.resolve();
  });
  expect(readPendingClaim(config, ACCOUNT)).toEqual(current);
  expect(readPendingClaim(config, ACCOUNT)?.update.hash).toBeUndefined();
  await act(async () => {
    next(null);
    await Promise.resolve();
  });
});
