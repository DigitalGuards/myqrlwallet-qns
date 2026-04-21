# Open Questions Blocking QNS Implementation

Seven load-bearing unknowns must be resolved with QRL core developers (Discord, GitHub Discussions, or the QIP process) before Phase 1 contracts deploy. Target: 1–2 week pre-implementation discovery spike.

Each item below lists (a) the question, (b) what its answer affects, (c) how to resolve it.

## 1. Hyperion `address` type width

**Q:** Does Hyperion redefine the Solidity `address` type from 20 bytes to 24 bytes, or does it preserve 20-byte `address` and expose QRL's full 24 bytes only via `bytes`/structs?

**Affects:** Whether every `address` field in vendored ENS compiles unmodified (Path A, preferred) or whether the registry needs wholesale retyping (Path B — forks ENS more aggressively). This is the single most important answer.

**How to resolve:** Read `hyperion/libsolidity/ast/Types.h` / `Types.cpp` in `/home/waterfall/myqrlwallet/hyperion`. Ask on `#hyperion-dev` in QRL Discord. Write a sentinel contract `contract T { address a = 0x...; }` and inspect `hypc --ast-compact-json` output for the declared width.

## 2. ML-DSA-87 verification precompile

**Q:** Is there a precompile on Zond for ML-DSA-87 signature verification? If yes: at what address, with what ABI, at what gas cost?

**Affects:** Phase 4 (signed records, ENSIP-19 sig reverse, CCIP-Read) is tractable with a precompile and infeasible without one (in-EVM verifier costs 5–10M gas per verify).

**How to resolve:** Grep `/home/waterfall/myqrlwallet/go-qrl` for `PrecompiledContract` registrations and MLDSA references. Ask on `#go-qrl` Discord. If missing, open a QIP proposing inclusion before mainnet freeze — this is a one-shot opportunity.

## 3. Testnet V2 and mainnet chainId

**Q:** Confirmed chainId for Testnet V2? Planned chainId for mainnet?

**Affects:** ENSIP-11 coinType derivation (`0x80000000 | chainId`) — used for multichain `addr` and per-chain reverse namespace. Hard-coded in resolver config, so changing it post-deployment requires redeployment.

**Current working assumption:** `1337` for Testnet V2 per `../QuantaPool/CLAUDE.md`. Mainnet unknown.

**How to resolve:** Query `qrl_chainId` on the testnet RPC; cross-check with `go-qrl/params/config.go`. Ask QRL team for mainnet chainId commitment before Phase 5.

## 4. On-chain address representation — descriptor included or excluded?

**Q:** When a contract reads `msg.sender`, does it get the 24-byte native address *with* the 3-byte cryptographic descriptor or *without*? (The post-April-2025 go-qrllib refactor separates the descriptor; where does the separation land at the EVM boundary?)

**Affects:** `sha3QRLAddress` for reverse-namespace computation must hash **exactly** what `msg.sender` produces on-chain. A mismatch means the reverse lookup computes the wrong node and reverse resolution silently fails.

**How to resolve:** Deploy a trivial `contract T { function me() view returns (bytes memory) { return abi.encodePacked(msg.sender); } }` on testnet and inspect the return. Cross-check against the address format definition in `/home/waterfall/myqrlwallet/go-qrl/common/address.go`.

## 5. TLD choice — `.qrl` vs `.q` vs alternatives

**Q:** Which TLD does the QRL ecosystem want? `.qrl` (aligned with post-Zond rebrand), `.q` (shortest), `.zond` (pre-rebrand), `.qns` (self-referential)?

**Affects:** Everything. TLD is baked into the deployed `FIFSQRLRegistrar`'s owned label and cannot be changed without a migration.

**Current recommendation:** `.qrl`. Aligns with brand, unambiguous, matches SDK naming.

**How to resolve:** Submit as the first naming-related QIP under the QEP track. Coordinate with QIP custodians (jackalyst, fr1t2, jplomas). Budget 2–4 weeks for community review.

## 6. `ecrecover` retained on Zond?

**Q:** Is precompile `0x01` (`ecrecover`) retained on Zond for ported Ethereum contract compatibility, or removed because ECDSA has no place in a post-quantum chain?

**Affects:** Every OpenZeppelin contract using `ECDSA.recover`, every EIP-712 consumer, every contract that dependencies assume is callable — not just QNS/ENS.

**How to resolve:** Check `/home/waterfall/myqrlwallet/go-qrl` precompile registrations. If removed: audit vendored ENS for any `ecrecover` use (should be only ENSIP-19 signature variants) and plan replacement with ML-DSA verifier.

## 7. `zondjs` / SDK target

**Q:** What's the status of `zondjs` (successor to archived `@theqrl/web3`)? Is it stable enough to be a QNS SDK dependency, or should QNS target the lower-level `@theqrl/qrl_providers` EIP-1193 interface directly?

**Affects:** `@qns/sdk` dependencies and API ergonomics. `@theqrl/web3` was archived 2023-10; `zondjs` is in development for Vortex IDE.

**Current decision:** Target `@theqrl/qrl_providers` (EIP-1193 `window.qrl`) as a minimal interface. Lift to `zondjs` when stable.

**How to resolve:** Check `theQRL/zondjs` repo status on GitHub. If stable by Phase 1, switch `@qns/sdk` to use it.

---

## Secondary (non-blocking) questions

| # | Question | Recommendation |
|---|---|---|
| 8 | ENSv2 per-name sub-registry architecture — adopt or skip? | **Skip.** Spec unfinalized; v1 is stable and audited. |
| 9 | XMSS pubkey support in `IPubkeyResolver` alongside ML-DSA? | **ML-DSA only.** XMSS deprecated for validators (still available for wallets); single standard in QNS simpler. |
| 10 | Tokenize names as QRC-721 from day one? | **No.** Defer until QRC-721 standard is finalized (Phase 5+). |

---

Resolution log — fill in as answers arrive:

```
[YYYY-MM-DD] #N answered by <source>: <answer summary>
```
