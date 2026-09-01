# Findings

Update 2026-08-26: the aligned ML-DSA-87 slot 3 frame, SHAKE256 slot 6 assignment, timestamp activation, 125000 verifier gas charge, Hyperion lowering, QNS consumers, tracer expectations, and live composition passed their current validation gates. The verifier failure return convention remains open.

No open critical or high-severity vulnerability was confirmed in the implemented local stack. The initial review and adversarial follow-up resolved five implementation and operator-safety findings. Four protocol integration risks remain explicit QIP or release decisions, and two low-severity QNS design or coverage items remain open before production.

## QRL2-001: Legacy reverse-label encoding did not cover native 64-byte addresses

Severity: Medium. Status: Resolved.

The inherited ENS reverse-label routine was designed for a 20-byte address and 32-byte VM words. Reuse under 64-byte QRVM semantics could truncate or mis-encode the address, creating incorrect reverse nodes and possible aliasing. The implementation now converts `bytes64(addr)` into exactly 128 lowercase hexadecimal bytes through [`QRLAddressReverse.hyp`](../../contracts/hyperion/reverse/QRLAddressReverse.hyp), then hashes that complete value.

The CHC proof establishes pair bounds, pair separation, nibble ranges, overflow safety, and division safety. SDK parity and the live `alice.qrl` forward, reverse, and forward-confirm flow establish concrete value agreement.

## QRL2-002: Ambient private seed could override an explicit local public fixture

Severity: Low. Status: Resolved.

An ignored `.env` can contain `TESTNET_SEED`. Local commands that explicitly request a published Kurtosis account now give that selector precedence. The selector is accepted only when the configured RPC URL has a loopback host and the connected chain ID is 3151908. This URL check does not attest the Docker host bind scope, which is guarded separately by the Kurtosis startup script. A regression test covers the precedence rule in [`loadDeployer.test.js`](../../test/scripts/loadDeployer.test.js).

## QRL2-003: Public-network activation values require protocol ratification

Severity: Medium design risk. Status: Implemented locally; open for QIP review.

The current go-qrl integration introduces one timestamp rule that changes slot 3 from the legacy 32-byte ML-DSA-87 frame to the aligned 64-byte frame and adds SHAKE256 at slot 6. Before activation, the legacy slot 3 behavior remains available and slot 6 is absent. At and after activation, both aligned operations are registered. Genesis parsing, configuration compatibility, registry selection, and pre-activation plus post-activation tests cover the rule. The local genesis set the activation timestamp to zero, and the activated tracer fixtures plus full repository suite passed.

Required resolution: ratify the activation timestamp for every public network. The next fresh QRL 2.0 testnet can activate at genesis; a network with existing blocks needs one coordinated timestamp across participants.

## QRL2-004: Gas price remains provisional across validator hardware

Severity: Medium design risk. Status: Open for QIP review.

The current ML-DSA-87 charge is 125000 gas. Five local runs measured a median near 180 microseconds per verification and a median near 323 ns for a 64-byte SHAKE256 call. A 30 million gas block permits at most 240 verifications, approximately 43 milliseconds at that measured median before scheduling and execution overhead. Validator CPU diversity, batch behavior, cache effects, and worst-case valid-length inputs still require review.

Required resolution: benchmark supported validator CPU classes, select a target gas-per-second budget, document the percentile and safety margin, and ratify the fixed charge in the QIP.

## QRL2-010: Verifier failure return convention is unresolved

Severity: Medium design risk. Status: Open for QIP review.

The current go-qrl implementation returns empty data for invalid signatures and malformed frames. A canonical 64-byte zero word remains a candidate before release. Direct callers can observe the difference, and ordinary ABI boolean decoding can revert on empty data. The aligned Hyperion builtin is fail-closed across both candidates: only the exact 64-byte success word maps to true; empty data and the canonical zero word map to false.

Required resolution: select one consensus failure form before release, add normative vectors for malformed and invalid inputs, and update direct-call guidance. Retain the dual-compatible Hyperion behavior through the review period.

## QRL2-011: The declared go-qrllib version differs from the resolved source

Severity: Medium consensus dependency risk. Status: Open for release review.

