import { describe, expect, it } from "vitest";
import { bytes32Word, hashText, isRecord, selector, stringArgument } from "./abi.js";
import { namehash, nodeToHex } from "./namehash.js";
import { listOwnedNames } from "./owned.js";
import { registrationName } from "./registration.js";
import { ACCOUNT, OTHER, config, MockChain } from "./__tests__/mockProvider.js";

const THIRD = `Q${"c".repeat(128)}`;

function transfer(chain: MockChain, name: string, to: string): void {
  chain.transfer(name, to);
}

/** Owner reads per node, to show which candidates were verified. */
function ownerChecks(chain: MockChain): string[] {
  return chain.calls
    .filter((call) => call.method === "qrl_call")
    .map((call) => call.params?.[0])
    .filter(
      (call): call is { data: string } =>
        isRecord(call) &&
        typeof call.data === "string" &&
        call.data.startsWith(selector("owner(bytes32)")),
    )
    .map((call) => `0x${call.data.slice(10, 74)}`);
}

/** Fixture: names registered to others, transferred in and out, and released. */
function fixture(): MockChain {
  const chain = new MockChain();
  for (let i = 0; i < 30; i++) {
    // Other accounts' names with published spellings are display hints only.
    const spam = registrationName(`spam${String(i)}`);
    chain.seed(spam.name, OTHER);
    chain.resolverLog("NameChanged(bytes32,string)", spam.node, `0x${stringArgument(spam.name)}`);
  }
  chain.seed("mine", ACCOUNT);
  chain.seed("gift", OTHER);
  transfer(chain, "gift", ACCOUNT);
  chain.seed("sold", ACCOUNT);
  transfer(chain, "sold", THIRD);
  chain.seed("dropped", ACCOUNT);
  chain.release("dropped");
  chain.seed("back", OTHER);
  transfer(chain, "back", ACCOUNT);
  transfer(chain, "back", OTHER);
  transfer(chain, "back", ACCOUNT);
  return chain;
}

