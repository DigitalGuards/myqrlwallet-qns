import { shake256 } from "@noble/hashes/sha3";

export const QNS_MLDSA_CONTEXT = "QNS-SIGN-v1";
export const MLDSA87_SIGNATURE_BYTES = 4627;
export const MLDSA87_PUBLIC_KEY_BYTES = 2592;
export const MLDSA87_DIGEST_BYTES = 64;
export const MLDSA87_MAX_CONTEXT_BYTES = 255;

const utf8 = new TextEncoder();

export function qnsContext(): Uint8Array {
  return utf8.encode(QNS_MLDSA_CONTEXT);
}

export function qnsDigest(message: Uint8Array): Uint8Array {
  return shake256(message, { dkLen: MLDSA87_DIGEST_BYTES });
}

export function encodeMLDSA87VerifyInput(
  digest: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
  context: Uint8Array,
): Uint8Array {
  if (digest.length !== MLDSA87_DIGEST_BYTES) {
    throw new Error(`ML-DSA-87 digest must be ${MLDSA87_DIGEST_BYTES} bytes`);
  }
  if (signature.length !== MLDSA87_SIGNATURE_BYTES) {
    throw new Error(`ML-DSA-87 signature must be ${MLDSA87_SIGNATURE_BYTES} bytes`);
  }
  if (publicKey.length !== MLDSA87_PUBLIC_KEY_BYTES) {
    throw new Error(`ML-DSA-87 public key must be ${MLDSA87_PUBLIC_KEY_BYTES} bytes`);
  }
  if (context.length > MLDSA87_MAX_CONTEXT_BYTES) {
    throw new Error(`ML-DSA context must be at most ${MLDSA87_MAX_CONTEXT_BYTES} bytes`);
  }

  const input = new Uint8Array(
    digest.length + publicKey.length + signature.length + 1 + context.length,
  );
  let offset = 0;
  input.set(digest, offset);
  offset += digest.length;
  input.set(publicKey, offset);
  offset += publicKey.length;
  input.set(signature, offset);
  offset += signature.length;
  input[offset] = context.length;
  offset += 1;
  input.set(context, offset);
  return input;
}
