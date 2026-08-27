import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3";

import vectors from "./fixtures/qns-vectors.json";
import { namehash, nodeToHex } from "./namehash.js";
import { reverseNodeFor, sha3HexAddress } from "./resolver.js";
import { encodeMLDSA87VerifyInput } from "./crypto.js";

const hex = (bytes: Uint8Array): string =>
  "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("shared known-answer vectors", () => {
  it("pins the reverse-label encoding", () => {
    expect(sha3HexAddress(vectors.reverse.address)).toBe(
      vectors.reverse.sha3HexAddress,
    );
    expect(reverseNodeFor(vectors.reverse.address)).toBe(vectors.reverse.node);
  });

  it("pins namehash values including the ENS addr.reverse constant", () => {
    for (const [name, node] of Object.entries(vectors.namehash)) {
      expect(nodeToHex(namehash(name))).toBe(node);
    }
  });

  it("pins the ML-DSA-87 precompile frame layout", () => {
    const digest = new Uint8Array(64).fill(vectors.mldsaFrame.digestFill);
    const publicKey = new Uint8Array(2592).fill(
      vectors.mldsaFrame.publicKeyFill,
    );
    const signature = new Uint8Array(4627).fill(
      vectors.mldsaFrame.signatureFill,
    );
    const context = new TextEncoder().encode(vectors.mldsaFrame.context);
    const frame = encodeMLDSA87VerifyInput(
      digest,
      signature,
      publicKey,
      context,
    );
    expect(frame.length).toBe(vectors.mldsaFrame.totalLength);
    expect(hex(keccak_256(frame))).toBe(vectors.mldsaFrame.keccak256);
  });
});
