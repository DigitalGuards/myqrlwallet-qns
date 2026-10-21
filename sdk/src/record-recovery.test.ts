import { describe, expect, it } from "vitest";
import { ACCOUNT, OTHER, config, MockChain } from "./__tests__/mockProvider.js";
import { isRecord, selector, ZERO_ADDRESS } from "./abi.js";
import { listOwnedNames } from "./owned.js";
import {
  readRegistrationState,
  registerName,
  registrationName,
  registrationTransaction,
} from "./registration.js";
import { reverseNodeFor } from "./resolver.js";

type ResolverFailure = "empty" | "malformed address" | "malformed spelling" | "revert";
const failures: ResolverFailure[] = ["empty", "malformed address", "malformed spelling", "revert"];

class UnusableResolverChain extends MockChain {
  constructor(private readonly failure: ResolverFailure) {
    super();
  }
  override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
    const call = args.params?.[0];
    if (args.method === "qrl_call" && isRecord(call) && call.to === OTHER) {
      if (this.failure === "revert")
        return Promise.reject(new Error("execution reverted: custom resolver"));
      if (this.failure === "empty") return Promise.resolve("0x");
      if (
        this.failure === "malformed address" ||
        (typeof call.data === "string" && call.data.startsWith(selector("name(bytes32)")))
      )
        return Promise.resolve("0x00");
    }
    return super.request(args);
  }
}

describe("unusable name records", () => {
  it.each(failures)(
    "isolates %s records, retains ownership, and repairs through the standard resolver",
    async (failure) => {
      const chain = new UnusableResolverChain(failure);
      const good = registrationName("alice");
      const damaged = registrationName("external");
      chain.seed(good.name, ACCOUNT);
      chain.resolvers.set(good.node, config.contracts.QRLPublicResolver ?? "");
      chain.addresses.set(good.node, ACCOUNT);
      chain.spellings.set(good.node, good.name);
      chain.seed(damaged.name, OTHER);
      chain.owners.set(damaged.node, ACCOUNT);
      chain.resolvers.set(damaged.node, OTHER);
      chain.primary = damaged.name;
      chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
      const context = { config, provider: chain };
      const names = await listOwnedNames(ACCOUNT, context, [damaged.name]);
      expect(names).toHaveLength(2);
      expect(names.find((item) => item.name === good.name)).toMatchObject({
        records: { resolverStatus: "usable", address: ACCOUNT, spelling: good.name },
      });
      expect(names.find((item) => item.name === damaged.name)).toMatchObject({
        primary: false,
        records: { resolver: OTHER, resolverStatus: "unusable", address: null, spelling: null },
      });
      const state = await readRegistrationState(damaged.name, ACCOUNT, context);
      expect(state).toMatchObject({
        owner: ACCOUNT,
        resolverStatus: "unusable",
        primary: null,
        complete: { register: true, resolver: false, address: false, name: false, primary: false },
      });
      expect(chain.sent).toHaveLength(0);
      for (const call of chain.calls.filter((item) => item.method === "qrl_call"))
        expect(call.params?.[1]).toBe("0x20");
      await registerName(damaged.name, {
        ...context,
        wallet: chain,
        account: ACCOUNT,
        transport: "extension",
        primary: false,
        onUpdate: () => {},
      });
      expect(chain.sent.map((tx) => tx.data)).toEqual(
        (["resolver", "address", "name"] as const).map(
          (step) => registrationTransaction(damaged.name, ACCOUNT, step, config).data,
        ),
      );
      expect(await readRegistrationState(damaged.name, ACCOUNT, context)).toMatchObject({
        owner: ACCOUNT,
        resolverStatus: "usable",
        address: ACCOUNT,
        spelling: damaged.name,
        complete: { register: true, resolver: true, address: true, name: true },
      });
    },
  );

  it("shows an owned node without trusting an unavailable spelling or reverse record", async () => {
    const chain = new UnusableResolverChain("revert");
    const parsed = registrationName("external");
    chain.seed(parsed.name, ACCOUNT);
    chain.resolvers.set(parsed.node, OTHER);
    chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    expect(await listOwnedNames(ACCOUNT, { config, provider: chain })).toMatchObject([
      { node: parsed.node, name: null, primary: false, records: { resolverStatus: "unusable" } },
    ]);
    expect(
      await readRegistrationState(parsed.name, ACCOUNT, { config, provider: chain }),
    ).toMatchObject({ owner: ACCOUNT, primary: null });
    expect(chain.sent).toHaveLength(0);
  });

  it("distinguishes an unset resolver and valid empty records", async () => {
    const chain = new MockChain();
    const parsed = registrationName("alice");
    chain.seed(parsed.name, ACCOUNT);
    expect(
      await readRegistrationState(parsed.name, ACCOUNT, { config, provider: chain }),
    ).toMatchObject({
      resolver: ZERO_ADDRESS,
      resolverStatus: "unset",
      address: null,
      spelling: null,
    });
    chain.resolvers.set(parsed.node, config.contracts.QRLPublicResolver ?? "");
    expect(
      await readRegistrationState(parsed.name, ACCOUNT, { config, provider: chain }),
    ).toMatchObject({
      resolverStatus: "usable",
      address: null,
      spelling: "",
    });
  });

  it.each(["owner(bytes32)", "resolver(bytes32)"])(
    "preserves authoritative %s failures",
    async (signature) => {
      const parsed = registrationName("alice");
      class BrokenRegistry extends MockChain {
        override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
          const call = args.params?.[0];
          if (
            args.method === "qrl_call" &&
            isRecord(call) &&
            call.to === config.contracts.QNSRegistry &&
            typeof call.data === "string" &&
            call.data.startsWith(selector(signature)) &&
            call.data.slice(10, 74) === parsed.node.slice(2)
          )
            return Promise.reject(new Error("Registry unavailable"));
          return super.request(args);
        }
      }
      const provider = new BrokenRegistry();
      provider.seed(parsed.name, ACCOUNT);
      const entries = await listOwnedNames(ACCOUNT, { config, provider });
      expect(entries).toMatchObject([
        {
          node: parsed.node,
          records: null,
          primary: null,
        },
      ]);
      expect(entries[0]?.error).toContain("Registry unavailable");
      await expect(
        readRegistrationState(parsed.name, ACCOUNT, { config, provider }),
      ).rejects.toThrow("Registry unavailable");
      expect(provider.sent).toHaveLength(0);
    },
  );
});
