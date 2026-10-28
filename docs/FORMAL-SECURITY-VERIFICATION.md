# Formal security verification

Status: 36 Hyperion CHC targets proved safe on the aligned tree on 2026-08-26. Six production contracts compiled through the legacy and via-IR paths, deployed to the activated local 64-byte Kurtosis network, and ran through the SDK, cryptographic, lifecycle, and authorization checks. The two formal harness contracts remained off-chain.

Update 2026-10-28: the gate proves 37 CHC and 24 BMC targets and requires nine reachability witnesses. The new targets cover registry authority and frame conditions, Controllable and Ownable effects, and the resolver record version. They complement the hyptest contract suites and the stateful fuzzer described in the README.

## Scope

The formal harness covers the new QNS security boundaries introduced for QRL 2.0:

- the exact 64-byte digest boundary before ML-DSA-87 verification
- QNS signing-context construction
- deterministic treatment of SHAKE256 and ML-DSA-87 calls in Hyperion's formal model
- owner-only resolver writes
- the narrow `setName` capability granted to the trusted reverse registrar
- transition lemmas showing that unauthorized callers leave owner-only records unchanged
- native 64-byte reverse-label pair offsets, pair separation, nibble ranges, arithmetic overflow, and division safety

The review also tracks go-qrl precompile parsing, success and failure return conventions, gas behavior, compiler lowering, SDK parity, and live execution. Those checks use unit tests, fuzzing, semantic tests, benchmarks, differential vectors, and Kurtosis integration evidence.

## Attacker model

An attacker can submit arbitrary contract calls, byte arrays, message digests, signatures, public keys, contexts, node hashes, names, and resolver values. The attacker may call every public contract method and may occupy the trusted reverse-registrar address in the capability-policy model. The attacker cannot break the cryptographic assumptions of SHAKE256, Keccak-256, or ML-DSA-87, alter finalized contract bytecode, compromise the execution or consensus client host, or violate QRVM transaction semantics.

The trusted computing base contains:

- go-qrl precompile registration and execution
- Go's SHAKE256 implementation and the resolved ML-DSA-87 module: declared as `theQRL/go-qrllib v0.8.0` and replaced by `rgeraldes24/go-qrllib` commit `a6d78f111b1f`
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

The proof gate is [`scripts/verify-formal.sh`](../scripts/verify-formal.sh). The harnesses are [`QNSSecurityProperties.hyp`](../test/formal/QNSSecurityProperties.hyp), [`QNSReverseSafetyProperties.hyp`](../test/formal/QNSReverseSafetyProperties.hyp), [`QNSRegistryProperties.hyp`](../test/formal/QNSRegistryProperties.hyp), [`QNSControllableProperties.hyp`](../test/formal/QNSControllableProperties.hyp) and [`QNSResolverVersionProperties.hyp`](../test/formal/QNSResolverVersionProperties.hyp), with the reachability witnesses in [`QNSRegistryReachability.hyp`](../test/formal/QNSRegistryReachability.hyp) and [`QNSControllableReachability.hyp`](../test/formal/QNSControllableReachability.hyp).

The registry and Controllable harnesses use the BMC engine with a 60-second per-query solver limit. BMC analyses each function from an arbitrary storage state, which is a stronger premise than reachable states, and these harness functions and the production code they call contain no loops, so no unrolling bound applies. A CHC run of the registry harness did not finish within 14 minutes because it must infer invariants over every inherited registry function; BMC proves the same assertions in under a second. Each BMC property has a reachability witness: the same production path followed by `assert(false)`, which the gate requires the checker to reach, so no property passes because its assertions are unreachable.

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

### Registry authority and frame conditions: 17 BMC targets

Each property calls the production `QNSRegistry` function internally, so its `authorised` modifier runs with the transaction's sender:

1. A successful `setOwner` implies the caller was the node owner or an operator approved by that owner, and stores the new owner.
2. `setOwner` leaves the owner, resolver and TTL of every other node unchanged.
3. A successful `setSubnodeOwner` implies authority over the parent, returns and writes exactly `keccak256(parent, label)`, and leaves the parent record unchanged.
4. `setResolver` and `setTTL` require the same authority, store the given values, and never change the owner.
5. A node owned by the registry address is frozen for every caller that is neither the registry nor approved by it.
6. `owner()` never returns the registry address, returns the raw owner otherwise, and `recordExists` matches a nonzero raw owner.

