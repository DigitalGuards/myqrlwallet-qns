import { keccak_256 } from "@noble/hashes/sha3";

const EMPTY_NODE = new Uint8Array(32);

const utf8 = new TextEncoder();

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * EIP-137 namehash. Labels must already be normalized per ENSIP-15 — call
 * `normalize()` on untrusted input before passing labels here. Empty string
 * returns the 32-byte zero root node.
 */
export function namehash(name: string): Uint8Array {
  if (name === "") return EMPTY_NODE;
  const labels = name.split(".");
  let node: Uint8Array = EMPTY_NODE;
  for (let i = labels.length - 1; i >= 0; i--) {
    const label = labels[i]!;
    const labelHash: Uint8Array = keccak_256(utf8.encode(label));
    node = keccak_256(concatBytes(node, labelHash));
  }
  return node;
}

/**
 * Hex-encode a 32-byte node as `0x`-prefixed lowercase. For passing to
 * `eth_call` resolver reads.
 */
export function nodeToHex(node: Uint8Array): string {
  if (node.length !== 32) throw new Error("expected 32-byte node");
  let out = "0x";
  for (const b of node) out += b.toString(16).padStart(2, "0");
  return out;
}
