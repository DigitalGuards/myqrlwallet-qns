import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  registrationName,
  registrationTransaction,
  reverseNodeFor,
  checkRegistrationTransaction,
} from "@qns/sdk";
import { ACCOUNT, config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import { App } from "./App";
import { WalletController } from "./wallet";
import { readPendingClaim, savePendingClaim } from "./storage";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

async function mount(chain: MockChain) {
  const controller = new WalletController(config);
  render(<App config={config} provider={chain} controller={controller} />);
  await act(() =>
    controller.connectExtension({
      id: "com.qrlwallet.extension",
      name: "MyQRLWallet Extension",
      provider: { request: (args) => chain.request(args), listen: () => () => {} },
    }),
  );
}

function seedReady(chain: MockChain) {
  const parsed = registrationName("alice");
  chain.seed(parsed.name, ACCOUNT);
  chain.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
  chain.addresses.set(parsed.node, ACCOUNT);
  chain.spellings.set(parsed.node, parsed.name);
  chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
  chain.primary = parsed.name;
}

it.each([false, true])(
  "retains recovery after a mismatched hash disappears (reload=%s)",
  async (reload) => {
    class DroppedHash extends MockChain {
      dropped: string | null = null;
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        if (args.method === "qrl_getTransactionByHash" && args.params?.[0] === this.dropped)
          return Promise.resolve(null);
        return super.request(args);
      }
    }
    const chain = new DroppedHash();
    seedReady(chain);
    chain.primary = "";
    chain.resolvers.delete(reverseNodeFor(ACCOUNT));
    const earlier = await chain.request({
      method: "qrl_sendTransaction",
      params: [registrationTransaction("alice", ACCOUNT, "primary", config)],
    });
    const original = await chain.request({
      method: "qrl_sendTransaction",
      params: [registrationTransaction("alice", ACCOUNT, "primary", config)],
    });
    const unrelated = await chain.request({
      method: "qrl_sendTransaction",
      params: [registrationTransaction("bob", ACCOUNT, "primary", config)],
    });
    if (
      typeof earlier !== "string" ||
      typeof original !== "string" ||
      typeof unrelated !== "string"
    )
      throw new Error("Missing hashes");
    await chain.request({ method: "qrl_getTransactionReceipt", params: [earlier] });
    chain.receiptPending = true;
    savePendingClaim(config, {
      name: "alice.qrl",
      account: ACCOUNT,
      primary: true,
      update: { step: "primary", status: "unconfirmed", requestId: "alice-request" },
    });
    await mount(chain);
    await screen.findByRole("button", { name: "Track transaction" });
    fireEvent.change(screen.getByLabelText("Transaction hash"), { target: { value: unrelated } });
    fireEvent.click(screen.getByRole("button", { name: "Track transaction" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check confirmation" }));
    await screen.findByText("Transaction does not match", { selector: "dd" });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Checking..." })).toBeNull();
    });
    expect(readPendingClaim(config, ACCOUNT)?.update.status).toBe("mismatched");
    if (reload) {
      cleanup();
      await mount(chain);
      await screen.findByText("Transaction does not match", { selector: "dd" });
    }
    chain.dropped = unrelated;
    const saved = readPendingClaim(config, ACCOUNT);
    if (!saved) throw new Error("Missing recovery");
    expect(
      await checkRegistrationTransaction(saved.name, saved.account, saved.update, {
        config,
        provider: chain,
      }),
    ).toBe("pending");
    expect(
      await chain.request({ method: "qrl_getTransactionReceipt", params: [original] }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check confirmation" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Checking..." })).toBeNull();
    });
    expect({
      saved: readPendingClaim(config, ACCOUNT)?.update.status ?? null,
      ready:
        screen.queryByText(
          "alice.qrl is ready. It resolves to your address and is your primary name.",
        ) !== null,
    }).toEqual({ saved: "unconfirmed", ready: false });
  },
);