### Controllable and Ownable effects: 7 BMC targets

1. `setController` writes exactly the named controller and keeps the owner.
2. `transferOwnership` installs the new owner and leaves controllers unchanged.
3. `renounceOwnership` leaves no owner and leaves controllers unchanged.

The owner check itself is not among these targets: see the custom-error boundary below.

### Resolver record version: 1 CHC target

A successful `clearRecords(node)` raises that node's record version by exactly one, whatever the external registry owner lookup answers. The run checks assertion targets only, because the version counter uses checked `uint64` arithmetic that reverts after 2^64 clears.

### Reachability witnesses: 9

Six registry witnesses and three Controllable witnesses show that every asserted path of the BMC properties is reachable, including the satisfiable preconditions of the frozen-node property.

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
| ML-DSA-87 valid and invalid behavior | Resolved Go library tests, Hyperion semantics, JavaScript differential checks, and live raw calls | Passed |
| Empty-data and canonical-zero failure compatibility | Hyperion execution-host fixtures for both candidates | Passed |
| Malformed input never reaches unsafe slices | Length gate, Go unit tests, and fuzzing | Passed |
| Legacy and via-IR compiler lowering | Hyperion semantic tests and six-contract builds through both paths | Passed |
| Full 128-character reverse encoding | SDK parity tests and live forward, reverse, and forward-confirm flow | Passed |
| Gas calibration | Five-run local benchmark and fixed gas tests | Provisional pending cross-platform review |
| Registry authority, operator scoping and frame conditions | BMC proof over production registry functions from arbitrary storage, with reachability witnesses | Proved safe |
| Controllable and Ownable effects | BMC proof over production functions, with reachability witnesses | Proved safe |
| Resolver record version increment | CHC proof over production `clearRecords` | Proved safe |
| Every external function, revert path and authorization matrix of the six contracts | Hyperion semantic suites under four codegen modes | Passed |
| Real ML-DSA-87 verification through the contract | Semantic suite with keys and signatures from `@theqrl/mldsa87`, verified by the test host | Passed |
| Stateful behaviour across random operation sequences | Differential fuzzing against a reference model, 600,000 steps | No mismatch |

## Formal model boundaries

Hyperion represents SHAKE256 and ML-DSA-87 as deterministic uninterpreted functions. The formal result establishes same-input consistency and contract control-flow properties. Cryptographic correctness, collision resistance, unforgeability, rejection behavior, and side-channel resistance rest on the concrete libraries and their separate evidence.

The public `digest(bytes)` ABI returns dynamic bytes because the current QRL web3 codec lacks general `bytes64` support. Hyperion's SMT abstraction for `abi.encodePacked` does not establish the dynamic return length. The builtin has a compile-time `bytes64` result, while semantic tests and live contract calls confirm a 64-byte ABI value.

The authorization proof assumes `ens.owner(node)` supplies the registry owner used by the transaction. A complete formal verification of the vendored ENS registry lifecycle, external-call semantics, compiler correctness, QRVM correctness, and deployed-bytecode equivalence remains outside this focused proof.

The reverse proof establishes universal helper lemmas and their production source composition. Dynamic-memory loop semantics are covered by compiler runtime checks, SDK parity, and live integration evidence.

The pinned SMTChecker does not end a path at `revert CustomError(...)`: both engines report the assertion after such a revert as reachable, while `require` and `revert("...")` behave as expected. Ignoring a revert only adds paths, so the proofs above remain sound, but guards written with custom errors cannot be proved. That covers the Ownable owner check, `NotAuthorised` in the resolver and `NotAvailable` in the FIFS registrar; the semantic suites and the fuzzer cover them. The CHC engine also did not settle, within the gate's per-query budget, that `clearRecords` leaves other nodes' versions unchanged across the external owner lookup; the semantic suite and the fuzzer cover that frame condition.

