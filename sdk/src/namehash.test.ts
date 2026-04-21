import { describe, it, expect } from "vitest";
import { namehash, nodeToHex } from "./namehash.js";

describe("namehash", () => {
  it("returns 32 zero bytes for the empty name (root)", () => {
    const root = namehash("");
    expect(root).toHaveLength(32);
    expect(nodeToHex(root)).toBe("0x" + "00".repeat(32));
  });

  it("matches known EIP-137 fixture for 'eth'", () => {
    expect(nodeToHex(namehash("eth"))).toBe(
      "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae",
    );
  });

  it("matches known EIP-137 fixture for 'foo.eth'", () => {
    expect(nodeToHex(namehash("foo.eth"))).toBe(
      "0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f",
    );
  });

  it("produces a distinct node for the planned QNS TLD 'qrl'", () => {
    const qrlNode = nodeToHex(namehash("qrl"));
    expect(qrlNode).toMatch(/^0x[0-9a-f]{64}$/);
    expect(qrlNode).not.toBe(nodeToHex(namehash("eth")));
  });
});
