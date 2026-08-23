---
qip:
title: QRL 2.0 SHAKE256 and ML-DSA-87 verification precompiles
author: <confirm community authors before submission>
layer: core/security
status: draft/incomplete
comments_uri:
comments_summary_uri:
created: 2026-08-22
updated: 2026-08-23
---

## Abstract

This QIP adds two deterministic native operations to the QRL 2.0 execution layer. Precompile address `0x03` computes SHAKE256 with a fixed 64-byte output from arbitrary input. Precompile address `0x06` verifies an ML-DSA-87 signature over a fixed 64-byte message representative with an explicit FIPS 204 context string. The verifier receives the signature and public key because ML-DSA has no public-key recovery operation equivalent to `ecrecover`.

Both operations use raw packed input and canonical 64-byte output values that match the QRL 2.0 virtual machine word size. Invalid or malformed verification input returns false. Out-of-gas behavior follows the normal precompile call path. The proposal also reserves Hyperion global builtins named `shake256` and `mldsa87verify` so contract authors can call the operations without hand-building static calls.

The initial implementation targets unused precompile slots in go-qrl, includes compiler support in Hyperion, and is exercised by QNS contract and SDK groundwork. Fork activation, the final ML-DSA gas price, and publication of a compact interoperable verification vector remain review items before this draft advances.

## Motivation

QRL 2.0 contracts need a practical way to verify post-quantum authorization. The ECDSA `ecrecover` model recovers a public key or signer address from an elliptic-curve signature. ML-DSA verification requires the public key as an explicit input and returns only a validity result. Implementing ML-DSA-87 in contract bytecode would add substantial execution cost, code size, and consensus risk.

SHAKE256 is used throughout the QRL cryptographic stack and provides a fixed-width message representative for contract protocols. A native 64-byte digest composes naturally with the QRL 2.0 64-byte word size and with ML-DSA-87 verification. QNS is an initial consumer for signed record operations, with the application-specific context `QNS-SIGN-v1`.

## Specification

### Addresses and activation

The following QRL execution addresses become precompiled contracts at a fork block selected during proposal review:

| Slot | Operation |
| --- | --- |
| `0x03` | SHAKE256 with a 64-byte output |
| `0x06` | ML-DSA-87 detached signature verification |

The addresses are encoded as native 64-byte QRL addresses with the slot number in the least significant byte. Clients MUST keep the new behavior behind the agreed fork activation rule.

### SHAKE256 precompile

The SHAKE256 precompile accepts the complete call input as an arbitrary byte string. It returns exactly 64 bytes equal to `SHAKE256(input, 64)`.

Required gas is:

```text
240 + 48 * ceil(input_length / 64)
```

An empty input has zero words and costs 240 gas. Implementations MUST calculate the word count and multiplication without integer wraparound. An unrepresentable cost saturates to the maximum gas integer and therefore cannot execute under a smaller gas limit.

### ML-DSA-87 verification precompile

The verifier accepts one raw byte string with this exact layout:

| Field | Length |
| --- | ---: |
| `messageRepresentative` | 64 bytes |
| `signature` | 4627 bytes |
| `publicKey` | 2592 bytes |
| `context` | 0 to 255 bytes |

The fixed portion is 7283 bytes. Total valid input length is 7283 to 7538 bytes inclusive. Field boundaries are determined only by the fixed lengths above. There are no length prefixes.

Verification invokes the FIPS 204 ML-DSA-87 verification operation with `context` as the context string, `messageRepresentative` as the message, `signature` as the detached signature, and `publicKey` as the public key.

The return value is always exactly 64 bytes after successful precompile execution:

- Valid signature: 63 zero bytes followed by `0x01`.
- Invalid signature or malformed input: 64 zero bytes.

Malformed input includes any length outside the allowed range. The verifier MUST NOT recover, derive, or return an account address. Applications MUST define and enforce their own binding between the supplied ML-DSA public key and an identity, account, or authorization record.

Required gas is 250000 for every input. This value is provisional until cross-platform benchmarks and denial-of-service review are complete. A call with less than the required gas fails with the execution layer's normal out-of-gas result and returns no value.

### Hyperion builtins

Hyperion exposes these pure global functions when compiling for a fork that supports the precompiles:

```hyperion
function shake256(bytes memory input) pure returns (bytes64)
function mldsa87verify(
    bytes64 messageRepresentative,
    bytes memory signature,
    bytes memory publicKey,
    bytes memory context
) pure returns (bool)
```

The compiler packs builtin arguments into the raw layouts defined above and issues a static call to the corresponding precompile. The compiler requests a 64-byte return value for both operations.

### Test vectors

SHAKE256 implementations MUST produce these outputs:

```text
SHAKE256("", 64)
46b9dd2b0ba88d13233b3feb743eeb243fcd52ea62b81b82b50c27646ed5762f
d75dc4ddd8c0f200cb05019d67b592f6fc821c49479ab48640292eacb3b7c4be

SHAKE256("abc", 64)
483366601360a8771c6863080cc4114d8db44530f8f1e1ee4f94ea37e78b5739
d5a15bef186a5386c75744c0527e1faa9f8726e462a12a4feb06bd8801e751e4
```

The reference test suite generates an ML-DSA-87 key from a deterministic 32-byte seed, signs a 64-byte message representative with a context, verifies the result, and then mutates each input field to confirm failure. A complete serialized vector and its provenance MUST be attached before this draft advances to proposal status.

