# SHAKE256 and ML-DSA-87 integration

Status: aligned implementation and validation evidence as of 2026-08-26. The slot map, raw framing, Hyperion lowering, SDK helpers, formal gate, and live composition have all been exercised on the current tree.

## Execution interfaces

This development branch standardizes the existing ML-DSA-87 precompile interface, adds SHAKE256, and supplies matching Hyperion builtins:

| Slot | Hyperion builtin | Input | Output | Gas |
|---|---|---|---|---|
| 3 | `mldsa87verify(bytes64,bytes,bytes,bytes)` | packed fields below | canonical true; failure form under review | `125000` |
| 6 | `shake256(bytes)` | arbitrary bytes | 64-byte SHAKE256 digest | `240 + 48 * ceil(len / 64)` |

The QRL implementation lead confirmed ML-DSA-87 at slot 3, SHAKE256 at slot 6, and 125000 as the expected verifier gas charge unless proposal review approves another value. Empty return data versus a canonical false word remains open before release.

## ML-DSA raw input

The VM precompile receives raw concatenation with no ABI framing:

```text
digest[64] || publicKey[2592] || signature[4627] || contextLength[1] || context[0..255]
```

`contextLength` must equal the number of trailing context bytes. A valid signature returns 63 zero bytes followed by `0x01`. The current go-qrl implementation returns empty data for malformed input and invalid signatures; a canonical 64-byte zero alternative remains under review.

Hyperion packs its typed arguments into this raw form before `STATICCALL`. It maps empty data and a canonical zero word to `false`, and maps only the exact 64-byte word ending in `0x01` to `true`.

## QNS signing profile

QNS signs the fixed 64-byte SHAKE256 digest of the canonical record message. ML-DSA-87 receives that digest as its message and uses the context bytes for `QNS-SIGN-v1`.

```text
digest = SHAKE256(record_message, 64)
signature = ML-DSA-87.Sign(digest, context="QNS-SIGN-v1")
valid = ML-DSA-87.Verify(digest, signature, public_key, context)
```

`QRLSignatureVerifier.hyp` exposes `digest`, `verifyDigest`, and the QNS-profile `verify` helper. Its public ABI carries the 64-byte digest as dynamic `bytes` because the current QRL web3 codec accepts standard fixed-byte types only through `bytes32`. The wrapper enforces an exact 64-byte digest before converting it to Hyperion's internal `bytes64` type. The SDK exposes matching digest and raw-payload helpers.

`verifyDigest` is a raw adapter: it forwards the caller-supplied `context` unmodified and does not bind the QNS domain separator. QNS flows MUST use `verify`, which pins `QNS-SIGN-v1`. A contract that authenticates through `verifyDigest` with a caller-controlled context accepts signatures from any protocol's domain; callers binding their own protocol MUST hard-code their own stable context. The signed-record work will revisit whether this entry point stays public once the canonical record-message encoding is frozen.

## Security properties

- The verifier uses FIPS 204 ML-DSA-87 through the currently resolved go-qrllib replacement at commit `a6d78f111b1f`. The go-qrl module declares `theQRL/go-qrllib v0.8.0` and replaces it with that fork commit, so release provenance must identify the resolved code explicitly.
- Context length is capped at 255 bytes as required by ML-DSA.
- QNS uses explicit domain separation to prevent cross-protocol replay.
- Contracts should store public keys or their commitments. Raw 4627-byte signatures are better kept in call data or off-chain records.
- There is no recovery operation. A verifier needs the public key because ML-DSA is not an `ecrecover` analogue.

Hyperion's CHC engine proved the exact digest-length rejection path, exact verifier dispatch tuple, every byte and index bound of the production QNS context, deterministic formal calls, resolver capability predicates, unauthorized transition models, and reverse-index arithmetic on the aligned compiler. The reproducible gate contains 36 safe targets. Cryptographic correctness is established separately through known vectors, resolved-library tests, compiler semantics, JavaScript differential verification, and live raw plus wrapped calls. See [`FORMAL-SECURITY-VERIFICATION.md`](FORMAL-SECURITY-VERIFICATION.md).

Five local benchmark runs measured medians near 323 ns for SHAKE256 over 64 bytes and 180 microseconds for ML-DSA-87 verification. At the current 125000 charge, a 30 million gas block permits at most 240 verifications, approximately 43 milliseconds at that measured median before scheduling and execution overhead. Cross-platform validator measurements remain a QIP gate.

## Pending review

- Carry the `qrl2-pq-v1` artifact target and genesis activation rule through release manifests and network configuration.
- Select the final verifier failure return convention.
- Review the fixed gas price against representative hardware and denial-of-service budgets.
- Freeze canonical QNS record-message encoding before signed resolver writes ship.
- Add cross-language vectors covering the SDK, Hyperion wrapper, and go-qrl precompile.
- Resolve or explicitly ratify the go-qrllib replacement and publish the consensus build checksum.