The current go-qrl base declares `github.com/theQRL/go-qrllib v0.8.0` and replaces it with `github.com/rgeraldes24/go-qrllib v0.1.1-0.20260707094212-a6d78f111b1f`. The replacement module declares the official module path. Go pins the module checksum as `h1:yhR6S+o8Fz2DZojtOAvyORd8msr+vyehEmZjDrxvVw8=`, so builds remain reproducible while that directive and checksum are preserved. Review material that names only v0.8.0 identifies different source from the code used by the verifier.

Required resolution: review and publish the resolved commit and checksum, then either consume an audited official release containing the same code or explicitly ratify the replacement for the target consensus release. CI should fail if the resolved module path or checksum drifts.

## QRL2-005: Kurtosis host publication was mistaken for loopback binding

Severity: High operator-safety. Status: Resolved.

The qrl-package execution launcher listens on `0.0.0.0` for HTTP, WebSocket, Engine API, and metrics, with admin, engine, debug, and txpool namespaces enabled. `port_publisher.nat_exit_ip` supplies the P2P advertisement and does not select the Docker host bind address. Docker's unspecified published-port default can therefore expose these unauthenticated development services beyond the workstation.

The QNS arguments disable the package's fixed public port ranges. Kurtosis 1.20.0 still assigns ephemeral host mappings for declared service ports. The start script inspects Docker's actual `NetworkSettings.Ports` for every running service container and fails closed if any host address is not `127.0.0.1` or `::1`; there is no wildcard override. A project-owned `socat` process supplies only the stable client URL at `127.0.0.1:32002`. Its lifecycle is managed by the user systemd instance when available, with a checked PID fallback. The 2026-08-26 composition exposed every ephemeral mapping on loopback and no wildcard address.

## QRL2-006: Live testnet deployment data was tracked

Severity: High opsec process. Status: Resolved.

`config/testnet.json` was a tracked public-repository file while its working copy could contain private infrastructure data. It is now removed from the Git index, ignored explicitly, and preserved locally. The tracked `config/local-qip55.example.json` remains the scrubbed deployment template.

## QRL2-007: Local images and running enclaves could be reused without provenance checks

Severity: Medium operator-safety. Status: Resolved.

The start path previously rebuilt only missing images and accepted any existing enclave with the expected name. The build scripts now label go-qrl, Qrysm, and genesis-generator images with source revisions. The go-qrl image also records source state and a deterministic hash over tracked plus untracked non-ignored inputs; the patched generator records its exact patch hash and activation value. Startup recomputes those values, compares each running service's image ID with its local tag, and offers `QNS_FORCE_REBUILD=1` for deliberate refreshes.

## QRL2-008: Deployment account retains alpha administration

Severity: Low design risk. Status: Open before production.

After `deploy-testnet.js`, the deployer remains the owner of `Root`, a Root controller, and the owner of `ReverseRegistrar`. This is explicit alpha administration and allows later wiring changes. Production deployment needs a reviewed destination owner, controller revocation, ownership transfers, and post-handoff verification. Renunciation is irreversible and is not automated without an agreed governance target.

## QRL2-009: Hyperion migration removed registry lifecycle unit coverage

Severity: Low review-evidence gap. Status: Partially remediated; open before production.

Removing the Solidity and Foundry path also removed 28 behavior tests: 15 forward-resolution tests and 13 reverse-resolution tests. A new live Hyperion suite restores eight high-value lifecycle and authorization cases: compatibility aliases, fresh registration, duplicate rejection, owner reassignment, unauthorized subnode and resolver writes, reverse-node parity, and scoped reverse claims. The formal policy lemmas cover the trusted-registrar capability that a live account cannot impersonate. Operator approvals, deeper subnode churn, and the remaining lifecycle transitions still need equivalent coverage before production.

## Residual assumptions

- ML-DSA-87 unforgeability and parser safety rely on the resolved go-qrllib replacement at commit `a6d78f111b1f`.
- SHAKE256 and Keccak security rely on their concrete implementations and standard assumptions.
- Hyperion, QRVM, the SMT encoding, and Z3 are part of the proof trusted base.
- Future signed resolver writes require an explicit public-key-to-QRL-identity binding.