## Rationale

Slots `0x03` and `0x06` are available in the current QRL execution registry. Existing operations occupy `0x01`, `0x02`, `0x04`, and `0x05`.

A fixed 64-byte SHAKE256 output matches `bytes64` and one QRL 2.0 virtual machine word. A separate SHAKE256 operation is useful beyond signature verification and avoids coupling message hashing to one application protocol.

The verifier uses a fixed 64-byte message representative to make the packed layout unambiguous and to bound consensus work. Contracts can compute it with the SHAKE256 precompile or receive a digest computed elsewhere. This construction is an application protocol built from pure ML-DSA-87 over 64 bytes. It MUST NOT be labeled as the distinct HashML-DSA mode unless an implementation actually follows that standard's prehash procedure and identifiers.

The context remains caller supplied because FIPS 204 context strings provide protocol domain separation. The 255-byte bound follows the ML-DSA interface. Applications should select a stable, non-empty context and treat changes as a signing-protocol version change.

Returning false for invalid material gives contracts a predictable verification primitive. Execution failure remains reserved for insufficient gas or an internal consensus implementation failure.

Alternatives considered include a new opcode, contract-level cryptographic code, arbitrary-length signed messages, and a verifier that derives a QRL address. Precompiles fit the existing execution architecture. Fixed field lengths remove parser ambiguity. Identity binding remains an application decision because multiple address and key registration schemes can consume the same verifier.

## Backward compatibility

This proposal changes calls to native addresses `0x03` and `0x06`. Before activation, those addresses have no precompile behavior. Contracts that deliberately call either empty address could observe different success, gas, and return-data behavior after activation.

The change therefore requires coordinated execution-client activation at a fork boundary. Hyperion compiler releases that emit these calls must identify the minimum compatible network revision. Contracts compiled with these builtins must not be deployed to an older network.

No existing precompile address or ABI is modified. Existing contract bytecode that does not call the two reserved addresses retains its behavior.

## Reference Implementation

The review implementation consists of:

- go-qrl precompile registration, gas accounting, SHAKE256 execution, and ML-DSA-87 verification.
- Hyperion type-system, legacy code generator, IR code generator, formal-model, documentation, and execution-host support.
- QNS Hyperion contract and TypeScript SDK examples using `QNS-SIGN-v1`.
- A Kurtosis configuration for a local 64-byte QRL 2.0 network.

The local composition pins `cyyber/qrysm@b53fd7c4` and `theQRL/qrl-genesis-generator@6a11fbce` because the published Qrysm images inspected during validation predated the 64-byte changes. The source-built execution, beacon, and validator services produced blocks. Six QNS contracts deployed, native 64-byte forward and reverse resolution passed, and direct plus wrapped valid and invalid cryptographic calls passed.

Hyperion's CHC engine, backed by Z3 4.12.1, proved 36 source-coupled QNS security targets. These cover exact digest-boundary dispatch, every byte and index bound of `QNS-SIGN-v1`, deterministic formal calls, resolver capability predicates, unauthorized transition models, and reverse-index arithmetic. The proof gate rejects unsafe, unproved, unavailable, unsupported, missing, or unexpected targets. Hyperion models the cryptographic operations as deterministic uninterpreted functions, so concrete cryptographic security remains grounded in the pinned implementations and differential vectors.

Public branch and commit links will be added after community review and before submission.

## Security Considerations

The ML-DSA public key is attacker-controlled input. Successful cryptographic verification proves that the signature matches that key, message representative, and context. It does not prove that the key belongs to a claimed QRL account. Every consuming contract must validate the key-to-identity binding required by its protocol.

Context strings are security boundaries. Reusing the same context and message format across unrelated protocols can enable cross-protocol signature reuse. Applications should define a versioned context and a canonical, injective message encoding.

Hashing and signing must agree exactly. A protocol that signs raw messages while a contract verifies `SHAKE256(message, 64)`, or that uses a different context, will reject valid user intent. Wallets and contracts should publish shared test vectors for the complete message construction.

Consensus clients must pin an audited ML-DSA-87 implementation and validate that arbitrary fixed-length signatures and public keys cannot panic, allocate without bounds, or produce platform-dependent results. Differential vectors should cover valid signatures, each mutated field, empty and maximum contexts, malformed lengths, and out-of-gas execution.

Gas pricing must cover worst-case verification cost on supported validator hardware with a conservative margin. The fixed charge prevents malformed inputs from receiving a discount, but the proposed value remains subject to benchmark review. Five local runs measured medians near 323 ns for SHAKE256 over 64 bytes and 180 microseconds for ML-DSA-87 verification. The proposed 250000 verifier charge is conservative relative to the proposed SHAKE256 schedule on that host; cross-platform validator measurements are still required.

SHAKE256 gas calculation must resist integer overflow. Both precompiles must return newly owned or immutable output buffers so concurrent execution cannot corrupt results.

## Open review items

1. Confirm the author list and champion.
2. Select the fork activation rule.
3. Ratify or adjust the 250000 gas charge using cross-platform benchmark data.
4. Attach a complete ML-DSA-87 serialized interoperability vector with provenance.
5. Confirm whether the core API should call the first field `messageRepresentative`, `digest`, or another consensus term.
6. Confirm compiler behavior when targeting a pre-activation network revision.
