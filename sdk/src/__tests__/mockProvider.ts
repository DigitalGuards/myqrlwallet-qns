import {
  addressWord,
  bytes32Word,
  hashText,
  isRecord,
  selector,
  stringArgument,
  uintWord,
  ZERO_ADDRESS,
} from "../abi.js";
import { parseNetworkConfig } from "../config.js";
import { namehash, nodeToHex } from "../namehash.js";
import { registrationName } from "../registration.js";
import { reverseNodeFor, type RpcProvider } from "../resolver.js";
import { keccak_256 } from "@noble/hashes/sha3";

function subnodeOf(parent: string, label: string): string {
  const hex = parent.slice(2) + label.slice(2);
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return nodeToHex(keccak_256(bytes));
}

export const ACCOUNT = `Q${"a".repeat(128)}`;
export const OTHER = `Q${"b".repeat(128)}`;
export const config = parseNetworkConfig({
  network: "qrl2-kurtosis-local",
  chainId: 3151908,
  rpcUrl: "http://localhost:32002",
  tld: "qrl",
  qrl2PrecompileSet: "qrl2-pq-v1",
  deploymentBlock: 10,
  contracts: {
    QNSRegistry: `Q${"1".repeat(128)}`,
    Root: `Q${"2".repeat(128)}`,
    FIFSQRLRegistrar: `Q${"3".repeat(128)}`,
    ReverseRegistrar: `Q${"4".repeat(128)}`,
    QRLPublicResolver: `Q${"5".repeat(128)}`,
    QRLSignatureVerifier: `Q${"6".repeat(128)}`,
  },
});
export interface SentTransaction {
  from: string;
  to: string;
  data: string;
  value: unknown;
  chainId: unknown;
  gas: unknown;
  gasLimit: unknown;
  type: unknown;
  nonce: unknown;
}

/** State changes apply only when a successful receipt is observed. All RPC stays in memory. */
export class MockChain implements RpcProvider {
  accounts: string[] = [ACCOUNT];
  chainId = "0x301824";
  receiptStatus = "0x1";
  receiptPending = false;
  confirmedNonce = 0n;
  rejectSend = 0;
  noCode = false;
  afterReceipt: (() => void) | null = null;
  calls: { method: string; params?: unknown[] }[] = [];
  sent: SentTransaction[] = [];
  owners = new Map<string, string>();
  resolvers = new Map<string, string>();
  addresses = new Map<string, string>();
  contenthashes = new Map<string, string>();
  /** Public resolver record versions per node; clearRecords increments them. */
  versions = new Map<string, bigint>();
  primary = "";
  spellings = new Map<string, string>();
  nameLogs: unknown[] = [];
  logs: unknown[] = [];
  private labels = new Map<string, string>();
  private applied = new Set<string>();
  private logIndex = 0;

  /** Registry and resolver events carry a chain position, as on a node. */
  private positioned(entry: { address: unknown; topics: string[]; data: string }) {
    return {
      ...entry,
      blockNumber: "0x14",
      logIndex: `0x${(this.logIndex++).toString(16)}`,
      removed: false,
    };
  }
  registryLog(signature: string, topics: string[], data: string): void {
    this.logs.push(
      this.positioned({
        address: config.contracts.QNSRegistry,
        topics: [`0x${bytes32Word(hashText(signature))}`, ...topics],
        data,
      }),
    );
  }
  resolverLog(signature: string, node: string, data: string): void {
    this.nameLogs.push(
      this.positioned({
        address: config.contracts.QRLPublicResolver,
        topics: [`0x${bytes32Word(hashText(signature))}`, `0x${bytes32Word(node)}`],
        data,
      }),
    );
  }

