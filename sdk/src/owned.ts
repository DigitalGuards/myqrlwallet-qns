import { keccak_256 } from "@noble/hashes/sha3";
import {
  bytes32Word,
  call,
  canonicalAddress,
  decodeAddress,
  decodeString,
  hashText,
  isRecord,
  quantity,
  toQuantity,
} from "./abi.js";
import { assertNetwork, requireContract } from "./config.js";
import { isHexBytes } from "./guards.js";
import { namehash, nodeToHex } from "./namehash.js";
import {
  readNameRecords,
  registrationName,
  type NameRecords,
  type RegistrationContext,
} from "./registration.js";
import { lookupAddress, type RpcProvider } from "./resolver.js";

interface OwnedNameIdentity {
  node: string;
  labelHash: string;
  /** Null when no verified spelling is available from records or hints. */
  name: string | null;
}

/** Failed candidate reads remain visible and retryable; actions require verified records. */
export type OwnedName = OwnedNameIdentity &
  (
    | { records: NameRecords; primary: boolean; error?: never }
    | { records: null; primary: null; error: string }
  );

function subnode(parent: string, label: string): string {
  const hex = parent.slice(2) + label.slice(2);
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return nodeToHex(keccak_256(bytes));
}

/** Retry only range refusals. An unnamed range limit is discovered by bounded halving. */
function smallerLogRange(error: unknown, span: bigint): bigint | null {
  const message = isRecord(error) && typeof error.message === "string" ? error.message : "";
  if (
    span <= 1n ||
    !/(?:block|range)/i.test(message) ||
    !/(?:limit|max|exceed|too (?:large|wide)|at most|up to)/i.test(message)
  )
    return null;
  const match = message.match(
    /(?:max(?:imum)?(?:[\s_-]+block)?(?:[\s_-]+range)?(?:[\s_-]+(?:limit|size))?(?:\s+(?:is|of))?|limited to|limit(?:\s+(?:is|of))?|up to|at most)\s*[:=]?\s*([\d,]+)\b/i,
  );
  const limit = match?.[1] ? BigInt(match[1].replaceAll(",", "")) : 0n;
  return limit > 0n && limit < span ? limit : span / 2n;
}

