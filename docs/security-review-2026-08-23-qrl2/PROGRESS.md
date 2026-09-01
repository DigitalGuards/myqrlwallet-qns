# Verification progress

Update 2026-08-26: the table records the aligned slot, framing, activation, failure-handling, compiler, QNS, and live-network results from the current review trees.

| Area | Check | Result |
|---|---|---|
| Formal | Hyperion CHC resolver, exact context, and crypto-boundary harness | 26 safe targets |
| Formal | Hyperion CHC reverse-index harness | 10 safe targets |
| Compiler | SHAKE256 and ML-DSA-87 SMT regression | Passed |
| Compiler | SHAKE256 semantic test, legacy and via IR | Passed |
| Compiler | ML-DSA-87 semantic test, legacy and via IR | Passed for valid, empty-failure, and canonical-zero-failure hosts |
| Compiler | Complete Hyperion suite | 7,184 passed |
| Contracts | Six deployable QNS contracts, normal compiler path | Passed |
| Contracts | Six deployable QNS contracts, explicit via-IR path | Passed |
| QNS | Deployment and provenance script tests | 17 passed |
| QNS SDK | TypeScript typecheck | Passed |
| QNS SDK | Unit tests | 23 passed |
| Local chain | Six production contracts deployed; formal harnesses stayed off-chain | Passed on chain ID 3151908 with activation timestamp 0 |
| Local chain | Forward, reverse, and forward-confirm resolution | Passed with a fresh `.qrl` registration |
| Local chain | Raw and wrapped cryptographic checks | 9 of 9 phases passed |
| Local chain | Hyperion lifecycle and authorization behavior | 8 of 8 subtests passed |
| go-qrl | Focused precompile and activation unit tests | Passed |
| go-qrl | Five-run precompile benchmark | Passed |
| go-qrl | Activated tracer fixture reconciliation | Passed in the active integration tree and retained snapshot tree |
| go-qrl | Full repository test suite | `go test ./...` passed in both review trees |
| Operator safety | Post-start host-binding verification across every enclave service | Passed; all observed mappings were loopback-only |
| Operator safety | Stable RPC proxy lifecycle | Passed through user systemd start, shell exit, and project stop |
| Operator safety | Source revision, content, patch, activation, and running image checks | Passed |
| Opsec | Live `config/testnet.json` removed from tracking and ignored | Resolved; local working file preserved |
| Dependency provenance | go-qrllib declared version versus fork replacement | Exact resolved commit identified; release decision pending |
| Removed coverage | 15 forward plus 13 reverse Foundry behavior tests | Eight high-value live cases restored; complete parity remains open |

## Live composition provenance

- go-qrl revision `5bd086068bd440be1111e828bc1a791337cff8ab`, dirty source state, content hash `12bbacb5f1a753eaed08bb45cfb9d02acc281b5093e02a0637b9f960499348b4`
- Qrysm beacon and validator revision `b53fd7c488f3f0d1d4163b270afac1749eed954b`
- genesis-generator revision `6a11fbcee762af14d188507f071d08ac5782fa69`, patch hash `34a69c37b727e5ea9f29ebc40817beccafdf3b3b8ec08c6ec6664210a5a80914`, activation label `0`
- Hyperion compiler `0.2.0-develop.2026.8.25+commit.f55de24d.mod.Linux.g++`

The live image matched these labels when the enclave started. Two activated call-tracer JSON fixtures changed after the enclave stopped; they do not enter the go-qrl binary. Both resulting full Go suites passed. The next QNS startup includes those fixture bytes in its source fingerprint and will rebuild the node image before another enclave run.

## Formal toolchain

- Hyperion compiler source: local `feat/qrl2-pq-precompiles` branch
- model checker engine: CHC
- solver: Z3 4.12.1
- proof gate: exact expected target counts plus rejection of unsafe, unproved, unavailable, and unsupported results

The host's system Z3 4.8.12 was below Hyperion's minimum 4.8.16. The proof compiler was rebuilt against a local Z3 4.12.1 distribution. This dependency correction preceded every reported proof.

## Full go-qrl validation

`go test ./...` passed on the active integration checkout after activated call-tracer expectations were added to the two affected fixtures. The same command passed on the retained precompile snapshot after its equivalent expectations were reconciled. The full runs covered catalyst, the tracer packages, and generated RLP tests.
