# Verification progress

| Area | Check | Result |
|---|---|---|
| Formal | Hyperion CHC resolver, exact context, and crypto-boundary harness | 26 safe targets |
| Formal | Hyperion CHC reverse-index harness | 10 safe targets |
| Compiler | SHAKE256 and ML-DSA-87 SMT regression | Passed |
| Compiler | SHAKE256 semantic test, legacy and via IR | Passed |
| Compiler | ML-DSA-87 semantic test, legacy and via IR | Passed |
| Contracts | Six deployable QNS contracts, normal compiler path | Passed |
| Contracts | Six deployable QNS contracts, explicit via-IR path | Passed |
| QNS | Script tests | 3 passed |
| QNS SDK | TypeScript typecheck | Passed |
| QNS SDK | Unit tests | 12 passed |
| Local chain | Six production contracts deployed; formal harnesses stayed off-chain | Passed |
| Local chain | Forward, reverse, and forward-confirm resolution | Passed |
| Local chain | Raw and wrapped cryptographic checks | 5 passed |
| go-qrl | Focused precompile unit tests, vet, and fuzzing | Passed; 36,698 fuzz executions |
| go-qrl | Five-run precompile benchmark | Passed |
| go-qrl | Tracer fixture reconciliation | Passed |
| go-qrl | Full repository test suite | Changed scope passed; pre-existing catalyst timing race reproduced on base `b92884a` |
| Operator safety | Docker bind probe and post-start host-binding verification | Added; fails closed unless loopback or explicitly acknowledged |
| Operator safety | Source revision labels and running service image-ID checks | Added |
| Opsec | Live `config/testnet.json` removed from tracking and ignored | Resolved; local working file preserved |
| Removed coverage | 15 forward plus 13 reverse Foundry behavior tests | Disclosed; Hyperion-native lifecycle replacement remains open |

## Formal toolchain

- Hyperion compiler source: local `feat/qrl2-pq-precompiles` branch
- model checker engine: CHC
- solver: Z3 4.12.1
- proof gate: exact expected target counts plus rejection of unsafe, unproved, unavailable, and unsupported results

The host's system Z3 4.8.12 was below Hyperion's minimum 4.8.16. The proof compiler was rebuilt against a local Z3 4.12.1 distribution. This dependency correction preceded every reported proof.

## Baseline exception

`go test -p 1 ./... -count=1` passed every reported package except `qrl/catalyst`. `TestPrepareAndGetPayload` intermittently observed zero transactions after its fixed 100 ms payload-build wait. Repeating the exact test reproduced the same failure on the untouched base commit `b92884a`, both with and without the two-core test throttle. The precompile branch does not modify catalyst, miner, transaction-pool, or payload-building code.