/** Enumerate .qrl nodes from NewOwner logs and verify current ownership, including transfers. */
export async function listOwnedNames(
  account: string,
  context: RegistrationContext,
  knownNames: readonly string[] = [],
  signal?: AbortSignal,
): Promise<OwnedName[]> {
  const owner = canonicalAddress(account);
  const { config, provider } = context;
  const registry = requireContract(config, "QNSRegistry");
  await assertNetwork(provider, config);
  const head = quantity(await provider.request({ method: "qrl_blockNumber" }));
  const snapshot: RpcProvider = {
    request: (args) =>
      provider.request(
        args.method === "qrl_call"
          ? { ...args, params: [args.params?.[0], toQuantity(head)] }
          : args,
      ),
  };
  const names = new Map<string, string>();
  // Verify the primary's forward record within its candidate so a per-name failure stays local.
  const primary = await lookupAddress(owner, { registry, provider: snapshot });
  for (const input of primary ? [...knownNames, primary] : knownNames) {
    try {
      const parsed = registrationName(input);
      names.set(parsed.node, parsed.name);
    } catch {
      // Stored hints are untrusted. Only valid normalized preimages are used.
    }
  }
  const parent = nodeToHex(namehash("qrl"));
  const eventTopic = `0x${bytes32Word(hashText("NewOwner(bytes32,bytes32,address)"))}`;
  const parentTopic = `0x${bytes32Word(parent)}`;
  const nameTopic = `0x${bytes32Word(hashText("NameChanged(bytes32,string)"))}`;
  const candidates = new Map<string, string>();
  const deploymentBlock = config.deploymentBlock ?? 1;
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock <= 0)
    throw new Error("Deployment block must be a positive integer");
  let pageSize = 2000n;
  for (let start = BigInt(deploymentBlock); start <= head;) {
    signal?.throwIfAborted();
    const end = start + pageSize - 1n < head ? start + pageSize - 1n : head;
    let logs: unknown;
    let spellings: unknown;
    try {
      logs = await provider.request({
        method: "qrl_getLogs",
        params: [
          {
            address: registry,
            fromBlock: toQuantity(start),
            toBlock: toQuantity(end),
            topics: [eventTopic, parentTopic],
          },
        ],
      });
      signal?.throwIfAborted();
      spellings = await provider.request({
        method: "qrl_getLogs",
        params: [
          {
            address: requireContract(config, "QRLPublicResolver"),
            fromBlock: toQuantity(start),
            toBlock: toQuantity(end),
            topics: [nameTopic],
          },
        ],
      });
    } catch (error) {
      signal?.throwIfAborted();
      const smaller = smallerLogRange(error, end - start + 1n);
      if (smaller === null) throw error;
      pageSize = smaller;
      continue;
    }
    signal?.throwIfAborted();
    if (!Array.isArray(logs)) throw new Error("Invalid ownership log response");
    for (const raw of logs) {
      const item: unknown = raw;
      if (
        !isRecord(item) ||
        !Array.isArray(item.topics) ||
        item.topics.length !== 3 ||
        canonicalAddress(item.address) !== registry
      )
        throw new Error("Invalid ownership log");
      if (item.removed === true) continue;
      const topics: unknown[] = item.topics;
      const [signature, node, label] = topics;
      if (
        signature !== eventTopic ||
        node !== parentTopic ||
        !isHexBytes(label) ||
        label.length !== 130 ||
        label.slice(66) !== "0".repeat(64)
      )
        throw new Error("Invalid native ownership topics");
      const labelHash = label.slice(0, 66);
      candidates.set(subnode(parent, labelHash), labelHash);
    }
    if (!Array.isArray(spellings)) throw new Error("Invalid name log response");
    for (const raw of spellings) {
      const item: unknown = raw;
      if (!isRecord(item) || item.removed === true || !Array.isArray(item.topics)) continue;
      const topics: unknown[] = item.topics;
      const node: unknown = topics[1];
      if (
        topics[0] !== nameTopic ||
        !isHexBytes(node) ||
        node.length !== 130 ||
        node.slice(66) !== "0".repeat(64)
      )
        continue;
      try {
        const parsed = registrationName(decodeString(item.data));
        if (
          canonicalAddress(item.address) === requireContract(config, "QRLPublicResolver") &&
          parsed.node === node.slice(0, 66)
        )
          names.set(parsed.node, parsed.name);
      } catch {
        // Name records are public input. Only normalized hash-matching spellings are hints.
      }
    }
    start = end + 1n;
  }
  // Hints also cover a just-confirmed name while a log endpoint catches up.
  for (const [node, name] of names) candidates.set(node, registrationName(name).labelHash);
  const result: OwnedName[] = [];
  for (const [node, labelHash] of candidates) {
    signal?.throwIfAborted();
    let reading = "verify ownership";
    try {
      if (
        decodeAddress(
          await call(provider, registry, "owner(bytes32)", bytes32Word(node), toQuantity(head)),
        ) !== owner
      )
        continue;
      reading = "read name records";
      const records = await readNameRecords(node, context, toQuantity(head));
      if (records.spelling) {
        try {
          const parsed = registrationName(records.spelling);
          if (parsed.node === node) names.set(node, parsed.name);
        } catch {
          // A resolver's spelling is only a hint until its hash matches the owned node.
        }
      }
      const name = names.get(node) ?? null;
      result.push({
        node,
        labelHash,
        name,
        records,
        primary: name !== null && name === primary && records.address === owner,
      });
    } catch (error) {
      signal?.throwIfAborted();
      result.push({
        node,
        labelHash,
        name: names.get(node) ?? null,
        records: null,
        primary: null,
        error: `Could not ${reading}: ${error instanceof Error ? error.message : "Request failed. Please try again."}`,
      });
    }
  }
  signal?.throwIfAborted();
  await assertNetwork(provider, config);
  return result.sort((a, b) => (a.name ?? a.node).localeCompare(b.name ?? b.node));
}
