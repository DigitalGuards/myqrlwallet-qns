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
  primary = "";
  spellings = new Map<string, string>();
  nameLogs: unknown[] = [];
  logs: unknown[] = [];
  private labels = new Map<string, string>();
  private applied = new Set<string>();

  seed(name: string, owner: string): void {
    const entry = registrationName(name);
    this.labels.set(entry.labelHash, entry.node);
    this.owners.set(entry.node, owner);
    this.logs.push({
      address: config.contracts.QNSRegistry,
      topics: [
        `0x${bytes32Word(hashText("NewOwner(bytes32,bytes32,address)"))}`,
        `0x${bytes32Word(nodeToHex(namehash("qrl")))}`,
        `0x${bytes32Word(entry.labelHash)}`,
      ],
      data: `0x${addressWord(owner)}`,
      removed: false,
    });
  }
  private mutate(tx: SentTransaction): void {
    const sig = tx.data.slice(0, 10);
    const node = tx.data.slice(10, 74);
    const address = `Q${tx.data.slice(138, 266)}`;
    if (sig === selector("register(bytes32,address)")) {
      const expected = registrationName("alice");
      if (`0x${node}` !== expected.labelHash) throw new Error("Mock registration supports alice");
      this.seed("alice", address);
    } else if (sig === selector("setResolver(bytes32,address)"))
      this.resolvers.set(`0x${node}`, address);
    else if (sig === selector("setAddr(bytes32,address)")) this.addresses.set(`0x${node}`, address);
    else if (sig === selector("setName(string)")) {
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
      this.nameLogs.push({
        address: tx.to,
        topics: [
          `0x${bytes32Word(hashText("NameChanged(bytes32,string)"))}`,
          `0x${bytes32Word(`0x${node}`)}`,
        ],
        data: `0x${stringArgument(spelling)}`,
      });
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
      return isRecord(filter) && filter.address === config.contracts.QRLPublicResolver
        ? this.nameLogs
        : this.logs;
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
    if (sig === selector("name(bytes32)"))
      return `0x${stringArgument(node === reverseNodeFor(ACCOUNT) ? this.primary : (this.spellings.get(node) ?? ""))}`;
    throw new Error(`Unexpected call: ${sig}`);
  }
}
