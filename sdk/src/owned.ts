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
  ZERO_ADDRESS,
} from "./abi.js";
import { assertNetwork, requireContract } from "./config.js";
import { isHexBytes } from "./guards.js";
import { scanLogs } from "./logs.js";
import { namehash, nodeToHex } from "./namehash.js";
import { normalize, QnsNameError } from "./normalize.js";
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

function logPosition(item: Record<string, unknown>): { block: bigint; index: bigint } {
  try {
    return { block: quantity(item.blockNumber), index: quantity(item.logIndex) };
  } catch {
    throw new Error("Invalid ownership log position");
  }
}

function decodeOwner(data: unknown): string {
  try {
    return decodeAddress(data);
  } catch {
    throw new Error("Invalid ownership log data");
  }
}

function subnode(parent: string, label: string): string {
  const hex = parent.slice(2) + label.slice(2);
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return nodeToHex(keccak_256(bytes));
}

/** Owner checks per listing. Candidates past the limit are reported through onUnchecked. */
export const OWNED_NAME_CHECKS = 500;

export interface OwnedNameOptions {
  /** Most candidates verified with an owner() call; hints are checked before log matches. */
  limit?: number;
  /** Called with the number of candidates left unchecked when the limit is reached. */
  onUnchecked?: (count: number) => void;
}

/**
 * Enumerate .qrl nodes from NewOwner logs and verify current ownership, including transfers.
 * Only nodes whose NewOwner or Transfer log data names the account are verified: the last
 * ownership change of a node the account owns is one of those logs, so for a complete log
 * history the result equals verifying every .qrl node, at one owner() call per match.
 */
export async function listOwnedNames(
  account: string,
  context: RegistrationContext,
  knownNames: readonly string[] = [],
  signal?: AbortSignal,
  options: OwnedNameOptions = {},
): Promise<OwnedName[]> {
  const owner = canonicalAddress(account);
  const { config, provider } = context;
  const registry = requireContract(config, "QNSRegistry");
  const limit = options.limit ?? OWNED_NAME_CHECKS;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid owned-name limit");
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
  /** Spellings for display: hints and published NameChanged records. */
  const names = new Map<string, string>();
  /** Saved and primary-name hints, which are verified even without a matching log. */
  const hints = new Map<string, string>();
  // Verify the primary's forward record within its candidate so a per-name failure stays local.
  const reverseName = await lookupAddress(owner, { registry, provider: snapshot });
  let primary: string | null = null;
  if (reverseName !== null) {
    try {
      primary = normalize(reverseName);
    } catch (error) {
      if (!(error instanceof QnsNameError)) throw error;
    }
  }
  for (const input of primary
    ? [primary, ...[...knownNames].reverse()]
    : [...knownNames].reverse()) {
    try {
      const parsed = registrationName(input);
      names.set(parsed.node, parsed.name);
      hints.set(parsed.node, parsed.labelHash);
    } catch {
      // Stored hints are untrusted. Only valid normalized preimages are used.
    }
  }
  const parent = nodeToHex(namehash("qrl"));
  const eventTopic = `0x${bytes32Word(hashText("NewOwner(bytes32,bytes32,address)"))}`;
  const transferTopic = `0x${bytes32Word(hashText("Transfer(bytes32,address)"))}`;
  const parentTopic = `0x${bytes32Word(parent)}`;
  const nameTopic = `0x${bytes32Word(hashText("NameChanged(bytes32,string)"))}`;
  const resolver = requireContract(config, "QRLPublicResolver");
  const deploymentBlock = config.deploymentBlock ?? 1;
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock <= 0)
    throw new Error("Deployment block must be a positive integer");
  const [ownership = [], spellings = [], transfers = []] = await scanLogs(
    provider,
    [
      { address: registry, topics: [eventTopic, parentTopic] },
      { address: resolver, topics: [nameTopic] },
      { address: registry, topics: [transferTopic] },
    ],
    BigInt(deploymentBlock),
    head,
    signal,
  );
  signal?.throwIfAborted();
  /** Every .qrl node seen, with its label hash. */
  const labels = new Map<string, string>();
  /** Ownership changes from NewOwner under .qrl and from Transfer, with chain positions. */
  const changes: { node: string; owner: string; block: bigint; index: bigint }[] = [];
  for (const raw of ownership) {
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
    const child = subnode(parent, labelHash);
    labels.set(child, labelHash);
    changes.push({ node: child, owner: decodeOwner(item.data), ...logPosition(item) });
  }
  for (const raw of transfers) {
    const item: unknown = raw;
    if (
      !isRecord(item) ||
      !Array.isArray(item.topics) ||
      item.topics.length !== 2 ||
      canonicalAddress(item.address) !== registry
    )
      throw new Error("Invalid transfer log");
    if (item.removed === true) continue;
    const topics: unknown[] = item.topics;
    const [signature, node] = topics;
    if (
      signature !== transferTopic ||
      !isHexBytes(node) ||
      node.length !== 130 ||
      node.slice(66) !== "0".repeat(64)
    )
      throw new Error("Invalid native transfer topics");
    changes.push({ node: node.slice(0, 66), owner: decodeOwner(item.data), ...logPosition(item) });
  }
  // The last ownership change of each node, in chain order (block, then log index).
  changes.sort((a, b) =>
    a.block !== b.block
      ? a.block < b.block
        ? -1
        : 1
      : a.index < b.index
        ? -1
        : a.index > b.index
          ? 1
          : 0,
  );
  const last = new Map<string, { owner: string; at: number }>();
  changes.forEach(({ node, owner: holder }, at) => last.set(node, { owner: holder, at }));
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
      if (canonicalAddress(item.address) === resolver && parsed.node === node.slice(0, 66))
        names.set(parsed.node, parsed.name);
    } catch {
      // Name records are public input. Only normalized hash-matching spellings are hints.
    }
  }
  // Saved and primary-name hints come first: they also cover a just-confirmed name while a
  // log endpoint catches up. Then the names whose last ownership log names the account,
  // newest first. Published spellings only label results.
  const unowned = (holder: string) => holder === ZERO_ADDRESS || holder === registry;
  const candidates = new Map<string, string>();
  for (const [node, labelHash] of hints) candidates.set(node, labelHash);
  const matched = [...last]
    .filter(([node, change]) => change.owner === owner && labels.has(node))
    .sort(([, a], [, b]) => b.at - a.at);
  for (const [node] of matched) {
    const labelHash = labels.get(node);
    if (labelHash !== undefined && !candidates.has(node)) candidates.set(node, labelHash);
  }
  // A name whose last ownership log names another account is not checked.
  for (const node of [...candidates.keys()]) {
    const change = last.get(node);
    if (change && change.owner !== owner && !unowned(change.owner)) candidates.delete(node);
  }
  const checked = [...candidates].slice(0, limit);
  if (candidates.size > checked.length) options.onUnchecked?.(candidates.size - checked.length);
  const result: OwnedName[] = [];
  for (const [node, labelHash] of checked) {
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
