import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ACCOUNT, config, MockChain, OTHER } from "../../sdk/src/__tests__/mockProvider";
import { TestExtension } from "./__tests__/mockExtension";
import { App } from "./App";
import { extensionAnnouncement, WalletController } from "./wallet";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

function setup(connected = false) {
  const extension = new TestExtension();
  extension.locked = !connected;
  extension.granted = connected;
  const choice = extensionAnnouncement({
    info: { rdns: "com.qrlwallet.extension", uuid: "test-extension", name: "Wallet" },
    provider: extension,
  });
  if (!choice) throw new Error("Missing extension choice");
  const controller = new WalletController(config);
  const chain = new MockChain();
  render(<App config={config} provider={chain} controller={controller} />);
  return { controller, extension, choice, chain };
}

it("disconnects during locked approval and reconnects after late approval without another prompt", async () => {
  const { controller, extension, choice, chain } = setup();
  let request: Promise<void> | undefined;
  await act(async () => {
    request = controller.connectExtension(choice);
    await Promise.resolve();
  });
  expect(screen.getByText("Unlock and approve in MyQRLWallet Extension")).toBeDefined();
  const disconnect = within(screen.getByRole("banner")).getByRole("button", { name: "Disconnect" });
  expect(disconnect.hasAttribute("disabled")).toBe(false);
  fireEvent.click(disconnect);
  await screen.findByText("Disconnected", { selector: "dd" });
  expect(extension.calls.at(-1)).toEqual({
    method: "wallet_revokePermissions",
    params: [{ qrl_accounts: {} }],
  });
  await act(async () => {
    extension.unlock();
    extension.approve();
    await request;
  });
  expect(extension.granted).toBe(true);
  expect(extension.calls.filter((call) => call.method === "wallet_revokePermissions")).toHaveLength(
    1,
  );
  expect(screen.getByText("Disconnected", { selector: "dd" })).toBeDefined();
  expect(
    within(screen.getByRole("banner")).getByRole("button", { name: "Connect wallet" }),
  ).toBeDefined();
  expect(screen.queryByText(ACCOUNT)).toBeNull();
  expect(extension.approvals).toHaveLength(1);

  await act(() => controller.connectExtension(choice));
  expect(screen.getByText("Connected", { selector: "dd" })).toBeDefined();
  expect(screen.getByText(ACCOUNT)).toBeDefined();
  expect(extension.approvals).toHaveLength(1);
  expect(extension.calls.filter((call) => call.method === "qrl_requestAccounts")).toHaveLength(2);
  expect(extension.calls.filter((call) => call.method === "wallet_revokePermissions")).toHaveLength(
    1,
  );
  expect(chain.sent).toHaveLength(0);
  expect(extension.sent).toHaveLength(0);
});

it("offers Connect again while locked and disables claims when locked, multi-account or disconnected", async () => {
  const { controller, extension, choice, chain } = setup(true);
  await act(() => controller.connectExtension(choice));
  await screen.findByText("Ready", { selector: "dd" });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("Available", { selector: "dd" });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Claim name" }).hasAttribute("disabled")).toBe(false);
  });
  act(() => {
    extension.lock();
  });
  expect(
    screen.getByText("Wallet locked. Unlock the extension, or press Disconnect."),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "Claim name" })).toBeNull();
  expect(screen.getByRole("button", { name: "Connect again" })).toBeDefined();
  expect(
    within(screen.getByRole("banner"))
      .getByRole("button", { name: "Disconnect" })
      .hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Connect again" }));
  await waitFor(() => {
    expect(extension.approvals).toHaveLength(1);
  });
  expect(screen.getByText("Unlock and approve in MyQRLWallet Extension")).toBeDefined();
  await act(async () => {
    extension.unlock();
    extension.approve();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Claim name" }).hasAttribute("disabled")).toBe(false);
  });
  act(() => {
    extension.emit("accountsChanged", [ACCOUNT, OTHER]);
  });
  expect(screen.getByText("Select one QRL 2.0 account in your wallet")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Claim name" })).toBeNull();
  act(() => {
    extension.granted = false;
    extension.emit("accountsChanged", []);
  });
  await screen.findByText("Disconnected", { selector: "dd" });
  expect(controller.getSnapshot().error).toBeNull();
  expect(screen.queryByRole("button", { name: "Claim name" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect again" })).toBeNull();
  expect(
    within(screen.getByRole("banner")).getByRole("button", { name: "Connect wallet" }),
  ).toBeDefined();
  expect(chain.sent).toHaveLength(0);
  expect(extension.sent).toHaveLength(0);
});