describe("owned names pre-filtered on log data", () => {
  it("verifies only nodes whose logs name the account and keeps the full-scan result", async () => {
    const chain = fixture();
    const names = await listOwnedNames(ACCOUNT, { config, provider: chain });
    const nodes = names.map((item) => item.node).sort();
    expect(nodes).toEqual(
      ["mine", "gift", "back"].map((name) => registrationName(name).node).sort(),
    );
    // The same answer as verifying every .qrl node seen in the logs.
    const every = [...chain.owners.entries()]
      .filter(([, owner]) => owner === ACCOUNT)
      .map(([node]) => node)
      .sort();
    expect(nodes).toEqual(every);
    const checked = new Set(ownerChecks(chain));
    for (const name of ["mine", "gift", "back"])
      expect(checked.has(registrationName(name).node)).toBe(true);
    // Names whose last ownership log names someone else, or a release, are not checked.
    for (const name of ["sold", "dropped"])
      expect(checked.has(registrationName(name).node)).toBe(false);
    for (let i = 0; i < 30; i++)
      expect(checked.has(registrationName(`spam${String(i)}`).node)).toBe(false);
  });

  it("bounds the owner checks and reports the rest", async () => {
    const chain = new MockChain();
    for (let i = 0; i < 12; i++) chain.seed(`n${String(i)}`, ACCOUNT);
    const unchecked: number[] = [];
    const names = await listOwnedNames(ACCOUNT, { config, provider: chain }, ["n11"], undefined, {
      limit: 5,
      onUnchecked: (count) => unchecked.push(count),
    });
    expect(names).toHaveLength(5);
    expect(unchecked).toEqual([7]);
    // The hint comes first, then the newest log matches.
    expect(names.map((item) => item.node).sort()).toEqual(
      ["n11", "n10", "n9", "n8", "n7"].map((name) => registrationName(name).node).sort(),
    );
    expect(new Set(ownerChecks(chain)).size).toBe(5);
  });

  it("keeps current names inside the bound when old assignments to the account moved on", async () => {
    const chain = new MockChain();
    // Names once assigned to the account and later moved to another account.
    for (let i = 0; i < 10; i++) {
      chain.seed(`old${String(i)}`, ACCOUNT);
      transfer(chain, `old${String(i)}`, OTHER);
    }
    chain.seed("current", ACCOUNT);
    const unchecked: number[] = [];
    const names = await listOwnedNames(ACCOUNT, { config, provider: chain }, [], undefined, {
      limit: 3,
      onUnchecked: (count) => unchecked.push(count),
    });
    expect(names.map((item) => item.node)).toEqual([registrationName("current").node]);
    expect(unchecked).toEqual([]);
  });

  it("checks saved and primary-name hints before log matches", async () => {
    const chain = new MockChain();
    for (let i = 0; i < 6; i++) chain.seed(`n${String(i)}`, ACCOUNT);
    chain.seed("saved", ACCOUNT);
    const names = await listOwnedNames(
      ACCOUNT,
      { config, provider: chain },
      ["saved", "n0"],
      undefined,
      { limit: 3 },
    );
    expect(names.map((item) => item.node).sort()).toEqual(
      ["saved", "n0", "n5"].map((name) => registrationName(name).node).sort(),
    );
  });

  it("orders NewOwner and Transfer logs by chain position", async () => {
    const chain = new MockChain();
    // Transferred to the account, released, then claimed by another account at the registrar.
    chain.seed("moved", OTHER);
    transfer(chain, "moved", ACCOUNT);
    chain.release("moved");
    chain.seed("moved", OTHER);
    // Assigned to another account, then transferred to the account.
    chain.seed("kept", OTHER);
    transfer(chain, "kept", ACCOUNT);
    const names = await listOwnedNames(ACCOUNT, { config, provider: chain });
    expect(names.map((item) => item.node)).toEqual([registrationName("kept").node]);
    expect(new Set(ownerChecks(chain))).toEqual(new Set([registrationName("kept").node]));
  });

  it.each([
    ["a non-record item", "unexpected"],
    ["missing topics", { address: config.contracts.QNSRegistry, data: "0x" }],
    [
      "a short data word",
      {
        address: config.contracts.QNSRegistry,
        topics: [
          `0x${bytes32Word(hashText("Transfer(bytes32,address)"))}`,
          `0x${bytes32Word(registrationName("mine").node)}`,
        ],
        data: "0x01",
        blockNumber: "0x14",
        logIndex: "0x1",
      },
    ],
  ])("fails the listing on a malformed Transfer item: %s", async (_label, item) => {
    class BadTransfers extends MockChain {
      override request(args: Parameters<MockChain["request"]>[0]): Promise<unknown> {
        const filter = args.params?.[0];
        if (
          args.method === "qrl_getLogs" &&
          isRecord(filter) &&
          Array.isArray(filter.topics) &&
          filter.topics[0] === `0x${bytes32Word(hashText("Transfer(bytes32,address)"))}`
        )
          return Promise.resolve([item]);
        return super.request(args);
      }
    }
    const chain = new BadTransfers();
    chain.seed("mine", ACCOUNT);
    await expect(listOwnedNames(ACCOUNT, { config, provider: chain })).rejects.toThrow(
      /Invalid (transfer log|ownership log data)/,
    );
  });

  it("rejects ownership logs whose data is not a native address word", async () => {
    const chain = new MockChain();
    chain.registryLog(
      "NewOwner(bytes32,bytes32,address)",
      [
        `0x${bytes32Word(nodeToHex(namehash("qrl")))}`,
        `0x${bytes32Word(registrationName("mine").labelHash)}`,
      ],
      "0x01",
    );
    await expect(listOwnedNames(ACCOUNT, { config, provider: chain })).rejects.toThrow(
      "Invalid ownership log data",
    );
  });
});
