import { keccak_256 } from "@noble/hashes/sha3";
import { namehash, nodeToHex } from "./namehash.js";

const utf8 = new TextEncoder();

/**
 * EIP-1193-style provider. Compatible with `window.qrl` from
 * `@theqrl/qrl_providers`, `window.ethereum`, ethers/viem providers, etc.
 */
export interface RpcProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface QnsConfig {
  /** Deployed registry address. */
  registry: string;
  provider: RpcProvider;
}

function selector(sig: string): string {
  const hash = keccak_256(utf8.encode(sig));
  let out = "0x";
  for (let i = 0; i < 4; i++) out += hash[i]!.toString(16).padStart(2, "0");
  return out;
}

const SELECTOR_RESOLVER = selector("resolver(bytes32)");
const SELECTOR_QRL_ADDR = selector("qrlAddr(bytes32)");
const SELECTOR_ADDR = selector("addr(bytes32)");

function bytes32Arg(hex: string): string {
  if (!hex.startsWith("0x") || hex.length !== 66) {
    throw new Error(`expected 0x-prefixed 32-byte hex, got ${hex}`);
  }
  return hex.slice(2);
}

async function ethCall(
  provider: RpcProvider,
  to: string,
  data: string,
): Promise<string> {
  const result = await provider.request({
    method: "eth_call",
    params: [{ to, data }, "latest"],
  });
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error(`unexpected eth_call result: ${String(result)}`);
  }
  return result;
}

function isZeroAddr(addrHex: string): boolean {
  return /^0x0+$/.test(addrHex);
}

/**
 * Decode an ABI-encoded `bytes` return value. Shape:
 *   [32 bytes offset][32 bytes length][length bytes, right-padded to 32].
 */
function decodeBytes(returnData: string): Uint8Array {
  if (returnData === "0x" || returnData.length <= 2) return new Uint8Array(0);
  const hex = returnData.slice(2);
  if (hex.length < 128) return new Uint8Array(0);
  const length = parseInt(hex.slice(64, 128), 16);
  if (length === 0) return new Uint8Array(0);
  const dataHex = hex.slice(128, 128 + length * 2);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function decodeAddress(returnData: string): string {
  if (returnData === "0x" || returnData.length < 66) {
    return "0x" + "0".repeat(40);
  }
  return "0x" + returnData.slice(-40);
}

/**
 * Look up the resolver address for a given namehash, via the registry.
 * Returns `null` if no resolver is set.
 */
export async function getResolver(
  name: string,
  config: QnsConfig,
): Promise<string | null> {
  const node = nodeToHex(namehash(name));
  const data = SELECTOR_RESOLVER + bytes32Arg(node);
  const result = await ethCall(config.provider, config.registry, data);
  const resolver = decodeAddress(result);
  return isZeroAddr(resolver) ? null : resolver;
}

/**
 * Resolve a QNS name to its native 24-byte QRL wallet-display address.
 *
 * Returns the 24-byte address if set; `null` if:
 *   - the name has no resolver pointer in the registry, or
 *   - the resolver returns an empty `qrlAddr` record.
 *
 * Throws on RPC failures.
 */
export async function resolveName(
  name: string,
  config: QnsConfig,
): Promise<Uint8Array | null> {
  const resolver = await getResolver(name, config);
  if (!resolver) return null;

  const node = nodeToHex(namehash(name));
  const data = SELECTOR_QRL_ADDR + bytes32Arg(node);
  const result = await ethCall(config.provider, resolver, data);
  const addrBytes = decodeBytes(result);
  return addrBytes.length === 0 ? null : addrBytes;
}

/**
 * Legacy lookup: returns the 20-byte EVM address stored via the
 * `IAddrResolver` compat shim. Use `resolveName` for the 24-byte
 * QRL-native record.
 */
export async function resolveLegacyAddr(
  name: string,
  config: QnsConfig,
): Promise<string | null> {
  const resolver = await getResolver(name, config);
  if (!resolver) return null;

  const node = nodeToHex(namehash(name));
  const data = SELECTOR_ADDR + bytes32Arg(node);
  const result = await ethCall(config.provider, resolver, data);
  const addr = decodeAddress(result);
  return isZeroAddr(addr) ? null : addr;
}

/**
 * Reverse lookup: given a QRL address, find its primary name.
 * Not yet implemented; lands in Phase 2 with ReverseRegistrar.
 */
export async function lookupAddress(
  _qrlAddress: Uint8Array,
  _config: QnsConfig,
): Promise<string | null> {
  throw new Error("lookupAddress: not implemented until Phase 2");
}
