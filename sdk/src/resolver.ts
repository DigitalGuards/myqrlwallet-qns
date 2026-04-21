import { namehash, nodeToHex } from "./namehash.js";

/**
 * Minimal JSON-RPC provider shape expected by the SDK. Compatible with
 * `window.qrl` from `@theqrl/qrl_providers` (EIP-1193) and any ethers/viem
 * provider that exposes `request({method, params})`.
 */
export interface RpcProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface QnsConfig {
  /** Address of the deployed ENSRegistry / QNS root registry. */
  registry: `0x${string}` | `Q${string}`;
  provider: RpcProvider;
}

/**
 * Resolve a QNS name to its native 24-byte QRL address (bytes).
 *
 * **Alpha stub** — Phase 1 implements:
 *   1. namehash(name)
 *   2. registry.resolver(node) via eth_call
 *   3. resolver.qrlAddr(node) via eth_call, returning the native 24-byte form
 *
 * See `contracts/solidity/resolvers/profiles/IQRLAddrResolver.sol` (Phase 1)
 * for the on-chain interface. See `docs/ADDRESS-COMPATIBILITY.md` for why this
 * returns bytes rather than the Solidity 20-byte `address` type.
 */
export async function resolveName(
  name: string,
  _config: QnsConfig,
): Promise<Uint8Array | null> {
  const node = namehash(name);
  void nodeToHex(node);
  throw new Error("resolveName: not implemented until Phase 1 contracts are deployed");
}

/**
 * Reverse lookup: given a 24-byte QRL address, return its primary name.
 *
 * **Alpha stub** — Phase 2 implements ENSIP-19 per-chain reverse namespace
 * using `sha3QRLAddress(addr).[coinTypeHex].reverse` and forward-confirms by
 * re-resolving the returned name.
 */
export async function lookupAddress(
  _qrlAddress: Uint8Array,
  _config: QnsConfig,
): Promise<string | null> {
  throw new Error("lookupAddress: not implemented until Phase 2");
}