  seed(name: string, owner: string): void {
    const entry = registrationName(name);
    this.labels.set(entry.labelHash, entry.node);
    this.owners.set(entry.node, owner);
    this.registryLog(
      "NewOwner(bytes32,bytes32,address)",
      [`0x${bytes32Word(nodeToHex(namehash("qrl")))}`, `0x${bytes32Word(entry.labelHash)}`],
      `0x${addressWord(owner)}`,
    );
  }

  /** An earlier owner's setup: public resolver pointer, address, spelling and content hash. */
  seedEarlierOwner(name: string, owner: string): void {
    const entry = registrationName(name);
    this.seed(entry.name, owner);
    this.resolvers.set(entry.node, config.contracts.QRLPublicResolver ?? ZERO_ADDRESS);
    this.registryLog(
      "NewResolver(bytes32,address)",
      [`0x${bytes32Word(entry.node)}`],
      `0x${addressWord(config.contracts.QRLPublicResolver ?? ZERO_ADDRESS)}`,
    );
    this.addresses.set(entry.node, owner);
    this.resolverLog("AddrChanged(bytes32,address)", entry.node, `0x${addressWord(owner)}`);
    this.spellings.set(entry.node, entry.name);
    this.resolverLog("NameChanged(bytes32,string)", entry.node, `0x${stringArgument(entry.name)}`);
    this.contenthashes.set(entry.node, "e301");
    this.resolverLog(
      "ContenthashChanged(bytes32,bytes)",
      entry.node,
      `0x${uintWord(64n)}${uintWord(2n)}${"e301".padEnd(128, "0")}`,
    );
  }

  /** The current owner hands the name to another account, as QNSRegistry.setOwner does. */
  transfer(name: string, owner: string): void {
    const entry = registrationName(name);
    this.owners.set(entry.node, owner);
    this.registryLog(
      "Transfer(bytes32,address)",
      [`0x${bytes32Word(entry.node)}`],
      `0x${addressWord(owner)}`,
    );
  }

  /** The current owner gives the name up; registry and resolver records stay. */
  release(name: string): void {
    const entry = registrationName(name);
    this.owners.delete(entry.node);
    this.registryLog(
      "Transfer(bytes32,address)",
      [`0x${bytes32Word(entry.node)}`],
      `0x${addressWord(ZERO_ADDRESS)}`,
    );
  }

