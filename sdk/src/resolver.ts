import { keccak_256 } from "@noble/hashes/sha3";
import { namehash, nodeToHex } from "./namehash.js";

const utf8 = new TextEncoder();
const ABI_WORD_BYTES = 64;
const ABI_WORD_HEX = ABI_WORD_BYTES * 2;
const ADDRESS_HEX = 128;

/**
 * EIP-1193-style provider. Any object exposing an async `request({method, params})`
 * works. Known-compatible providers:
 *   - `@qrlwallet/connect` v2-v4 (primary: mobile QR/deep-link session to MyQRLWallet,
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
const SELECTOR_ADDR = selector("addr(bytes32)");
const SELECTOR_NAME = selector("name(bytes32)");

/// namehash("addr.reverse"), the ENSIP-19 per-chain reverse namespace root.
const ADDR_REVERSE_NODE =
  "0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2";

function bytes32Arg(hex: string): string {
  if (!hex.startsWith("0x") || hex.length !== 66) {
    throw new Error(`expected 0x-prefixed 32-byte hex, got ${hex}`);
  }
  return hex.slice(2) + "0".repeat(64);
}

async function qrlCall(
  provider: RpcProvider,
  to: string,
  data: string,
): Promise<string> {
  const result = await provider.request({
    method: "qrl_call",
    params: [{ to, data }, "latest"],
  });
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error(`unexpected qrl_call result: ${String(result)}`);
  }
  return result;
}

function isZeroAddr(addrHex: string): boolean {
  return /^0+$/.test(stripAddrPrefix(addrHex));
}

/**
 * Decode an ABI-encoded `bytes` return value. Shape:
 *   [64 bytes offset][64 bytes length][length bytes, right-padded to 64].
 */
function decodeBytes(returnData: string): Uint8Array {
  if (returnData === "0x" || returnData.length <= 2) return new Uint8Array(0);
  const hex = returnData.slice(2);
  if (hex.length < ABI_WORD_HEX * 2) return new Uint8Array(0);

  const offset = Number(BigInt(`0x${hex.slice(0, ABI_WORD_HEX)}`));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("invalid ABI bytes offset");
  }
  const lengthWordStart = offset * 2;
  const lengthWordEnd = lengthWordStart + ABI_WORD_HEX;
  if (lengthWordEnd > hex.length) return new Uint8Array(0);
  const length = Number(BigInt(`0x${hex.slice(lengthWordStart, lengthWordEnd)}`));
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("invalid ABI bytes length");
  }
  if (length === 0) return new Uint8Array(0);
  const dataStart = lengthWordEnd;
  const dataHex = hex.slice(dataStart, dataStart + length * 2);
  if (dataHex.length !== length * 2) {
    throw new Error("truncated ABI bytes data");
  }
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function decodeAddress(returnData: string): string {
  if (returnData === "0x" || returnData.length < 2 + ADDRESS_HEX) {
    return "Q" + "0".repeat(ADDRESS_HEX);
  }
  return "Q" + returnData.slice(-ADDRESS_HEX);
}

/// Decode an ABI-encoded `string` return value, using the same wire format as bytes.
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

/// QRL 2.0 reverse label: keccak256 of the 128-char lowercase hex of a
/// 64-byte address, with no
/// `0x`/`Q` prefix. The ReverseRegistrar labels subnodes by this hash.
function sha3HexAddress(addr: string): string {
  const hex = stripAddrPrefix(addr);
  if (hex.length !== ADDRESS_HEX || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`expected 64-byte address hex, got "${addr}"`);
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
  const result = await qrlCall(config.provider, config.registry, data);
  const resolver = decodeAddress(result);
  return isZeroAddr(resolver) ? null : resolver;
}

/**
 * Resolve a QNS name to its native 64-byte QRL 2.0 address.
 *
 * Returns the Q-prefixed address if set; `null` if:
 *   - the name has no resolver pointer in the registry, or
 *   - the resolver returns a zero native address record.
 *
 * Throws on RPC failures.
 */
export async function resolveName(
  name: string,
  config: QnsConfig,
): Promise<string | null> {
  const resolver = await getResolver(name, config);
  if (!resolver) return null;

  const node = nodeToHex(namehash(name));
  const data = SELECTOR_ADDR + bytes32Arg(node);
  const result = await qrlCall(config.provider, resolver, data);
  const addr = decodeAddress(result);
  return isZeroAddr(addr) ? null : addr;
}

/**
 * Compatibility alias for `resolveName`.
 */
export async function resolveLegacyAddr(
  name: string,
  config: QnsConfig,
): Promise<string | null> {
  return resolveName(name, config);
}

/**
 * Reverse lookup: given a 64-byte QRL address (`0x...` or `Q...`),
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
  const resolverResult = await qrlCall(
    config.provider,
    config.registry,
    resolverData,
  );
  const resolver = decodeAddress(resolverResult);
  if (isZeroAddr(resolver)) return null;

  const nameData = SELECTOR_NAME + bytes32Arg(node);
  const nameResult = await qrlCall(config.provider, resolver, nameData);
  const name = decodeString(nameResult);
  return name.length === 0 ? null : name;
}

/**
 * Convenience wrapper that calls `lookupAddress` and then re-resolves the
 * returned name to confirm it maps back to the given address (via the
 * native `addr(bytes32)` record). Returns the name only on match.
 * Returns null when no reverse is set, or the name doesn't forward-resolve
 * to the expected address.
 */
export async function verifyReverse(
  addr: string,
  config: QnsConfig,
): Promise<string | null> {
  const name = await lookupAddress(addr, config);
  if (!name) return null;
  const forwardAddr = await resolveName(name, config);
  if (!forwardAddr) return null;
  const canonical = "q" + stripAddrPrefix(addr);
  return forwardAddr.toLowerCase() === canonical ? name : null;
}
