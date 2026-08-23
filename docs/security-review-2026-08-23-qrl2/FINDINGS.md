# Findings

No open critical or high-severity vulnerability was confirmed in the implemented local stack. The initial review and adversarial follow-up resolved five implementation and operator-safety findings. Two protocol integration risks remain explicit QIP decisions, and two low-severity QNS design or coverage items remain open before production.

## QRL2-001: Legacy reverse-label encoding did not cover native 64-byte addresses

Severity: Medium. Status: Resolved.

The inherited ENS reverse-label routine was designed for a 20-byte address and 32-byte VM words. Reuse under 64-byte QRVM semantics could truncate or mis-encode the address, creating incorrect reverse nodes and possible aliasing. The implementation now converts `bytes64(addr)` into exactly 128 lowercase hexadecimal bytes through [`QRLAddressReverse.hyp`](../../contracts/hyperion/vendored/reverseRegistrar/QRLAddressReverse.hyp), then hashes that complete value.

The CHC proof establishes pair bounds, pair separation, nibble ranges, overflow safety, and division safety. SDK parity and the live `alice.qrl` forward, reverse, and forward-confirm flow establish concrete value agreement.

## QRL2-002: Ambient private seed could override an explicit local public fixture

Severity: Low. Status: Resolved.

An ignored `.env` can contain `TESTNET_SEED`. Local commands that explicitly request a published Kurtosis account now give that selector precedence. The selector is accepted only when the configured RPC URL has a loopback host and the connected chain ID is 3151908. This URL check does not attest the Docker host bind scope, which is guarded separately by the Kurtosis startup script. A regression test covers the precedence rule in [`loadDeployer.test.js`](../../test/scripts/loadDeployer.test.js).

## QRL2-003: Precompile activation requires a consensus rule

Severity: Medium design risk. Status: Open for QIP review.

The review implementation registers slots 3 and 6 in the active Zond map in `go-qrl/core/vm/contracts.go`. A fresh local genesis is internally consistent. An existing network needs a coordinated activation boundary so old and new clients cannot disagree about call success, gas, return data, or tracing. The reconciled tracer fixture is direct evidence of the observable transition: the precompile-aware result has three subtraces and `0x4d205` gas where the pre-activation fixture had six subtraces and `0x1131d` gas.

Required resolution: choose genesis activation or a named fork rule, gate both go-qrl registration and Hyperion target compatibility, and add pre-activation plus post-activation consensus tests.

## QRL2-004: Gas price remains provisional across validator hardware

Severity: Medium design risk. Status: Open for QIP review.

The proposed ML-DSA-87 charge is 250000 gas. Five local runs measured a median near 180 microseconds per verification and a median near 323 ns for a 64-byte SHAKE256 call. This makes 250000 conservative relative to the proposed SHAKE256 schedule on the measured host. Validator CPU diversity, batch behavior, cache effects, and worst-case valid-length inputs still require review.

Required resolution: benchmark supported validator CPU classes, select a target gas-per-second budget, document the percentile and safety margin, and ratify the fixed charge in the QIP.

## QRL2-005: Kurtosis host publication was mistaken for loopback binding

Severity: High operator-safety. Status: Resolved.

The qrl-package execution launcher listens on `0.0.0.0` for HTTP, WebSocket, Engine API, and metrics, with admin, engine, debug, and txpool namespaces enabled. `port_publisher.nat_exit_ip` supplies the P2P advertisement and does not select the Docker host bind address. Docker's unspecified published-port default can therefore expose these unauthenticated development services beyond the workstation.

The QNS start script now probes Docker's actual default bind behavior and fails closed unless all observed host addresses are loopback. It verifies the running execution container after startup and requires `QNS_ALLOW_WILDCARD_BIND=1` for an explicit operator override after host-level controls are applied. The collection guide documents Docker daemon binding, firewall limitations, and direct inspection commands.

## QRL2-006: Live testnet deployment data was tracked

Severity: High opsec process. Status: Resolved.

`config/testnet.json` was a tracked public-repository file while its working copy could contain private infrastructure data. It is now removed from the Git index, ignored explicitly, and preserved locally. The tracked `config/local-qip55.example.json` remains the scrubbed deployment template.

## QRL2-007: Local images and running enclaves could be reused without provenance checks

Severity: Medium operator-safety. Status: Resolved.

The start path previously rebuilt only missing images and accepted any existing enclave with the expected name. The build scripts now label go-qrl, Qrysm, and genesis-generator images with source revisions; go-qrl also records a clean or dirty source state. Startup compares those labels with pinned sources, compares each running service's image ID with its local tag, rejects unverifiable dirty-source reuse, and offers `QNS_FORCE_REBUILD=1` for deliberate refreshes.

## QRL2-008: Deployment account retains alpha administration

Severity: Low design risk. Status: Open before production.

After `deploy-testnet.js`, the deployer remains the owner of `Root`, a Root controller, and the owner of `ReverseRegistrar`. This is explicit alpha administration and allows later wiring changes. Production deployment needs a reviewed destination owner, controller revocation, ownership transfers, and post-handoff verification. Renunciation is irreversible and is not automated without an agreed governance target.

## QRL2-009: Hyperion migration removed registry lifecycle unit coverage

Severity: Low review-evidence gap. Status: Open before production.

Removing the Solidity and Foundry path also removed 28 behavior tests: 15 forward-resolution tests and 13 reverse-resolution tests. The formal policy lemmas and live end-to-end flows cover the new security boundaries, while re-registration, operator approvals, subnode churn, and related lifecycle transitions still need a Hyperion-native unit harness.

## Residual assumptions

- ML-DSA-87 unforgeability and parser safety rely on pinned go-qrllib behavior.
- SHAKE256 and Keccak security rely on their concrete implementations and standard assumptions.
- Hyperion, QRVM, the SMT encoding, and Z3 are part of the proof trusted base.
- Future signed resolver writes require an explicit public-key-to-QRL-identity binding.