  /** A subname of `name` created by its current owner. */
  seedSubname(name: string, label: string, owner: string): void {
    const parent = registrationName(name).node;
    const labelHash = hashText(label);
    this.owners.set(subnodeOf(parent, labelHash), owner);
    this.registryLog(
      "NewOwner(bytes32,bytes32,address)",
      [`0x${bytes32Word(parent)}`, `0x${bytes32Word(labelHash)}`],
      `0x${addressWord(owner)}`,
    );
  }
  private mutate(tx: SentTransaction): void {
    const sig = tx.data.slice(0, 10);
    const node = tx.data.slice(10, 74);
    const address = `Q${tx.data.slice(138, 266)}`;
    if (sig === selector("register(bytes32,address)")) {
      const expected = registrationName("alice");
      if (`0x${node}` !== expected.labelHash) throw new Error("Mock registration supports alice");
      this.seed("alice", address);
    } else if (sig === selector("setResolver(bytes32,address)")) {
      this.resolvers.set(`0x${node}`, address);
      this.registryLog(
        "NewResolver(bytes32,address)",
        [`0x${bytes32Word(`0x${node}`)}`],
        `0x${addressWord(address)}`,
      );
    } else if (sig === selector("setAddr(bytes32,address)")) {
      this.addresses.set(`0x${node}`, address);
      this.resolverLog("AddrChanged(bytes32,address)", `0x${node}`, `0x${addressWord(address)}`);
    } else if (sig === selector("clearRecords(bytes32)")) {
      this.addresses.delete(`0x${node}`);
      this.spellings.delete(`0x${node}`);
      this.contenthashes.delete(`0x${node}`);
      const version = (this.versions.get(`0x${node}`) ?? 0n) + 1n;
      this.versions.set(`0x${node}`, version);
      this.resolverLog("VersionChanged(bytes32,uint64)", `0x${node}`, `0x${uintWord(version)}`);
    } else if (sig === selector("setName(string)")) {
      const length = Number(BigInt(`0x${tx.data.slice(138, 266)}`));
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++)
        bytes[i] = parseInt(tx.data.slice(266 + i * 2, 268 + i * 2), 16);
      this.primary = new TextDecoder().decode(bytes);
      this.resolvers.set(
        reverseNodeFor(tx.from),
        config.contracts.QRLPublicResolver ?? ZERO_ADDRESS,
      );
    } else if (sig === selector("setName(bytes32,string)")) {
      const length = Number(BigInt(`0x${tx.data.slice(266, 394)}`));
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++)
        bytes[i] = parseInt(tx.data.slice(394 + i * 2, 396 + i * 2), 16);
      const spelling = new TextDecoder().decode(bytes);
      this.spellings.set(`0x${node}`, spelling);
      this.resolverLog("NameChanged(bytes32,string)", `0x${node}`, `0x${stringArgument(spelling)}`);
    } else throw new Error("Unexpected write");
  }
  request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    this.calls.push(args);
    try {
      return Promise.resolve(this.respond(args));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("Mock provider failed"));
    }
  }
  private respond({ method, params = [] }: { method: string; params?: unknown[] }): unknown {
    if (method === "qrl_chainId") return this.chainId;
    if (method === "qrl_accounts" || method === "qrl_requestAccounts") return this.accounts;
    if (method === "qrl_getCode") return this.noCode ? "0x" : "0x60006000";
    if (method === "qrl_estimateGas") return "0x186a0";
    if (method === "qrl_getTransactionCount") {
      let nonce = this.confirmedNonce;
      if (params[1] === "pending")
        for (const tx of this.sent) {
          if (typeof tx.nonce === "string" && BigInt(tx.nonce) >= nonce)
            nonce = BigInt(tx.nonce) + 1n;
        }
      return `0x${nonce.toString(16)}`;
    }
    if (method === "qrl_getTransactionByHash") {
      const hash = params[0];
      if (typeof hash !== "string") throw new Error("Invalid hash");
      const tx = this.sent[Number(BigInt(hash)) - 1];
      return tx ? { ...tx, hash, input: tx.data, value: "0x0" } : null;
    }
    if (method === "qrl_blockNumber") return "0x20";
    if (method === "qrl_getLogs") {
      const filter = params[0];
      const position = (entry: unknown, index: number) =>
        isRecord(entry) && entry.blockNumber === undefined
          ? { ...entry, blockNumber: "0x14", logIndex: `0x${(100000 + index).toString(16)}` }
          : entry;
      if (!isRecord(filter)) throw new Error("Invalid log filter");
      const topics = Array.isArray(filter.topics) ? filter.topics : [];
      // Owned-name scans use one address and concrete topics; they receive every stored log
      // so malformed entries reach the SDK validation. Other filters match like a node does.
      if (typeof filter.address === "string" && !topics.includes(null)) {
        const word = (value: unknown) =>
          typeof value === "string" && /^0x[0-9a-f]{128}$/.test(value);
        // Other well-formed events stay out, as on a node; malformed entries are kept.
        return (filter.address === config.contracts.QRLPublicResolver ? this.nameLogs : this.logs)
          .map(position)
          .filter(
            (entry) =>
              !isRecord(entry) ||
              !Array.isArray(entry.topics) ||
              !word(entry.topics[0]) ||
              entry.topics[0] === topics[0],
          );
      }
      const addresses: unknown[] = Array.isArray(filter.address)
        ? filter.address
        : [filter.address];
      return [...this.logs, ...this.nameLogs].map(position).filter((entry) => {
        if (!isRecord(entry) || !addresses.includes(entry.address) || !Array.isArray(entry.topics))
          return false;
        const logTopics: unknown[] = entry.topics;
        return topics.every(
          (value: unknown, index) => value === null || logTopics[index] === value,
        );
      });
    }
    if (method === "qrl_sendTransaction") {
      if (this.rejectSend === this.sent.length + 1)
        throw Object.assign(new Error("User rejected request"), { code: 4001 });
      const tx = params[0];
      if (
        !isRecord(tx) ||
        typeof tx.from !== "string" ||
        typeof tx.to !== "string" ||
        typeof tx.data !== "string"
      )
        throw new Error("Malformed write");
      this.sent.push({
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        chainId: tx.chainId,
        gas: tx.gas,
        gasLimit: tx.gasLimit,
        type: tx.type,
        nonce: this.respond({ method: "qrl_getTransactionCount", params: [tx.from, "pending"] }),
      });
      return `0x${this.sent.length.toString(16).padStart(64, "0")}`;
    }
    if (method === "qrl_getTransactionReceipt") {
      if (this.receiptPending) return null;
      const hash = params[0];
      if (typeof hash !== "string") throw new Error("Invalid hash");
      const tx = this.sent[Number(BigInt(hash)) - 1];
      if (!tx) return null;
      if (!this.applied.has(hash)) {
        if (this.receiptStatus === "0x1") this.mutate(tx);
        this.applied.add(hash);
        if (typeof tx.nonce === "string") this.confirmedNonce = BigInt(tx.nonce) + 1n;
        this.afterReceipt?.();
      }
      return {
        transactionHash: hash,
        blockHash: `0x${"c".repeat(64)}`,
        blockNumber: "0x20",
        status: this.receiptStatus,
      };
    }
    if (method !== "qrl_call") throw new Error(`Unexpected RPC: ${method}`);
    const call = params[0];
    if (!isRecord(call) || typeof call.data !== "string" || typeof call.to !== "string")
      throw new Error("Invalid call");
    const sig = call.data.slice(0, 10);
    const node = `0x${call.data.slice(10, 74)}`;
    const address = (value: string | undefined | null) => `0x${addressWord(value ?? ZERO_ADDRESS)}`;
    if (sig === selector("qns()")) return address(config.contracts.QNSRegistry);
    if (sig === selector("baseNode()")) return `0x${bytes32Word(nodeToHex(namehash("qrl")))}`;
    if (sig === selector("defaultResolver()")) return address(config.contracts.QRLPublicResolver);
    if (sig === selector("trustedReverseRegistrar()"))
      return address(config.contracts.ReverseRegistrar);
    if (sig === selector("owner(bytes32)")) {
      if (node === nodeToHex(namehash("qrl"))) return address(config.contracts.FIFSQRLRegistrar);
      if (node === nodeToHex(namehash("addr.reverse")))
        return address(config.contracts.ReverseRegistrar);
      return address(this.owners.get(node));
    }
    if (sig === selector("available(bytes32)"))
      return `0x${uintWord(this.owners.has(this.labels.get(node) ?? "") ? 0n : 1n)}`;
    if (sig === selector("resolver(bytes32)")) return address(this.resolvers.get(node));
    if (sig === selector("addr(bytes32)")) return address(this.addresses.get(node));
    if (sig === selector("recordVersions(bytes32)"))
      return `0x${uintWord(this.versions.get(node) ?? 0n)}`;
    if (sig === selector("contenthash(bytes32)")) {
      const hash = this.contenthashes.get(node) ?? "";
      return `0x${uintWord(64n)}${uintWord(BigInt(hash.length / 2))}${hash.padEnd(Math.ceil(hash.length / 128) * 128, "0")}`;
    }
    if (sig === selector("name(bytes32)"))
      return `0x${stringArgument(node === reverseNodeFor(ACCOUNT) ? this.primary : (this.spellings.get(node) ?? ""))}`;
    throw new Error(`Unexpected call: ${sig}`);
  }
}
