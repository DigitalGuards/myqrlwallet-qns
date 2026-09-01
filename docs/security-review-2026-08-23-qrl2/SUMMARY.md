# Security verification summary

Update 2026-08-26: the source and validation are aligned to ML-DSA-87 at slot 3, SHAKE256 at slot 6, the 64-byte verifier frame, timestamp activation, and 125000 verifier gas. Hyperion remains fail-closed across both candidate failure returns.

The aligned QRL 2.0 precompile and QNS implementation produced reproducible formal, compiler, client, SDK, deployment, and live integration evidence.

- The aligned formal gate reported all 36 Hyperion CHC targets safe.
- Owner-only resolver writes and the narrow trusted reverse-registrar capability use formally verified shared predicates.
- The exact 64-byte verifier boundary and dispatch tuple are formally verified.
- Reverse-label offset, separation, nibble, overflow, and division lemmas are formally verified through helpers used by production code.
- Hyperion's complete 7,184-test suite, both QNS compiler paths, six contract deployments, 17 script tests, 23 SDK tests, nine live PQ phases, and eight live lifecycle subtests passed.
- A fresh `.qrl` name passed forward resolution, reverse resolution, and forward confirmation on chain ID `3151908` with genesis activation timestamp zero.
- Five findings were fixed: the legacy-width reverse encoder, local public-fixture seed precedence, unsafe Kurtosis exposure assumptions, tracked deployment data, and stale image or enclave reuse.
- The activation mechanism is implemented and tested; public-network activation values, verifier failure semantics, cross-platform gas ratification, and go-qrllib replacement provenance remain QIP or release decisions.
- Alpha deployer administration and complete parity with the removed 28-test lifecycle suite remain explicit pre-production work. Eight high-value lifecycle and authorization cases now run against the deployed Hyperion stack.
- `go test ./...` passed in both the active integration tree and retained snapshot after their activated call-tracer fixtures were reconciled.
- Every observed Kurtosis service mapping used loopback. The stable RPC proxy survived launcher exit under user systemd and stopped with the enclave.

Formal cryptographic claims are intentionally narrow. Hyperion models SHAKE256 and ML-DSA-87 as deterministic uninterpreted functions. Concrete cryptographic security rests on the standard algorithms, the exact resolved implementation, differential vectors, and independent upstream review.

The validated enclave and stable RPC proxy were stopped after validation to release host resources. The stopped enclave record remains available for inspection; reviewers can recreate it from the source-identified images for an independent run.

See [`FORMAL-SECURITY-VERIFICATION.md`](../FORMAL-SECURITY-VERIFICATION.md) for the full property list, method, evidence classes, commands, assumptions, and residual decisions.
