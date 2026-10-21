import { canonicalAddress } from "./networkConfig.js";
export { canonicalAddress, ZERO_ADDRESS, isRecord, isHash } from "./networkConfig.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { isHexBytes } from "./guards.js";
import { nodeToHex } from "./namehash.js";
import type { RpcProvider } from "./resolver.js";

export function hashText(value: string): string {
  return nodeToHex(keccak_256(new TextEncoder().encode(value)));
}

export function selector(signature: string): string {
  return hashText(signature).slice(0, 10);
}

export function bytes32Word(value: string): string {
  if (!isHexBytes(value) || value.length !== 66) throw new Error("Expected a 32-byte hash");
  return value.slice(2).toLowerCase() + "0".repeat(64);
}

export function uintWord(value: bigint): string {
  if (value < 0n || value >= 1n << 512n) throw new Error("Invalid ABI integer");
  return value.toString(16).padStart(128, "0");
}

export function addressWord(value: string): string {
  return canonicalAddress(value).slice(1);
}

export function decodeAddress(value: unknown): string {
  if (!isHexBytes(value) || value.length !== 130) {
    throw new Error("Expected a 64-byte ABI address response");
  }
  return canonicalAddress(value);
}

export function decodeBool(value: unknown): boolean {
  if (value === `0x${uintWord(0n)}`) return false;
  if (value === `0x${uintWord(1n)}`) return true;
  throw new Error("Expected a canonical 64-byte ABI boolean response");
}

export function stringArgument(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return (
    uintWord(64n) +
    uintWord(BigInt(bytes.length)) +
    hex.padEnd(Math.ceil(bytes.length / 64) * 128, "0")
  );
}

export function nodeStringArguments(node: string, value: string): string {
  return bytes32Word(node) + uintWord(128n) + stringArgument(value).slice(128);
}

export function decodeString(value: unknown): string {
  if (!isHexBytes(value) || value.length < 258 || BigInt(value.slice(0, 130)) !== 64n)
    throw new Error("Invalid ABI string offset");
  const length = BigInt(`0x${value.slice(130, 258)}`);
  const body = value.slice(258);
  if (length > BigInt(body.length / 2) || BigInt(body.length) !== ((length + 63n) / 64n) * 128n)
    throw new Error("Invalid ABI string length");
  const bytes = new Uint8Array(Number(length));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  if (/[^0]/.test(body.slice(bytes.length * 2))) throw new Error("Invalid ABI string padding");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error("Expected an RPC hex quantity");
  }
  return BigInt(value);
}

export function toQuantity(value: bigint): string {
  if (value < 0n) throw new Error("Expected a positive quantity");
  return `0x${value.toString(16)}`;
}

export async function call(
  provider: RpcProvider,
  to: string,
  signature: string,
  args = "",
  block = "latest",
): Promise<unknown> {
  return provider.request({
    method: "qrl_call",
    params: [{ to: canonicalAddress(to), data: selector(signature) + args }, block],
  });
}
