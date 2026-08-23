# Findings

No open critical or high-severity vulnerability was confirmed in the implemented local stack. Two implementation findings were fixed during the review. Two protocol integration risks remain explicit QIP decisions.

## QRL2-001: Legacy reverse-label encoding did not cover native 64-byte addresses

Severity: Medium. Status: Resolved.

The inherited ENS reverse-label routine was designed for a 20-byte address and 32-byte VM words. Reuse under 64-byte QRVM semantics could truncate or mis-encode the address, creating incorrect reverse nodes and possible aliasing. The implementation now converts `bytes64(addr)` into exactly 128 lowercase hexadecimal bytes through [`QRLAddressReverse.hyp`](../../contracts/hyperion/vendored/reverseRegistrar/QRLAddressReverse.hyp), then hashes that complete value.

The CHC proof establishes pair bounds, pair separation, nibble ranges, overflow safety, and division safety. SDK parity and the live `alice.qrl` forward, reverse, and forward-confirm flow establish concrete value agreement.

## QRL2-002: Ambient private seed could override an explicit local public fixture

Severity: Low. Status: Resolved.

An ignored `.env` can contain `TESTNET_SEED`. Local commands that explicitly request a published Kurtosis account now give that selector precedence. The selector is accepted only for a loopback RPC and exact chain ID 3151908. A regression test covers the precedence rule in [`loadDeployer.test.js`](../../test/scripts/loadDeployer.test.js).

## QRL2-003: Precompile activation requires a consensus rule

Severity: Medium design risk. Status: Open for QIP review.

The review implementation registers slots 3 and 6 in the active Zond map in `go-qrl/core/vm/contracts.go`. A fresh local genesis is internally consistent. An existing network needs a coordinated activation boundary so old and new clients cannot disagree about call success, gas, or return data.

Required resolution: choose genesis activation or a named fork rule, gate both go-qrl registration and Hyperion target compatibility, and add pre-activation plus post-activation consensus tests.

## QRL2-004: Gas price remains provisional across validator hardware

Severity: Medium design risk. Status: Open for QIP review.

The proposed ML-DSA-87 charge is 250000 gas. Five local runs measured a median near 180 microseconds per verification and a median near 323 ns for a 64-byte SHAKE256 call. This makes 250000 conservative relative to the proposed SHAKE256 schedule on the measured host. Validator CPU diversity, batch behavior, cache effects, and worst-case valid-length inputs still require review.

Required resolution: benchmark supported validator CPU classes, select a target gas-per-second budget, document the percentile and safety margin, and ratify the fixed charge in the QIP.

## Residual assumptions

- ML-DSA-87 unforgeability and parser safety rely on pinned go-qrllib behavior.
- SHAKE256 and Keccak security rely on their concrete implementations and standard assumptions.
- Hyperion, QRVM, the SMT encoding, and Z3 are part of the proof trusted base.
- Future signed resolver writes require an explicit public-key-to-QRL-identity binding.
