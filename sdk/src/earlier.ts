import { keccak_256 } from "@noble/hashes/sha3";
import { bytes32Word, call, decodeAddress, hashText, quantity, ZERO_ADDRESS } from "./abi.js";
import { requireContract, type NetworkConfig } from "./config.js";
import { isHexBytes } from "./guards.js";
import { compareLogs, parseLogs, scanLogs, type ChainLog } from "./logs.js";
import { nodeToHex } from "./namehash.js";
import type { RpcProvider } from "./resolver.js";

const topic = (signature: string) => `0x${bytes32Word(hashText(signature))}`;
const TOPICS = {
  newOwner: topic("NewOwner(bytes32,bytes32,address)"),
  version: topic("VersionChanged(bytes32,uint64)"),
  records: new Set([
    topic("AddrChanged(bytes32,address)"),
    topic("TextChanged(bytes32,string,string,string)"),
    topic("ContenthashChanged(bytes32,bytes)"),
    topic("NameChanged(bytes32,string)"),
  ]),
};

/** Logs older than this many blocks below the read head are cached; newer blocks are read again. */
const CACHE_DEPTH = 128n;
/** Subname owners verified per read. Further subnames count as still owned. */
const SUBNAME_CHECKS = 25;

/**
 * Log history per name node for one session. It feeds the earlier-owner line and the log
 * input of the clear decision only. A gap in it (an endpoint that skipped blocks) can only
 * miss a text-only leftover on a name whose resolver pointer is zero, because the pointer,
 * address, name and content hash are always read directly, and logs can only add a clear.
 */
export class NameHistoryCache {
  readonly #entries = new Map<string, { through: bigint; logs: readonly ChainLog[] }>();
  get(key: string) {
    return this.#entries.get(key);
  }
  set(key: string, through: bigint, logs: readonly ChainLog[]): void {
    this.#entries.set(key, { through, logs });
  }
}

export interface EarlierContext {
  config: NetworkConfig;
  provider: RpcProvider;
  history?: NameHistoryCache;
}

/**
 * What a previous owner may have left on an unowned name, read at one block. Because the name
 * is unowned, every live record belongs to an earlier owner.
 */
export interface EarlierState {
  /** Registry resolver pointer at the snapshot. */
  resolver: string;
  /** A direct read of the public resolver shows an address, name or content hash. */
  records: boolean;
  /**
   * Public resolver logs for the node: a record write after the last VersionChanged, none,
   * unavailable (the read failed or could not cover the history), or skipped (not needed).
   */
  logs: "writes" | "none" | "unavailable" | "skipped";
  /** One-level subnames another account owns, from NewOwner logs. Null when not read. */
  subnames: number | null;
  /** The public resolver's record version for the node at the snapshot. */
  version: bigint;
  /** Any of: a nonzero pointer, direct records, logged writes, or logs that could not be read. */
  needsClear: boolean;
}

function subnode(parent: string, label: string): string {
  const hex = parent.slice(2) + label.slice(2);
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return nodeToHex(keccak_256(bytes));
}

function abiBytesLength(value: unknown): bigint {
  if (!isHexBytes(value) || value.length < 258 || BigInt(value.slice(0, 130)) !== 64n)
    throw new Error("Invalid ABI bytes response");
  return BigInt(`0x${value.slice(130, 258)}`);
}

/** The public resolver's record version for a node, a direct read. */
export async function readRecordVersion(
  node: string,
  context: EarlierContext,
  block: string,
): Promise<bigint> {
  const value = await call(
    context.provider,
    requireContract(context.config, "QRLPublicResolver"),
    "recordVersions(bytes32)",
    bytes32Word(node),
    block,
  );
  if (!isHexBytes(value) || value.length !== 130) throw new Error("Expected a 64-byte ABI word");
  return BigInt(value);
}

