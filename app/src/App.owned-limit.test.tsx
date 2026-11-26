import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ACCOUNT, config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import { App, uncheckedNotice } from "./App";
import { WalletController } from "./wallet";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);

it("says how many names My names left unchecked", async () => {
  const chain = new MockChain();
  for (let i = 0; i < 502; i++) chain.seed(`n${String(i)}`, ACCOUNT);
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
  const names = within(screen.getByRole("region", { name: "My names" }));
  expect(await names.findByText(uncheckedNotice(2), {}, { timeout: 10000 })).toBeDefined();
});

it("words the unchecked-names line", () => {
  expect(uncheckedNotice(1)).toBe(
    "1 more name from this address's history was not checked. Search for a name to check it.",
  );
  expect(uncheckedNotice(7)).toBe(
    "7 more names from this address's history were not checked. Search for a name to check it.",
  );
});
