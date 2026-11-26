import { describe, expect, it } from "vitest";
import { addressWord, bytes32Word, isRecord, selector, stringArgument } from "./abi.js";
import { namehash, nodeToHex } from "./namehash.js";
import { listOwnedNames } from "./owned.js";
import { registrationName } from "./registration.js";
import { ACCOUNT, OTHER, config, MockChain } from "./__tests__/mockProvider.js";

const THIRD = `Q${"c".repeat(128)}`;

function transfer(chain: MockChain, name: string, to: string): void {
  const node = registrationName(name).node;
  chain.owners.set(node, to);
  chain.registryLog(
    "Transfer(bytes32,address)",
    [`0x${bytes32Word(node)}`],
    `0x${addressWord(to)}`,
  );
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
    for (const name of ["mine", "gift", "sold", "dropped", "back"])
      expect(checked.has(registrationName(name).node)).toBe(true);
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
    // Log matches come first, in log order; the hint n11 is past the limit.
    expect(names.map((item) => item.node).sort()).toEqual(
      ["n0", "n1", "n2", "n3", "n4"].map((name) => registrationName(name).node).sort(),
    );
    expect(new Set(ownerChecks(chain)).size).toBe(5);
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
