import { keccak_256 } from "@noble/hashes/sha3";
import { namehash, nodeToHex } from "./namehash.js";

const utf8 = new TextEncoder();

/**
 * EIP-1193-style provider. Any object exposing an async `request({method, params})`
 * works. Known-compatible providers:
 *   - `@qrlwallet/connect` v2+ (primary: mobile QR/deep-link session to MyQRLWallet,
 *     post-quantum ML-KEM-768 relay). Construct a `QRLConnectProvider` and pass it in.
 *   - ethers/viem provider wrappers (if pointed at a QRL Zond RPC endpoint).
 *   - Node-side: shim over `@theqrl/web3`'s `web3.qrl.call`, see
 *     `scripts/register-and-resolve.js` `makeSdkProvider()`.
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
const SELECTOR_NAME = selector("name(bytes32)");

/// namehash("addr.reverse") — the ENSIP-19 per-chain reverse namespace root.
const ADDR_REVERSE_NODE =
  "0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2";

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

/// Decode an ABI-encoded `string` return value — same wire format as bytes.
function decodeString(returnData: string): string {
  const bytes = decodeBytes(returnData);
  return new TextDecoder().decode(bytes);
}

function stripAddrPrefix(addr: string): string {
  const lower = addr.toLowerCase();
  if (lower.startsWith("0x")) return lower.slice(2);
  if (lower.startsWith("q")) return lower.slice(1);
  return lower;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/// ENSIP-19: keccak256 of the 40-char lowercase hex of a 20-byte address, no
/// `0x`/`Q` prefix. The ReverseRegistrar labels subnodes by this hash.
function sha3HexAddress(addr: string): string {
  const hex = stripAddrPrefix(addr);
  if (hex.length !== 40 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`expected 20-byte address hex, got "${addr}"`);
  }
  return "0x" + bytesToHex(keccak_256(utf8.encode(hex)));
}

function reverseNodeFor(addr: string): string {
  const labelHash = sha3HexAddress(addr).slice(2);
  const concat = ADDR_REVERSE_NODE.slice(2) + labelHash;
  return "0x" + bytesToHex(keccak_256(hexToBytes(concat)));
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
 * Reverse lookup: given a 20-byte EVM-form address (`0x...` or `Q...`),
 * return the primary name set on its `addr.reverse` record, or null.
 *
 * Following ENS convention, this does NOT forward-confirm (the caller
 * should re-resolve and check equality if trust is required). Forward-
 * confirm helper lives at `verifyReverse`.
 */
export async function lookupAddress(
  addr: string,
  config: QnsConfig,
): Promise<string | null> {
  const node = reverseNodeFor(addr);

  const resolverData = SELECTOR_RESOLVER + bytes32Arg(node);
  const resolverResult = await ethCall(
    config.provider,
    config.registry,
    resolverData,
  );
  const resolver = decodeAddress(resolverResult);
  if (isZeroAddr(resolver)) return null;

  const nameData = SELECTOR_NAME + bytes32Arg(node);
  const nameResult = await ethCall(config.provider, resolver, nameData);
  const name = decodeString(nameResult);
  return name.length === 0 ? null : name;
}

/**
 * Convenience wrapper that calls `lookupAddress` and then re-resolves the
 * returned name to confirm it maps back to the given address (via the
 * 20-byte legacy `addr(bytes32)` record). Returns the name only on match.
 * Returns null when no reverse is set, or the name doesn't forward-resolve
 * to the expected address.
 */
export async function verifyReverse(
  addr: string,
  config: QnsConfig,
): Promise<string | null> {
  const name = await lookupAddress(addr, config);
  if (!name) return null;
  const forwardAddr = await resolveLegacyAddr(name, config);
  if (!forwardAddr) return null;
  const canonical = "0x" + stripAddrPrefix(addr);
  return forwardAddr.toLowerCase() === canonical ? name : null;
}
