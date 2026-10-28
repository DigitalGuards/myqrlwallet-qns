import { describe, expect, it } from "vitest";
import { ACCOUNT, OTHER, config, MockChain } from "./__tests__/mockProvider.js";
import { listOwnedNames } from "./owned.js";
import {
  readPrimaryState,
  readRegistrationState,
  registerName,
  registrationName,
} from "./registration.js";
import { reverseNodeFor, verifyReverse } from "./resolver.js";

function ready(stored: string) {
  const provider = new MockChain();
  const name = registrationName("alice");
  const resolver = config.contracts.QRLPublicResolver ?? "";
  provider.seed(name.name, ACCOUNT);
  provider.resolvers.set(name.node, resolver);
  provider.addresses.set(name.node, ACCOUNT);
  provider.spellings.set(name.node, name.name);
  provider.resolvers.set(reverseNodeFor(ACCOUNT), resolver);
  provider.primary = stored;
  return { provider, name, context: { config, provider } };
}

describe("verified primary spellings", () => {
  it("uses alice.qrl throughout for a verified stored ALIce.QRL and preserves the raw reverse name", async () => {
    const { context, provider } = ready("ALIce.QRL");
    const registry = config.contracts.QNSRegistry ?? "";
    expect(await verifyReverse(ACCOUNT, { registry, provider })).toBe("alice.qrl");
    expect(await readPrimaryState(ACCOUNT, registry, provider)).toEqual({
      primary: "alice.qrl",
      reverseName: "ALIce.QRL",
    });
    expect(await readRegistrationState("Alice.QRL", ACCOUNT, context)).toMatchObject({
      primary: "alice.qrl",
      complete: { primary: true },
      required: { primary: false },
    });
    expect(await listOwnedNames(ACCOUNT, context)).toMatchObject([
      { name: "alice.qrl", primary: true },
    ]);
    await registerName("alice", {
      ...context,
      wallet: provider,
      account: ACCOUNT,
      primary: true,
      transport: "extension",
      onUpdate: () => {
        // Submitted calls and stored spelling establish the no-write postcondition.
      },
    });
    expect(provider.sent).toHaveLength(0);
    expect(provider.primary).toBe("ALIce.QRL");
  });

  it("treats an unnormalizable stored name as different", async () => {
    const { context, provider } = ready("bad_name.qrl");
    expect(await readPrimaryState(ACCOUNT, config.contracts.QNSRegistry ?? "", provider)).toEqual({
      primary: null,
      reverseName: "bad_name.qrl",
    });
    expect(await readRegistrationState("alice", ACCOUNT, context)).toMatchObject({
      primary: null,
      complete: { primary: false },
      required: { primary: true },
    });
    expect(await listOwnedNames(ACCOUNT, context)).toMatchObject([{ primary: false }]);
  });

  it("requires forward verification even when the stored spelling normalizes to the requested name", async () => {
    const { context, provider, name } = ready("ALIce.QRL");
    provider.addresses.set(name.node, OTHER);
    expect(await readPrimaryState(ACCOUNT, config.contracts.QNSRegistry ?? "", provider)).toEqual({
      primary: null,
      reverseName: "ALIce.QRL",
    });
    expect(await readRegistrationState("alice", ACCOUNT, context)).toMatchObject({
      primary: null,
      complete: { primary: false },
      required: { primary: false },
    });
    expect(await listOwnedNames(ACCOUNT, context)).toMatchObject([{ primary: false }]);
  });
});
