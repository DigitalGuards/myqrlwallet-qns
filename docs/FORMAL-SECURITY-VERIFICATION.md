# Formal security verification

Status: 36 Hyperion CHC targets proved safe on 2026-08-23. Six production contracts were compiled through the legacy and via-IR paths, deployed to the local 64-byte Kurtosis network, and exercised end to end. The two formal harness contracts were compiled for proof and remained off-chain.

## Scope

The formal harness covers the new QNS security boundaries introduced for QRL 2.0:

- the exact 64-byte digest boundary before ML-DSA-87 verification
- QNS signing-context construction
- deterministic treatment of SHAKE256 and ML-DSA-87 calls in Hyperion's formal model
- owner-only resolver writes
- the narrow `setName` capability granted to the trusted reverse registrar
- transition lemmas showing that unauthorized callers leave owner-only records unchanged
- native 64-byte reverse-label pair offsets, pair separation, nibble ranges, arithmetic overflow, and division safety

The review also tracks go-qrl precompile parsing, canonical output, gas behavior, compiler lowering, SDK parity, and live execution. Those checks use unit tests, fuzzing, semantic tests, benchmarks, differential vectors, and Kurtosis integration evidence.

## Attacker model

An attacker can submit arbitrary contract calls, byte arrays, message digests, signatures, public keys, contexts, node hashes, names, and resolver values. The attacker may call every public contract method and may occupy the trusted reverse-registrar address in the capability-policy model. The attacker cannot break the cryptographic assumptions of SHAKE256, Keccak-256, or ML-DSA-87, alter finalized contract bytecode, compromise the execution or consensus client host, or violate QRVM transaction semantics.

The trusted computing base contains:

- go-qrl precompile registration and execution
- Go's SHAKE256 implementation and the pinned go-qrllib ML-DSA-87 verifier
- Hyperion parsing, type checking, both code generators, ABI lowering, and SMT encoding
- QRVM execution semantics
- Z3 4.12.1
- the ENS registry's owner response used by the resolver

## Proof method

Hyperion was rebuilt with `USE_Z3=ON` against Z3 4.12.1. The proof command uses the CHC engine, selects the intended harness contract, enables every safety target, prints every proved target, and fails if any target is unsafe, unproved, unsupported, missing, or unexpectedly added.

Run:

```bash
HYPERION_FORMAL_COMPILER=../hyperion/build-formal/hypc/hypc npm run verify:formal
```

If the Z3 shared library is installed outside the system loader path:

```bash
HYPERION_FORMAL_COMPILER=../hyperion/build-formal/hypc/hypc HYPERION_Z3_LIBRARY_DIR=/path/to/z3/lib npm run verify:formal
```

The proof gate is [`scripts/verify-formal.sh`](../scripts/verify-formal.sh). The harnesses are [`QNSSecurityProperties.hyp`](../test/formal/QNSSecurityProperties.hyp) and [`QNSReverseSafetyProperties.hyp`](../test/formal/QNSReverseSafetyProperties.hyp).

## Proved properties

### Cryptographic boundary and resolver capabilities: 26 targets

The CHC engine proved all of these assertions safe:

1. Every `verifyDigest` input with a length other than 64 returns false.
2. Every 64-byte `verifyDigest` input dispatches the same digest, signature, public key, and context tuple to `mldsa87verify`.
3. The production `qnsContext()` helper returns the exact 11 bytes of `QNS-SIGN-v1`; every indexed byte is also proved in bounds.
4. Repeated SHAKE256 calls with the same symbolic input return the same symbolic result.
5. Repeated ML-DSA-87 calls with the same symbolic tuple return the same symbolic result.
6. `canWrite(nodeOwner, caller)` is equivalent to `nodeOwner == caller`.
7. A non-owner fails the owner-only predicate.
8. The modeled owner-only state transition leaves the record unchanged for a non-owner.
9. `canSetName` is equivalent to owner access or a nonzero matching trusted reverse registrar.
10. Every name-only caller outside owner access is the configured nonzero trusted registrar.
11. A configured trusted registrar receives name access.
12. A trusted registrar that is distinct from the node owner lacks owner-only access.
13. The trusted registrar cannot change an owner-only modeled record when it is distinct from the owner.

Several related assertions and the context index-safety checks share one property group, which yields 26 individual CHC targets.

Production wiring uses the same proved predicates. `setAddr`, `setText`, `setContenthash`, and `clearRecords` flow through `canWrite`. `setName` alone flows through `canSetName`.

### Reverse-index arithmetic: 10 targets

The CHC engine proved these source-coupled lemmas for every possible input satisfying the production preconditions:

1. Every byte index from 0 through 63 maps to a high-nibble offset below 128.
2. The adjacent low-nibble offset remains below 128.
3. Offset addition and multiplication cannot overflow.
4. Distinct byte indices have distinct pair offsets.
5. Ordered byte indices have non-overlapping adjacent pairs.
6. Every high nibble is below 16.
7. Every low nibble is below 16.
8. Division by the constant 16 is safe.

