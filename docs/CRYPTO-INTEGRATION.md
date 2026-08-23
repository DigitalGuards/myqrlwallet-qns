# SHAKE256 and ML-DSA-87 integration

Status: implementation, formal verification, and QIP review groundwork as of 2026-08-23.

## Proposed precompiles

This development branch adds two QRL-native precompiles to go-qrl and matching Hyperion builtins:

| Slot | Hyperion builtin | Input | Output | Gas |
|---|---|---|---|---|
| 3 | `shake256(bytes)` | arbitrary bytes | 64-byte SHAKE256 digest | `240 + 48 * ceil(len / 64)` |
| 6 | `mldsa87verify(bytes64,bytes,bytes,bytes)` | packed fields below | canonical 64-byte bool | `250000` |

The slot assignments and gas schedule are proposal values pending community and core-team review.

## ML-DSA raw input

The VM precompile receives raw concatenation with no ABI framing:

```text
digest[64] || signature[4627] || publicKey[2592] || context[0..255]
```

The fixed field sizes make the boundaries unambiguous. Malformed input and invalid signatures return a 64-byte zero value. A valid signature returns 63 zero bytes followed by `0x01`.

Hyperion packs its typed arguments into this raw form before `STATICCALL`.

## QNS signing profile

QNS signs the fixed 64-byte SHAKE256 digest of the canonical record message. ML-DSA-87 receives that digest as its message and uses the context bytes for `QNS-SIGN-v1`.

```text
digest = SHAKE256(record_message, 64)
signature = ML-DSA-87.Sign(digest, context="QNS-SIGN-v1")
valid = ML-DSA-87.Verify(digest, signature, public_key, context)
```

`QRLSignatureVerifier.hyp` exposes `digest`, `verifyDigest`, and the QNS-profile `verify` helper. Its public ABI carries the 64-byte digest as dynamic `bytes` because the current QRL web3 codec accepts standard fixed-byte types only through `bytes32`. The wrapper enforces an exact 64-byte digest before converting it to Hyperion's internal `bytes64` type. The SDK exposes matching digest and raw-payload helpers.

## Security properties

- The verifier uses FIPS 204 ML-DSA-87 through the pinned go-qrllib implementation.
- Context length is capped at 255 bytes as required by ML-DSA.
- QNS uses explicit domain separation to prevent cross-protocol replay.
- Contracts should store public keys or their commitments. Raw 4627-byte signatures are better kept in call data or off-chain records.
- There is no recovery operation. A verifier needs the public key because ML-DSA is not an `ecrecover` analogue.

Hyperion's CHC engine proved the exact digest-length rejection path, exact verifier dispatch tuple, every byte and index bound of the production QNS context, deterministic formal calls, resolver capability predicates, unauthorized transition models, and reverse-index arithmetic. The reproducible gate contains 36 safe targets. Cryptographic correctness is established separately through known vectors, pinned-library tests, compiler semantics, JavaScript differential verification, and live raw plus wrapped calls. See [`FORMAL-SECURITY-VERIFICATION.md`](FORMAL-SECURITY-VERIFICATION.md).

Five local benchmark runs measured medians near 323 ns for SHAKE256 over 64 bytes and 180 microseconds for ML-DSA-87 verification. The proposed 250000 verifier charge is conservative relative to the proposed SHAKE256 schedule on that host. Cross-platform validator measurements remain a QIP gate.

## Pending review

- Confirm activation rules and final slot allocation.
- Review the fixed gas price against representative hardware and denial-of-service budgets.
- Freeze canonical QNS record-message encoding before signed resolver writes ship.
- Add cross-language vectors covering the SDK, Hyperion wrapper, and go-qrl precompile.
