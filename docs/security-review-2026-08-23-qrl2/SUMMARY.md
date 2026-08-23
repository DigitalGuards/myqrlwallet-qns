# Security verification summary

The QRL 2.0 precompile and QNS groundwork now has a reproducible formal gate and live integration evidence.

- 36 Hyperion CHC targets proved safe.
- Owner-only resolver writes and the narrow trusted reverse-registrar capability use formally verified shared predicates.
- The exact 64-byte verifier boundary and dispatch tuple are formally verified.
- Reverse-label offset, separation, nibble, overflow, and division lemmas are formally verified through helpers used by production code.
- Two compiler paths, six contracts, SDK parity, six local deployments, forward resolution, reverse resolution, SHAKE256 vectors, and ML-DSA-87 valid and invalid behavior passed.
- Two implementation findings were fixed: the legacy-width reverse encoder and local public-fixture seed precedence.
- Fork activation and cross-platform gas ratification remain open QIP decisions.
- The go-qrl changed scope, tracer suite, static analysis, and fuzz target passed. The full repository run exposed an intermittent catalyst payload timing test that also reproduces on untouched base commit `b92884a`.

Formal cryptographic claims are intentionally narrow. Hyperion models SHAKE256 and ML-DSA-87 as deterministic uninterpreted functions. Concrete cryptographic security rests on the standard algorithms, pinned implementations, differential vectors, and independent upstream review.

See [`FORMAL-SECURITY-VERIFICATION.md`](../FORMAL-SECURITY-VERIFICATION.md) for the full property list, method, evidence classes, commands, assumptions, and residual decisions.