The production reverse encoder allocates 128 bytes, loops while `i < 64`, and calls these same `pairOffset`, `highNibble`, and `lowNibble` helpers. The CHC lemmas establish the helper preconditions and every array offset used by the loop. The `hexDigit` lowercase ASCII mapping is established by source inspection, SDK vectors, and live reverse resolution, which also provide execution evidence for the full encoded value and resulting Keccak hash.

## Evidence classes

| Property | Evidence | Result |
|---|---|---|
| Digest length rejection and exact verifier dispatch | Unbounded CHC proof over production verifier | Proved safe |
| Resolver capability predicates and unauthorized transitions | Unbounded CHC proof over production policy helpers | Proved safe |
| Reverse pair bounds, separation, nibble bounds, and arithmetic | Unbounded CHC proof over production helpers | Proved safe |
| Formal consistency of new Hyperion builtins | Compiler SMT regression plus CHC proof | Passed |
| SHAKE256 output bytes | Standard known vectors in Go, Hyperion semantics, and live raw calls | Passed |
| ML-DSA-87 valid and invalid behavior | Pinned Go library tests, Hyperion semantics, JavaScript differential check, and live raw calls | Passed |
| Canonical 64-byte boolean output | Go unit tests and live raw calls | Passed |
| Malformed input never reaches unsafe slices | Length gate, Go unit tests, and fuzzing | Passed |
| Legacy and via-IR compiler lowering | Hyperion semantic tests and six-contract builds through both paths | Passed |
| Full 128-character reverse encoding | SDK parity tests and live forward, reverse, and forward-confirm flow | Passed |
| Gas calibration | Five-run local benchmark and fixed gas tests | Provisional pending cross-platform review |

## Formal model boundaries

Hyperion represents SHAKE256 and ML-DSA-87 as deterministic uninterpreted functions. The formal result establishes same-input consistency and contract control-flow properties. Cryptographic correctness, collision resistance, unforgeability, rejection behavior, and side-channel resistance rest on the concrete libraries and their separate evidence.

The public `digest(bytes)` ABI returns dynamic bytes because the current QRL web3 codec lacks general `bytes64` support. Hyperion's SMT abstraction for `abi.encodePacked` does not establish the dynamic return length. The builtin has a compile-time `bytes64` result, while semantic tests and live contract calls confirm a 64-byte ABI value.

The authorization proof assumes `ens.owner(node)` supplies the registry owner used by the transaction. A complete formal verification of the vendored ENS registry lifecycle, external-call semantics, compiler correctness, QRVM correctness, and deployed-bytecode equivalence remains outside this focused proof.

The reverse proof establishes universal helper lemmas and their production source composition. Dynamic-memory loop semantics are covered by compiler runtime checks, SDK parity, and live integration evidence.

The migration removed the Foundry toolchain and its 28 Solidity behavior tests: 15 forward-resolution tests and 13 reverse-resolution tests. The Hyperion compile gates, focused policy proofs, SDK tests, and live flows cover the new QRL 2.0 boundaries, but they do not replace all registry lifecycle and state-transition coverage. Re-registration, operator approvals, and subnode churn need a Hyperion-native behavioral harness before production deployment.

## Concrete validation

The following checks passed on the proof-coupled source:

```bash
HYPERION_Z3_LIBRARY_DIR=/path/to/z3/lib npm run verify:formal
HYPERION_COMPILER=../hyperion/build/hypc/hypc npm test
QNS_CONFIG=config/local-qip55.json QNS_PUBLIC_DEV_ACCOUNT=0 npm run deploy:testnet
QNS_CONFIG=config/local-qip55.json QNS_PUBLIC_DEV_ACCOUNT=0 npm run register -- alice
QNS_CONFIG=config/local-qip55.json npm run verify:pq
```

The formal gate proved 36 CHC targets. Six contracts compiled normally and via IR. The local chain accepted all six deployments. `alice.qrl` passed forward resolution, reverse resolution, and forward confirmation. SHAKE256 known-vector, ML-DSA-87 valid, ML-DSA-87 invalid, wrapper parity, and exact digest-boundary checks all passed.

The Kurtosis evidence and deployment record remain available for independent review. The local enclave was stopped after validation to release host resources and must be recreated for another live run.

## Residual protocol decisions

- Select the fork activation rule for slots 3 and 6. A fresh genesis can activate them immediately; an existing network requires coordinated consensus activation.
- Ratify the gas schedule using multiple supported validator CPU classes. The current local medians were about 323 ns for 64-byte SHAKE256 and 180 microseconds for ML-DSA-87 verification. The 250000 charge is conservative relative to the proposed SHAKE256 schedule on that host.
- Publish a serialized cross-language ML-DSA-87 vector with provenance.
- Define the public-key-to-QRL-identity binding before signatures authorize QNS record writes.
- Freeze the canonical signed-record encoding and treat any change to `QNS-SIGN-v1` as a protocol-version change.
- Select a stable Hyperion release and repeat the proof with its supported Z3 version before public deployment.
- Select the production governance owner, revoke the deployer's temporary Root controller role, and transfer Root plus ReverseRegistrar ownership through a separately reviewed handoff procedure.
- Restore Hyperion-native lifecycle coverage for the 28 removed Foundry behavior tests before production deployment.

The detailed review artifacts are in [`docs/security-review-2026-08-23-qrl2/`](./security-review-2026-08-23-qrl2/).