The migration removed the Foundry toolchain and its 28 Solidity behavior tests: 15 forward-resolution tests and 13 reverse-resolution tests. The new live Hyperion suite restores eight high-value lifecycle and authorization cases covering compatibility aliases, fresh registration, duplicate rejection, owner reassignment, unauthorized subnode and resolver writes, reverse-node parity, and scoped reverse claims. The formal policy proofs cover the trusted-registrar capability that a live account cannot impersonate. Since 2026-10-28 the in-process Hyperion suites cover operator approvals, subnode churn and the remaining registry transitions, and the stateful fuzzer checks random sequences of them.

## Concrete validation

The following checks passed on the aligned source on 2026-08-26:

```bash
HYPERION_Z3_LIBRARY_DIR=/path/to/z3/lib npm run verify:formal
HYPERION_COMPILER=../hyperion/build/hypc/hypc npm test
QNS_CONFIG=config/local-qip55.json QNS_PUBLIC_DEV_ACCOUNT=0 npm run deploy:testnet
QNS_CONFIG=config/local-qip55.json QNS_PUBLIC_DEV_ACCOUNT=0 npm run register -- alice
QNS_CONFIG=config/local-qip55.json npm run verify:pq
QNS_BEHAVIOR=1 QNS_PUBLIC_DEV_ACCOUNT=0 npm run test:behavior
```

The formal gate proved 36 CHC targets. Hyperion `0.2.0-develop.2026.8.25+commit.f55de24d.mod.Linux.g++` passed its complete 7,184-test suite, including both new builtin semantics. Six contracts compiled normally and via IR. QNS passed 17 deployment-script tests and 23 SDK tests. The local chain accepted all six deployments. A fresh `.qrl` name passed forward resolution, reverse resolution, and forward confirmation. The PQ verifier passed nine direct and wrapped phases covering the SHAKE256 vector, valid and invalid ML-DSA-87 calls, mutated digest and public key, context lengths 0 and 255, cross-context rejection, and the exact digest boundary. The live behavior suite passed all eight subtests. Both the active go-qrl integration tree and the retained snapshot tree passed `go test ./...` after their activated tracer expectations were reconciled.

The local composition used chain ID `3151908`, `qrl2PQPrecompilesTime: 0`, exact source and image labels, and loopback-only ephemeral Kurtosis mappings. Block height advanced from 96 to 98 during the final health probe. The deployment record remains local and ignored. The validated enclave and its stable RPC proxy were stopped after validation to release host resources; the stopped enclave record remains available for inspection.

## Residual protocol decisions

- Select the activation rule for the existing slot 3 verifier and new slot 6 SHAKE256 operation. A fresh genesis can activate them immediately; an existing network requires coordinated consensus activation.
- Select empty data or a canonical 64-byte zero word as the final verifier failure form. Hyperion is fail-closed for both candidates during review.
- Ratify the gas schedule using multiple supported validator CPU classes. The current local medians were about 323 ns for 64-byte SHAKE256 and 180 microseconds for ML-DSA-87 verification. The expected verifier charge is 125000 unless proposal review approves another value.
- Publish a serialized cross-language ML-DSA-87 vector with provenance.
- Define the public-key-to-QRL-identity binding before signatures authorize QNS record writes.
- Freeze the canonical signed-record encoding and treat any change to `QNS-SIGN-v1` as a protocol-version change.
- Select a stable Hyperion release and repeat the proof with its supported Z3 version before public deployment.
- Select the production governance owner and review the [ordered handoff](DEPLOYMENT-GOVERNANCE.md): assign the `reverse` registry node to its final owner, optionally lock `qrl` and then `reverse` after exact owner checks, add reviewed Root controllers, revoke deployer controller roles, then transfer Root and ReverseRegistrar ownership. Lock `qrl` only after the long-lived registrar holds it: the alpha FIFSQRLRegistrar cannot transfer the node after Root locks it. The handoff and read-only power check have mocked-provider unit coverage; they add no formal proof targets or live deployment evidence.
- Repeat the live behavior suite on the target network with the lifecycle cases that the in-process suites now cover.

The detailed review artifacts are in [`docs/security-review-2026-08-23-qrl2/`](./security-review-2026-08-23-qrl2/).