/** Registry and public resolver logs keyed by the node, ordered by chain position. */
async function nodeHistory(
  node: string,
  context: EarlierContext,
  head: bigint,
): Promise<ChainLog[]> {
  const { config, provider, history } = context;
  const registry = requireContract(config, "QNSRegistry");
  const resolver = requireContract(config, "QRLPublicResolver");
  // Without a deployment block the scan cannot show it covered the history.
  if (config.deploymentBlock === undefined) throw new Error("Unknown deployment block");
  const key = `${String(config.chainId)}:${config.genesisHash ?? ""}:${registry}:${resolver}:${node}`;
  const cached = history?.get(key);
  if (cached && cached.through >= head) return cached.logs.filter((log) => log.block <= head);
  const from = cached ? cached.through + 1n : BigInt(config.deploymentBlock);
  const [raw = []] = await scanLogs(
    provider,
    [{ address: [registry, resolver], topics: [null, `0x${bytes32Word(node)}`] }],
    from,
    head,
  );
  const seen = new Set<string>();
  const fresh = parseLogs(raw).filter((log) => {
    const position = `${String(log.block)}:${String(log.index)}`;
    if (log.block < from || log.block > head || seen.has(position)) return false;
    seen.add(position);
    return true;
  });
  const logs = [...(cached?.logs ?? []), ...fresh].sort(compareLogs);
  const safe = head - CACHE_DEPTH;
  if (history && safe >= from)
    history.set(
      key,
      safe,
      logs.filter((log) => log.block <= safe),
    );
  return logs;
}

/**
 * Reads the earlier-owner state of an unowned name. Direct reads decide first; the log read
 * runs only when it can still add something (a text-only leftover) or when subnames are wanted.
 * A failed or incomplete log read never throws: it counts as a reason to clear.
 */
export async function readEarlierState(
  node: string,
  context: EarlierContext,
  block: string,
  options: { subnames?: boolean } = {},
): Promise<EarlierState> {
  const { config, provider } = context;
  const registry = requireContract(config, "QNSRegistry");
  const publicResolver = requireContract(config, "QRLPublicResolver");
  const word = bytes32Word(node);
  const resolver = decodeAddress(await call(provider, registry, "resolver(bytes32)", word, block));
  const address = decodeAddress(await call(provider, publicResolver, "addr(bytes32)", word, block));
  let records = address !== ZERO_ADDRESS;
  for (const signature of ["name(bytes32)", "contenthash(bytes32)"]) {
    if (records) break;
    records = abiBytesLength(await call(provider, publicResolver, signature, word, block)) > 0n;
  }
  const version = await readRecordVersion(node, context, block);
  const direct = resolver !== ZERO_ADDRESS || records;
  let logs: EarlierState["logs"] = "skipped";
  let subnames: number | null = null;
  if (!direct || options.subnames) {
    let history: ChainLog[] | null = null;
    try {
      history = await nodeHistory(node, context, quantity(block));
    } catch {
      logs = "unavailable";
    }
    if (history) {
      const nodeTopic = `0x${word}`;
      let writes = false;
      const labels = new Set<string>();
      for (const log of history) {
        const [signature, first, second] = log.topics;
        if (first !== nodeTopic || !signature) continue;
        if (log.address === publicResolver) {
          if (signature === TOPICS.version) writes = false;
          else if (TOPICS.records.has(signature)) writes = true;
        } else if (log.address === registry && signature === TOPICS.newOwner && second) {
          if (second.length === 130 && second.slice(66) === "0".repeat(64))
            labels.add(second.slice(0, 66));
        }
      }
      logs = writes ? "writes" : "none";
      if (options.subnames) {
        const list = [...labels];
        subnames = Math.max(list.length - SUBNAME_CHECKS, 0);
        for (const label of list.slice(0, SUBNAME_CHECKS)) {
          const holder = decodeAddress(
            await call(
              provider,
              registry,
              "owner(bytes32)",
              bytes32Word(subnode(node, label)),
              block,
            ),
          );
          if (holder !== ZERO_ADDRESS) subnames++;
        }
      }
    }
  }
  return {
    resolver,
    records,
    logs,
    subnames,
    version,
    needsClear: direct || logs === "writes" || logs === "unavailable",
  };
}
