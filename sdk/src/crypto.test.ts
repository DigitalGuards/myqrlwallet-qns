import { describe, expect, it } from "vitest";
import {
  MLDSA87_DIGEST_BYTES,
  MLDSA87_PUBLIC_KEY_BYTES,
  MLDSA87_SIGNATURE_BYTES,
  QNS_MLDSA_CONTEXT,
  encodeMLDSA87VerifyInput,
  qnsContext,
  qnsDigest,
} from "./crypto.js";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("QNS ML-DSA helpers", () => {
  it("matches the SHAKE256-512 abc vector", () => {
    expect(hex(qnsDigest(new TextEncoder().encode("abc")))).toBe(
      "483366601360a8771c6863080cc4114d8db44530f8f1e1ee4f94ea37e78b5739d5a15bef186a5386c75744c0527e1faa9f8726e462a12a4feb06bd8801e751e4",
    );
  });

  it("packs the raw precompile input without ABI framing", () => {
    const digest = new Uint8Array(MLDSA87_DIGEST_BYTES).fill(0x42);
    const signature = new Uint8Array(MLDSA87_SIGNATURE_BYTES).fill(0x43);
    const publicKey = new Uint8Array(MLDSA87_PUBLIC_KEY_BYTES).fill(0x44);
    const context = qnsContext();
    const input = encodeMLDSA87VerifyInput(digest, signature, publicKey, context);

    expect(new TextDecoder().decode(context)).toBe(QNS_MLDSA_CONTEXT);
    expect(input.length).toBe(64 + 4627 + 2592 + context.length);
    expect(input[0]).toBe(0x42);
    expect(input[64]).toBe(0x43);
    expect(input[64 + 4627]).toBe(0x44);
    expect(input.slice(-context.length)).toEqual(context);
  });

  it("rejects malformed component lengths", () => {
    expect(() =>
      encodeMLDSA87VerifyInput(
        new Uint8Array(63),
        new Uint8Array(MLDSA87_SIGNATURE_BYTES),
        new Uint8Array(MLDSA87_PUBLIC_KEY_BYTES),
        qnsContext(),
      ),
    ).toThrow("digest must be 64 bytes");
  });
});
